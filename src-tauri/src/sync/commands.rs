//! What the window asks sync to do.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::atomic::Ordering,
};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::{
    engine::{Engine, Exception, ExceptionFor},
    lock, quietly, restart_watcher, run_logged, shared, transport, wake, Shared, ENABLED,
};
use crate::{
    error::{AppError, AppResult},
    AppState,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub id: String,
    pub name: String,
    pub group: Option<String>,
    /// Milliseconds since 1970; 0 if never seen.
    pub last_seen: u64,
    pub app_version: String,
    /// Plain words, if something about this device's files is wrong.
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingFont {
    pub key: String,
    pub family: String,
    pub style: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub enabled: bool,
    pub folder: Option<String>,
    pub device_id: String,
    pub device_name: String,
    pub group: Option<String>,
    pub syncing: bool,
    /// When other devices' changes were last read (ms since 1970).
    pub last_sync: Option<u64>,
    /// Changes made here not yet written to the folder.
    pub pending: usize,
    /// Other devices, most recently seen first.
    pub devices: Vec<DeviceStatus>,
    /// Problems in plain words, not tied to one device.
    pub problems: Vec<String>,
    /// Fonts that should be on here but aren't on this computer.
    pub missing: Vec<MissingFont>,
    /// The folder is in a cloud drive, where files can be online-only.
    pub cloud_folder: bool,
    /// This computer took a new sync id because its app data came from another computer.
    pub cloned: bool,
    /// Another computer uses a newer sync format.
    pub newer_format: bool,
}

pub(super) fn status(sh: &Shared) -> AppResult<SyncStatus> {
    let state = sh.app.state::<AppState>();
    let faces = super::local_faces(&state).ok();
    let (mut status, missing) = {
        let guard = lock(&sh.engine);
        let Some(e) = guard.as_ref() else {
            return Err(AppError::Other("Sync is still starting".into()));
        };
        (status_of(sh, e), faces.map(|f| e.missing(&f)).unwrap_or_default())
    };
    // With the engine lock let go: a file on a network drive that dropped can take seconds to
    // check, and the user's switch and sync itself wait for that lock.
    status.missing = missing
        .into_iter()
        .filter(|m| m.not_here(|path| Path::new(path).exists()))
        .map(|m| MissingFont { key: m.key, family: m.family, style: m.style })
        .collect();
    Ok(status)
}

/// Everything in the status but the fonts not on this computer.
fn status_of(sh: &Shared, e: &Engine) -> SyncStatus {
    let me = e.me();
    let mut devices: Vec<DeviceStatus> = e
        .saved
        .peers
        .iter()
        .filter(|(id, _)| id.as_str() != me)
        .map(|(id, p)| DeviceStatus {
            id: id.clone(),
            name: if p.name.is_empty() { "A computer that hasn't said its name yet".into() } else { p.name.clone() },
            group: p.group.clone(),
            last_seen: p.last_seen,
            app_version: p.app_version.clone(),
            problem: e.problems.get(id).cloned(),
        })
        .collect();
    devices.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    let problems = e
        .problems
        .iter()
        .filter(|(k, _)| !super::is_device_id(k) || k.as_str() == me)
        .map(|(_, v)| v.clone())
        .collect();
    let newer_format = !e.newer_formats.is_empty() || e.problems.values().any(|p| p.contains("newer version"));
    SyncStatus {
        enabled: e.config.enabled,
        folder: e.config.folder.clone(),
        device_id: me.to_string(),
        device_name: e.config.name.clone(),
        group: e.config.group.clone(),
        syncing: sh.syncing.load(Ordering::SeqCst),
        last_sync: e.last_sync,
        pending: e.outbox.len(),
        devices,
        problems,
        missing: Vec::new(),
        cloud_folder: e.config.folder.as_deref().is_some_and(|f| super::is_cloud_folder(Path::new(f))),
        cloned: e.cloned,
        newer_format,
    }
}

fn sh() -> AppResult<&'static Shared> {
    shared().ok_or_else(|| AppError::Other("Sync is still starting".into()))
}

#[tauri::command(async)]
pub fn sync_status() -> AppResult<SyncStatus> {
    status(sh()?)
}

