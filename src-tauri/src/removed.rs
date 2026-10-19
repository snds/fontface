//! Remove from Library: fonts you don't want listed, without touching their files.
//!
//! A removed file is turned off, its rows leave the library, and its path is kept in
//! `removed_files`, so scans skip it from then on (from any folder that reaches it). Put Back
//! marks it to come back: the next scan of its folder lists it again, with the date it was first
//! added, and forgets it here. Removing its folder forgets it too (the row cascades), and a scan
//! that no longer finds the file forgets it. Font files are never moved, renamed or deleted.
//!
//! Only files in your own folders can be removed: macOS's font folders are always part of the
//! library, and Google Fonts and Purchases remove fonts their own way (their pages).
//!
//! Tags and family choices are kept by face key, so a font put back has them again.
//!
//! **Schema.** A side table outside the numbered migrations in db.rs, like the tag tables
//! (tags/mod.rs): `ensure_schema` creates it if it's missing, at launch and before each scan.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

use crate::{
    activation, db,
    error::{AppError, AppResult},
    model::ActivationOutcome,
    AppState,
};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS removed_files (
    path        TEXT PRIMARY KEY,
    folder_id   INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    removed_at  INTEGER NOT NULL,
    -- When its fonts first came into the library, so they keep that date if put back.
    added_at    INTEGER,
    -- Put Back: listed again by the next scan of its folder, then forgotten here.
    restored    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS removed_files_folder ON removed_files(folder_id);
";

pub fn ensure_schema(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(SCHEMA)?;
    Ok(())
}

/// What a scan of one folder needs to know (`for_scan`).
#[derive(Debug, Default)]
pub struct ForScan {
    /// Removed files, in any folder: never listed.
    pub skip: HashSet<String>,
    /// Files put back, with the date their fonts first came in (if known): listed again.
    pub restore: HashMap<String, Option<i64>>,
    /// Every removed or put-back file of this folder: the scan forgets those it no longer finds.
    pub here: HashSet<String>,
}

pub fn for_scan(conn: &Connection, folder_id: i64) -> AppResult<ForScan> {
    let mut out = ForScan::default();
    let mut stmt = conn.prepare("SELECT path, folder_id, added_at, restored FROM removed_files")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<i64>>(2)?, r.get::<_, bool>(3)?)))?;
    for row in rows {
        let (path, folder, added_at, restored) = row?;
        if folder == folder_id {
            out.here.insert(path.clone());
        }
        if restored {
            out.restore.insert(path, added_at);
        } else {
            out.skip.insert(path);
        }
    }
    Ok(out)
}

/// The file is removed right now (and not put back). The scanner asks again just before it
/// lists a file, since it may have been removed while the scan was reading it.
pub fn is_removed(conn: &Connection, path: &str) -> AppResult<bool> {
    let restored: Option<bool> = conn
        .prepare_cached("SELECT restored FROM removed_files WHERE path = ?1")?
        .query_row([path], |r| r.get(0))
        .optional()?;
    Ok(restored == Some(false))
}

/// A file put back has been read again: nothing more to remember.
pub fn forget(conn: &Connection, path: &str) -> AppResult<()> {
    conn.prepare_cached("DELETE FROM removed_files WHERE path = ?1")?.execute([path])?;
    Ok(())
}

/// A file you removed from the library, for Settings › Library.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedFile {
    pub path: String,
    pub folder_id: i64,
    pub removed_at: i64,
}

/// Files removed and not put back, most recent first.
pub fn list(conn: &Connection) -> AppResult<Vec<RemovedFile>> {
    let mut stmt = conn.prepare("SELECT path, folder_id, removed_at FROM removed_files WHERE restored = 0 ORDER BY removed_at DESC, path")?;
    let rows = stmt.query_map([], |r| Ok(RemovedFile { path: r.get(0)?, folder_id: r.get(1)?, removed_at: r.get(2)? }))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// A removed file that was on: Undo turns it back on the same way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasOn {
    pub path: String,
    /// On until logout.
    pub temporary: bool,
}

/// What Remove from Library did.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveReport {
    /// The files no longer listed.
    pub removed: Vec<String>,
    /// Their folders (scanned again by Undo).
    pub folders: Vec<i64>,
    /// Of those, the files that were on.
    pub was_on: Vec<WasOn>,
    /// Files that couldn't be turned off: they stay in the library, so nothing is left on that
    /// Fontface no longer lists.
    pub failures: Vec<ActivationOutcome>,
    /// Fonts asked for that aren't in your folders (or aren't listed any more): left alone.
    pub skipped: usize,
}

