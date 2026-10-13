//! Turning fonts on and off at the OS level, without copying them into system folders.
//!
//! Every platform module exposes the same functions:
//!   `activate(path, scope)`     — make every face in the file available to all apps for this user
//!   `deactivate(path, scope)`   — undo that
//!   `deactivate_elsewhere(path)`— also drop a registration another app made (e.g. session scope)
//!   `available_paths()`         — real paths of every font file the OS has loaded (None if unknown)
//! activate/deactivate are idempotent. Callers confirm the outcome with `available_paths()`,
//! because "already registered" / "not registered" don't prove the OS state matches.
//!
//! The database records intent; `reconcile` re-applies it. Every change to intent or OS state
//! happens under `lock()`, so a scan, a reconcile and a click never interleave on the same file.
//!
//! **Temporary activations.** In the "temporary" activation mode (see settings.rs), fonts are
//! registered in session scope and listed in `temporary_activations`. At launch, a listed file
//! the OS no longer has means the login session ended: it's recorded as off, leaves the list,
//! and is never turned back on. A file that's already on keeps the scope it has (`turn_on_plan`),
//! and so does a font an update or replacement turns off and back on (`temporary_after_swap`),
//! or one whose folder moved (Locate… moves its listing, and `reconcile` turns it back on in
//! session scope).

use std::{
    collections::{BTreeSet, HashSet},
    path::Path,
    sync::{Mutex, MutexGuard},
};

use rusqlite::Connection;

use crate::{
    db,
    error::AppResult,
    settings::{ActivationMode, RestorePolicy},
    AppState,
};

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
    use super::Scope;
    use crate::error::{AppError, AppResult};
    use std::path::Path;
    pub fn activate(_: &Path, _: Scope) -> AppResult<()> {
        Err(AppError::Unsupported("font activation".into()))
    }
    pub fn deactivate(_: &Path, _: Scope) -> AppResult<()> {
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

/// Where an OS registration lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// Stays on after Fontface quits and after a restart.
    Persistent,
    /// On until the user logs out or restarts. Not tied to Fontface's process.
    Session,
}

impl From<ActivationMode> for Scope {
    fn from(mode: ActivationMode) -> Self {
        match mode {
            ActivationMode::Persistent => Scope::Persistent,
            ActivationMode::Temporary => Scope::Session,
        }
    }
}

/// Creative Cloud's font files are never registered or unregistered by Fontface (Adobe's terms).
/// Every on/off path in the app goes through these three functions, so this one check covers all.
fn refuse_adobe(path: &Path) -> AppResult<()> {
    let real = std::fs::canonicalize(path).ok();
    if crate::services::adobe::is_adobe_path(path) || real.is_some_and(|p| crate::services::adobe::is_adobe_path(&p)) {
        return Err(crate::error::AppError::Invalid("Adobe Fonts are turned on and off in Creative Cloud".into()));
    }
    Ok(())
}

/// Turns a file on in this scope.
pub fn activate_in(path: &Path, scope: Scope) -> AppResult<()> {
    refuse_adobe(path)?;
    platform::activate(path, scope)
}

/// Removes Fontface's persistent registration of a file.
pub fn deactivate(path: &Path) -> AppResult<()> {
    deactivate_in(path, Scope::Persistent)
}

pub fn deactivate_in(path: &Path, scope: Scope) -> AppResult<()> {
    refuse_adobe(path)?;
    platform::deactivate(path, scope)
}

pub fn deactivate_elsewhere(path: &Path) -> AppResult<()> {
    refuse_adobe(path)?;
    platform::deactivate_elsewhere(path)
}

/// How many files `reconcile` turned back on, and how many the OS refused.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Reactivated {
    pub restored: usize,
    pub failed: usize,
}

