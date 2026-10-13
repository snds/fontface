//! Purchases: notices font downloads, works out which store they came from, and imports them.
//!
//! Most font stores have no API, so instead of signing in anywhere Fontface watches folders the
//! user chooses (Downloads by default). Each item directly inside a watched folder counts as one
//! download: a font file, a zip, or a folder (Safari and Archive Utility unzip downloads into a
//! folder). Fontface reads where it came from (macOS records the page and file URL with every
//! download), matches that to a store, and, once the user says so, copies just the desktop font
//! files and their license files into `<app data>/Services/Purchases/<Store>/<Family>/`. The
//! original download is left where it is.
//!
//! License guardrails: copying the user's own downloads into a library on the same computer is a
//! normal install. License files travel with the fonts. Web, app and ePub font files are left
//! out (a desktop license doesn't cover them, and vice versa). Nothing is ever uploaded or synced.
//! Fonts tied to a subscription, and anything that looks like a trial, are flagged.

use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex, MutexGuard,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{adobe::is_adobe_path, service_dir};
use crate::{
    activation::{self, Scope, TurnedOff},
    cloud,
    error::{AppError, AppResult},
    scanner,
};

const SIDECAR: &str = ".fontface-purchase.json";
/// Largest single font file read from a download.
const MAX_FONT_BYTES: u64 = 64 * 1024 * 1024;
/// Most data read out of one archive (guards against zip bombs).
const MAX_ARCHIVE_READ: u64 = 768 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 20_000;
/// Most files looked at inside one downloaded folder.
const MAX_FOLDER_ENTRIES: usize = 20_000;
const FOLDER_DEPTH: usize = 6;
/// Most font files read out of one downloaded folder (a whole font collection isn't a "download").
const MAX_FOLDER_FONTS: usize = 2_000;
/// Folder names that are apps or bundles, never font downloads.
const BUNDLE_SUFFIXES: &[&str] = &[".app", ".framework", ".bundle", ".plugin", ".kext", ".photoslibrary", ".git"];
/// Longest file or folder name Fontface writes (well under the 255-byte limit).
const MAX_NAME_CHARS: usize = 120;
/// Browsers' in-progress download names: never inspected.
const PARTIAL_SUFFIXES: &[&str] = &[".crdownload", ".download", ".part", ".partial", ".tmp"];
/// Folder names inside downloads that hold web, app or ebook fonts, not desktop fonts.
const NON_DESKTOP_FOLDERS: &[&str] = &["web", "webfont", "webfonts", "webkit", "kit", "embed", "epub", "app", "apps", "mobile", "woff", "woff2"];
/// How long after import a purchase that may be a trial gets a reminder.
pub const TRIAL_REMINDER_SECS: i64 = 30 * 24 * 60 * 60;

// ------------------------------------------------------------------------------------ stores

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    pub id: &'static str,
    pub name: &'static str,
    #[serde(skip)]
    domains: &'static [&'static str],
    /// Fonts from this store must be removed when the subscription ends.
    pub subscription_bound: bool,
    /// Downloads here may be trials, not licensed for commercial use.
    pub may_be_trial: bool,
}

const fn store(id: &'static str, name: &'static str, domains: &'static [&'static str]) -> Store {
    Store { id, name, domains, subscription_bound: false, may_be_trial: false }
}

/// Known stores and foundries, matched by the download's web address.
pub const STORES: &[Store] = &[
    store("myfonts", "MyFonts", &["myfonts.com", "myfonts.net"]),
    store("fontspring", "Fontspring", &["fontspring.com"]),
    store("fontsquirrel", "Font Squirrel", &["fontsquirrel.com"]),
    store("typenetwork", "Type Network", &["typenetwork.com"]),
    store("futurefonts", "Future Fonts", &["futurefonts.xyz", "futurefonts.com"]),
    Store { may_be_trial: true, ..store("fontstore", "Fontstore", &["fontstore.com"]) },
    store("ilt", "I Love Typography", &["ilovetypography.com"]),
    Store { subscription_bound: true, ..store("envato-elements", "Envato Elements", &["elements.envato.com"]) },
    store("envato-market", "Envato Market", &["graphicriver.net", "themeforest.net", "market.envato.com"]),
    store("creative-market", "Creative Market", &["creativemarket.com"]),
    store("fontshare", "Fontshare", &["fontshare.com"]),
    store("monotype", "Monotype", &["fonts.com", "monotypefonts.com", "monotype.com"]),
    store("google-fonts", "Google Fonts (download)", &["fonts.google.com", "fonts.gstatic.com"]),
    store("type-together", "TypeTogether", &["type-together.com"]),
    store("commercial-type", "Commercial Type", &["commercialtype.com"]),
    store("klim", "Klim Type Foundry", &["klim.co.nz"]),
    store("grilli", "Grilli Type", &["grillitype.com"]),
    store("pangram", "Pangram Pangram", &["pangrampangram.com"]),
    store("dinamo", "Dinamo", &["abcdinamo.com"]),
    store("colophon", "Colophon", &["colophon-foundry.org"]),
    store("hoefler", "Hoefler&Co.", &["typography.com"]),
    store("production-type", "Production Type", &["productiontype.com"]),
    store("displaay", "Displaay", &["displaay.net"]),
    store("velvetyne", "Velvetyne", &["velvetyne.fr"]),
    store("github", "GitHub", &["github.com", "githubusercontent.com"]),
];

pub const OTHER: &str = "other";

fn host(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1)?;
    let host = rest.split(['/', '?', '#']).next()?.rsplit('@').next()?.split(':').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// The store a download came from, by matching the file URL, then the page it was linked from.
pub fn store_for(urls: &[String]) -> Option<&'static Store> {
    urls.iter().filter_map(|u| host(u)).find_map(|h| {
        STORES.iter().find(|s| s.domains.iter().any(|d| h == *d || h.ends_with(&format!(".{d}"))))
    })
}

pub fn store_by_id(id: &str) -> Option<&'static Store> {
    STORES.iter().find(|s| s.id == id)
}

fn store_name(id: &str) -> String {
    store_by_id(id).map(|s| s.name.to_string()).unwrap_or_else(|| "Other".into())
}

// ------------------------------------------------------------------------------------ origin

/// Where a downloaded file came from: [file URL, page URL], as the OS recorded them.
#[cfg(target_os = "macos")]
fn origin_of(path: &Path) -> Vec<String> {
    xattr::get(path, "com.apple.metadata:kMDItemWhereFroms")
        .ok()
        .flatten()
        .and_then(|bytes| plist::from_bytes::<Vec<String>>(&bytes).ok())
        .unwrap_or_default()
}

/// Windows records a download's origin in the file's Zone.Identifier stream.
#[cfg(target_os = "windows")]
fn origin_of(path: &Path) -> Vec<String> {
    let stream = format!("{}:Zone.Identifier", path.display());
    let text = std::fs::read_to_string(stream).unwrap_or_default();
    ["HostUrl=", "ReferrerUrl="]
        .iter()
        .filter_map(|key| text.lines().find_map(|l| l.trim().strip_prefix(key)).map(str::to_string))
        .collect()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn origin_of(_: &Path) -> Vec<String> {
    Vec::new()
}

/// A download's origin. For a folder (an unzipped download), the first file inside that has one.
pub fn origin(path: &Path) -> Vec<String> {
    let own = origin_of(path);
    if !own.is_empty() || !path.is_dir() {
        return own;
    }
    walkdir::WalkDir::new(path)
        .max_depth(FOLDER_DEPTH)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .take(200)
        .map(|e| origin_of(e.path()))
        .find(|o| !o.is_empty())
        .unwrap_or_default()
}

/// The store id a picked file or folder came from, if it can be told.
pub fn detect_store(path: &Path) -> Option<&'static str> {
    store_for(&origin(path)).map(|s| s.id)
}

// ------------------------------------------------------------------------------ classifying

pub fn is_license_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let stem_ok = ["licens", "licenc", "lizenz", "eula", "ofl", "terms", "copying"].iter().any(|k| lower.contains(k));
    let ext_ok = match lower.rsplit_once('.') {
        None => true,
        Some((_, ext)) => ["txt", "md", "pdf", "html", "htm", "rtf", "doc", "docx", "odt", "pages"].contains(&ext),
    };
    stem_ok && ext_ok
}

fn is_archive(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("zip"))
}

fn is_partial(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    PARTIAL_SUFFIXES.iter().any(|s| lower.ends_with(s))
}

/// A file worth looking at: a font file or a zip, not hidden, not still downloading.
pub fn is_candidate_file(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    !name.starts_with('.') && !is_partial(name) && (scanner::is_font_file(path) || is_archive(path))
}

