//! Walks a folder, reads font metadata, and keeps the `fonts` table in sync.
//!
//! How a scan runs:
//! 1. **Discover.** Walk the folder and check each font file's size and modified time. This
//!    metadata is cheap, even for online-only cloud files. Unchanged files are skipped.
//! 2. **Read.** Changed files are read and parsed by 8 worker threads. On macOS these threads
//!    are set so that reading an online-only cloud file fails at once, instead of starting a
//!    download that can take from seconds to many minutes. Those files go to a separate queue of
//!    3 download threads, so one slow download never holds up the rest. Only this thread writes
//!    to the database, committing about every 400 ms, so fonts show up while the scan runs.
//! 3. **Clean up.** Files that disappeared are forgotten. This step only runs if the walk could
//!    list every folder, so an unreachable drive never wipes the library.
//!
//! Every step checks the cancel flag.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed},
        mpsc::{self, RecvTimeoutError},
        Arc, Mutex,
    },
    time::{Duration, Instant, UNIX_EPOCH},
};

use rusqlite::{params, Connection};
use ttf_parser::{Face, PlatformId};
use walkdir::WalkDir;

use crate::{
    activation, cloud, db,
    error::{AppError, AppResult},
    model::{Axis, ScanFailure, ScanProgress, ScanReport},
};

pub const FONT_EXTENSIONS: &[&str] = &["ttf", "otf", "ttc", "otc"];
const READ_WORKERS: usize = 8;
const DOWNLOAD_WORKERS: usize = 3;
const COMMIT_EVERY: Duration = Duration::from_millis(400);
const PROGRESS_EVERY: Duration = Duration::from_millis(120);

pub struct ParsedFace {
    pub family: String,
    pub subfamily: String,
    pub full_name: Option<String>,
    pub postscript_name: Option<String>,
    pub version: Option<String>,
    pub designer: Option<String>,
    pub manufacturer: Option<String>,
    pub copyright: Option<String>,
    pub license: Option<String>,
    pub license_url: Option<String>,
    pub weight: u16,
    pub width: u16,
    pub italic: bool,
    pub monospace: bool,
    pub variable: bool,
    pub axes: Vec<Axis>,
    pub glyph_count: u16,
    pub format: String,
}

pub fn is_font_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| FONT_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Parses every face in a font file. A plain .ttf/.otf has one face; a collection has several.
pub fn parse_file(data: &[u8]) -> Result<Vec<ParsedFace>, String> {
    let collection = ttf_parser::fonts_in_collection(data);
    let count = collection.unwrap_or(1);
    // `count` comes from the file's header, so it isn't trusted for allocation.
    let mut faces = Vec::with_capacity((count as usize).min(64));
    for index in 0..count {
        let face = Face::parse(data, index).map_err(|e| e.to_string())?;
        faces.push(parse_face(&face, collection.is_some()));
    }
    if faces.is_empty() {
        return Err("collection contains no fonts".into());
    }
    Ok(faces)
}

fn parse_face(face: &Face, in_collection: bool) -> ParsedFace {
    let name = |id: u16| name_string(face, id);
    let family = name(16).or_else(|| name(1)).unwrap_or_else(|| "Unknown".into());
    let subfamily = name(17).or_else(|| name(2)).unwrap_or_else(|| "Regular".into());

    let tables = face.tables();
    let outlines = if tables.cff.is_some() || tables.cff2.is_some() { "OpenType CFF" } else { "TrueType" };
    let format = if in_collection { format!("{outlines} Collection") } else { outlines.to_string() };

    let axes = face
        .variation_axes()
        .into_iter()
        .map(|a| Axis {
            tag: String::from_utf8_lossy(&a.tag.to_bytes()).into_owned(),
            name: name(a.name_id),
            min: a.min_value,
            default: a.def_value,
            max: a.max_value,
            hidden: a.hidden,
        })
        .collect();

    ParsedFace {
        family,
        subfamily,
        full_name: name(4),
        postscript_name: name(6),
        version: name(5),
        designer: name(9),
        manufacturer: name(8),
        copyright: name(0),
        license: name(13),
        license_url: name(14),
        weight: face.weight().to_number(),
        width: face.width().to_number(),
        italic: face.is_italic(),
        monospace: face.is_monospaced(),
        variable: face.is_variable(),
        axes,
        glyph_count: face.number_of_glyphs(),
        format,
    }
}