/// Re-applies recorded intent that the OS isn't honoring, for these files: at launch, after a
/// scan for files that were unreachable at launch or whose folder moved (Locate…), and when the
/// user answers "Turn them back on". It doesn't run after every scan, so it won't undo a change
/// made in another app mid-session. Each file is turned on in the scope `wanted_scope` gives.
///
/// Intent is never cleared here: a missing file may be on a drive that hasn't mounted yet.
/// Each path that's still missing is passed to `on_missing` (while the lock is held), to be
/// retried after its folder's next scan.
pub fn reconcile(state: &AppState, paths: &HashSet<String>, mut on_missing: impl FnMut(String)) -> AppResult<Reactivated> {
    let conn = db::open(&state.db_path)?;
    let loaded = available_paths().unwrap_or_default();
    let mut done = Reactivated::default();
    for path in paths.iter().filter(|p| !loaded.contains(*p)) {
        let _guard = lock();
        // Re-check under the lock: the user may have turned it off or removed its folder since.
        let Some(scope) = wanted_scope(&conn, path).unwrap_or(None) else { continue };
        let p = Path::new(path);
        if !p.exists() {
            on_missing(path.clone());
        } else if let Err(e) = activate_in(p, scope) {
            eprintln!("fontface: couldn't turn {path} back on: {e}");
            done.failed += 1;
        } else {
            if scope == Scope::Session {
                // Listed already; recorded like any other turn-on, so the list stays the truth.
                if let Err(e) = state.write(|conn| record_scope(conn, path, scope)) {
                    eprintln!("fontface: couldn't record {path} as on for this login: {e}");
                }
            }
            done.restored += 1;
        }
    }
    Ok(done)
}

/// Whether a file is still wanted on, and in which scope. `None`: it's off now, or only in a
/// macOS font folder. Session scope if it's listed as temporary, else persistent. Launch never
/// hands `reconcile` a temporary file (an ended login is recorded as off, and a live one is
/// loaded), so only a temporary font whose folder moved (Locate…) comes back in session scope.
pub fn wanted_scope(conn: &Connection, path: &str) -> AppResult<Option<Scope>> {
    let (wanted, temporary): (bool, bool) = conn.query_row(
        "SELECT COALESCE((SELECT MAX(fonts.activated) FROM fonts JOIN folders ON folders.id = fonts.folder_id
                          WHERE fonts.path = ?1 AND folders.kind != 'system'), 0),
                EXISTS(SELECT 1 FROM temporary_activations WHERE path = ?1)",
        [path],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(wanted.then_some(if temporary { Scope::Session } else { Scope::Persistent }))
}

// ------------------------------------------------------------------ temporary activations

/// Files Fontface turned on for this login only (session scope). Outside the numbered
/// migrations in db.rs, like the tag tables, so it merges cleanly with other features.
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS temporary_activations (path TEXT PRIMARY KEY);";

/// Creates the table if it's missing. Idempotent; called once at launch.
pub fn ensure_schema(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(SCHEMA)?;
    Ok(())
}

pub fn temporary_paths(conn: &Connection) -> AppResult<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT path FROM temporary_activations")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Records the scope a file was just turned on in: session scope lists it as temporary,
/// persistent scope takes it off the list.
pub fn record_scope(conn: &Connection, path: &str, scope: Scope) -> AppResult<()> {
    match scope {
        Scope::Session => conn.execute("INSERT OR IGNORE INTO temporary_activations (path) VALUES (?1)", [path])?,
        Scope::Persistent => conn.execute("DELETE FROM temporary_activations WHERE path = ?1", [path])?,
    };
    Ok(())
}

/// A file was turned off, so it's no longer on temporarily.
pub fn forget_temporary(conn: &Connection, path: &str) -> AppResult<()> {
    conn.execute("DELETE FROM temporary_activations WHERE path = ?1", [path])?;
    Ok(())
}

/// What turning a file on does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnOn {
    Register(Scope),
    /// It's already on in the other scope: leave it as it is.
    AlreadyOn,
}