/// Removes the files of these fonts from the library: turned off first, then no longer listed.
/// Every font in a file goes with it (the OS treats a file as one). Fonts outside your folders
/// are left alone, and so is a file that couldn't be turned off.
///
/// Lock order: the activation lock, then the DB mutex (through `AppState::write`).
pub fn remove(state: &AppState, font_ids: &[i64]) -> AppResult<RemoveReport> {
    let mut report = RemoveReport::default();
    // (path, folder) of each file in one of your folders, each once.
    let mut files: Vec<(String, i64)> = Vec::new();
    {
        let conn = state.conn()?;
        let mut stmt = conn.prepare_cached(
            "SELECT fonts.path, fonts.folder_id, folders.kind FROM fonts JOIN folders ON folders.id = fonts.folder_id WHERE fonts.id = ?1",
        )?;
        let mut seen = HashSet::new();
        for id in font_ids {
            match stmt.query_row([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))).optional()? {
                Some((path, folder, kind)) if kind == "user" => {
                    if seen.insert(path.clone()) {
                        files.push((path, folder));
                    }
                }
                _ => report.skipped += 1,
            }
        }
    }
    if files.is_empty() {
        return Ok(report);
    }

    let _guard = activation::lock();
    let (on, temporary): (HashSet<String>, HashSet<String>) = {
        let conn = state.conn()?;
        let mut stmt = conn.prepare_cached("SELECT COALESCE(MAX(activated), 0) FROM fonts WHERE path = ?1")?;
        let mut on = HashSet::new();
        for (path, _) in &files {
            if stmt.query_row([path], |r| r.get::<_, bool>(0))? {
                on.insert(path.clone());
            }
        }
        (on, activation::temporary_paths(&conn)?)
    };
    // Turned off outside the DB mutex (the OS calls can take a while).
    let mut going = Vec::with_capacity(files.len());
    for (path, folder) in files {
        let is_temporary = temporary.contains(&path);
        if on.contains(&path) {
            if let Err(e) = crate::commands::turn_off_file(&path, is_temporary) {
                report.failures.push(ActivationOutcome {
                    path,
                    ids: vec![],
                    active: true,
                    activated: true,
                    temporary: is_temporary,
                    error: Some(format!("Couldn't turn it off, so it stays in the library: {e}")),
                });
                continue;
            }
            report.was_on.push(WasOn { path: path.clone(), temporary: is_temporary });
        }
        going.push((path, folder));
    }
    let now = db::now();
    state.write(|conn| {
        ensure_schema(conn)?;
        let tx = conn.transaction()?;
        for (path, folder) in &going {
            let added_at: Option<i64> = tx.query_row("SELECT MIN(added_at) FROM fonts WHERE path = ?1", [path], |r| r.get(0))?;
            tx.execute(
                "INSERT INTO removed_files (path, folder_id, removed_at, added_at, restored) VALUES (?1, ?2, ?3, ?4, 0)
                 ON CONFLICT (path) DO UPDATE SET folder_id = excluded.folder_id, removed_at = excluded.removed_at,
                    added_at = COALESCE(excluded.added_at, removed_files.added_at), restored = 0",
                params![path, folder, now, added_at],
            )?;
            tx.execute("DELETE FROM fonts WHERE path = ?1", [path])?;
            activation::forget_temporary(&tx, path)?;
        }
        tx.commit()?;
        Ok(())
    })?;
    let gone: HashSet<&String> = going.iter().map(|(p, _)| p).collect();
    state.deferred().retain(|p| !gone.contains(p));
    state.seen_loaded().retain(|p| !gone.contains(p));
    let mut folders: Vec<i64> = going.iter().map(|(_, f)| *f).collect();
    folders.sort_unstable();
    folders.dedup();
    report.folders = folders;
    report.removed = going.into_iter().map(|(p, _)| p).collect();
    Ok(report)
}

/// Put Back: these removed files are listed again at their folder's next scan. Returns the
/// folders to scan.
pub fn put_back(state: &AppState, paths: &[String]) -> AppResult<Vec<i64>> {
    state.write(|conn| {
        ensure_schema(conn)?;
        let tx = conn.transaction()?;
        let mut folders = Vec::new();
        for path in paths {
            let folder: Option<i64> = tx.query_row("SELECT folder_id FROM removed_files WHERE path = ?1", [path], |r| r.get(0)).optional()?;
            if let Some(folder) = folder {
                tx.execute("UPDATE removed_files SET restored = 1 WHERE path = ?1", [path])?;
                folders.push(folder);
            }
        }
        tx.commit()?;
        folders.sort_unstable();
        folders.dedup();
        Ok(folders)
    })
}

// ---------------------------------------------------------------------------- commands

/// Remove from Library… (after the page has asked you to confirm).
#[tauri::command(async)]
pub fn fonts_remove(state: State<'_, AppState>, font_ids: Vec<i64>) -> AppResult<RemoveReport> {
    if font_ids.is_empty() {
        return Err(AppError::Invalid("Nothing to remove".into()));
    }
    remove(&state, &font_ids)
}

/// The files you removed from the library and haven't put back.
#[tauri::command(async)]
pub fn fonts_removed(state: State<'_, AppState>) -> AppResult<Vec<RemovedFile>> {
    let conn = state.conn()?;
    ensure_schema(&conn)?;
    list(&conn)
}

/// Put Back (Undo, or Settings › Library). The page scans the returned folders.
#[tauri::command(async)]
pub fn fonts_put_back(state: State<'_, AppState>, paths: Vec<String>) -> AppResult<Vec<i64>> {
    put_back(&state, &paths)
}