/// True if a font's folder inside the download says it's for the web, an app or an ebook.
fn non_desktop(rel: &str) -> bool {
    let parts: Vec<&str> = rel.split(['/', '\\']).collect();
    parts[..parts.len().saturating_sub(1)].iter().any(|p| {
        let p = p.to_ascii_lowercase();
        NON_DESKTOP_FOLDERS.iter().any(|w| p == *w || p.split([' ', '-', '_']).any(|t| t == *w))
    })
}

/// Words that mark trial or demo fonts (whole words, so "Contest" doesn't count).
fn looks_like_trial(texts: &[&str]) -> bool {
    texts.iter().any(|t| {
        let lower = t.to_ascii_lowercase();
        let words: Vec<&str> = lower.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).collect();
        words.iter().any(|w| ["trial", "trials", "demo", "test", "testfont", "testfonts"].contains(w))
            || words.windows(2).any(|p| p == ["personal", "use"])
    })
}

// ---------------------------------------------------------------------------------- inspecting

/// What a download holds.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contents {
    /// Desktop font files that will be imported (paths inside the download).
    pub fonts: Vec<String>,
    pub families: Vec<String>,
    pub licenses: Vec<String>,
    /// Font files left out: web/app/ebook files, and second formats of a font (TTF when the
    /// same font is also there as OTF).
    #[serde(default)]
    pub skipped_fonts: Vec<String>,
    /// Names or addresses suggest trial or demo fonts.
    #[serde(default)]
    pub trial: bool,
    /// Too many fonts to treat as one download (e.g. a whole font collection); import it by hand.
    #[serde(default)]
    pub too_large: bool,
    /// Font files that couldn't be read or aren't valid fonts (shown, never silently dropped).
    #[serde(default)]
    pub unreadable: Vec<String>,
    /// A fingerprint of each file in `fonts` (same order), to recognise the same fonts wherever
    /// they turn up again.
    #[serde(default)]
    pub prints: Vec<String>,
    /// The faces in `fonts`: PostScript name + variable/static + slant.
    #[serde(default)]
    pub faces: Vec<String>,
}

/// True for app or bundle folders, which are never font downloads.
fn is_bundle(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    BUNDLE_SUFFIXES.iter().any(|s| name.ends_with(s))
}

/// The regular files inside a downloaded folder that matter: no hidden files (like Finder's
/// .DS_Store), no in-progress downloads, no bundles, no symlinks, nothing from Adobe's store.
fn visible_files(path: &Path) -> impl Iterator<Item = walkdir::DirEntry> {
    walkdir::WalkDir::new(path)
        .max_depth(FOLDER_DEPTH)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let n = e.file_name().to_string_lossy();
            e.depth() == 0 || (!n.starts_with('.') && !is_partial(&n) && !is_adobe_path(e.path()) && !is_bundle(e.path()))
        })
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .take(MAX_FOLDER_ENTRIES)
}

/// A font file found in a download, before deciding whether to import it.
struct Candidate {
    rel: String,
    families: Vec<String>,
    /// One key per face: PostScript name + variable/static + slant (as the library groups fonts).
    keys: Vec<String>,
    cff: bool,
    print: String,
}

/// A stable fingerprint of a file's bytes: its length and a 64-bit hash (FxHash-style mixing,
/// eight bytes at a time). For recognising files again, not for security.
pub(crate) fn fingerprint(bytes: &[u8]) -> String {
    const K: u64 = 0x517c_c1b7_2722_0a95;
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut words = bytes.chunks_exact(8);
    for w in &mut words {
        h = (h.rotate_left(5) ^ u64::from_le_bytes(w.try_into().unwrap_or_default())).wrapping_mul(K);
    }
    for &b in words.remainder() {
        h = (h.rotate_left(5) ^ u64::from(b)).wrapping_mul(K);
    }
    h ^= h >> 33;
    h = h.wrapping_mul(0xff51_afd7_ed55_8ccd);
    h ^= h >> 33;
    format!("{h:016x}-{}", bytes.len())
}

fn candidate(rel: String, bytes: &[u8]) -> Option<Candidate> {
    let faces = scanner::parse_file(bytes).ok()?;
    let visible: Vec<_> = faces.into_iter().filter(|f| !f.family.starts_with('.')).collect();
    if visible.is_empty() {
        return None;
    }
    let mut keys: Vec<String> = visible
        .iter()
        .filter_map(|f| f.postscript_name.as_ref().map(|ps| format!("{ps}|{}|{}", f.variable, f.italic)))
        .collect();
    keys.sort();
    Some(Candidate {
        rel,
        cff: visible.iter().all(|f| f.format.starts_with("OpenType CFF")),
        families: visible.iter().map(|f| f.family.clone()).collect(),
        keys,
        print: fingerprint(bytes),
    })
}

/// The PostScript name inside a face key.
fn key_postscript(key: &str) -> &str {
    key.rsplitn(3, '|').last().unwrap_or(key)
}

/// Reads a regular file of at most `max` bytes (never a symlink, pipe or device).
fn read_capped(path: &Path, max: u64) -> Option<Vec<u8>> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() || meta.len() > max || cloud::is_dataless(&meta) {
        return None;
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path).ok()?.take(max + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= max).then_some(bytes)
}

/// Usable entries of a zip, skipping macOS metadata and anything that would escape on extraction.
fn archive_entry_name(entry: &zip::read::ZipFile) -> Option<String> {
    if entry.is_dir() || entry.is_symlink() {
        return None;
    }
    let path = entry.enclosed_name()?;
    let s = path.to_string_lossy().replace('\\', "/");
    let base = path.file_name()?.to_string_lossy().into_owned();
    (!s.starts_with("__MACOSX/") && !s.contains("/__MACOSX/") && !base.starts_with('.')).then_some(s)
}

/// Reads one zip entry. Its declared size is the hard limit: an entry that inflates past what
/// it declares is refused, so the archive budget really bounds what's read.
fn read_entry(entry: &mut zip::read::ZipFile, budget: &mut u64) -> Option<Vec<u8>> {
    let want = entry.size();
    if want > MAX_FONT_BYTES || want > *budget || *budget == 0 {
        return None;
    }
    let mut bytes = Vec::with_capacity(want as usize);
    entry.take(want + 1).read_to_end(&mut bytes).ok()?;
    *budget = budget.saturating_sub(bytes.len() as u64);
    (bytes.len() as u64 == want).then_some(bytes)
}