/// Turning on a file that's already on leaves it in the scope it has. So in persistent mode, a
/// font that's on temporarily stays temporary (it goes away at logout, and isn't registered
/// twice). In temporary mode, a font Fontface already keeps on for good stays that way, so
/// quitting with "turn off temporary fonts" can't take away a font the user meant to keep.
/// Anything else is registered in the mode's scope.
pub fn turn_on_plan(mode: ActivationMode, recorded_on: bool, temporary: bool, loaded: bool) -> TurnOn {
    match mode {
        ActivationMode::Persistent if loaded && temporary => TurnOn::AlreadyOn,
        ActivationMode::Temporary if loaded && recorded_on && !temporary => TurnOn::AlreadyOn,
        mode => TurnOn::Register(mode.into()),
    }
}

/// A file an update, replacement or removal turned off, with the scope it was on in, so it can
/// come back exactly as it was.
pub type TurnedOff = (String, Scope);

/// After an update or a replacement, which fonts come back on for this login only. Each font
/// keeps the scope it had: one that was on temporarily comes back temporarily, and one that was
/// on to stay comes back to stay, whatever the activation mode is now. A font that's new in this
/// version (e.g. statics rebuilt as a variable font) comes back temporarily only if everything
/// that was on was temporary.
///
/// `was_on`: (name, scope) for each font that was on. `old`: every name in the old copy. `new`:
/// every name in the new one. Names are file names (Google Fonts) or PostScript names
/// (purchases). Returns the names to turn on temporarily, sorted; the rest come back to stay.
pub fn temporary_after_swap(was_on: &[(String, Scope)], old: &HashSet<String>, new: &[String]) -> Vec<String> {
    let kept: HashSet<&String> = was_on.iter().filter(|(_, s)| *s == Scope::Persistent).map(|(n, _)| n).collect();
    let mut temporary: BTreeSet<String> =
        was_on.iter().filter(|(n, s)| *s == Scope::Session && !kept.contains(n)).map(|(n, _)| n.clone()).collect();
    if !was_on.is_empty() && kept.is_empty() {
        temporary.extend(new.iter().filter(|n| !old.contains(*n)).cloned());
    }
    temporary.into_iter().collect()
}

/// Turns off every temporary activation (at quit, when the user chose that in settings). Files
/// that turn off are recorded as off and leave the list; any that fail stay listed, so the next
/// launch sees the truth. Returns how many turned off.
pub fn clear_temporary(state: &AppState) -> AppResult<usize> {
    let _guard = lock();
    let paths = temporary_paths(&*state.conn()?)?;
    let mut done = Vec::new();
    for path in paths {
        match deactivate_in(Path::new(&path), Scope::Session) {
            Ok(()) => done.push(path),
            Err(e) => eprintln!("fontface: couldn't turn off {path} at quit: {e}"),
        }
    }
    if !done.is_empty() {
        state.write(|conn| {
            let tx = conn.transaction()?;
            for path in &done {
                tx.execute("UPDATE fonts SET activated = 0 WHERE path = ?1", [path])?;
                forget_temporary(&tx, path)?;
            }
            tx.commit()?;
            Ok(())
        })?;
    }
    Ok(done.len())
}

// ---------------------------------------------------------------------------------- launch

/// What launch does with recorded intent the OS isn't honoring. Every list is sorted.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    /// Temporary activations the OS no longer has: the login session ended. Recorded as off and
    /// taken off the list. Never turned back on.
    pub expired: Vec<String>,
    /// Turn back on now (persistent scope).
    pub reactivate: Vec<String>,
    /// Missing files (a drive that isn't mounted yet): intent is kept, and they're retried after
    /// their folder's next scan, whatever the policy. Their being off isn't the user's doing.
    pub deferred: Vec<String>,
    /// "ask": files to ask the user about.
    pub ask: Vec<String>,
    /// "never": the user accepts what the OS has, so these are recorded as off.
    pub record_off: Vec<String>,
}

