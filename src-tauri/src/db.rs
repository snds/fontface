use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex, MutexGuard,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::{
    error::{AppError, AppResult},
    model::{Axis, Folder, FontDetail, FontSummary},
};

pub(crate) const SCHEMA_V1: &str = "
CREATE TABLE folders (
    id        INTEGER PRIMARY KEY,
    path      TEXT NOT NULL UNIQUE,
    added_at  INTEGER NOT NULL
);
CREATE TABLE fonts (
    id              INTEGER PRIMARY KEY,
    folder_id       INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    path            TEXT NOT NULL,
    face_index      INTEGER NOT NULL DEFAULT 0,
    file_size       INTEGER NOT NULL,
    mtime           INTEGER NOT NULL,
    family          TEXT NOT NULL,
    subfamily       TEXT NOT NULL,
    full_name       TEXT,
    postscript_name TEXT,
    version         TEXT,
    designer        TEXT,
    manufacturer    TEXT,
    copyright       TEXT,
    license         TEXT,
    license_url     TEXT,
    weight          INTEGER NOT NULL,
    width           INTEGER NOT NULL,
    italic          INTEGER NOT NULL,
    monospace       INTEGER NOT NULL,
    variable        INTEGER NOT NULL,
    axes            TEXT NOT NULL DEFAULT '[]',
    glyph_count     INTEGER NOT NULL,
    format          TEXT NOT NULL,
    activated       INTEGER NOT NULL DEFAULT 0,
    UNIQUE (path, face_index)
);
CREATE INDEX fonts_family ON fonts(family);
CREATE INDEX fonts_folder ON fonts(folder_id);
PRAGMA user_version = 1;
";

// v2: folders get a kind, so the macOS font folders can be told apart from ones the user added.
const SCHEMA_V2: &str = "
ALTER TABLE folders ADD COLUMN kind TEXT NOT NULL DEFAULT 'user';
PRAGMA user_version = 2;
";

// v3:
// - Ids are never reused (AUTOINCREMENT). The UI caches previews and selection by id, and the
//   scan registry is keyed by folder id, so a removed row's id must not come back.
// - `skipped_files` remembers files that held no usable fonts (unreadable, or only private
//   macOS families), so unchanged ones aren't re-read and re-reported on every scan.
// Tables are rebuilt with foreign keys OFF, or dropping `folders` would cascade-delete every font.
const SCHEMA_V3: &str = "
CREATE TABLE folders_v3 (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    path      TEXT NOT NULL UNIQUE,
    added_at  INTEGER NOT NULL,
    kind      TEXT NOT NULL DEFAULT 'user'
);
INSERT INTO folders_v3 (id, path, added_at, kind) SELECT id, path, added_at, kind FROM folders;
CREATE TABLE fonts_v3 (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id       INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    path            TEXT NOT NULL,
    face_index      INTEGER NOT NULL DEFAULT 0,
    file_size       INTEGER NOT NULL,
    mtime           INTEGER NOT NULL,
    family          TEXT NOT NULL,
    subfamily       TEXT NOT NULL,
    full_name       TEXT,
    postscript_name TEXT,
    version         TEXT,
    designer        TEXT,
    manufacturer    TEXT,
    copyright       TEXT,
    license         TEXT,
    license_url     TEXT,
    weight          INTEGER NOT NULL,
    width           INTEGER NOT NULL,
    italic          INTEGER NOT NULL,
    monospace       INTEGER NOT NULL,
    variable        INTEGER NOT NULL,
    axes            TEXT NOT NULL DEFAULT '[]',
    glyph_count     INTEGER NOT NULL,
    format          TEXT NOT NULL,
    activated       INTEGER NOT NULL DEFAULT 0,
    UNIQUE (path, face_index)
);
INSERT INTO fonts_v3 SELECT * FROM fonts;
DROP TABLE fonts;
DROP TABLE folders;
ALTER TABLE folders_v3 RENAME TO folders;
ALTER TABLE fonts_v3 RENAME TO fonts;
CREATE INDEX fonts_family ON fonts(family);
CREATE INDEX fonts_folder ON fonts(folder_id);
CREATE INDEX fonts_path ON fonts(path);
CREATE TABLE skipped_files (
    path       TEXT PRIMARY KEY,
    folder_id  INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    file_size  INTEGER NOT NULL,
    mtime      INTEGER NOT NULL,
    reason     TEXT NOT NULL
);
CREATE INDEX skipped_folder ON skipped_files(folder_id);
PRAGMA user_version = 3;
";