/// Looks inside a font file, zip or folder. Returns `None` when there's nothing to judge yet:
/// a symlink or special file, Adobe's font store, or files still online-only in cloud storage.
pub fn inspect(path: &Path) -> AppResult<Option<Contents>> {
    let meta = std::fs::symlink_metadata(path)?;
    let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if is_adobe_path(path) || is_adobe_path(&real) || !(meta.is_file() || meta.is_dir()) {
        return Ok(None);
    }
    let mut found: Vec<Candidate> = Vec::new();
    let mut licenses = Vec::new();
    let mut contents_too_large = false;
    let mut unreadable = Vec::new();
    let mut names = vec![path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()];

    if meta.is_dir() {
        if is_bundle(path) {
            return Ok(None);
        }
        let mut budget = MAX_ARCHIVE_READ;
        let mut font_files = 0;
        for entry in visible_files(path) {
            let p = entry.path();
            let rel = p.strip_prefix(path).unwrap_or(p).to_string_lossy().into_owned();
            let Ok(m) = entry.metadata() else { continue };
            if scanner::is_font_file(p) {
                font_files += 1;
                if font_files > MAX_FOLDER_FONTS || budget == 0 {
                    contents_too_large = true;
                    break;
                }
                if cloud::is_dataless(&m) {
                    if non_desktop(&rel) {
                        continue; // left out anyway
                    }
                    return Ok(None); // a desktop font is still downloading from cloud storage: look again later
                }
                let cap = MAX_FONT_BYTES.min(budget);
                match read_capped(p, cap) {
                    Some(bytes) => {
                        budget = budget.saturating_sub(bytes.len() as u64);
                        match candidate(rel.clone(), &bytes) {
                            Some(c) => found.push(c),
                            None => unreadable.push(rel),
                        }
                    }
                    None if m.len() <= cap => unreadable.push(rel),
                    None => contents_too_large = true,
                }
            } else if is_license_name(&entry.file_name().to_string_lossy()) {
                licenses.push(rel);
            }
        }
    } else if cloud::is_dataless(&meta) {
        return Ok(None);
    } else if is_archive(path) {
        let mut archive = zip::ZipArchive::new(std::fs::File::open(path)?)
            .map_err(|e| AppError::Invalid(format!("Not a readable zip: {e}")))?;
        let mut budget = MAX_ARCHIVE_READ;
        for i in 0..archive.len().min(MAX_ARCHIVE_ENTRIES) {
            let Ok(mut entry) = archive.by_index(i) else { continue };
            let Some(name) = archive_entry_name(&entry) else { continue };
            let base = name.rsplit('/').next().unwrap_or(&name).to_string();
            if scanner::is_font_file(Path::new(&base)) {
                if let Some(bytes) = read_entry(&mut entry, &mut budget) {
                    match candidate(name.clone(), &bytes) {
                        Some(c) => found.push(c),
                        None => unreadable.push(name),
                    }
                }
            } else if is_license_name(&base) {
                licenses.push(name);
            }
        }
    } else if scanner::is_font_file(path) {
        match read_capped(path, MAX_FONT_BYTES).and_then(|b| candidate(names[0].clone(), &b)) {
            Some(c) => found.push(c),
            None if meta.len() <= MAX_FONT_BYTES => unreadable.push(names[0].clone()),
            None => {}
        }
    }

    // Choose what to import: desktop files only, and when the same font is there as both OTF
    // and TTF, the OTF. (Same font = same faces: PostScript name, variable or static, slant.)
    let mut contents = Contents { licenses, too_large: contents_too_large, unreadable, ..Default::default() };
    let mut best: HashMap<String, usize> = HashMap::new();
    let mut desktop: Vec<usize> = Vec::new();
    for (i, c) in found.iter().enumerate() {
        if non_desktop(&c.rel) {
            contents.skipped_fonts.push(c.rel.clone());
            continue;
        }
        if c.keys.is_empty() {
            desktop.push(i);
            continue;
        }
        let key = c.keys.join("\n");
        match best.get(&key) {
            // Same font in the same format: two real copies (e.g. two folders); keep both.
            Some(&j) if found[j].cff == c.cff => desktop.push(i),
            Some(&j) if found[j].cff => contents.skipped_fonts.push(c.rel.clone()),
            Some(&j) => {
                contents.skipped_fonts.push(found[j].rel.clone());
                best.insert(key, i);
            }
            None => {
                best.insert(key, i);
            }
        }
    }
    desktop.extend(best.values().copied());
    desktop.sort_unstable();
    for i in desktop {
        let c = &found[i];
        contents.fonts.push(c.rel.clone());
        contents.prints.push(c.print.clone());
        contents.faces.extend(c.keys.iter().cloned());
        for f in &c.families {
            if !contents.families.contains(f) {
                contents.families.push(f.clone());
            }
        }
    }
    contents.faces.sort();
    contents.faces.dedup();
    if contents.too_large {
        contents.fonts.clear();
        contents.prints.clear();
        contents.faces.clear();
    }
    names.extend(contents.fonts.iter().cloned());
    names.extend(contents.families.iter().cloned());
    contents.trial = looks_like_trial(&names.iter().map(String::as_str).collect::<Vec<_>>());
    Ok(Some(contents))
}

// ---------------------------------------------------------------------------------- storage

/// Creates the purchase tables if needed. Idempotent, and independent of the main schema
/// version, so it merges cleanly with other features that add tables.
pub fn ensure_schema(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS purchase_watch (
             path      TEXT PRIMARY KEY,
             added_at  INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS purchase_settings (
             key    TEXT PRIMARY KEY,
             value  TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS purchase_finds (
             id            INTEGER PRIMARY KEY AUTOINCREMENT,
             path          TEXT NOT NULL UNIQUE,
             file_size     INTEGER NOT NULL,
             mtime         INTEGER NOT NULL,
             store         TEXT,
             origin_url    TEXT,
             referrer      TEXT,
             contents      TEXT NOT NULL DEFAULT '{}',
             status        TEXT NOT NULL DEFAULT 'new',
             found_at      INTEGER NOT NULL,
             imported_dir  TEXT
         );",
    )?;
    let has_file_id: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('purchase_finds') WHERE name = 'file_id'",
        [],
        |r| r.get::<_, i64>(0).map(|n| n > 0),
    )?;
    if !has_file_id {
        conn.execute_batch("ALTER TABLE purchase_finds ADD COLUMN file_id TEXT;")?;
    }
    Ok(())
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn nanos(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as i64).unwrap_or(0)
}

/// (size, newest modified time in ns) of a file, or of everything inside a folder. Changes
/// whenever anything in the download changes, so an unchanged download isn't looked at again.
pub fn signature(path: &Path) -> Option<(i64, i64)> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if meta.is_file() {
        return Some((meta.len() as i64, nanos(meta.modified().ok()?)));
    }
    if !meta.is_dir() {
        return None;
    }
    // Only the files that matter, so Finder writing .DS_Store doesn't make a download "change".
    let (mut size, mut newest, mut count) = (0i64, 0i64, 0i64);
    for entry in visible_files(path) {
        if let Ok(m) = entry.metadata() {
            size += m.len() as i64;
            count += 1;
            if let Ok(t) = m.modified() {
                newest = newest.max(nanos(t));
            }
        }
    }
    // Fold the file count in, so adding or removing a file always changes the stamp.
    Some((size, newest ^ count))
}

/// The file system's identity for a path (survives renames and moves on the same disk).
#[cfg(unix)]
fn file_id(path: &Path) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::symlink_metadata(path).ok()?;
    Some(format!("{}:{}", m.dev(), m.ino()))
}

#[cfg(not(unix))]
fn file_id(_: &Path) -> Option<String> {
    None
}

