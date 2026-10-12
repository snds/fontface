//! "Locate…" for a library folder that was moved or renamed.
//!
//! Removing the folder and adding the new one would lose what's tied to its path: fonts that
//! are turned on, tags kept for fonts without a PostScript name (their key is the file), and
//! the colors of the folder and its subfolders. Relocating moves all of that to the new path
//! instead. A rescan afterwards picks up any files that changed.

use std::path::Path;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::{
    db,
    error::{AppError, AppResult},
};

/// How many of the folder's files are checked at the new place before moving.
const SAMPLE: usize = 200;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Relocated {
    /// False when none of the folder's fonts are at the new place and `force` wasn't set:
    /// nothing changed, and the UI asks before trying again with `force`.
    pub moved: bool,
    /// Of the files checked, how many are at the new place.
    pub found: usize,
    pub checked: usize,
    /// The new path, as stored.
    pub path: String,
    /// The folder's old path.
    pub old_path: String,
    /// New paths of fonts that were turned on, to turn back on once the folder is rescanned.
    #[serde(skip)]
    pub active: Vec<String>,
    /// Old paths of every font that moved, to forget in the app's in-memory lists.
    #[serde(skip)]
    pub old_paths: Vec<String>,
}

/// Points a user folder at `new_root`, carrying its fonts, tags kept by file, and location
/// colors along. Refuses folders that would overlap another library folder.
pub fn relocate(conn: &mut Connection, folder_id: i64, new_root: &Path, force: bool) -> AppResult<Relocated> {
    let folder = db::get_folder(conn, folder_id)?;
    if folder.kind != "user" {
        return Err(AppError::Invalid("Only folders you added can be located somewhere else".into()));
    }
    let canonical = std::fs::canonicalize(new_root)?;
    if !canonical.is_dir() {
        return Err(AppError::Invalid(format!("{} is not a folder", new_root.display())));
    }
    if crate::services::adobe::is_adobe_path(&canonical) {
        return Err(AppError::Invalid("That folder holds Adobe Fonts synced by Creative Cloud, which Fontface doesn't use".into()));
    }
    let new = canonical.to_string_lossy().into_owned();
    let old = folder.path.clone();
    if new == old {
        return Err(AppError::Invalid("That's the folder's current place".into()));
    }
    // Folders never overlap, so each file belongs to one folder (as when adding a folder).
    let others: Vec<String> = conn
        .prepare("SELECT path FROM folders WHERE id != ?1")?
        .query_map([folder_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    if let Some(other) = others.iter().find(|p| canonical.starts_with(p) || Path::new(p).starts_with(&canonical)) {
        return Err(AppError::Invalid(format!(
            "That folder overlaps {other}, which is already in your library. Choose the folder itself, or remove the other one first."
        )));
    }

    // Do the fonts look like they're there? Checks a sample of files by their path inside the folder.
    let sample: Vec<String> = conn
        .prepare("SELECT DISTINCT path FROM fonts WHERE folder_id = ?1 ORDER BY path LIMIT ?2")?
        .query_map(params![folder_id, SAMPLE as i64], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let relative = |p: &str| p.strip_prefix(&old).and_then(|r| r.strip_prefix('/')).map(str::to_string);
    let checked: Vec<String> = sample.iter().filter_map(|p| relative(p)).collect();
    let found = checked.iter().filter(|r| canonical.join(r).is_file()).count();
    let mut result = Relocated { found, checked: checked.len(), path: new.clone(), old_path: old.clone(), ..Default::default() };
    if found == 0 && !checked.is_empty() && !force {
        return Ok(result);
    }

    let tx = conn.transaction()?;
    let under = |table: &str, column: &str, extra: &str| {
        format!("SELECT {column} FROM {table} WHERE substr({column}, 1, length(?1) + 1) = ?1 || '/' {extra}")
    };
    result.old_paths = tx
        .prepare(&under("fonts", "path", "AND folder_id = ?2"))?
        .query_map(params![old, folder_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    tx.execute("UPDATE folders SET path = ?1 WHERE id = ?2", params![new, folder_id])?;
    // Paths: the new root, then everything after the old root (SQLite counts characters).
    let moved = |column: &str| format!("?2 || substr({column}, length(?1) + 1)");
    let inside = |column: &str| format!("substr({column}, 1, length(?1) + 1) = ?1 || '/'");
    tx.execute(
        &format!("UPDATE fonts SET path = {} WHERE folder_id = ?3 AND {}", moved("path"), inside("path")),
        params![old, new, folder_id],
    )?;
    tx.execute(
        &format!("UPDATE skipped_files SET path = {} WHERE folder_id = ?3 AND {}", moved("path"), inside("path")),
        params![old, new, folder_id],
    )?;
    // Tags kept by file ("file:<path>#<face>"). A key the tag already has at the new path wins.
    tx.execute(
        "UPDATE OR IGNORE tag_fonts SET face_key = 'file:' || ?2 || substr(face_key, length(?1) + 6)
         WHERE substr(face_key, 1, length(?1) + 6) = 'file:' || ?1 || '/'",
        params![old, new],
    )?;
    tx.execute("DELETE FROM tag_fonts WHERE substr(face_key, 1, length(?1) + 6) = 'file:' || ?1 || '/'", [&old])?;
    // Colors of the folder and its subfolders. One already set at the new place wins.
    tx.execute("UPDATE OR IGNORE location_colors SET location = ?2 WHERE location = ?1", params![old, new])?;
    tx.execute(
        &format!("UPDATE OR IGNORE location_colors SET location = {} WHERE {}", moved("location"), inside("location")),
        params![old, new],
    )?;
    tx.execute(
        &format!("DELETE FROM location_colors WHERE location = ?1 OR {}", inside("location")),
        params![old],
    )?;
    result.active = tx
        .prepare("SELECT DISTINCT path FROM fonts WHERE folder_id = ?1 AND activated = 1")?
        .query_map([folder_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    tx.commit()?;
    result.moved = true;
    Ok(result)
}
