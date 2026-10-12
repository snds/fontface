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
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{adobe::is_adobe_path, service_dir};
use crate::{
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
    })
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
        for f in &c.families {
            if !contents.families.contains(f) {
                contents.families.push(f.clone());
            }
        }
    }
    if contents.too_large {
        contents.fonts.clear();
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
/// offered. A recorded download that was only moved or renamed keeps its state, quietly.
pub fn record(conn: &Connection, path: &Path) -> AppResult<Option<i64>> {
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

    let _turn = crate::db::scan_write_turn(); // take turns with scan writers
    if unchanged(conn)? {
        return Ok(None); // recorded by a concurrent check meanwhile
    }
    // Already imported or dismissed, and the fonts are the same: just refresh the stamp.
    let previous: Option<(String, String)> = conn
        .query_row("SELECT status, contents FROM purchase_finds WHERE path = ?1", [&key], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    if let Some((old_status, old_contents)) = &previous {
        let same_fonts = serde_json::from_str::<Contents>(old_contents).is_ok_and(|c| c.fonts == contents.fonts);
        if (old_status == "imported" || old_status == "dismissed") && same_fonts {
            status = if old_status == "imported" { "imported" } else { "dismissed" };
        }
    }
    conn.execute(
        "INSERT INTO purchase_finds (path, file_size, mtime, store, origin_url, referrer, contents, status, found_at, file_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (path) DO UPDATE SET file_size = excluded.file_size, mtime = excluded.mtime,
            store = excluded.store, origin_url = excluded.origin_url, referrer = excluded.referrer,
            contents = excluded.contents, status = excluded.status, found_at = excluded.found_at,
            file_id = excluded.file_id",
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
            id
        ],
    )?;
    if status != "new" {
        return Ok(None);
    }
    Ok(Some(conn.query_row("SELECT id FROM purchase_finds WHERE path = ?1", [&key], |r| r.get(0))?))
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
pub fn check_folders(conn: &Connection) -> AppResult<Vec<i64>> {
    let mut new = Vec::new();
    for folder in watch_folders(conn)? {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || is_partial(&name) {
                continue;
            }
            if let Ok(Some(id)) = record(conn, &entry.path()) {
                new.push(id);
            }
        }
    }
    Ok(new)
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub dir: String,
    pub files: Vec<String>,
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

/// Writes `bytes` under a new name in `dir`, adding " 2", " 3"… if the name is taken. The file
/// system decides what "taken" means, so case-insensitive and Unicode-normalizing volumes work.
fn write_new(dir: &Path, name: &str, bytes: &[u8]) -> AppResult<String> {
    let name = safe_name(name);
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (name.clone(), String::new()),
    };
    for n in 1..1000 {
        let candidate = if n == 1 { name.clone() } else { format!("{stem} {n}{ext}") };
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

/// Copies a download's desktop font files and license files into the Purchases folder:
/// `<Store>/<Family>/`. Files are gathered in a hidden folder first and then moved into place in
/// one step, so a library scan never sees a half-copied purchase. The original isn't touched.
pub fn import(data_dir: &Path, source: &Path, store_id: &str, origin_url: Option<String>, referrer: Option<String>) -> AppResult<ImportResult> {
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

    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = store_dir.join(format!(".import-{nonce}"));
    std::fs::create_dir_all(&tmp)?;
    let fail = |e: AppError| {
        let _ = std::fs::remove_dir_all(&tmp);
        e
    };

    let font_set: HashSet<&String> = contents.fonts.iter().collect();
    let license_set: HashSet<&String> = contents.licenses.iter().collect();
    let (mut fonts, mut licenses) = (Vec::new(), Vec::new());
    let mut save = |rel: &str, bytes: &[u8], is_font: bool| -> AppResult<()> {
        let base = rel.rsplit(['/', '\\']).next().unwrap_or(rel);
        let written = write_new(&tmp, base, bytes)?;
        if is_font { fonts.push(written) } else { licenses.push(written) }
        Ok(())
    };
    let copied = (|| -> AppResult<()> {
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
            let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "font".into());
            save(&name, &bytes, true)?;
        }
        Ok(())
    })();
    drop(save);
    copied.map_err(fail)?;
    if fonts.is_empty() {
        return Err(fail(AppError::Invalid("No desktop font files could be copied from it".into())));
    }

    let sidecar = Sidecar {
        store: store_id.to_string(),
        store_name: store_name(store_id),
        origin_url,
        referrer,
        source_name: real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        imported_at: now(),
        license_files: licenses,
        subscription_bound: store.is_some_and(|s| s.subscription_bound),
        may_be_trial: store.is_some_and(|s| s.may_be_trial) || contents.trial,
    };
    std::fs::write(tmp.join(SIDECAR), serde_json::to_vec_pretty(&sidecar).unwrap_or_default())
        .map_err(|e| fail(e.into()))?;

    // Move into place under a name nobody else has taken; another import may be racing for it.
    let label = safe_name(&contents.families.first().cloned().unwrap_or_else(|| {
        real.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Fonts".into())
    }));
    let mut dest = None;
    for n in 1..1000 {
        let candidate = if n == 1 { store_dir.join(&label) } else { store_dir.join(format!("{label} {n}")) };
        if candidate.exists() {
            continue;
        }
        match std::fs::rename(&tmp, &candidate) {
            Ok(()) => {
                dest = Some(candidate);
                break;
            }
            Err(_) if candidate.exists() => continue, // lost a race for this name
            Err(e) => return Err(fail(AppError::Other(format!("Couldn't move the fonts into place: {e}")))),
        }
    }
    let dest = dest.ok_or_else(|| fail(AppError::Other("Couldn't find a free folder name".into())))?;
    let dir = std::fs::canonicalize(&dest).unwrap_or(dest).to_string_lossy().into_owned();
    Ok(ImportResult { dir, files: fonts })
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

pub fn find_source(conn: &Connection, id: i64) -> AppResult<FindSource> {
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
            let _ = record(conn, &path);
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
}

/// Everything imported so far, read from each folder's sidecar.
pub fn imported(data_dir: &Path) -> Vec<Imported> {
    let mut out = Vec::new();
    let Some(root) = service_dir(data_dir, "purchases") else { return out };
    for store_dir in std::fs::read_dir(root).into_iter().flatten().flatten() {
        if store_dir.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        for item in std::fs::read_dir(store_dir.path()).into_iter().flatten().flatten() {
            if item.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let dir = item.path();
            let Some(meta) = std::fs::read(dir.join(SIDECAR)).ok().and_then(|b| serde_json::from_slice::<Sidecar>(&b).ok()) else {
                continue;
            };
            let font_files = std::fs::read_dir(&dir)
                .into_iter()
                .flatten()
                .flatten()
                .filter(|e| scanner::is_font_file(&e.path()))
                .count();
            out.push(Imported {
                dir: std::fs::canonicalize(&dir).unwrap_or(dir.clone()).to_string_lossy().into_owned(),
                label: item.file_name().to_string_lossy().into_owned(),
                store: meta.store,
                store_name: meta.store_name,
                origin_url: meta.origin_url,
                source_name: meta.source_name,
                imported_at: meta.imported_at,
                font_files,
                license_files: meta.license_files,
                subscription_bound: meta.subscription_bound,
                may_be_trial: meta.may_be_trial,
            });
        }
    }
    out.sort_by(|a, b| a.store_name.cmp(&b.store_name).then(a.label.to_lowercase().cmp(&b.label.to_lowercase())));
    out
}

/// True if `dir` is a purchase folder Fontface created (inside Purchases, two levels down).
pub fn is_import_dir(data_dir: &Path, dir: &Path) -> bool {
    let Some(root) = service_dir(data_dir, "purchases").and_then(|r| std::fs::canonicalize(r).ok()) else { return false };
    let Ok(real) = std::fs::canonicalize(dir) else { return false };
    real.parent().and_then(Path::parent) == Some(root.as_path()) && real.join(SIDECAR).exists()
}

pub fn sweep_leftovers(data_dir: &Path) {
    let Some(root) = service_dir(data_dir, "purchases") else { return };
    for store_dir in std::fs::read_dir(root).into_iter().flatten().flatten() {
        for item in std::fs::read_dir(store_dir.path()).into_iter().flatten().flatten() {
            if item.file_name().to_string_lossy().starts_with(".import-") {
                let _ = std::fs::remove_dir_all(item.path());
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

/// Marks finds whose imported folder no longer exists as dismissed, so they don't linger.
pub fn forget_removed(conn: &Connection, dir: &str) -> AppResult<()> {
    conn.execute("UPDATE purchase_finds SET status = 'dismissed', imported_dir = NULL WHERE imported_dir = ?1", [dir])?;
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