pub fn watching(conn: &Connection) -> bool {
    conn.query_row("SELECT value FROM purchase_settings WHERE key = 'watching'", [], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
        .is_some_and(|v| v == "1")
}

pub fn set_watching(conn: &Connection, on: bool) -> AppResult<()> {
    conn.execute(
        "INSERT INTO purchase_settings (key, value) VALUES ('watching', ?1)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [if on { "1" } else { "0" }],
    )?;
    Ok(())
}

pub fn watch_folders(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT path FROM purchase_watch ORDER BY path COLLATE NOCASE")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Checks a folder can be watched. Returns the canonical path to store.
pub fn validate_watch_folder(path: &Path) -> AppResult<String> {
    let real = std::fs::canonicalize(path)?;
    if !real.is_dir() {
        return Err(AppError::Invalid(format!("{} is not a folder", path.display())));
    }
    if is_adobe_path(&real) {
        return Err(AppError::Invalid("That folder holds Adobe Fonts synced by Creative Cloud".into()));
    }
    Ok(real.to_string_lossy().into_owned())
}

pub fn add_watch_folder(conn: &Connection, path: &str) -> AppResult<()> {
    conn.execute("INSERT OR IGNORE INTO purchase_watch (path, added_at) VALUES (?1, ?2)", params![path, now()])?;
    Ok(())
}

pub fn remove_watch_folder(conn: &Connection, path: &str) -> AppResult<()> {
    conn.execute("DELETE FROM purchase_watch WHERE path = ?1", [path])?;
    Ok(())
}

/// Why a watched folder can't be read right now, in plain words, if it can't.
pub fn folder_problem(path: &str) -> Option<String> {
    match std::fs::read_dir(path) {
        Ok(_) => None,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some("Folder not found. Is the drive connected?".into()),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Some(
            "Fontface isn't allowed to read this folder. Allow it in System Settings → Privacy & Security → Files and Folders.".into(),
        ),
        Err(e) => Some(e.to_string()),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Find {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub is_folder: bool,
    pub store: Option<String>,
    pub store_name: Option<String>,
    pub origin_url: Option<String>,
    pub referrer: Option<String>,
    pub contents: Contents,
    pub status: String,
    pub found_at: i64,
    pub imported_dir: Option<String>,
    /// The original download no longer exists.
    pub missing: bool,
    /// An imported purchase this looks like a newer version of (see `link_replacements`).
    pub replaces: Option<String>,
}

pub fn finds(conn: &Connection) -> AppResult<Vec<Find>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, store, origin_url, referrer, contents, status, found_at, imported_dir FROM purchase_finds
         WHERE status IN ('new', 'imported') ORDER BY found_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        let path: String = r.get(1)?;
        let store: Option<String> = r.get(2)?;
        let contents: String = r.get(5)?;
        let p = Path::new(&path);
        Ok(Find {
            id: r.get(0)?,
            name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            is_folder: p.is_dir(),
            missing: !p.exists(),
            store_name: store.as_deref().map(store_name),
            store,
            origin_url: r.get(3)?,
            referrer: r.get(4)?,
            contents: serde_json::from_str(&contents).unwrap_or_default(),
            status: r.get(6)?,
            found_at: r.get(7)?,
            imported_dir: r.get(8)?,
            replaces: None,
            path,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The item directly inside a watched folder that `path` belongs to: the path itself if it sits
/// at the top level, or its top-level folder (an unzipped download). Hidden or still-downloading
/// items give `None`.
pub fn unit_for(roots: &[PathBuf], path: &Path) -> Option<PathBuf> {
    let root = roots.iter().find(|r| path.starts_with(r) && path != r.as_path())?;
    let mut parts = path.strip_prefix(root).ok()?.components();
    let first = parts.next()?.as_os_str().to_string_lossy().into_owned();
    if first.starts_with('.') || is_partial(&first) {
        return None;
    }
    // Hidden or partial names deeper down (temporary files of an unzip in progress) are noise.
    if parts.any(|c| {
        let n = c.as_os_str().to_string_lossy();
        n.starts_with('.') || is_partial(&n)
    }) {
        return None;
    }
    Some(root.join(first))
}

/// Records a download if it's new or changed. Returns its id if it holds fonts and is newly
/// offered. A recorded download that was only moved or renamed keeps its state, quietly, and so
/// does one whose fonts Fontface already has (e.g. an imported folder moved into a subfolder).
pub fn record(conn: &Connection, data_dir: &Path, path: &Path) -> AppResult<Option<i64>> {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return Ok(None) };
    let kind_ok = (meta.is_file() && is_candidate_file(path)) || (meta.is_dir() && !is_bundle(path));
    if !kind_ok || is_adobe_path(path) {
        return Ok(None);
    }
    // "Family/" next to "Family.zip" is the zip opened by Finder: the same download, counted once.
    if meta.is_dir() {
        if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
            if parent.join(format!("{}.zip", name.to_string_lossy())).is_file() {
                return Ok(None);
            }
        }
    }
    let Some((size, mtime)) = signature(path) else { return Ok(None) };
    let key = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()).to_string_lossy().into_owned();
    let unchanged = |conn: &Connection| -> AppResult<bool> {
        Ok(conn
            .query_row("SELECT file_size, mtime FROM purchase_finds WHERE path = ?1", [&key], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?
            .is_some_and(|stamp: (i64, i64)| stamp == (size, mtime)))
    };
    if unchanged(conn)? {
        return Ok(None);
    }
    let id = file_id(path);

    // Moved or renamed? Same file identity, old path gone, same contents stamp: keep the row
    // (and whether it was imported or dismissed). The stamp check stops a new download that got
    // a reused file number (some drives reuse them) from adopting an old row.
    if let Some(fid) = &id {
        let moved: Option<(i64, String, i64, i64)> = conn
            .query_row(
                "SELECT id, path, file_size, mtime FROM purchase_finds WHERE file_id = ?1 AND path != ?2",
                params![fid, key],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        if let Some((row, _, _, _)) = moved.filter(|(_, old, s, m)| !Path::new(old).exists() && (*s, *m) == (size, mtime)) {
            let _turn = crate::db::scan_write_turn();
            let tx = conn.unchecked_transaction()?;
            // A row already at the new path belonged to a file that has since been replaced.
            tx.execute("DELETE FROM purchase_finds WHERE path = ?1 AND id != ?2", params![key, row])?;
            tx.execute("UPDATE purchase_finds SET path = ?2 WHERE id = ?1", params![row, key])?;
            tx.commit()?;
            return Ok(None);
        }
    }

    let Some(contents) = inspect(path)? else { return Ok(None) };
    let urls = origin(path);
    let store = store_for(&urls).map(|s| s.id.to_string());
    let mut status = if contents.fonts.is_empty() { "empty" } else { "new" };
    let mut imported_dir = None;
    if status == "new" {
        if let Some((known, dir)) = already_handled(conn, data_dir, &key, &contents)? {
            status = known;
            imported_dir = dir;
        }
    }

    let _turn = crate::db::scan_write_turn(); // take turns with scan writers
    if unchanged(conn)? {
        return Ok(None); // recorded by a concurrent check meanwhile
    }
    // Already imported, dismissed or transferred, and the fonts are the same: just refresh the stamp.
    let previous: Option<(String, String)> = conn
        .query_row("SELECT status, contents FROM purchase_finds WHERE path = ?1", [&key], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    if let Some((old_status, old_contents)) = &previous {
        let same_fonts = serde_json::from_str::<Contents>(old_contents).is_ok_and(|c| c.fonts == contents.fonts);
        if same_fonts {
            status = match old_status.as_str() {
                "imported" => "imported",
                "dismissed" => "dismissed",
                "transferred" => "transferred",
                _ => status,
            };
        }
    }
    conn.execute(
        "INSERT INTO purchase_finds (path, file_size, mtime, store, origin_url, referrer, contents, status, found_at, file_id, imported_dir)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT (path) DO UPDATE SET file_size = excluded.file_size, mtime = excluded.mtime,
            store = excluded.store, origin_url = excluded.origin_url, referrer = excluded.referrer,
            contents = excluded.contents, status = excluded.status, found_at = excluded.found_at,
            file_id = excluded.file_id, imported_dir = COALESCE(excluded.imported_dir, purchase_finds.imported_dir)",
        params![
            key,
            size,
            mtime,
            store,
            urls.first(),
            urls.get(1),
            serde_json::to_string(&contents).unwrap_or_default(),
            status,
            now(),
            id,
            imported_dir
        ],
    )?;
    if status != "new" {
        return Ok(None);
    }
    Ok(Some(conn.query_row("SELECT id FROM purchase_finds WHERE path = ?1", [&key], |r| r.get(0))?))
}

/// Whether every font in a download is one Fontface has already dealt with, judged by the files'
/// fingerprints, so the same fonts aren't offered twice wherever they turn up:
/// - in an imported purchase, or imported before → ("imported", the purchase folder holding them);
/// - in a download that was transferred, or dismissed and has since moved → ("dismissed", None).
///
/// A dismissed download that's still where it was doesn't count: downloading the same fonts
/// again on purpose offers them again.
fn already_handled(
    conn: &Connection,
    data_dir: &Path,
    key: &str,
    contents: &Contents,
) -> AppResult<Option<(&'static str, Option<String>)>> {
    if contents.prints.is_empty() || contents.prints.len() != contents.fonts.len() {
        return Ok(None);
    }
    let imports = records(data_dir);
    let mut imported: HashSet<String> = imports.iter().flat_map(|r| r.meta.prints.iter().cloned()).collect();
    let mut set_aside: HashSet<String> = HashSet::new();
    let mut stmt = conn.prepare(
        "SELECT path, status, contents FROM purchase_finds
         WHERE path != ?1 AND status IN ('imported', 'dismissed', 'transferred')",
    )?;
    let rows = stmt.query_map([key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
    for row in rows {
        let (path, status, json) = row?;
        let Ok(c) = serde_json::from_str::<Contents>(&json) else { continue };
        match status.as_str() {
            "imported" => imported.extend(c.prints),
            "transferred" => set_aside.extend(c.prints),
            _ if !Path::new(&path).exists() => set_aside.extend(c.prints),
            _ => {}
        }
    }
    if contents.prints.iter().all(|p| imported.contains(p)) {
        let dir = imports
            .iter()
            .find(|r| contents.prints.iter().any(|p| r.meta.prints.contains(p)))
            .map(|r| r.dir.to_string_lossy().into_owned());
        return Ok(Some(("imported", dir)));
    }
    if contents.prints.iter().all(|p| imported.contains(p) || set_aside.contains(p)) {
        return Ok(Some(("dismissed", None)));
    }
    Ok(None)
}

/// After importing a picked file or folder, marks a find for the same download as imported,
/// so it isn't offered again.
pub fn mark_path_imported(conn: &Connection, path: &Path, store: &str, dir: &str) -> AppResult<()> {
    let key = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()).to_string_lossy().into_owned();
    conn.execute(
        "UPDATE purchase_finds SET status = 'imported', store = ?2, imported_dir = ?3 WHERE path = ?1",
        params![key, store, dir],
    )?;
    Ok(())
}

/// Watched folders may not sit inside one another (the outer one would swallow the inner).
pub fn check_not_nested(existing: &[String], new: &str) -> AppResult<()> {
    let new_path = Path::new(new);
    for e in existing {
        let e_path = Path::new(e);
        if e_path == new_path {
            continue;
        }
        if new_path.starts_with(e_path) {
            return Err(AppError::Invalid(format!("That folder is already inside a watched folder ({e})")));
        }
        if e_path.starts_with(new_path) {
            return Err(AppError::Invalid(format!("That folder holds a watched folder ({e}). Remove that one first.")));
        }
    }
    Ok(())
}

/// Looks at every item directly inside the watched folders. Returns the ids of new finds that
/// hold fonts. Folders that can't be read are skipped (`folder_problem` explains them).
///
/// One check runs at a time per library: asked for while one is running (the watcher, "Check
/// now" and the check at startup can overlap), it waits for that one and shares its result.
pub fn check_folders(conn: &Connection, data_dir: &Path) -> AppResult<Vec<i64>> {
    let key = conn.path().unwrap_or_default().to_string();
    single_flight(&key, || {
        let mut new = Vec::new();
        for folder in watch_folders(conn)? {
            let Ok(entries) = std::fs::read_dir(&folder) else { continue };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || is_partial(&name) {
                    continue;
                }
                if let Ok(Some(id)) = record(conn, data_dir, &entry.path()) {
                    new.push(id);
                }
            }
        }
        Ok(new)
    })
}

#[derive(Default)]
struct Flight {
    result: Mutex<Option<Result<Vec<i64>, String>>>,
    done: Condvar,
}

/// Checks in progress, by key (the library's database path).
static FLIGHTS: Mutex<Vec<(String, Arc<Flight>)>> = Mutex::new(Vec::new());

/// Runs `run` unless a run with the same key is already in progress; then waits for that run
/// and returns its result instead.
pub(crate) fn single_flight(key: &str, run: impl FnOnce() -> AppResult<Vec<i64>>) -> AppResult<Vec<i64>> {
    let (flight, leader) = {
        let mut flights = FLIGHTS.lock().unwrap_or_else(|p| p.into_inner());
        match flights.iter().find(|(k, _)| k == key) {
            Some((_, f)) => (f.clone(), false),
            None => {
                let f = Arc::new(Flight::default());
                flights.push((key.to_string(), f.clone()));
                (f, true)
            }
        }
    };
    if !leader {
        let mut result = flight.result.lock().unwrap_or_else(|p| p.into_inner());
        while result.is_none() {
            result = flight.done.wait(result).unwrap_or_else(|p| p.into_inner());
        }
        return result.clone().unwrap_or(Ok(Vec::new())).map_err(AppError::Other);
    }
    /// Hands the result to anyone waiting, even if `run` panics, and lets the next run start.
    struct Land<'a> {
        key: &'a str,
        flight: Arc<Flight>,
        result: Option<Result<Vec<i64>, String>>,
    }
    impl Drop for Land<'_> {
        fn drop(&mut self) {
            FLIGHTS.lock().unwrap_or_else(|p| p.into_inner()).retain(|(k, _)| k != self.key);
            let result = self.result.take().unwrap_or_else(|| Err("The check stopped unexpectedly".into()));
            *self.flight.result.lock().unwrap_or_else(|p| p.into_inner()) = Some(result);
            self.flight.done.notify_all();
        }
    }
    let mut land = Land { key, flight, result: None };
    let result = run();
    land.result = Some(result.as_ref().map(Clone::clone).map_err(ToString::to_string));
    result
}

pub fn dismiss(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("UPDATE purchase_finds SET status = 'dismissed' WHERE id = ?1", [id])?;
    Ok(())
}

// ---------------------------------------------------------------------------------- import

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sidecar {
    store: String,
    store_name: String,
    origin_url: Option<String>,
    referrer: Option<String>,
    source_name: String,
    imported_at: i64,
    license_files: Vec<String>,
    subscription_bound: bool,
    may_be_trial: bool,
    /// The user said they bought it, so it's never flagged as a trial again (kept on Replace).
    #[serde(default)]
    license_confirmed: bool,
    /// What the folder's font files are, worked out from the files whenever the folder changes.
    #[serde(default)]
    families: Vec<String>,
    #[serde(default)]
    faces: Vec<String>,
    #[serde(default)]
    prints: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub dir: String,
    /// Font files this import added to the folder.
    pub files: Vec<String>,
}

/// File changes in the Purchases folder (placing, grouping, replacing, removing, sidecar edits)
/// take turns through this lock. It's only held for file work, never while waiting for the
/// activation lock or the database, so it can't deadlock with them.
static PLACE: Mutex<()> = Mutex::new(());

fn place_lock() -> MutexGuard<'static, ()> {
    PLACE.lock().unwrap_or_else(|p| p.into_inner())
}

/// A file or folder name that's safe to write on macOS and Windows: no separators or control
/// characters, no leading dots, a reasonable length, and not a reserved Windows device name.
fn safe_name(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if "/\\:<>\"|?*".contains(c) || c.is_control() { '-' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim_end_matches(['.', ' ']).to_string();
    let (stem, ext) = match trimmed.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && e.len() <= 8 => (s.to_string(), format!(".{e}")),
        _ => (trimmed.clone(), String::new()),
    };
    let mut stem: String = stem.chars().take(MAX_NAME_CHARS).collect();
    const RESERVED: &[&str] = &["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "lpt1", "lpt2", "lpt3"];
    if RESERVED.contains(&stem.to_ascii_lowercase().as_str()) {
        stem.push('_');
    }
    if stem.is_empty() { format!("Untitled{ext}") } else { format!("{stem}{ext}") }
}

/// `name`, then "name 2", "name 3"… with the extension kept.
fn numbered(name: &str) -> impl Iterator<Item = String> + '_ {
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s, format!(".{e}")),
        None => (name, String::new()),
    };
    (1..1000).map(move |n| if n == 1 { name.to_string() } else { format!("{stem} {n}{ext}") })
}

/// Writes `bytes` under a new name in `dir`, adding " 2", " 3"… if the name is taken. The file
/// system decides what "taken" means, so case-insensitive and Unicode-normalizing volumes work.
fn write_new(dir: &Path, name: &str, bytes: &[u8]) -> AppResult<String> {
    let name = safe_name(name);
    for candidate in numbered(&name) {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(dir.join(&candidate)) {
            Ok(mut f) => {
                f.write_all(bytes)?;
                return Ok(candidate);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(AppError::Other(format!("Couldn't save {candidate}: {e}"))),
        }
    }
    Err(AppError::Other(format!("Too many files named {name}")))
}

/// Puts a finished file into `dir` under a new name, all at once (a hard link never replaces an
/// existing file, so a scan never sees half a file). Falls back to copying if linking fails.
fn link_new(from: &Path, dir: &Path, name: &str) -> AppResult<String> {
    let name = safe_name(name);
    for candidate in numbered(&name) {
        match std::fs::hard_link(from, dir.join(&candidate)) {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return write_new(dir, &name, &std::fs::read(from)?),
        }
    }
    Err(AppError::Other(format!("Too many files named {name}")))
}

/// Replaces a sidecar in one step (written next to it, then renamed over it).
fn write_sidecar(dir: &Path, meta: &Sidecar) -> AppResult<()> {
    let tmp = dir.join(format!("{SIDECAR}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec_pretty(meta).unwrap_or_default())?;
    std::fs::rename(&tmp, dir.join(SIDECAR)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.into()
    })
}

/// The font files directly in a folder, sorted by name.
fn font_files_in(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')) && scanner::is_font_file(p))
        .collect();
    files.sort();
    files
}

fn file_name_of(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// What the font files in a folder are: (families, face keys, fingerprints).
fn describe_dir(dir: &Path) -> (Vec<String>, Vec<String>, Vec<String>) {
    let (mut families, mut faces, mut prints) = (Vec::new(), Vec::new(), Vec::new());
    for path in font_files_in(dir) {
        let Some(c) = read_capped(&path, MAX_FONT_BYTES).and_then(|b| candidate(file_name_of(&path), &b)) else { continue };
        for f in c.families {
            if !families.contains(&f) {
                families.push(f);
            }
        }
        faces.extend(c.keys);
        prints.push(c.print);
    }
    faces.sort();
    faces.dedup();
    (families, faces, prints)
}

fn describe_into(dir: &Path, meta: &mut Sidecar) {
    (meta.families, meta.faces, meta.prints) = describe_dir(dir);
}

/// Adds fonts that joined a folder to its sidecar's description.
fn add_description(meta: &mut Sidecar, families: &[String], faces: &[String], prints: &[String]) {
    for f in families {
        if !meta.families.contains(f) {
            meta.families.push(f.clone());
        }
    }
    meta.faces.extend(faces.iter().cloned());
    meta.faces.sort();
    meta.faces.dedup();
    meta.prints.extend(prints.iter().cloned());
}

/// Copied files waiting in a hidden folder next to the store's purchases, not yet in the
/// library. Dropping it unplaced deletes them.
pub struct Prepared {
    tmp: PathBuf,
    store_dir: PathBuf,
    label: String,
    sidecar: Sidecar,
    /// Font files copied.
    pub files: Vec<String>,
    licenses: Vec<String>,
    /// A single font file (not a zip or folder): it joins a folder of its family if there is one.
    loose: bool,
}

impl Drop for Prepared {
    fn drop(&mut self) {
        // Placed: tmp is empty (nothing to do). Abandoned or failed: clean it up.
        if !self.tmp.as_os_str().is_empty() {
            let _ = std::fs::remove_dir_all(&self.tmp);
        }
    }
}

static NONCE: AtomicU64 = AtomicU64::new(0);

/// Step 1 of an import: copies a download's desktop font files and license files into a hidden
/// folder inside `<Store>/`. The original isn't touched.
pub fn prepare(data_dir: &Path, source: &Path, store_id: &str, origin_url: Option<String>, referrer: Option<String>) -> AppResult<Prepared> {
    let real = std::fs::canonicalize(source)?;
    if is_adobe_path(&real) {
        return Err(AppError::Invalid("That's an Adobe Fonts file managed by Creative Cloud".into()));
    }
    let contents = inspect(&real)?.ok_or_else(|| {
        AppError::Invalid("Part of this download is still online-only in cloud storage. Download it fully, then try again.".into())
    })?;
    if contents.fonts.is_empty() {
        return Err(AppError::Invalid("No desktop font files were found in it".into()));
    }
    let root = service_dir(data_dir, "purchases").ok_or_else(|| AppError::Other("Purchases folder missing".into()))?;
    let store = store_by_id(store_id);
    let store_dir = root.join(safe_name(&store_name(store_id)));
    std::fs::create_dir_all(&store_dir)?;

    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = store_dir.join(format!(".import-{nanos}-{}", NONCE.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir(&tmp)?;
    let label = safe_name(&contents.families.first().cloned().unwrap_or_else(|| {
        real.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Fonts".into())
    }));
    let mut prepared = Prepared {
        tmp,
        store_dir,
        label,
        sidecar: Sidecar {
            store: store_id.to_string(),
            store_name: store_name(store_id),
            origin_url,
            referrer,
            source_name: file_name_of(&real),
            imported_at: now(),
            license_files: Vec::new(),
            subscription_bound: store.is_some_and(|s| s.subscription_bound),
            may_be_trial: store.is_some_and(|s| s.may_be_trial) || contents.trial,
            license_confirmed: false,
            families: contents.families.clone(),
            faces: contents.faces.clone(),
            prints: Vec::new(),
        },
        files: Vec::new(),
        licenses: Vec::new(),
        loose: real.is_file() && !is_archive(&real),
    };

    let font_set: HashSet<&String> = contents.fonts.iter().collect();
    let license_set: HashSet<&String> = contents.licenses.iter().collect();
    let mut save = |rel: &str, bytes: &[u8], is_font: bool| -> AppResult<()> {
        let base = rel.rsplit(['/', '\\']).next().unwrap_or(rel);
        let written = write_new(&prepared.tmp, base, bytes)?;
        if is_font {
            prepared.files.push(written);
            prepared.sidecar.prints.push(fingerprint(bytes));
        } else {
            prepared.licenses.push(written);
        }
        Ok(())
    };
    if real.is_dir() {
        for rel in contents.fonts.iter().chain(contents.licenses.iter()) {
            let max = if font_set.contains(rel) { MAX_FONT_BYTES } else { 32 * 1024 * 1024 };
            if let Some(bytes) = read_capped(&real.join(rel), max) {
                save(rel, &bytes, font_set.contains(rel))?;
            }
        }
    } else if is_archive(&real) {
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&real)?)
            .map_err(|e| AppError::Invalid(format!("Not a readable zip: {e}")))?;
        let mut budget = MAX_ARCHIVE_READ;
        for i in 0..archive.len().min(MAX_ARCHIVE_ENTRIES) {
            let Ok(mut entry) = archive.by_index(i) else { continue };
            let Some(name) = archive_entry_name(&entry) else { continue };
            let (is_font, is_license) = (font_set.contains(&name), license_set.contains(&name));
            if !is_font && !is_license {
                continue;
            }
            if let Some(bytes) = read_entry(&mut entry, &mut budget) {
                if !is_font || scanner::parse_file(&bytes).is_ok() {
                    save(&name, &bytes, is_font)?;
                }
            }
        }
    } else if let Some(bytes) = read_capped(&real, MAX_FONT_BYTES) {
        save(&file_name_of(&real), &bytes, true)?;
    }
    if prepared.files.is_empty() {
        return Err(AppError::Invalid("No desktop font files could be copied from it".into()));
    }
    prepared.sidecar.license_files = prepared.licenses.clone();
    Ok(prepared)
}

/// Step 2 of an import: moves the prepared files into the library in one step, as a new
/// `<Store>/<Family>/` folder. A single font file joins a folder of its family from the same
/// store instead (fonts downloaded one at a time end up together), unless it has a face that
/// folder already has.
pub fn place(mut prepared: Prepared) -> AppResult<ImportResult> {
    let _place = place_lock();
    if prepared.loose {
        if let Some(target) = group_target(&prepared) {
            return merge_into(prepared, &target);
        }
    }
    write_sidecar(&prepared.tmp, &prepared.sidecar)?;
    // Move into place under a name nobody else has taken.
    let mut dest = None;
    for name in numbered(&prepared.label) {
        let candidate = prepared.store_dir.join(name);
        if candidate.exists() {
            continue;
        }
        match std::fs::rename(&prepared.tmp, &candidate) {
            Ok(()) => {
                dest = Some(candidate);
                break;
            }
            Err(_) if candidate.exists() => continue, // lost a race for this name
            Err(e) => return Err(AppError::Other(format!("Couldn't move the fonts into place: {e}"))),
        }
    }
    let dest = dest.ok_or_else(|| AppError::Other("Couldn't find a free folder name".into()))?;
    prepared.tmp = PathBuf::new(); // placed: nothing for Drop to clean up
    let dir = std::fs::canonicalize(&dest).unwrap_or(dest).to_string_lossy().into_owned();
    Ok(ImportResult { dir, files: std::mem::take(&mut prepared.files) })
}

/// The folder a single prepared font file should join: an import from the same store whose
/// families include the file's, that doesn't have any of its faces yet (that would be a newer
/// version, see `replace`), and that's flagged as a trial only if the file is too.
fn group_target(prepared: &Prepared) -> Option<PathBuf> {
    let Sidecar { families, faces, .. } = &prepared.sidecar;
    if families.is_empty() {
        return None;
    }
    let mut items: Vec<PathBuf> = std::fs::read_dir(&prepared.store_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path())
        .collect();
    items.sort();
    items.into_iter().filter_map(|d| read_record(&d)).find_map(|r| {
        let fits = r.meta.store == prepared.sidecar.store
            && r.meta.may_be_trial == prepared.sidecar.may_be_trial
            && families.iter().all(|f| r.meta.families.contains(f))
            && !faces.iter().any(|k| r.meta.faces.contains(k));
        fits.then_some(r.dir)
    })
}

/// Adds prepared files to an existing purchase folder and updates its sidecar.
fn merge_into(prepared: Prepared, target: &Path) -> AppResult<ImportResult> {
    let mut meta = read_record(target).ok_or_else(|| AppError::NotFound("That purchase is no longer in the library".into()))?.meta;
    let mut files = Vec::new();
    for name in &prepared.files {
        files.push(link_new(&prepared.tmp.join(name), target, name)?);
    }
    for name in &prepared.licenses {
        meta.license_files.push(link_new(&prepared.tmp.join(name), target, name)?);
    }
    add_description(&mut meta, &prepared.sidecar.families, &prepared.sidecar.faces, &prepared.sidecar.prints);
    write_sidecar(target, &meta)?;
    let dir = std::fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf()).to_string_lossy().into_owned();
    Ok(ImportResult { dir, files })
}

/// Copies a download's desktop font files and license files into the Purchases folder:
/// `<Store>/<Family>/`. Files are gathered in a hidden folder first and then moved into place in
/// one step, so a library scan never sees a half-copied purchase. The original isn't touched.
pub fn import(data_dir: &Path, source: &Path, store_id: &str, origin_url: Option<String>, referrer: Option<String>) -> AppResult<ImportResult> {
    place(prepare(data_dir, source, store_id, origin_url, referrer)?)
}

/// Puts a prepared download in place of an imported purchase folder, keeping the folder's name.
/// Old fonts whose faces the download has are dropped; the rest stay, and so do the old license
/// files. The old folder is set aside first and put back if the swap fails.
fn swap(mut prepared: Prepared, old_dir: &Path) -> AppResult<ImportResult> {
    let _place = place_lock();
    let old = read_record(old_dir).ok_or_else(|| AppError::NotFound("That purchase is no longer in the library".into()))?;
    let mut meta = prepared.sidecar.clone();
    for path in font_files_in(old_dir) {
        let Some(bytes) = read_capped(&path, MAX_FONT_BYTES) else { continue };
        let found = candidate(file_name_of(&path), &bytes);
        let keys = found.as_ref().map(|c| c.keys.clone()).unwrap_or_default();
        if keys.is_empty() || !keys.iter().all(|k| prepared.sidecar.faces.contains(k)) {
            let kept = write_new(&prepared.tmp, &file_name_of(&path), &bytes)?;
            prepared.files.push(kept);
            if let Some(c) = found {
                add_description(&mut meta, &c.families, &c.keys, &[c.print]);
            }
        }
    }
    for name in &old.meta.license_files {
        let Some(bytes) = read_capped(&old_dir.join(name), 32 * 1024 * 1024) else { continue };
        let same = prepared.licenses.iter().any(|l| std::fs::read(prepared.tmp.join(l)).is_ok_and(|b| b == bytes));
        if !same {
            let kept = write_new(&prepared.tmp, name, &bytes)?;
            prepared.licenses.push(kept);
        }
    }
    meta.license_files = prepared.licenses.clone();
    meta.license_confirmed = old.meta.license_confirmed;
    meta.may_be_trial &= !meta.license_confirmed;
    write_sidecar(&prepared.tmp, &meta)?;

    // The backup's name says where it goes back, so an interrupted swap is undone at startup.
    let backup = old_dir.with_file_name(format!(".replaced-{}", file_name_of(old_dir)));
    let _ = std::fs::remove_dir_all(&backup);
    std::fs::rename(old_dir, &backup).map_err(|e| AppError::Other(format!("Couldn't set the old copy aside: {e}")))?;
    if let Err(e) = std::fs::rename(&prepared.tmp, old_dir) {
        let _ = std::fs::rename(&backup, old_dir);
        return Err(AppError::Other(format!("Couldn't move the new version into place: {e}")));
    }
    prepared.tmp = PathBuf::new(); // placed
    let _ = std::fs::remove_dir_all(&backup);
    let dir = std::fs::canonicalize(old_dir).unwrap_or_else(|_| old_dir.to_path_buf()).to_string_lossy().into_owned();
    let mut files = std::mem::take(&mut prepared.files);
    files.sort();
    Ok(ImportResult { dir, files })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Replaced {
    pub dir: String,
    pub store: String,
    /// Every font file now in the folder.
    pub files: Vec<String>,
    /// PostScript names of the faces that were on before; the UI turns these back on.
    pub was_active_faces: Vec<String>,
    /// PostScript names of every face the old copy had. A face that's new in this version is
    /// turned on too if any face was on.
    pub old_faces: Vec<String>,
    /// PostScript names of the faces to turn back on for this login only (scope "temporary"),
    /// because they, or what they replace, were on that way. The others come back to stay
    /// (scope "persistent"). See `activation::temporary_after_swap`.
    pub temporary_faces: Vec<String>,
}

/// PostScript names of the faces in a font file.
fn postscript_names(path: &Path) -> Vec<String> {
    read_capped(path, MAX_FONT_BYTES)
        .and_then(|b| scanner::parse_file(&b).ok())
        .map(|faces| faces.into_iter().filter_map(|f| f.postscript_name).collect())
        .unwrap_or_default()
}

/// Replaces an imported purchase with a newer download of it. The new files are copied and
/// checked first. Only then are the old fonts turned off (`turn_off` returns the files it turned
/// off, each with its scope) and the files swapped; if the swap fails, `turn_back_on` gets those
/// files back.
pub fn replace(
    data_dir: &Path,
    old_dir: &Path,
    source: &Path,
    source_store: Option<&str>,
    origin_url: Option<String>,
    referrer: Option<String>,
    turn_off: impl FnOnce(&Path) -> AppResult<Vec<TurnedOff>>,
    turn_back_on: impl FnOnce(&[TurnedOff]),
) -> AppResult<Replaced> {
    if !is_import_dir(data_dir, old_dir) {
        return Err(AppError::Invalid("That isn't a purchase Fontface imported".into()));
    }
    let old = read_record(old_dir).ok_or_else(|| AppError::NotFound("That purchase is no longer in the library".into()))?;
    if source_store != Some(old.meta.store.as_str()) {
        return Err(AppError::Invalid(format!("That download isn't from {}", old.meta.store_name)));
    }
    let prepared = prepare(data_dir, source, &old.meta.store, origin_url, referrer)?;
    let Sidecar { families, faces, .. } = &prepared.sidecar;
    if !families.iter().all(|f| old.meta.families.contains(f)) || !faces.iter().any(|k| old.meta.faces.contains(k)) {
        return Err(AppError::Invalid(format!("That download isn't a version of {}", old.label)));
    }
    let new_faces: Vec<String> = faces.iter().map(|k| key_postscript(k).to_string()).collect();
    let mut old_faces: Vec<String> = old.meta.faces.iter().map(|k| key_postscript(k).to_string()).collect();
    old_faces.sort();
    old_faces.dedup();
    let turned_off = turn_off(old_dir)?;
    let was_on: Vec<(String, Scope)> = turned_off
        .iter()
        .flat_map(|(p, scope)| postscript_names(Path::new(p)).into_iter().map(move |name| (name, *scope)))
        .collect();
    let temporary_faces = activation::temporary_after_swap(&was_on, &old_faces.iter().cloned().collect(), &new_faces);
    let mut was_active_faces: Vec<String> = was_on.into_iter().map(|(name, _)| name).collect();
    was_active_faces.sort();
    was_active_faces.dedup();
    match swap(prepared, old_dir) {
        Ok(r) => Ok(Replaced { dir: r.dir, store: old.meta.store, files: r.files, was_active_faces, old_faces, temporary_faces }),
        Err(e) => {
            turn_back_on(&turned_off);
            Err(e)
        }
    }
}

/// What's needed to import a recorded find. If the file changed since it was found, it's
/// looked at again and an error asks the user to review it, so the right store and contents
/// are shown before anything is copied.
pub struct FindSource {
    pub path: PathBuf,
    pub store: Option<String>,
    pub origin_url: Option<String>,
    pub referrer: Option<String>,
}

pub fn find_source(conn: &Connection, data_dir: &Path, id: i64) -> AppResult<FindSource> {
    let (path, store, origin_url, referrer, size, mtime): (String, Option<String>, Option<String>, Option<String>, i64, i64) = conn
        .query_row(
            "SELECT path, store, origin_url, referrer, file_size, mtime FROM purchase_finds WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("That download is no longer listed".into()))?;
    let path = PathBuf::from(path);
    match signature(&path) {
        None => Err(AppError::NotFound("The download is gone from its folder".into())),
        Some(stamp) if stamp != (size, mtime) => {
            let _ = record(conn, data_dir, &path);
            Err(AppError::Invalid("This download changed since it was found. Review it and add it again.".into()))
        }
        Some(_) => Ok(FindSource { path, store, origin_url, referrer }),
    }
}

pub fn mark_imported(conn: &Connection, id: i64, store: &str, dir: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE purchase_finds SET status = 'imported', store = ?2, imported_dir = ?3 WHERE id = ?1",
        params![id, store, dir],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub dir: String,
    pub label: String,
    pub store: String,
    pub store_name: String,
    pub origin_url: Option<String>,
    pub source_name: String,
    pub imported_at: i64,
    pub font_files: usize,
    pub license_files: Vec<String>,
    pub subscription_bound: bool,
    pub may_be_trial: bool,
    /// It may be a trial and was added at least 30 days ago: remind the user.
    pub trial_reminder: bool,
}

/// An imported purchase folder and its sidecar.
struct Record {
    dir: PathBuf,
    label: String,
    meta: Sidecar,
}

fn read_record(dir: &Path) -> Option<Record> {
    let mut meta: Sidecar = serde_json::from_slice(&std::fs::read(dir.join(SIDECAR)).ok()?).ok()?;
    if meta.prints.is_empty() {
        describe_into(dir, &mut meta); // imported before Fontface recorded this
    }
    let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    Some(Record { label: file_name_of(&dir), dir, meta })
}

fn records(data_dir: &Path) -> Vec<Record> {
    let Some(root) = service_dir(data_dir, "purchases") else { return Vec::new() };
    let visible = |e: &std::fs::DirEntry| !e.file_name().to_string_lossy().starts_with('.');
    std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(visible)
        .flat_map(|store_dir| std::fs::read_dir(store_dir.path()).into_iter().flatten().flatten())
        .filter(visible)
        .filter_map(|item| read_record(&item.path()))
        .collect()
}

pub fn trial_reminder_due(imported_at: i64, may_be_trial: bool, now: i64) -> bool {
    may_be_trial && now - imported_at >= TRIAL_REMINDER_SECS
}

/// Everything imported so far, read from each folder's sidecar.
pub fn imported(data_dir: &Path) -> Vec<Imported> {
    let now = now();
    let mut out: Vec<Imported> = records(data_dir)
        .into_iter()
        .map(|r| Imported {
            font_files: font_files_in(&r.dir).len(),
            trial_reminder: trial_reminder_due(r.meta.imported_at, r.meta.may_be_trial, now),
            dir: r.dir.to_string_lossy().into_owned(),
            label: r.label,
            store: r.meta.store,
            store_name: r.meta.store_name,
            origin_url: r.meta.origin_url,
            source_name: r.meta.source_name,
            imported_at: r.meta.imported_at,
            license_files: r.meta.license_files,
            subscription_bound: r.meta.subscription_bound,
            may_be_trial: r.meta.may_be_trial,
        })
        .collect();
    out.sort_by(|a, b| a.store_name.cmp(&b.store_name).then(a.label.to_lowercase().cmp(&b.label.to_lowercase())));
    out
}

/// Points each new find that looks like a newer version of an imported purchase at it: the same
/// store, families the purchase has, at least one of the same faces, and files that differ (the
/// same files were never offered: see `already_handled`). The UI offers "Replace" for these.
pub fn link_replacements(finds: &mut [Find], data_dir: &Path) {
    let imports = records(data_dir);
    for find in finds.iter_mut().filter(|f| f.status == "new") {
        let Some(store) = find.store.as_deref() else { continue };
        let c = &find.contents;
        find.replaces = imports
            .iter()
            .filter(|r| {
                r.meta.store == store
                    && !c.families.is_empty()
                    && c.families.iter().all(|f| r.meta.families.contains(f))
                    && !c.prints.iter().all(|p| r.meta.prints.contains(p))
            })
            .map(|r| (r, c.faces.iter().filter(|k| r.meta.faces.contains(k)).count()))
            .filter(|(_, shared)| *shared > 0)
            .max_by_key(|(_, shared)| *shared)
            .map(|(r, _)| r.dir.to_string_lossy().into_owned());
    }
}

/// "I bought it": the purchase is no longer flagged as a trial, now or after a Replace.
pub fn confirm_license(data_dir: &Path, dir: &Path) -> AppResult<()> {
    if !is_import_dir(data_dir, dir) {
        return Err(AppError::Invalid("That isn't a purchase Fontface imported".into()));
    }
    let _place = place_lock();
    let mut meta = read_record(dir).ok_or_else(|| AppError::NotFound("That purchase is no longer in the library".into()))?.meta;
    meta.may_be_trial = false;
    meta.license_confirmed = true;
    write_sidecar(dir, &meta)
}

/// True if `dir` is a purchase folder Fontface created (inside Purchases, two levels down).
pub fn is_import_dir(data_dir: &Path, dir: &Path) -> bool {
    let Some(root) = service_dir(data_dir, "purchases").and_then(|r| std::fs::canonicalize(r).ok()) else { return false };
    let Ok(real) = std::fs::canonicalize(dir) else { return false };
    real.parent().and_then(Path::parent) == Some(root.as_path()) && real.join(SIDECAR).exists()
}

/// Runs at startup: removes half-made imports, and finishes interrupted replacements (the old
/// copy goes back if the new one never landed, and is deleted if it did).
pub fn sweep_leftovers(data_dir: &Path) {
    let Some(root) = service_dir(data_dir, "purchases") else { return };
    for store_dir in std::fs::read_dir(root).into_iter().flatten().flatten() {
        for item in std::fs::read_dir(store_dir.path()).into_iter().flatten().flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with(".import-") {
                let _ = std::fs::remove_dir_all(item.path());
            } else if let Some(label) = name.strip_prefix(".replaced-") {
                let home = store_dir.path().join(label);
                if home.exists() {
                    let _ = std::fs::remove_dir_all(item.path());
                } else {
                    let _ = std::fs::rename(item.path(), home);
                }
            }
        }
    }
}

/// Deletes an imported folder, its fonts and licenses first and the sidecar last, so a removal
/// that fails partway still leaves a folder Fontface recognises (and can remove later).
pub fn delete_import_dir(dir: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)?.flatten() {
        if entry.file_name() != SIDECAR {
            let p = entry.path();
            if entry.file_type()?.is_dir() { std::fs::remove_dir_all(&p)? } else { std::fs::remove_file(&p)? }
        }
    }
    std::fs::remove_dir_all(dir)
}

/// Removes an imported purchase: `turn_off` turns its fonts off (returning the files it turned
/// off, each with its scope), then the folder is deleted. If deleting fails, `turn_back_on` gets
/// those files back.
pub fn remove_import(
    data_dir: &Path,
    dir: &Path,
    turn_off: impl FnOnce(&Path) -> AppResult<Vec<TurnedOff>>,
    turn_back_on: impl FnOnce(&[TurnedOff]),
) -> AppResult<()> {
    if !is_import_dir(data_dir, dir) {
        return Err(AppError::Invalid("That isn't a purchase Fontface imported".into()));
    }
    let turned_off = turn_off(dir)?;
    let deleted = {
        let _place = place_lock();
        delete_import_dir(dir)
    };
    if let Err(e) = deleted {
        turn_back_on(&turned_off);
        return Err(e.into());
    }
    Ok(())
}

/// After an imported folder is removed, its finds get `status`: "dismissed" (removed) or
/// "transferred" (the license went to someone else). Neither is offered again.
pub fn forget_removed(conn: &Connection, dir: &str, status: &str) -> AppResult<()> {
    let status = if status == "transferred" { "transferred" } else { "dismissed" };
    conn.execute("UPDATE purchase_finds SET status = ?2, imported_dir = NULL WHERE imported_dir = ?1", params![dir, status])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_stores_by_domain() {
        let urls = |a: &str, b: &str| vec![a.to_string(), b.to_string()];
        assert_eq!(store_for(&urls("https://cdn.myfonts.net/x/font.zip", "")).map(|s| s.id), Some("myfonts"));
        assert_eq!(store_for(&urls("https://s3.amazonaws.com/x.zip", "https://www.fontspring.com/account")).map(|s| s.id), Some("fontspring"));
        assert_eq!(store_for(&urls("https://elements.envato.com/x", "")).map(|s| s.subscription_bound), Some(true));
        assert!(store_for(&urls("https://notmyfonts.com/x", "")).is_none(), "a lookalike domain doesn't match");
        assert!(store_for(&[]).is_none());
    }

    #[test]
    fn recognises_license_files_and_partial_downloads() {
        for name in ["OFL.txt", "Desktop License Agreement.pdf", "LICENSE", "Licensing.pdf", "Lizenz.pdf", "EULA.docx", "Licencia.pdf"] {
            assert!(is_license_name(name), "{name}");
        }
        assert!(!is_license_name("Specimen.pdf"));
        assert!(!is_candidate_file(Path::new("/x/Font.zip.crdownload")));
        assert!(!is_candidate_file(Path::new("/x/.hidden.otf")));
        assert!(is_candidate_file(Path::new("/x/Font.ZIP")));
    }

    #[test]
    fn tells_desktop_fonts_from_web_and_app_files() {
        assert!(non_desktop("Kit/Webfonts/3A6B2F_0_0.ttf"));
        assert!(non_desktop("Andale/App/Andale-App.ttf"));
        assert!(non_desktop("Fontshare/WEB/x.ttf"));
        assert!(!non_desktop("Andale/Desktop/OTF/Andale-Regular.otf"));
        assert!(!non_desktop("Andale-Regular.otf"));
    }

    #[test]
    fn spots_trial_downloads_by_whole_words() {
        assert!(looks_like_trial(&["Grilli Type Trial Fonts.zip"]));
        assert!(looks_like_trial(&["ABCDiatype-Test.otf"]));
        assert!(looks_like_trial(&["Free for personal use only"]));
        assert!(!looks_like_trial(&["Contest Display.otf", "Testament Serif"]));
    }

    #[test]
    fn units_are_top_level_items() {
        let roots = vec![PathBuf::from("/d")];
        assert_eq!(unit_for(&roots, Path::new("/d/Font.zip")), Some(PathBuf::from("/d/Font.zip")));
        assert_eq!(unit_for(&roots, Path::new("/d/Family/OTF/A.otf")), Some(PathBuf::from("/d/Family")));
        assert_eq!(unit_for(&roots, Path::new("/d/.tmp/A.otf")), None);
        assert_eq!(unit_for(&roots, Path::new("/d/Font.zip.crdownload")), None);
        assert_eq!(unit_for(&roots, Path::new("/d")), None);
        assert_eq!(unit_for(&roots, Path::new("/elsewhere/A.otf")), None);
    }

    #[test]
    fn safe_names_are_short_and_portable() {
        assert_eq!(safe_name("A/B: C?.otf"), "A-B- C-.otf");
        assert_eq!(safe_name("CON.otf"), "CON_.otf");
        assert!(safe_name(&"x".repeat(500)).chars().count() <= MAX_NAME_CHARS);
        assert_eq!(safe_name("..hidden"), "hidden");
    }

    #[test]
    fn writes_never_collide_even_on_case_insensitive_volumes() {
        let dir = std::env::temp_dir().join(format!("fontface-write-new-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(write_new(&dir, "A.otf", b"1").unwrap(), "A.otf");
        let second = write_new(&dir, "a.otf", b"2").unwrap();
        assert_ne!(second.to_lowercase(), "a.otf".to_string().replace("a.otf", "never"), "{second}");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2, "both files exist");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
