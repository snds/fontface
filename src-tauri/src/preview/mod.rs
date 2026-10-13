//! Preview profiles: what the library list draws for each face, so a preview always shows the
//! font's own glyphs. Symbol, icon, Expert and script fonts often can't draw their own name;
//! without a profile the missing letters fall back to the system font. See `profile.rs` for
//! how the text is chosen and `font.rs` for how CoreText's character lookup is mirrored.
//!
//! **Storage.** One row per face in `face_previews`, a side table created by `ensure_schema`
//! (outside db.rs's numbered migrations, like the tag tables). A row counts only while its
//! file size, modified time and `rev` match the font row and `PREVIEW_REV`; `db::list_fonts`
//! checks that in its join, so stale rows arrive as `preview: null`. Bumping `PREVIEW_REV`
//! recomputes everything at the next launch. Rows go when their font does (ON DELETE CASCADE).
//!
//! **Who writes rows.**
//! - The scanner, for every file it reads, in the same transaction as the font rows.
//! - `backfill`, once at launch, for faces without a current row (fonts scanned before this
//!   existed, or after a `PREVIEW_REV` bump).
//! - `on_demand`, for rows on screen that still have none (say, a cloud file downloaded since).
//!
//! **Safety.** Creative Cloud's font files are never read (Adobe's terms), online-only files
//! are never downloaded for a profile (reads fail fast instead), and files over 96 MB are
//! skipped, the same rules as `protocol.rs`. Each face gets a bounded amount of work
//! (`font::limits`), so a damaged file can't stall a scan. Commands read files on two reader
//! threads (`Readers`), never on Tauri's async workers, each command through its own
//! latest-wins `Lane`, so a call nobody waits for any more is skipped instead of read.

pub mod characters;
pub mod font;
pub mod profile;
mod unicode;

#[cfg(test)]
mod tests;