pub fn open(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(10))?;
    // journal_mode returns a row, so it can't go through execute_batch.
    conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
    // The bundled SQLite turns foreign keys ON by default. Migrations rebuild tables, and with
    // foreign keys on, dropping `folders` would cascade-delete every font. So: off, migrate, on.
    conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
    migrate(&conn)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> AppResult<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V1} COMMIT;"))?;
    }
    if version < 2 {
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V2} COMMIT;"))?;
    }
    if version < 3 {
        // open() has turned foreign keys off for this; check, since this step drops tables.
        let fk: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?;
        if fk != 0 {
            return Err(AppError::Other("refusing to migrate with foreign keys on".into()));
        }
        conn.execute_batch(&format!("BEGIN IMMEDIATE; {SCHEMA_V3} COMMIT;"))?;
        let broken: i64 = conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get(0))?;
        if broken > 0 {
            eprintln!("fontface: {broken} rows reference missing folders after migration");
        }
    }
    Ok(())
}

/// How many UI writes are waiting for the database. A scan's writer checks this and steps
/// aside (commits, then waits) so a click never waits behind a long scan.
static UI_WRITES_WAITING: AtomicUsize = AtomicUsize::new(0);

/// While alive, asks any running scan to yield SQLite's write lock. Raise it only after taking
/// the app's DB mutex (see `AppState::write`), so scans pause only for the actual SQLite wait.
pub struct UiWriteGate(());

impl UiWriteGate {
    pub fn raise() -> Self {
        UI_WRITES_WAITING.fetch_add(1, Ordering::SeqCst);
        UiWriteGate(())
    }
}