/// Decides what launch does. `recorded_on`: files Fontface was asked to keep on (outside the
/// macOS font folders). `temporary`: files turned on for one login. `loaded`: what the OS has
/// loaded now. `exists`: whether a file is on disk. Files that are loaded need nothing, except
/// that a temporary one stays listed.
pub fn launch_plan(
    recorded_on: &HashSet<String>,
    temporary: &HashSet<String>,
    loaded: &HashSet<String>,
    exists: impl Fn(&str) -> bool,
    policy: RestorePolicy,
) -> LaunchPlan {
    let mut plan = LaunchPlan::default();
    let temporary: BTreeSet<&String> = temporary.iter().collect();
    for path in &temporary {
        if !loaded.contains(*path) {
            plan.expired.push((*path).clone());
        }
    }
    let recorded_on: BTreeSet<&String> = recorded_on.iter().collect();
    for path in recorded_on {
        if loaded.contains(path) || temporary.contains(path) {
            continue;
        }
        let list = if !exists(path) {
            &mut plan.deferred
        } else {
            match policy {
                RestorePolicy::Always => &mut plan.reactivate,
                RestorePolicy::Ask => &mut plan.ask,
                RestorePolicy::Never => &mut plan.record_off,
            }
        };
        list.push(path.clone());
    }
    plan
}

/// Reads what launch needs and decides (see `launch_plan`). `None` when the OS can't say what's
/// loaded: then launch changes nothing.
pub fn plan_launch(state: &AppState, policy: RestorePolicy) -> AppResult<Option<LaunchPlan>> {
    let Some(loaded) = available_paths() else { return Ok(None) };
    let (recorded_on, temporary) = {
        let conn = state.conn()?;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT fonts.path FROM fonts JOIN folders ON folders.id = fonts.folder_id
             WHERE fonts.activated = 1 AND folders.kind != 'system'",
        )?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        let recorded_on: HashSet<String> = rows.collect::<Result<_, _>>()?;
        (recorded_on, temporary_paths(&conn)?)
    };
    Ok(Some(launch_plan(&recorded_on, &temporary, &loaded, |p| Path::new(p).exists(), policy)))
}

/// Carries out the plan, except `ask`, which waits for the user. Missing files are passed to
/// `on_missing`, to be retried after their folder's next scan.
pub fn apply_launch(state: &AppState, plan: &LaunchPlan, on_missing: impl FnMut(String)) -> AppResult<Reactivated> {
    expire(state, &plan.expired)?;
    record_off_unless_loaded(state, &plan.record_off)?;
    // Deferred files go through reconcile too: one that has appeared since is turned on now.
    let again: HashSet<String> = plan.reactivate.iter().chain(&plan.deferred).cloned().collect();
    if again.is_empty() {
        return Ok(Reactivated::default());
    }
    reconcile(state, &again, on_missing)
}

/// Temporary activations whose login session ended: recorded as off and taken off the list.
fn expire(state: &AppState, paths: &[String]) -> AppResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let _guard = lock();
    // Re-check under the lock: the user may have turned one back on since.
    let loaded = available_paths().unwrap_or_default();
    state.write(|conn| {
        let tx = conn.transaction()?;
        for path in paths.iter().filter(|p| !loaded.contains(*p)) {
            tx.execute("UPDATE fonts SET activated = 0 WHERE path = ?1", [path])?;
            forget_temporary(&tx, path)?;
        }
        tx.commit()?;
        Ok(())
    })
}

/// Records these files as off, unless the OS has them loaded now (the user may have turned one
/// on since). Used for the "never" policy, and when the user answers "Leave them off".
pub fn record_off_unless_loaded(state: &AppState, paths: &[String]) -> AppResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let _guard = lock();
    // If the OS can't say, keep the intent: guessing wrong would lose the user's choice.
    let Some(loaded) = available_paths() else { return Ok(()) };
    state.write(|conn| {
        let tx = conn.transaction()?;
        for path in paths.iter().filter(|p| !loaded.contains(*p)) {
            tx.execute("UPDATE fonts SET activated = 0 WHERE path = ?1", [path])?;
        }
        tx.commit()?;
        Ok(())
    })
}