use std::{
    collections::HashMap,
    panic::{catch_unwind, AssertUnwindSafe},
    path::Path,
    sync::{
        atomic::{
            AtomicU64, AtomicUsize,
            Ordering::{Relaxed, SeqCst},
        },
        mpsc::{self, RecvTimeoutError},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

use crate::{
    cloud, db,
    error::{AppError, AppResult},
};

pub use profile::{Names, Profile};

/// Bump after changing how profiles are worked out: every profile is recomputed at next launch.
/// 2: symbol-only fonts with plain letters draw their names, empty one-point glyphs count as
/// empty, more Expert sets are found, and the full name keeps its own kind.
/// 3: icon fonts with plain letters and a big private-use icon set (Material Symbols) show
/// their icons.
pub const PREVIEW_REV: i64 = 3;

/// At most this many ids per `preview_profiles` call.
pub const MAX_ON_DEMAND: usize = 64;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS face_previews (
    font_id        INTEGER PRIMARY KEY REFERENCES fonts(id) ON DELETE CASCADE,
    file_size      INTEGER NOT NULL,
    mtime          INTEGER NOT NULL,
    rev            INTEGER NOT NULL,
    kind           TEXT NOT NULL,
    full_kind      TEXT,
    family_text    TEXT,
    full_text      TEXT,
    sample         TEXT,
    label          TEXT,
    ascii_missing  TEXT NOT NULL DEFAULT '',
    flags          INTEGER NOT NULL DEFAULT 0,
    ascent         REAL,
    descent        REAL,
    ink_top        REAL,
    ink_bottom     REAL
);
";

/// Creates `face_previews` if it's missing. Idempotent; called at launch, and by the scanner on
/// its own connection since it writes the table.
pub fn ensure_schema(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(SCHEMA)?;
    // Added in PREVIEW_REV 2; a table made before has rev 1 rows only, which no longer count.
    let has_full_kind: bool =
        conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('face_previews') WHERE name = 'full_kind'", [], |r| r.get(0))?;
    if !has_full_kind {
        conn.execute_batch("ALTER TABLE face_previews ADD COLUMN full_kind TEXT")?;
    }
    Ok(())
}

/// The join `db::list_fonts` uses: only a current profile matches.
pub fn join_clause() -> String {
    format!(
        "LEFT JOIN face_previews p ON p.font_id = fonts.id AND p.rev = {PREVIEW_REV} \
         AND p.file_size = fonts.file_size AND p.mtime = fonts.mtime"
    )
}

/// The profile columns, in the order `info_from_row` reads them.
pub const COLUMNS: &str =
    "p.kind, p.family_text, p.full_text, p.label, p.ascii_missing, p.ascent, p.descent, p.ink_top, p.ink_bottom, p.full_kind";

/// How many columns `COLUMNS` lists.
pub const COLUMN_COUNT: usize = 10;

/// What the list needs from a profile (`FontSummary.preview`). Ordinary fonts send only
/// `kind` and the four metrics.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInfo {
    /// What the family row draws: name, trim, case, sample19, script, symbols, expert, partial
    /// or none.
    pub kind: String,
    /// What a style row draws, when it isn't the same as `kind`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_kind: Option<String>,
    /// What a family row draws instead of the family name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family_text: Option<String>,
    /// What a style row draws instead of the full name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_text: Option<String>,
    /// "Symbols", "Expert set", a script name or "Partial set", when either row draws a sample.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Printable ASCII characters the face can't draw.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub ascii_missing: String,
    /// Line ascent and descent in em, as CoreText (and so the web view) lays the line out.
    pub ascent: f64,
    pub descent: f64,
    /// Ink of the family and full preview texts, in em above and below the baseline.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ink_top: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ink_bottom: Option<f64>,
}

/// Em values are kept to 3 decimals: plenty for fitting, and short in the list payload.
fn round(v: f32) -> f64 {
    // + 0.0 turns -0.0 into 0.0.
    (v as f64 * 1000.0).round() / 1000.0 + 0.0
}

impl PreviewInfo {
    pub fn from_profile(p: &Profile) -> Self {
        PreviewInfo {
            kind: p.kind.as_str().to_string(),
            full_kind: (p.full_kind != p.kind).then(|| p.full_kind.as_str().to_string()),
            family_text: p.family_text.clone(),
            full_text: p.full_text.clone(),
            label: p.label.clone(),
            ascii_missing: p.ascii_missing.clone(),
            ascent: round(p.ascent),
            descent: round(p.descent),
            ink_top: p.ink.map(|i| round(i.0)),
            ink_bottom: p.ink.map(|i| round(i.1)),
        }
    }
}

/// Reads `COLUMNS` starting at column `at`. None when the row has no current profile.
pub fn info_from_row(r: &Row, at: usize) -> rusqlite::Result<Option<PreviewInfo>> {
    let Some(kind) = r.get::<_, Option<String>>(at)? else { return Ok(None) };
    Ok(Some(PreviewInfo {
        kind,
        family_text: r.get(at + 1)?,
        full_text: r.get(at + 2)?,
        label: r.get(at + 3)?,
        ascii_missing: r.get::<_, Option<String>>(at + 4)?.unwrap_or_default(),
        ascent: r.get::<_, Option<f64>>(at + 5)?.unwrap_or(0.8),
        descent: r.get::<_, Option<f64>>(at + 6)?.unwrap_or(0.2),
        ink_top: r.get(at + 7)?,
        ink_bottom: r.get(at + 8)?,
        full_kind: r.get(at + 9)?,
    }))
}

/// Saves a face's profile, stamped with the file version it was worked out from. Nothing is
/// written if the font row is gone or now describes another version of the file (a scan got
/// there first). Returns whether it was written.
pub fn store(conn: &Connection, font_id: i64, file_size: i64, mtime: i64, p: &Profile) -> AppResult<bool> {
    let mut stmt = conn.prepare_cached(
        "INSERT INTO face_previews (font_id, file_size, mtime, rev, kind, family_text, full_text, sample, label,
            ascii_missing, flags, ascent, descent, ink_top, ink_bottom, full_kind)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
         WHERE EXISTS (SELECT 1 FROM fonts WHERE id = ?1 AND file_size = ?2 AND mtime = ?3)
         ON CONFLICT (font_id) DO UPDATE SET file_size = excluded.file_size, mtime = excluded.mtime,
            rev = excluded.rev, kind = excluded.kind, full_kind = excluded.full_kind, family_text = excluded.family_text,
            full_text = excluded.full_text, sample = excluded.sample, label = excluded.label,
            ascii_missing = excluded.ascii_missing, flags = excluded.flags, ascent = excluded.ascent,
            descent = excluded.descent, ink_top = excluded.ink_top, ink_bottom = excluded.ink_bottom",
    )?;
    let written = stmt.execute(params![
        font_id,
        file_size,
        mtime,
        PREVIEW_REV,
        p.kind.as_str(),
        p.family_text,
        p.full_text,
        p.sample,
        p.label,
        p.ascii_missing,
        p.flags,
        round(p.ascent),
        round(p.descent),
        p.ink.map(|i| round(i.0)),
        p.ink.map(|i| round(i.1)),
        (p.full_kind != p.kind).then(|| p.full_kind.as_str()),
    ])?;
    Ok(written > 0)
}