impl Drop for UiWriteGate {
    fn drop(&mut self) {
        UI_WRITES_WAITING.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Rows for Creative Cloud's font files must never exist (Adobe's terms). Drops any, using the
/// same path rule as the rest of the app, without touching the OS (Creative Cloud owns those
/// registrations). Runs once at startup, before anything else writes.
pub fn purge_adobe_rows(conn: &mut Connection) -> AppResult<usize> {
    let paths: Vec<String> = {
        let mut stmt = conn.prepare("SELECT DISTINCT path FROM fonts UNION SELECT path FROM skipped_files")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.filter_map(Result::ok).filter(|p| crate::services::adobe::is_adobe_path(Path::new(p))).collect()
    };
    if paths.is_empty() {
        return Ok(0);
    }
    let tx = conn.transaction()?;
    for p in &paths {
        tx.execute("DELETE FROM fonts WHERE path = ?1", [p])?;
        tx.execute("DELETE FROM skipped_files WHERE path = ?1", [p])?;
    }
    tx.commit()?;
    Ok(paths.len())
}

/// Scan writers (one per folder being scanned) take turns through this mutex, from BEGIN to
/// COMMIT. Without it they'd compete through SQLite's busy handler, which polls about every
/// 100 ms and rarely catches the short gap after another writer's commit.
static SCAN_WRITER: Mutex<()> = Mutex::new(());
static SCAN_WRITERS_WAITING: AtomicUsize = AtomicUsize::new(0);

pub struct ScanWriteTurn(#[allow(dead_code)] MutexGuard<'static, ()>);

/// Waits for this scan's turn to write. Hold it only from BEGIN to COMMIT.
pub fn scan_write_turn() -> ScanWriteTurn {
    SCAN_WRITERS_WAITING.fetch_add(1, Ordering::SeqCst);
    let guard = SCAN_WRITER.lock().unwrap_or_else(|p| p.into_inner());
    SCAN_WRITERS_WAITING.fetch_sub(1, Ordering::SeqCst);
    ScanWriteTurn(guard)
}

/// Another scan is waiting for its turn: the current writer should commit soon.
pub fn scan_writer_waiting() -> bool {
    SCAN_WRITERS_WAITING.load(Ordering::SeqCst) > 0
}

pub fn ui_write_waiting() -> bool {
    UI_WRITES_WAITING.load(Ordering::SeqCst) > 0
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// The folders macOS loads fonts from by itself. Fonts here are always on.
pub fn system_font_dirs() -> Vec<(PathBuf, &'static str)> {
    let mut dirs = Vec::new();
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push((PathBuf::from(home).join("Library/Fonts"), "My Fonts"));
        }
        dirs.push((PathBuf::from("/Library/Fonts"), "Computer Fonts"));
        dirs.push((PathBuf::from("/System/Library/Fonts"), "macOS System Fonts"));
    }
    #[cfg(target_os = "windows")]
    {
        // Windows: %WINDIR%\Fonts and %LOCALAPPDATA%\Microsoft\Windows\Fonts (not wired up yet).
    }
    dirs
}

fn folder_label(path: &str, kind: &str) -> String {
    if kind == "system" {
        for (dir, label) in system_font_dirs() {
            if std::fs::canonicalize(&dir).map(|d| d == Path::new(path)).unwrap_or(false) {
                return label.to_string();
            }
        }
    }
    Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
}

/// Reads a folder row without touching the filesystem (callers may hold the DB lock).
/// Call `check_folders` afterwards, without the lock, to fill in `missing` and `label`.
fn folder_from_row(r: &Row) -> rusqlite::Result<Folder> {
    Ok(Folder {
        id: r.get(0)?,
        path: r.get(1)?,
        kind: r.get(2)?,
        label: String::new(),
        missing: false,
        font_count: r.get(3)?,
    })
}

/// Fills in `missing` and `label`. These touch the filesystem (a disconnected network share
/// can stall), so run this after releasing the DB lock.
pub fn check_folders(folders: &mut [Folder]) {
    for f in folders {
        f.missing = !Path::new(&f.path).is_dir();
        f.label = folder_label(&f.path, &f.kind);
    }
}

const FOLDER_SELECT: &str = "SELECT f.id, f.path, f.kind, (SELECT COUNT(*) FROM fonts WHERE folder_id = f.id) FROM folders f";

pub fn list_folders(conn: &Connection) -> AppResult<Vec<Folder>> {
    let mut stmt = conn.prepare(&format!(
        "{FOLDER_SELECT} ORDER BY f.kind = 'user', f.kind = 'service', f.path COLLATE NOCASE"
    ))?;
    let rows = stmt.query_map([], folder_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get_folder(conn: &Connection, id: i64) -> AppResult<Folder> {
    conn.query_row(&format!("{FOLDER_SELECT} WHERE f.id = ?1"), [id], folder_from_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("folder {id}")))
}

/// Adds a folder, keeping the rule that folders never overlap, so each file belongs to exactly one.
/// - Inside an existing folder: refused, because its fonts are already covered.
/// - Containing existing folders: they're absorbed, and their fonts keep their activation state.
pub fn insert_folder(conn: &mut Connection, path: &Path, kind: &str) -> AppResult<i64> {
    // Creative Cloud's font store: its terms forbid using those files outside Creative Cloud.
    if crate::services::adobe::is_adobe_path(path) {
        return Err(AppError::Invalid(
            "That folder holds Adobe Fonts synced by Creative Cloud. Adobe's terms only allow using them through \
             Creative Cloud, so Fontface lists them under Services → Adobe Fonts instead."
                .into(),
        ));
    }
    let new_path = path.to_string_lossy().into_owned();
    let existing: Vec<(i64, String, String)> = {
        let mut stmt = conn.prepare("SELECT id, path, kind FROM folders")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    if let Some((_, parent, _)) = existing.iter().find(|(_, p, _)| path.starts_with(p)) {
        return Err(AppError::Invalid(format!("Already in the library through {parent}")));
    }
    let children: Vec<&(i64, String, String)> =
        existing.iter().filter(|(_, p, _)| Path::new(p).starts_with(path)).collect();
    // A user folder must not swallow a macOS font folder: those stay separate and always on.
    if kind == "user" {
        if let Some((_, inner, k)) = children.iter().find(|(_, _, k)| k != "user") {
            let what = if k == "system" { "the macOS font folder" } else { "Fontface's own service folder" };
            return Err(AppError::Invalid(format!(
                "This folder contains {what} {inner}, which is always in the library. Add a more specific folder instead."
            )));
        }
    }
    let tx = conn.transaction()?;
    tx.execute("INSERT INTO folders (path, added_at, kind) VALUES (?1, ?2, ?3)", params![new_path, now(), kind])?;
    let id = tx.last_insert_rowid();
    for (child_id, _, _) in children {
        tx.execute("UPDATE fonts SET folder_id = ?1 WHERE folder_id = ?2", params![id, child_id])?;
        tx.execute("UPDATE skipped_files SET folder_id = ?1 WHERE folder_id = ?2", params![id, child_id])?;
        tx.execute("DELETE FROM folders WHERE id = ?1", [child_id])?;
    }
    // Rows another folder listed through a symlink into this one now belong here. Moving them
    // (rather than letting the old folder drop them) keeps their ids and on/off choices.
    claim_fonts_under(&tx, id, &new_path)?;
    tx.commit()?;
    Ok(id)
}

/// Makes sure each macOS font folder that exists is in the library, marked as a system folder.
/// A folder the user added earlier at the same path is converted. One that's covered by a
/// broader user folder is left alone.
pub fn ensure_system_folders(conn: &mut Connection) -> AppResult<()> {
    for (dir, _) in system_font_dirs() {
        let Ok(canonical) = std::fs::canonicalize(&dir) else { continue };
        if !canonical.is_dir() {
            continue;
        }
        let path = canonical.to_string_lossy().into_owned();
        let updated = conn.execute("UPDATE folders SET kind = 'system' WHERE path = ?1", [&path])?;
        if updated == 0 {
            match insert_folder(conn, &canonical, "system") {
                Ok(_) => {}
                // Covered by a broader user folder (only possible in libraries from before v3):
                // leave it; those fonts are still listed through that folder.
                Err(AppError::Invalid(_)) => {}
                Err(e) => return Err(e),
            }
        }
    }
    Ok(())
}

/// Moves fonts that already live under `path` (listed through some other folder) to folder `id`.
fn claim_fonts_under(conn: &Connection, id: i64, path: &str) -> AppResult<()> {
    let prefix = format!("{}/", path.trim_end_matches('/'));
    conn.execute("UPDATE fonts SET folder_id = ?1 WHERE substr(path, 1, length(?2)) = ?2", params![id, prefix])?;
    conn.execute("UPDATE skipped_files SET folder_id = ?1 WHERE substr(path, 1, length(?2)) = ?2", params![id, prefix])?;
    Ok(())
}

/// Every library folder root except `except`. The scanner skips files that resolve into one
/// of these through a symlink, so a font is never listed twice.
pub fn other_roots(conn: &Connection, except: i64) -> AppResult<Vec<PathBuf>> {
    let mut stmt = conn.prepare("SELECT path FROM folders WHERE id != ?1")?;
    let rows = stmt.query_map([except], |r| r.get::<_, String>(0))?;
    Ok(rows.map(|r| r.map(PathBuf::from)).collect::<Result<_, _>>()?)
}

/// The list columns: the font's own (18), then its preview profile's (`preview::COLUMNS`).
fn summary_columns() -> String {
    format!(
        "fonts.id, fonts.folder_id, fonts.path, fonts.face_index, fonts.family, \
         fonts.subfamily, fonts.full_name, fonts.postscript_name, fonts.weight, fonts.width, fonts.italic, \
         fonts.monospace, fonts.variable, fonts.format, fonts.activated, folders.kind = 'system', \
         fonts.mtime, fonts.file_size, {}",
        crate::preview::COLUMNS
    )
}

/// How many columns `summary_columns` lists.
const SUMMARY_LEN: usize = 18 + crate::preview::COLUMN_COUNT;

/// Fonts with their folder, and their preview profile if it's current (a stale one reads as none).
fn summary_from() -> String {
    format!("fonts JOIN folders ON folders.id = fonts.folder_id {}", crate::preview::join_clause())
}

/// Fills in `os_active` from the set of font files the OS currently has loaded.
/// `None` means the platform can't report it; then intent (or installed) is shown instead.
pub fn apply_os_state(fonts: &mut [FontSummary], available: Option<&HashSet<String>>) {
    for f in fonts {
        f.os_active = match available {
            Some(set) => f.installed || set.contains(&f.path),
            None => f.installed || f.activated,
        };
    }
}

pub fn summary_from_row(r: &Row) -> rusqlite::Result<FontSummary> {
    Ok(FontSummary {
        id: r.get(0)?,
        folder_id: r.get(1)?,
        path: r.get(2)?,
        face_index: r.get(3)?,
        family: r.get(4)?,
        subfamily: r.get(5)?,
        full_name: r.get(6)?,
        postscript_name: r.get(7)?,
        weight: r.get(8)?,
        width: r.get(9)?,
        italic: r.get(10)?,
        monospace: r.get(11)?,
        variable: r.get(12)?,
        format: r.get(13)?,
        activated: r.get(14)?,
        installed: r.get(15)?,
        mtime: r.get(16)?,
        file_size: r.get(17)?,
        os_active: false,
        preview: crate::preview::info_from_row(r, 18)?,
    })
}

pub fn list_fonts(conn: &Connection) -> AppResult<Vec<FontSummary>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM {} \
         ORDER BY fonts.family COLLATE NOCASE, fonts.italic, fonts.width, fonts.weight",
        summary_columns(),
        summary_from()
    ))?;
    let rows = stmt.query_map([], summary_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get_font(conn: &Connection, id: i64) -> AppResult<Option<FontDetail>> {
    let sql = format!(
        "SELECT {}, fonts.version, fonts.designer, fonts.manufacturer, fonts.copyright, \
         fonts.license, fonts.license_url, fonts.axes, fonts.glyph_count \
         FROM {} WHERE fonts.id = ?1",
        summary_columns(),
        summary_from()
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([id])?;
    let Some(r) = rows.next()? else { return Ok(None) };
    let n = SUMMARY_LEN;
    let axes_json: String = r.get(n + 6)?;
    Ok(Some(FontDetail {
        summary: summary_from_row(r)?,
        version: r.get(n)?,
        designer: r.get(n + 1)?,
        manufacturer: r.get(n + 2)?,
        copyright: r.get(n + 3)?,
        license: r.get(n + 4)?,
        license_url: r.get(n + 5)?,
        axes: serde_json::from_str::<Vec<Axis>>(&axes_json).unwrap_or_default(),
        glyph_count: r.get(n + 7)?,
    }))
}