/// Turns sync on with this folder (or moves it to another folder). The "Fontface Sync" folder
/// is made inside it; picking that folder itself works too.
#[tauri::command(async)]
pub fn sync_set_folder(app: AppHandle, path: String) -> AppResult<SyncStatus> {
    let sh = sh()?;
    let state = app.state::<AppState>();
    let mut folder = PathBuf::from(&path);
    if folder.file_name().is_some_and(|n| n == transport::ROOT) {
        folder.pop();
    }
    if !folder.is_dir() {
        return Err(AppError::Invalid("That folder can't be found".into()));
    }
    let real = std::fs::canonicalize(&folder)?;
    let data = std::fs::canonicalize(&state.data_dir).unwrap_or_else(|_| state.data_dir.clone());
    if real.starts_with(&data) {
        return Err(AppError::Invalid("Choose a folder outside Fontface's own app data".into()));
    }
    let folder_str = real.to_string_lossy().into_owned();
    let me = lock(&sh.engine).as_ref().map(|e| e.me().to_string()).ok_or_else(|| AppError::Other("Sync is still starting".into()))?;
    // Check it can be written before saying yes.
    let probe = transport::FolderTransport::new(&real, &me);
    std::fs::create_dir_all(probe.watch_dir().join(&me))
        .map_err(|e| AppError::Invalid(format!("Fontface can't write in that folder: {e}")))?;
    {
        let _cycle = lock(&sh.cycle);
        let mut guard = lock(&sh.engine);
        let e = guard.as_mut().ok_or_else(|| AppError::Other("Sync is still starting".into()))?;
        quietly(|| {
            state.write(|conn| {
                if e.config.folder.as_deref() != Some(folder_str.as_str()) {
                    e.reset(conn)?;
                }
                e.config.folder = Some(folder_str.clone());
                e.config.enabled = true;
                e.save_config(conn)
            })
        })?;
        ENABLED.store(true, Ordering::SeqCst);
    }
    restart_watcher();
    wake(true, true);
    status(sh)
}

/// Turns sync off. Local tags and fonts stay as they are, and so do the files in the sync folder.
#[tauri::command(async)]
pub fn sync_turn_off(app: AppHandle) -> AppResult<SyncStatus> {
    let sh = sh()?;
    let state = app.state::<AppState>();
    {
        let _cycle = lock(&sh.cycle);
        let mut guard = lock(&sh.engine);
        let e = guard.as_mut().ok_or_else(|| AppError::Other("Sync is still starting".into()))?;
        quietly(|| {
            state.write(|conn| {
                e.config.enabled = false;
                e.reset(conn)?;
                e.save_config(conn)
            })
        })?;
        ENABLED.store(false, Ordering::SeqCst);
    }
    *lock(&sh.watcher) = None;
    status(sh)
}

/// Changes how this computer appears to the others, and which device group it's in. An empty
/// group means none.
#[tauri::command(async)]
pub fn sync_set_device(app: AppHandle, name: String, group: String) -> AppResult<SyncStatus> {
    let sh = sh()?;
    let state = app.state::<AppState>();
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let group = group.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(AppError::Invalid("This computer needs a name".into()));
    }
    if name.chars().count() > 100 || group.chars().count() > 100 || name.chars().chain(group.chars()).any(char::is_control) {
        return Err(AppError::Invalid("Names can be at most 100 characters".into()));
    }
    {
        let mut guard = lock(&sh.engine);
        let e = guard.as_mut().ok_or_else(|| AppError::Other("Sync is still starting".into()))?;
        // Fonts whose on/off changes with the group are carried out again; the rest stay as
        // they are here.
        e.set_group((!group.is_empty()).then_some(group));
        e.config.name = name;
        e.device_dirty = true;
        quietly(|| state.write(|conn| e.save_config(conn).and_then(|_| e.save_state(conn))))?;
    }
    wake(true, false);
    status(sh)
}

/// Reads other computers' changes and writes this one's, now. Returns when it's done.
#[tauri::command(async)]
pub fn sync_now() -> AppResult<SyncStatus> {
    let sh = sh()?;
    if !ENABLED.load(Ordering::SeqCst) {
        return Err(AppError::Invalid("Sync is off".into()));
    }
    run_logged(true);
    status(sh)
}

/// The window came to the front: worth checking for other computers' changes.
#[tauri::command(async)]
pub fn sync_poke() {
    super::note_remote();
}

/// This computer's exceptions: face key → "on" (always on here) or "off" (never on here).
#[tauri::command(async)]
pub fn sync_exceptions() -> AppResult<BTreeMap<String, Exception>> {
    let sh = sh()?;
    let guard = lock(&sh.engine);
    Ok(guard.as_ref().filter(|e| e.config.enabled).map(|e| e.exceptions()).unwrap_or_default())
}

/// Sets this computer's exception for fonts: "follow" (the shared choice), "on" or "off".
#[tauri::command(async)]
pub fn sync_set_exception(app: AppHandle, keys: Vec<String>, value: Exception, group: Option<bool>) -> AppResult<()> {
    let sh = sh()?;
    let state = app.state::<AppState>();
    let target = if group.unwrap_or(false) { ExceptionFor::ThisGroup } else { ExceptionFor::ThisDevice };
    {
        let mut guard = lock(&sh.engine);
        let e = guard.as_mut().filter(|e| e.config.enabled).ok_or_else(|| AppError::Invalid("Sync is off".into()))?;
        quietly(|| {
            state.write(|conn| {
                let tx = conn.transaction()?;
                e.set_exception(&tx, &keys, value, target)?;
                e.save_state(&tx)?;
                tx.commit()?;
                Ok(())
            })
        })?;
    }
    // Carried out by a cycle soon (it switches the fonts).
    wake(true, false);
    Ok(())
}