// ------------------------------------------------------------------------------ reading files

/// Why a file wasn't read for a preview.
#[derive(Debug, Clone, PartialEq)]
pub enum Unreadable {
    /// Creative Cloud's font store: never read (Adobe's terms).
    Adobe,
    /// Online-only in cloud storage. Never downloaded for a preview.
    Cloud,
    /// Over 96 MB.
    TooLarge,
    /// Not there (an unplugged drive, or deleted since the last scan).
    Missing,
    /// Changed since the last scan: the next scan reads it.
    Changed,
    /// Read, but not a usable font.
    Broken(String),
}

impl Unreadable {
    /// Worth asking again later in the session (the file may download, or a scan catch up).
    pub fn retry_later(&self) -> bool {
        matches!(self, Unreadable::Cloud | Unreadable::Changed | Unreadable::Missing)
    }

    pub fn message(&self) -> String {
        match self {
            Unreadable::Adobe => "Adobe Fonts files are only used through Creative Cloud, so Fontface doesn't read them.".into(),
            Unreadable::Cloud => "This file is online-only. Its characters show once your cloud drive downloads it.".into(),
            Unreadable::TooLarge => "This file is too large to read for a preview.".into(),
            Unreadable::Missing => "The font file can't be found right now.".into(),
            Unreadable::Changed => "The font file changed since it was last read. Rescan its folder to update it.".into(),
            Unreadable::Broken(e) => format!("This font can't be read: {e}"),
        }
    }
}

/// Files previews must never read: Creative Cloud's font store, by the app's path rule or any
/// path through CoreSync or livetype.
pub fn never_read(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    crate::services::adobe::is_adobe_path(Path::new(path)) || lower.contains("coresync") || lower.contains("livetype")
}

/// Reads a library font file for a preview. `stamp` is the (size, modified time) the database
/// has for it; a file that no longer matches isn't read.
///
/// The calling thread must be set to fail fast on online-only files
/// (`cloud::fail_fast_on_this_thread`), so a read never starts a download.
pub fn read_file(path: &str, stamp: Option<(i64, i64)>) -> Result<Vec<u8>, Unreadable> {
    if never_read(path) {
        return Err(Unreadable::Adobe);
    }
    let meta = std::fs::metadata(path).map_err(|_| Unreadable::Missing)?;
    if cloud::is_dataless(&meta) {
        return Err(Unreadable::Cloud);
    }
    if meta.len() > crate::protocol::MAX_PREVIEW_BYTES {
        return Err(Unreadable::TooLarge);
    }
    if stamp.is_some_and(|(size, mtime)| size != meta.len() as i64 || mtime != crate::scanner::mtime_secs(&meta)) {
        return Err(Unreadable::Changed);
    }
    std::fs::read(path).map_err(|e| if cloud::is_not_downloaded(&e) { Unreadable::Cloud } else { Unreadable::Missing })
}

