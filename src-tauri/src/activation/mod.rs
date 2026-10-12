//! Turning fonts on and off at the OS level, without copying them into system folders.
//!
//! Every platform module exposes the same functions:
//!   `activate(path)`            — make every face in the file available to all apps for this user
//!   `deactivate(path)`          — undo that
//!   `deactivate_elsewhere(path)`— also drop a registration another app made (e.g. session scope)
//!   `available_paths()`         — real paths of every font file the OS has loaded (None if unknown)
//! activate/deactivate are idempotent. Callers confirm the outcome with `available_paths()`,
//! because "already registered" / "not registered" don't prove the OS state matches.
//!
//! The database records intent; `reconcile` re-applies it. Every change to intent or OS state
//! happens under `lock()`, so a scan, a reconcile and a click never interleave on the same file.

use std::{
    collections::HashSet,
    path::Path,
    sync::{Mutex, MutexGuard},
};

use crate::{db, error::AppResult};

static LOCK: Mutex<()> = Mutex::new(());

/// Serializes activation changes across the whole app (UI commands, scans, reconcile).
pub fn lock() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(target_os = "macos")]
pub use macos::available_paths;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use windows as platform;
#[cfg(target_os = "windows")]
pub use windows::available_paths;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod unsupported {
    use crate::error::{AppError, AppResult};
    use std::path::Path;
    pub fn activate(_: &Path) -> AppResult<()> {
        Err(AppError::Unsupported("font activation".into()))
    }
    pub fn deactivate(_: &Path) -> AppResult<()> {
        Err(AppError::Unsupported("font activation".into()))
    }
    pub fn available_paths() -> Option<std::collections::HashSet<String>> {
        None
    }
    pub fn deactivate_elsewhere(_: &Path) -> AppResult<()> {
        Ok(())
    }
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use unsupported as platform;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub use unsupported::available_paths;

/// Creative Cloud's font files are never registered or unregistered by Fontface (Adobe's terms).
/// Every on/off path in the app goes through these three functions, so this one check covers all.
fn refuse_adobe(path: &Path) -> AppResult<()> {
    let real = std::fs::canonicalize(path).ok();
    if crate::services::adobe::is_adobe_path(path) || real.is_some_and(|p| crate::services::adobe::is_adobe_path(&p)) {
        return Err(crate::error::AppError::Invalid("Adobe Fonts are turned on and off in Creative Cloud".into()));
    }
    Ok(())
}

pub fn activate(path: &Path) -> AppResult<()> {
    refuse_adobe(path)?;
    platform::activate(path)
}

pub fn deactivate(path: &Path) -> AppResult<()> {
    refuse_adobe(path)?;
    platform::deactivate(path)
}

pub fn deactivate_elsewhere(path: &Path) -> AppResult<()> {
    refuse_adobe(path)?;
    platform::deactivate_elsewhere(path)
}

/// Re-applies recorded intent that the OS isn't honoring: at launch for every file (`only` =
/// None), and after a scan for files that were unreachable at launch (`only` = those paths).
/// It doesn't run after every scan, so it won't undo a change made in another app mid-session.
///
/// Intent is never cleared here: a missing file may be on a drive that hasn't mounted yet.
/// Each path that's still missing is passed to `on_missing` (while the lock is held), to be
/// retried after its folder's next scan.
pub fn reconcile(db_path: &Path, only: Option<&HashSet<String>>, mut on_missing: impl FnMut(String)) -> AppResult<()> {
    let conn = db::open(db_path)?;
    let paths: Vec<String> = match only {
        Some(set) => set.iter().cloned().collect(),
        None => {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT fonts.path FROM fonts JOIN folders ON folders.id = fonts.folder_id
                 WHERE fonts.activated = 1 AND folders.kind != 'system'",
            )?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            rows.collect::<Result<_, _>>()?
        }
    };
    let loaded = available_paths().unwrap_or_default();
    for path in paths.into_iter().filter(|p| !loaded.contains(p)) {
        let _guard = lock();
        // Re-check under the lock: the user may have turned it off or removed its folder since.
        let still_wanted: bool = conn
            .query_row(
                "SELECT COALESCE(MAX(fonts.activated), 0) FROM fonts JOIN folders ON folders.id = fonts.folder_id
                 WHERE fonts.path = ?1 AND folders.kind != 'system'",
                [&path],
                |r| r.get(0),
            )
            .unwrap_or(false);
        if !still_wanted {
            continue;
        }
        let p = Path::new(&path);
        if !p.exists() {
            on_missing(path);
        } else if let Err(e) = activate(p) {
            eprintln!("fontface: couldn't turn {path} back on: {e}");
        }
    }
    Ok(())
}