/// Picks the best `name` table entry: Windows US English, then any Unicode entry, then Mac Roman.
fn name_string(face: &Face, id: u16) -> Option<String> {
    let mut unicode: Option<String> = None;
    let mut mac: Option<String> = None;
    for n in face.names().into_iter().filter(|n| n.name_id == id) {
        if n.platform_id == PlatformId::Windows && n.language_id == 0x0409 {
            if let Some(s) = n.to_string().filter(|s| !s.trim().is_empty()) {
                return Some(s.trim().to_string());
            }
        }
        if unicode.is_none() && n.is_unicode() {
            unicode = n.to_string();
        }
        if mac.is_none() && n.platform_id == PlatformId::Macintosh && n.encoding_id == 0 {
            // Mac Roman matches ASCII for the characters font names almost always use.
            mac = Some(n.name.iter().map(|&b| b as char).collect());
        }
    }
    unicode.or(mac).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn mtime_secs(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

enum ReadError {
    /// Couldn't read the file (permissions, offline, still copying). Worth retrying next scan.
    Io(String),
    /// Read fine but isn't a usable font. Remembered until the file changes.
    Parse(String),
}

enum ReadOutcome {
    Parsed(Result<Vec<ParsedFace>, ReadError>),
    /// Online-only and not downloaded yet; goes to the download queue.
    NotDownloaded,
}

fn parse_bytes(data: std::io::Result<Vec<u8>>) -> Result<Vec<ParsedFace>, ReadError> {
    let data = data.map_err(|e| ReadError::Io(e.to_string()))?;
    parse_file(&data).map_err(ReadError::Parse)
}

fn read_and_parse(path: &Path) -> ReadOutcome {
    match std::fs::read(path) {
        Err(e) if cloud::is_not_downloaded(&e) => ReadOutcome::NotDownloaded,
        other => ReadOutcome::Parsed(parse_bytes(other)),
    }
}

/// For a walk error, the dead symlink's target if that's what it was. Such a link is skipped
/// without marking the walk incomplete, but fonts recorded under its target are protected from
/// cleanup, in case it points at a drive that's only unplugged.
fn broken_link_target(path: &Path) -> Option<PathBuf> {
    let is_link = std::fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(false);
    if !is_link || path.metadata().is_ok() {
        return None;
    }
    let target = std::fs::read_link(path).ok()?;
    let target = if target.is_relative() { path.parent()?.join(target) } else { target };
    // Resolve whatever part of the target still exists, to match the stored real paths.
    let (mut base, mut rest) = (target.as_path(), Vec::new());
    loop {
        if let Ok(real) = std::fs::canonicalize(base) {
            return Some(rest.iter().rev().fold(real, |acc: PathBuf, part| acc.join(part)));
        }
        rest.push(base.file_name()?.to_owned());
        base = base.parent()?;
    }
}

fn is_hidden(entry: &walkdir::DirEntry) -> bool {
    entry.depth() > 0 && entry.file_name().to_str().map(|s| s.starts_with('.')).unwrap_or(false)
}

/// Lets an event through at most once per interval. The first call always passes.
struct Throttle {
    every: Duration,
    last: Option<Instant>,
}

impl Throttle {
    fn new(every: Duration) -> Self {
        Self { every, last: None }
    }
    fn ready(&mut self) -> bool {
        if self.last.map_or(true, |t| t.elapsed() >= self.every) {
            self.last = Some(Instant::now());
            return true;
        }
        false
    }
}

/// Moves rows stored under a symlinked (walked) path to the file's real path. If rows already
/// exist under the real path, the walked ones are folded in: "on" wins, then they're removed.
fn adopt_walked_path(
    conn: &Connection,
    known: &mut HashMap<String, (i64, i64)>,
    skipped: &mut HashMap<String, (i64, i64)>,
    walked: &str,
    real: &str,
) -> AppResult<()> {
    let in_fonts = known.remove(walked);
    let in_skipped = skipped.remove(walked);
    if in_fonts.is_none() && in_skipped.is_none() {
        return Ok(());
    }
    let _turn = db::scan_write_turn();
    if let Some(stamp) = in_fonts {
        conn.execute(
            "UPDATE fonts SET activated = 1 WHERE path = ?1 AND EXISTS (SELECT 1 FROM fonts WHERE path = ?2 AND activated = 1)",
            params![real, walked],
        )?;
        conn.execute("UPDATE OR IGNORE fonts SET path = ?1 WHERE path = ?2", params![real, walked])?;
        conn.execute("DELETE FROM fonts WHERE path = ?1", [walked])?;
        known.entry(real.to_string()).or_insert(stamp);
    }
    if let Some(stamp) = in_skipped {
        conn.execute("UPDATE OR IGNORE skipped_files SET path = ?1 WHERE path = ?2", params![real, walked])?;
        conn.execute("DELETE FROM skipped_files WHERE path = ?1", [walked])?;
        skipped.entry(real.to_string()).or_insert(stamp);
    }
    Ok(())
}

struct Pending {
    path: PathBuf,
    path_str: String,
    size: i64,
    mtime: i64,
    known: bool,
    cloud: bool,
}

pub fn scan_folder(
    db_path: &Path,
    folder_id: i64,
    root: &Path,
    cancel: &Arc<AtomicBool>,
    mut on_progress: impl FnMut(ScanProgress),
) -> AppResult<ScanReport> {
    if !root.is_dir() {
        return Err(AppError::Invalid(format!(
            "{} can't be reached. If it's on a cloud drive or an external disk, check that it's connected.",
            root.display()
        )));
    }
    let mut conn = db::open(db_path)?;
    let mut report = ScanReport { folder_id, ..Default::default() };
    let mut throttle = Throttle::new(PROGRESS_EVERY);

    let stamps = |sql: &str| -> AppResult<HashMap<String, (i64, i64)>> {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([folder_id], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?;
        Ok(rows.collect::<Result<_, _>>()?)
    };
    // Files with fonts in the library, and files remembered as holding none.
    let mut known = stamps("SELECT path, file_size, mtime FROM fonts WHERE folder_id = ?1 GROUP BY path")?;
    let mut skipped = stamps("SELECT path, file_size, mtime FROM skipped_files WHERE folder_id = ?1")?;
    let other_roots = db::other_roots(&conn, folder_id)?;
    // Files another folder already lists (e.g. two folders that both link to one outside folder).
    let owned_elsewhere: HashSet<String> = {
        let mut stmt = conn.prepare(
            "SELECT path FROM fonts WHERE folder_id != ?1 UNION SELECT path FROM skipped_files WHERE folder_id != ?1",
        )?;
        let rows = stmt.query_map([folder_id], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut protected: Vec<PathBuf> = Vec::new();

    // 1. Discover, and sort out which files changed.
    let mut seen = HashSet::new();
    let mut pending = Vec::new();
    let mut cloud = 0;
    // Creative Cloud's font store is never read (Adobe's terms), including through symlinks;
    // hidden entries are skipped too.
    let adobe = crate::services::adobe::is_adobe_path;
    for entry in WalkDir::new(root).follow_links(true).into_iter().filter_entry(|e| {
        !is_hidden(e)
            && !adobe(e.path())
            && !(e.path_is_symlink() && std::fs::canonicalize(e.path()).is_ok_and(|real| adobe(&real)))
    }) {
        if cancel.load(Relaxed) {
            report.cancelled = true;
            return Ok(report);
        }
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                let hidden = e.depth() > 0
                    && e.path().and_then(|p| p.file_name()).and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.'));
                if e.loop_ancestor().is_some() || hidden {
                    continue; // a symlink loop, or something we'd skip anyway
                }
                if let Some(target) = e.path().and_then(broken_link_target) {
                    protected.push(target);
                    // Rows stored by older versions use the path through the link.
                    protected.extend(e.path().map(Path::to_path_buf));
                    continue;
                }
                // Anything else means part of the folder went unseen.
                eprintln!("fontface: can't list {}: {e}", e.path().map(|p| p.display().to_string()).unwrap_or_default());
                report.walk_errors += 1;
                continue;
            }
        };
        if !entry.file_type().is_file() || !is_font_file(entry.path()) {
            continue;
        }
        report.files += 1;
        // Store the real on-disk path (symlinks resolved), the same key the OS's list of loaded
        // fonts is normalized to, so "is it on?" comparisons match.
        let real = std::fs::canonicalize(entry.path()).unwrap_or_else(|_| entry.path().to_path_buf());
        if adobe(&real) {
            report.files -= 1; // reached Adobe's store through a link: never read
            continue;
        }
        let path_str = real.to_string_lossy().into_owned();
        // Older versions stored the path as walked (through symlinks). Move such rows to the
        // real path, keeping ids and on/off choices, instead of deleting (and turning off) them.
        // This runs before the ownership checks below, so it covers every way a file is reached.
        let walked = entry.path().to_string_lossy().into_owned();
        if walked != path_str {
            adopt_walked_path(&conn, &mut known, &mut skipped, &walked, &path_str)?;
        }
        // Reached through a symlink into another library folder, or already listed by another
        // folder: that folder owns it. Mark it seen anyway, so a row this folder held from
        // before is handed over by the owner's scan rather than deleted (and turned off) here.
        if !real.starts_with(root)
            && (other_roots.iter().any(|r| real.starts_with(r)) || owned_elsewhere.contains(&path_str))
        {
            report.files -= 1;
            seen.insert(path_str);
            continue;
        }
        if !seen.insert(path_str.clone()) {
            report.files -= 1; // reached twice through a symlink
            continue;
        }
        match entry.metadata() {
            Err(e) => report.failed.push(ScanFailure { path: path_str.clone(), reason: e.to_string() }),
            Ok(meta) => {
                let (size, mtime) = (meta.len() as i64, mtime_secs(&meta));
                let previous = known.get(&path_str);
                if previous == Some(&(size, mtime)) || skipped.get(&path_str) == Some(&(size, mtime)) {
                    report.unchanged += 1;
                } else {
                    let dataless = cloud::is_dataless(&meta);
                    cloud += dataless as usize;
                    pending.push(Pending {
                        path: real,
                        path_str: path_str.clone(),
                        size,
                        mtime,
                        known: previous.is_some(),
                        cloud: dataless,
                    });
                }
            }
        }
        if throttle.ready() {
            on_progress(ScanProgress {
                folder_id,
                phase: "discovering",
                found: report.files,
                done: report.unchanged,
                cloud,
                current: path_str,
            });
        }
    }

    // 2. Read and parse the changed files. Workers are detached threads (not scoped) so that a
    //    cancel never has to wait for a download stuck inside the kernel.
    let mut done = report.unchanged + report.failed.len();
    if !pending.is_empty() {
        on_progress(ScanProgress { folder_id, phase: "reading", found: report.files, done, cloud, current: String::new() });
        let pending = Arc::new(pending);
        let next = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel::<(usize, ReadOutcome)>();
        let (download_tx, download_rx) = mpsc::channel::<usize>();
        let download_rx = Arc::new(Mutex::new(download_rx));
        let halted = {
            let (cancel, stop) = (cancel.clone(), stop.clone());
            move || cancel.load(Relaxed) || stop.load(Relaxed)
        };

        for _ in 0..READ_WORKERS.min(pending.len()) {
            let (tx, pending, next, halted) = (tx.clone(), pending.clone(), next.clone(), halted.clone());
            std::thread::spawn(move || {
                cloud::fail_fast_on_this_thread();
                while !halted() {
                    let i = next.fetch_add(1, Relaxed);
                    let Some(item) = pending.get(i) else { break };
                    if tx.send((i, read_and_parse(&item.path))).is_err() {
                        break;
                    }
                }
            });
        }
        for _ in 0..DOWNLOAD_WORKERS {
            let (tx, pending, queue, halted) = (tx.clone(), pending.clone(), download_rx.clone(), halted.clone());
            std::thread::spawn(move || loop {
                let Ok(i) = queue.lock().map_err(|_| ()).and_then(|q| q.recv().map_err(|_| ())) else { break };
                if halted() {
                    break;
                }
                // Default I/O policy: this read downloads the file.
                let outcome = ReadOutcome::Parsed(parse_bytes(std::fs::read(&pending[i].path)));
                if tx.send((i, outcome)).is_err() {
                    break;
                }
            });
        }
        drop(tx);

        let mut outstanding = pending.len();
        let mut cloud_left = cloud;
        let mut write = || -> AppResult<()> {
            let mut in_tx = false;
            let mut turn: Option<db::ScanWriteTurn> = None;
            let mut last_commit = Instant::now();
            while outstanding > 0 && !cancel.load(Relaxed) {
                match rx.recv_timeout(Duration::from_millis(250)) {
                    Ok((i, ReadOutcome::NotDownloaded)) => {
                        // Hand it to the download queue; it still counts as outstanding.
                        let _ = download_tx.send(i);
                    }
                    Ok((i, ReadOutcome::Parsed(result))) => {
                        outstanding -= 1;
                        done += 1;
                        let item = &pending[i];
                        cloud_left -= item.cloud as usize;
                        if !in_tx {
                            // Let a waiting UI write (a click) go first.
                            while db::ui_write_waiting() && !cancel.load(Relaxed) {
                                std::thread::sleep(Duration::from_millis(2));
                            }
                            turn = Some(db::scan_write_turn());
                            conn.execute_batch("BEGIN")?;
                            in_tx = true;
                        }
                        match result {
                            Ok(faces) => {
                                let written = upsert_faces(&conn, folder_id, &item.path_str, item.size, item.mtime, &faces)?;
                                if written > 0 {
                                    conn.execute("DELETE FROM skipped_files WHERE path = ?1", [&item.path_str])?;
                                    if item.known { report.updated += 1 } else { report.added += 1 }
                                } else {
                                    // Only private macOS UI families: nothing to list. Remember it.
                                    remember_skipped(&conn, folder_id, item, "only private macOS fonts")?;
                                }
                            }
                            // Never delete on failure: the file is still there, and its rows carry
                            // the user's on/off choice. An I/O failure leaves the old size/mtime
                            // in place, so the file is retried next scan.
                            Err(ReadError::Io(reason)) => {
                                report.failed.push(ScanFailure { path: item.path_str.clone(), reason });
                            }
                            Err(ReadError::Parse(reason)) => {
                                // Remember it, so it isn't re-read and re-reported until it changes.
                                // Any existing rows (and the on/off choice) are left as they were.
                                remember_skipped(&conn, folder_id, item, &reason)?;
                                report.failed.push(ScanFailure { path: item.path_str.clone(), reason });
                            }
                        }
                        if throttle.ready() {
                            on_progress(ScanProgress {
                                folder_id,
                                phase: "reading",
                                found: report.files,
                                done,
                                cloud: cloud_left,
                                current: item.path_str.clone(),
                            });
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
                // Commit on a timer so the UI sees progress, or at once if the UI or another
                // folder's scan wants to write.
                if in_tx && (last_commit.elapsed() >= COMMIT_EVERY || db::ui_write_waiting() || db::scan_writer_waiting()) {
                    conn.execute_batch("COMMIT")?;
                    turn = None;
                    in_tx = false;
                    last_commit = Instant::now();
                }
            }
            if in_tx {
                conn.execute_batch("COMMIT")?;
            }
            drop(turn);
            Ok(())
        };
        let result = write();
        // Tell every worker to finish. Threads stuck in a download exit when it completes.
        stop.store(true, Relaxed);
        drop(download_tx);
        drop(rx);
        result?;
    }

    if cancel.load(Relaxed) {
        report.cancelled = true;
        return Ok(report);
    }

    // 3. Forget files that are gone, but only if the walk saw every folder. Files under a dead
    //    symlink's target are kept: the link may point at a drive that's only unplugged.
    if report.walk_errors == 0 {
        let gone = |map: &HashMap<String, (i64, i64)>| -> Vec<String> {
            map.keys()
                .filter(|p| !seen.contains(*p) && !protected.iter().any(|t| Path::new(p).starts_with(t)))
                .cloned()
                .collect()
        };
        let (gone_fonts, gone_skipped) = (gone(&known), gone(&skipped));
        if !gone_fonts.is_empty() || !gone_skipped.is_empty() {
            // Lock order everywhere: scan write turn, then activation lock.
            let _turn = db::scan_write_turn();
            let _activation = activation::lock();
            // Turn off gone files that were on. No transaction is open during these OS calls.
            for path in &gone_fonts {
                let was_active: bool = conn
                    .query_row("SELECT COALESCE(MAX(activated), 0) FROM fonts WHERE path = ?1", [path], |r| r.get(0))
                    .unwrap_or(false);
                // An old alias of a file still listed under its real path: deleting the alias
                // row is enough. Unregistering would turn off the live font.
                let alias_of_listed = std::fs::canonicalize(path).ok().is_some_and(|real| {
                    let real = real.to_string_lossy().into_owned();
                    real != *path
                        && conn
                            .query_row("SELECT EXISTS(SELECT 1 FROM fonts WHERE path = ?1)", [&real], |r| r.get(0))
                            .unwrap_or(false)
                });
                if was_active && !alias_of_listed {
                    let _ = activation::deactivate(Path::new(path));
                }
            }
            // Then delete in one short write transaction. IMMEDIATE takes the write lock up
            // front, so SQLite's busy timeout applies if another folder's scan is writing.
            while db::ui_write_waiting() {
                std::thread::sleep(Duration::from_millis(2));
            }
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            for path in &gone_fonts {
                tx.execute("DELETE FROM fonts WHERE path = ?1", [path])?;
                report.removed += 1;
            }
            for path in &gone_skipped {
                tx.execute("DELETE FROM skipped_files WHERE path = ?1", [path])?;
            }
            tx.commit()?;
        }
    }

    Ok(report)
}

fn remember_skipped(conn: &Connection, folder_id: i64, item: &Pending, reason: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO skipped_files (path, folder_id, file_size, mtime, reason) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (path) DO UPDATE SET folder_id = excluded.folder_id, file_size = excluded.file_size,
            mtime = excluded.mtime, reason = excluded.reason",
        params![item.path_str, folder_id, item.size, item.mtime, reason],
    )?;
    Ok(())
}

/// Writes every listable face of a file. Returns how many rows were written.
fn upsert_faces(
    conn: &Connection,
    folder_id: i64,
    path: &str,
    size: i64,
    mtime: i64,
    faces: &[ParsedFace],
) -> AppResult<usize> {
    let mut stmt = conn.prepare_cached(
        "INSERT INTO fonts (folder_id, path, face_index, file_size, mtime, family, subfamily,
            full_name, postscript_name, version, designer, manufacturer, copyright, license,
            license_url, weight, width, italic, monospace, variable, axes, glyph_count, format)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
            ?18, ?19, ?20, ?21, ?22, ?23)
         ON CONFLICT (path, face_index) DO UPDATE SET
            folder_id = excluded.folder_id, file_size = excluded.file_size, mtime = excluded.mtime,
            family = excluded.family, subfamily = excluded.subfamily, full_name = excluded.full_name,
            postscript_name = excluded.postscript_name, version = excluded.version,
            designer = excluded.designer, manufacturer = excluded.manufacturer,
            copyright = excluded.copyright, license = excluded.license,
            license_url = excluded.license_url, weight = excluded.weight, width = excluded.width,
            italic = excluded.italic, monospace = excluded.monospace, variable = excluded.variable,
            axes = excluded.axes, glyph_count = excluded.glyph_count, format = excluded.format",
    )?;
    let mut written = 0;
    for (index, f) in faces.iter().enumerate() {
        // Families starting with "." are private macOS UI fonts that apps can't pick. Skip them.
        if f.family.starts_with('.') {
            conn.execute("DELETE FROM fonts WHERE path = ?1 AND face_index = ?2", params![path, index as u32])?;
            continue;
        }
        let axes = serde_json::to_string(&f.axes).unwrap_or_else(|_| "[]".into());
        stmt.execute(params![
            folder_id, path, index as u32, size, mtime, f.family, f.subfamily, f.full_name,
            f.postscript_name, f.version, f.designer, f.manufacturer, f.copyright, f.license,
            f.license_url, f.weight, f.width, f.italic, f.monospace, f.variable, axes,
            f.glyph_count, f.format
        ])?;
        written += 1;
    }
    // A collection that shrank leaves stale faces behind.
    conn.execute(
        "DELETE FROM fonts WHERE path = ?1 AND face_index >= ?2",
        params![path, faces.len() as u32],
    )?;
    Ok(written)
}