/// A face as the database lists it: what a profile needs.
#[derive(Debug, Clone)]
pub struct FaceRow {
    pub id: i64,
    pub path: String,
    pub face_index: u32,
    pub file_size: i64,
    pub mtime: i64,
    pub family: String,
    pub subfamily: String,
    pub full_name: Option<String>,
    pub postscript_name: Option<String>,
}

const ROW_COLUMNS: &str = "fonts.id, fonts.path, fonts.face_index, fonts.file_size, fonts.mtime, fonts.family, \
     fonts.subfamily, fonts.full_name, fonts.postscript_name";

fn face_row(r: &Row) -> rusqlite::Result<FaceRow> {
    Ok(FaceRow {
        id: r.get(0)?,
        path: r.get(1)?,
        face_index: r.get(2)?,
        file_size: r.get(3)?,
        mtime: r.get(4)?,
        family: r.get(5)?,
        subfamily: r.get(6)?,
        full_name: r.get(7)?,
        postscript_name: r.get(8)?,
    })
}

pub fn face_row_by_id(conn: &Connection, id: i64) -> AppResult<Option<FaceRow>> {
    Ok(conn.query_row(&format!("SELECT {ROW_COLUMNS} FROM fonts WHERE fonts.id = ?1"), [id], face_row).optional()?)
}

impl FaceRow {
    pub fn stamp(&self) -> (i64, i64) {
        (self.file_size, self.mtime)
    }

    fn file_stem(&self) -> String {
        Path::new(&self.path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
    }

    /// Runs `f` with this face's names.
    pub fn with_names<T>(&self, f: impl FnOnce(&Names) -> T) -> T {
        let stem = self.file_stem();
        f(&Names {
            family: &self.family,
            subfamily: &self.subfamily,
            full: self.full_name.as_deref().unwrap_or(""),
            postscript: self.postscript_name.as_deref().unwrap_or(""),
            file_stem: &stem,
        })
    }
}

/// Works out a profile, catching a panic from a damaged font so a scan or backfill never stops.
/// A face whose profile fails gets `Profile::fallback` (its names, as before profiles), which
/// is stored like any other, so it isn't tried again at every launch.
pub fn profile_safely(face: &ttf_parser::Face, names: &Names) -> Profile {
    match catch_unwind(AssertUnwindSafe(|| profile::profile(face, names))) {
        Ok(p) => p,
        Err(_) => {
            eprintln!("fontface: couldn't work out a preview profile for {}", names.family);
            Profile::fallback(profile::flags::FAILED)
        }
    }
}

/// Profiles for faces of one file (all rows share the path and stamp), read once.
pub fn profiles_for_file(rows: &[FaceRow]) -> Result<Vec<(i64, Profile)>, Unreadable> {
    let Some(first) = rows.first() else { return Ok(vec![]) };
    let data = read_file(&first.path, Some(first.stamp()))?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let face = ttf_parser::Face::parse(&data, row.face_index).map_err(|e| Unreadable::Broken(e.to_string()))?;
        out.push((row.id, row.with_names(|names| profile_safely(&face, names))));
    }
    Ok(out)
}

/// Groups rows by file (path and stamp), keeping the order they came in.
fn by_file(rows: Vec<FaceRow>) -> Vec<Vec<FaceRow>> {
    let mut groups: Vec<Vec<FaceRow>> = Vec::new();
    let mut index: HashMap<(String, i64, i64), usize> = HashMap::new();
    for row in rows {
        let key = (row.path.clone(), row.file_size, row.mtime);
        match index.get(&key) {
            Some(&i) => groups[i].push(row),
            None => {
                index.insert(key, groups.len());
                groups.push(vec![row]);
            }
        }
    }
    groups
}

// ----------------------------------------------------------------------------- reader threads

/// How many files commands read at once for previews and the character grid: every lane below
/// shares these threads, so no more than this many reads ever run together.
pub const READER_THREADS: usize = 2;

type Job = Box<dyn FnOnce() + Send>;

fn reader_failed() -> AppError {
    AppError::Other("reading font files for previews failed".into())
}

/// Threads that read font files for commands. They fail fast on online-only files (so a read
/// never starts a download) and take jobs in the order they were sent. A job that nobody wants
/// any more by the time a thread takes it is skipped without reading anything (`run_if`).
pub struct Readers {
    tx: Mutex<Option<mpsc::Sender<Job>>>,
}

impl Readers {
    /// Starts `threads` reader threads. They stop once this is dropped and their queue is empty.
    pub fn start(threads: usize, name: &str) -> Readers {
        let (tx, rx) = mpsc::channel::<Job>();
        let rx = Arc::new(Mutex::new(rx));
        let mut started = 0;
        for i in 0..threads {
            let rx = rx.clone();
            let spawned = std::thread::Builder::new().name(format!("{name}-{i}")).spawn(move || {
                cloud::fail_fast_on_this_thread();
                loop {
                    // The queue is locked only while waiting for the next job.
                    let job = match rx.lock() {
                        Ok(rx) => rx.recv(),
                        Err(_) => return,
                    };
                    let Ok(job) = job else { return };
                    // A job that panics drops its answer channel (its caller gets an error);
                    // the thread carries on.
                    let _ = catch_unwind(AssertUnwindSafe(job));
                }
            });
            started += spawned.is_ok() as usize;
        }
        // No thread to run them: callers get an error instead of waiting forever.
        Readers { tx: Mutex::new((started > 0).then_some(tx)) }
    }

    /// Sends `f` to a reader thread now; the future waits for its answer without holding the
    /// calling thread. When a thread takes the job, it's skipped (the answer is `None`, and
    /// nothing is read) if `wanted()` says no, or if nobody waits for the answer any more.
    pub fn run_if<T: Send + 'static>(
        &self,
        wanted: impl FnOnce() -> bool + Send + 'static,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> impl std::future::Future<Output = AppResult<Option<T>>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let job: Job = Box::new(move || {
            if tx.is_closed() || !wanted() {
                let _ = tx.send(None);
                return;
            }
            let _ = tx.send(Some(f()));
        });
        let sent = match self.tx.lock() {
            Ok(guard) => guard.as_ref().is_some_and(|sender| sender.send(job).is_ok()),
            Err(_) => false,
        };
        async move {
            if !sent {
                return Err(reader_failed());
            }
            rx.await.map_err(|_| reader_failed())
        }
    }
}

/// The app's reader threads, started on first use. Commands that read font files run there
/// (through a `Lane`), so a slow disk or a stalled network share never ties up Tauri's async
/// workers (and with them the switches and the list). At most `READER_THREADS` jobs run at
/// once; the rest wait their turn.
fn readers() -> &'static Readers {
    static READERS: OnceLock<Readers> = OnceLock::new();
    READERS.get_or_init(|| Readers::start(READER_THREADS, "fontface-preview-reader"))
}

/// Latest wins: of the jobs sent through one lane, one that hasn't started by the time a newer
/// one is sent is skipped when a reader thread takes it. So holding an arrow key through the
/// list doesn't queue a character grid for every font passed, and a profile call the UI has
/// given up on (`src/previewQueue.ts` sends the next one only after the last settles or times
/// out) doesn't hold up the one it sent instead. A job that has started runs to the end.
pub struct Lane {
    latest: AtomicU64,
}

impl Lane {
    pub const fn new() -> Lane {
        Lane { latest: AtomicU64::new(0) }
    }

    /// Runs `f` on the app's reader threads, unless a newer job is sent through this lane before
    /// it starts: then the answer is `None`.
    pub fn run<T: Send + 'static>(
        &'static self,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> impl std::future::Future<Output = AppResult<Option<T>>> {
        self.run_on(readers(), f)
    }

    /// `run`, on the given threads.
    pub fn run_on<T: Send + 'static>(
        &'static self,
        readers: &Readers,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> impl std::future::Future<Output = AppResult<Option<T>>> {
        let mine = self.latest.fetch_add(1, SeqCst) + 1;
        readers.run_if(move || self.latest.load(SeqCst) == mine, f)
    }
}

/// `preview_profiles` calls.
pub static PROFILE_LANE: Lane = Lane::new();
/// `font_characters` calls.
pub static CHARACTER_LANE: Lane = Lane::new();

// ---------------------------------------------------------------------------------- on demand

/// The answer for one id of `preview_profiles`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnDemand {
    pub id: i64,
    pub preview: Option<PreviewInfo>,
    /// No profile now, but worth asking again later (online-only, or changed since the scan).
    pub retry: bool,
}

impl OnDemand {
    /// The answer for a call skipped before it started (a newer one replaced it): ask again later.
    pub fn skipped(ids: &[i64]) -> Vec<OnDemand> {
        ids.iter().take(MAX_ON_DEMAND).map(|&id| OnDemand { id, preview: None, retry: true }).collect()
    }
}

/// Profiles for the given font ids (at most `MAX_ON_DEMAND`): current stored ones as they are,
/// the rest worked out from their files and saved with `write`. Reads files, so run it on a
/// thread that fails fast on online-only files (`Readers`).
pub fn on_demand(
    conn: impl FnOnce() -> AppResult<Vec<(FaceRow, Option<PreviewInfo>)>>,
    write: impl FnOnce(&[(FaceRow, Profile)]) -> AppResult<()>,
) -> AppResult<Vec<OnDemand>> {
    let rows = conn()?;
    let mut out = Vec::with_capacity(rows.len());
    let mut todo = Vec::new();
    for (row, current) in rows {
        match current {
            Some(preview) => out.push(OnDemand { id: row.id, preview: Some(preview), retry: false }),
            None => todo.push(row),
        }
    }
    if todo.is_empty() {
        return Ok(out);
    }
    let results = by_file(todo).into_iter().map(|rows| (profiles_for_file(&rows), rows));
    let mut fresh = Vec::new();
    for (result, rows) in results {
        match result {
            Ok(profiles) => {
                let mut by_id: HashMap<i64, Profile> = profiles.into_iter().collect();
                for row in rows {
                    let profile = by_id.remove(&row.id);
                    out.push(OnDemand { id: row.id, preview: profile.as_ref().map(PreviewInfo::from_profile), retry: false });
                    if let Some(p) = profile {
                        fresh.push((row, p));
                    }
                }
            }
            Err(why) => {
                let retry = why.retry_later();
                out.extend(rows.iter().map(|row| OnDemand { id: row.id, preview: None, retry }));
            }
        }
    }
    if !fresh.is_empty() {
        write(&fresh)?;
    }
    Ok(out)
}

/// The rows for `ids`, each with its current profile if it has one.
pub fn rows_for_ids(conn: &Connection, ids: &[i64]) -> AppResult<Vec<(FaceRow, Option<PreviewInfo>)>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {ROW_COLUMNS}, {COLUMNS} FROM fonts {} WHERE fonts.id = ?1",
        join_clause()
    ))?;
    let mut out = Vec::new();
    for id in ids.iter().take(MAX_ON_DEMAND) {
        if let Some(row) = stmt.query_row([id], |r| Ok((face_row(r)?, info_from_row(r, 9)?))).optional()? {
            out.push(row);
        }
    }
    Ok(out)
}

// ----------------------------------------------------------------------------------- backfill

/// A batch of new profiles, sent to the UI as the `preview-profiles` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub profiles: Vec<Fresh>,
    /// The last batch: the backfill is finished.
    pub done: bool,
    /// Profiles saved by this run so far. On the last batch, 0 means nothing changed (files
    /// that are missing or online-only are looked at again every launch), so the list doesn't
    /// need reloading.
    pub written: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fresh {
    pub id: i64,
    /// The file version the profile describes, so the UI can match it to its font.
    pub mtime: i64,
    pub file_size: i64,
    pub preview: PreviewInfo,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct BackfillReport {
    pub files: usize,
    pub written: usize,
    /// Online-only files, left for later.
    pub cloud: usize,
    /// Missing, too large, changed since the scan, or unreadable.
    pub other: usize,
    pub orphans_removed: usize,
}

const COMMIT_EVERY: Duration = Duration::from_millis(400);

/// Faces without a current profile, grouped by file. Creative Cloud's files and files over
/// 96 MB (as last scanned) are left out.
pub fn stale_files(conn: &Connection) -> AppResult<Vec<Vec<FaceRow>>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ROW_COLUMNS} FROM fonts {} WHERE p.font_id IS NULL ORDER BY fonts.path, fonts.face_index",
        join_clause()
    ))?;
    let rows = stmt
        .query_map([], face_row)?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|r| !never_read(&r.path) && r.file_size as u64 <= crate::protocol::MAX_PREVIEW_BYTES)
        .collect();
    Ok(by_file(rows))
}

/// Waits for a UI write to finish, then takes the scan write turn: the order every background
/// writer follows, so a click never waits behind it.
fn write_turn() -> db::ScanWriteTurn {
    while db::ui_write_waiting() {
        std::thread::sleep(Duration::from_millis(2));
    }
    db::scan_write_turn()
}

/// The backfill's connection, inside a write transaction or not. A transaction holds the scan
/// write turn from BEGIN until its COMMIT or ROLLBACK has run, never longer: the turn is
/// released only after the transaction has ended, on success and on error alike. Transactions
/// are opened only to save what's already been read (`save_read`), never left open while
/// waiting for the readers.
struct Writer {
    conn: Connection,
    turn: Option<db::ScanWriteTurn>,
}

impl Writer {
    fn begin(&mut self) -> AppResult<()> {
        if self.turn.is_none() {
            let turn = write_turn();
            // IMMEDIATE: if a UI write took the write lock since `write_turn` checked the gate,
            // wait for it here rather than fail at the first write.
            self.conn.execute_batch("BEGIN IMMEDIATE")?;
            self.turn = Some(turn);
        }
        Ok(())
    }

    #[cfg(test)]
    fn in_transaction(&self) -> bool {
        self.turn.is_some()
    }

    fn commit(&mut self) -> AppResult<()> {
        if self.turn.is_some() {
            let committed = self.conn.execute_batch("COMMIT");
            if committed.is_err() {
                let _ = self.conn.execute_batch("ROLLBACK");
            }
            self.turn = None;
            committed?;
        }
        Ok(())
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        // Left mid-transaction by an error: roll back before the turn goes (with the fields).
        if self.turn.is_some() {
            let _ = self.conn.execute_batch("ROLLBACK");
        }
    }
}

/// Profiles worked out for one file, waiting to be saved: the file version they describe, and
/// each face's profile.
type FileProfiles = ((i64, i64), Vec<(i64, Profile)>);

/// Works out the missing profiles once, at launch: `threads` readers (failing fast on
/// online-only files, which are skipped), one writer saving what they've read about every
/// 400 ms through the scan write turn. No transaction stays open while it waits for the
/// readers, and a save steps aside for UI writes like the scanner does, so a click never finds
/// the database locked. `emit` gets each saved batch, then a final one with `done` set. Also
/// removes orphaned rows.
pub fn backfill(db_path: &Path, threads: usize, emit: impl FnMut(Batch)) -> AppResult<BackfillReport> {
    backfill_with(db_path, threads, profiles_for_file, emit)
}

/// `backfill`, reading each file's rows with `read` (tests pass their own).
fn backfill_with(
    db_path: &Path,
    threads: usize,
    read: impl Fn(&[FaceRow]) -> Result<Vec<(i64, Profile)>, Unreadable> + Send + Sync + 'static,
    mut emit: impl FnMut(Batch),
) -> AppResult<BackfillReport> {
    let conn = db::open(db_path)?;
    ensure_schema(&conn)?;
    let mut report = BackfillReport::default();
    {
        let _turn = write_turn();
        report.orphans_removed = conn.execute("DELETE FROM face_previews WHERE font_id NOT IN (SELECT id FROM fonts)", [])?;
    }
    let jobs = Arc::new(stale_files(&conn)?);
    let mut writer = Writer { conn, turn: None };
    report.files = jobs.len();
    if jobs.is_empty() {
        return Ok(report);
    }
    let next = Arc::new(AtomicUsize::new(0));
    let read = Arc::new(read);
    let (tx, rx) = mpsc::channel::<(usize, Result<Vec<(i64, Profile)>, Unreadable>)>();
    for _ in 0..threads.clamp(1, jobs.len()) {
        let (jobs, next, tx, read) = (jobs.clone(), next.clone(), tx.clone(), read.clone());
        std::thread::spawn(move || {
            cloud::fail_fast_on_this_thread();
            loop {
                let i = next.fetch_add(1, Relaxed);
                let Some(rows) = jobs.get(i) else { break };
                if tx.send((i, read(rows))).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);

    // Read, not saved yet. Kept in memory between saves, so SQLite's write lock is free while
    // the readers work.
    let mut ready: Vec<FileProfiles> = Vec::new();
    let mut last_save = Instant::now();
    loop {
        let finished = match rx.recv_timeout(Duration::from_millis(250)) {
            Ok((i, Ok(profiles))) => {
                ready.push((jobs[i][0].stamp(), profiles));
                false
            }
            Ok((_, Err(Unreadable::Cloud))) => {
                report.cloud += 1;
                false
            }
            Ok((_, Err(_))) => {
                report.other += 1;
                false
            }
            Err(RecvTimeoutError::Timeout) => false,
            Err(RecvTimeoutError::Disconnected) => true,
        };
        if !ready.is_empty() && (finished || last_save.elapsed() >= COMMIT_EVERY) {
            let saved = save_read(&mut writer, std::mem::take(&mut ready))?;
            report.written += saved.len();
            if !saved.is_empty() {
                emit(Batch { profiles: saved, done: false, written: report.written });
            }
            last_save = Instant::now();
        }
        if finished {
            break;
        }
    }
    emit(Batch { profiles: vec![], done: true, written: report.written });
    Ok(report)
}

/// Saves what the readers have read, file by file. When a UI write or a scan is waiting, it
/// commits after the current file and lets them go first (`Writer::begin` waits for them).
/// Returns what was saved, all of it committed.
fn save_read(writer: &mut Writer, ready: Vec<FileProfiles>) -> AppResult<Vec<Fresh>> {
    let mut saved = Vec::new();
    for ((file_size, mtime), profiles) in ready {
        writer.begin()?;
        for (id, p) in profiles {
            if store(&writer.conn, id, file_size, mtime, &p)? {
                saved.push(Fresh { id, file_size, mtime, preview: PreviewInfo::from_profile(&p) });
            }
        }
        if db::ui_write_waiting() || db::scan_writer_waiting() {
            writer.commit()?;
        }
    }
    writer.commit()?;
    Ok(saved)
}
