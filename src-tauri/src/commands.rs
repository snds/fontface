//! Commands the UI calls. All run off the main thread (`async`), so a slow CoreText call or a
//! big library query never freezes the window.

use std::{
    collections::{BTreeSet, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering::Relaxed},
        Arc,
    },
};

use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::watch;

use crate::{
    activation, db, services,
    error::{AppError, AppResult},
    model::{ActivationOutcome, Folder, FontDetail, FontSummary, ScanReport},
    scanner, AppState, RunningScan,
};

#[tauri::command(async)]
pub fn list_folders(state: State<'_, AppState>) -> AppResult<Vec<Folder>> {
    let mut folders = db::list_folders(&*state.conn()?)?;
    db::check_folders(&mut folders); // filesystem checks, after the DB lock is released
    Ok(folders)
}

#[tauri::command(async)]
pub fn add_folder(state: State<'_, AppState>, path: String) -> AppResult<Folder> {
    let canonical = std::fs::canonicalize(&path)?;
    if !canonical.is_dir() {
        return Err(AppError::Invalid(format!("{path} is not a folder")));
    }
    let id = state.write(|conn| db::insert_folder(conn, &canonical, "user"))?;
    let mut folder = db::get_folder(&*state.conn()?, id)?;
    db::check_folders(std::slice::from_mut(&mut folder));
    Ok(folder)
}

/// Removes a user folder from the library. A running scan of it is cancelled, and its fonts are
/// turned off first, so nothing stays active that the app no longer knows about.
/// The macOS font folders can't be removed.
#[tauri::command(async)]
pub fn remove_folder(state: State<'_, AppState>, folder_id: i64) -> AppResult<Vec<ActivationOutcome>> {
    if let Some(running) = state.scans()?.get(&folder_id) {
        running.cancel.store(true, Relaxed);
    }
    // Take the activation lock before reading which fonts are on, and hold it through the
    // delete, so no other change (a click, a reconcile) can slip in between.
    let _guard = activation::lock();
    let (paths, active): (Vec<String>, Vec<String>) = {
        let conn = state.conn()?;
        match db::get_folder(&conn, folder_id)?.kind.as_str() {
            "system" => return Err(AppError::Invalid("macOS font folders are always part of the library".into())),
            "service" => {
                return Err(AppError::Invalid("Service folders are managed by Fontface. Remove fonts from the service instead.".into()))
            }
            _ => {}
        }
        let all = conn
            .prepare("SELECT DISTINCT path FROM fonts WHERE folder_id = ?1")?
            .query_map([folder_id], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        let on = conn
            .prepare("SELECT DISTINCT path FROM fonts WHERE folder_id = ?1 AND activated = 1")?
            .query_map([folder_id], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        (all, on)
    };
    let mut failures = Vec::new();
    for path in active {
        if let Err(e) = activation::deactivate(Path::new(&path)) {
            failures.push(ActivationOutcome { path, ids: vec![], active: true, error: Some(e.to_string()) });
        }
    }
    state.write(|conn| Ok(conn.execute("DELETE FROM folders WHERE id = ?1", [folder_id])?))?;
    let paths: HashSet<String> = paths.into_iter().collect();
    state.deferred().retain(|p| !paths.contains(p));
    state.seen_loaded().retain(|p| !paths.contains(p));
    Ok(failures)
}

type ScanResult = Option<Result<ScanReport, String>>;

enum ScanStart {
    /// A scan of this folder is already running; wait for its result.
    Wait(watch::Receiver<ScanResult>),
    Run(Arc<AtomicBool>, watch::Sender<ScanResult>),
}

/// Scans one folder. If a scan of it is already running, waits for that one and returns its
/// result, so a reloaded window can pick up a scan already in progress.
#[tauri::command]
pub async fn scan_folder(app: AppHandle, state: State<'_, AppState>, folder_id: i64) -> AppResult<ScanReport> {
    let root = db::get_folder(&*state.conn()?, folder_id)?.path;
    let start = {
        let mut scans = state.scans()?;
        match scans.get(&folder_id) {
            Some(running) => ScanStart::Wait(running.done.clone()),
            None => {
                let cancel = Arc::new(AtomicBool::new(false));
                let (tx, rx) = watch::channel(None);
                scans.insert(folder_id, RunningScan { cancel: cancel.clone(), done: rx });
                ScanStart::Run(cancel, tx)
            }
        }
    };
    let (cancel, done) = match start {
        ScanStart::Wait(mut rx) => {
            let result = rx
                .wait_for(Option::is_some)
                .await
                .map_err(|_| AppError::Other("the scan ended unexpectedly".into()))?
                .clone()
                .expect("wait_for guarantees Some");
            return result.map_err(AppError::Other);
        }
        ScanStart::Run(cancel, tx) => (cancel, tx),
    };

    let db_path = state.db_path.clone();
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let report = scanner::scan_folder(&db_path, folder_id, Path::new(&root), &cancel, |p| {
            let _ = handle.emit("scan-progress", p);
        })?;
        if !report.cancelled {
            retry_deferred(&handle, &db_path, folder_id);
        }
        Ok(report)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))
    .and_then(|r| r);

    // Publish the result to anyone waiting, then free the folder for the next scan.
    let shared = match &result {
        Ok(report) => Ok(report.clone()),
        Err(e) => Err(e.to_string()),
    };
    let _ = done.send(Some(shared));
    if let Ok(mut scans) = app.state::<AppState>().scans() {
        scans.remove(&folder_id);
    }
    result
}

/// Turns back on fonts in this folder that were active but unreachable at launch. Selected by
/// folder ownership, not path prefix: a folder can list files that live elsewhere via symlinks.
fn retry_deferred(app: &AppHandle, db_path: &Path, folder_id: i64) {
    let state = app.state::<AppState>();
    if state.deferred().is_empty() {
        return;
    }
    let owned: HashSet<String> = match db::open(db_path).and_then(|conn| {
        let mut stmt = conn.prepare("SELECT DISTINCT path FROM fonts WHERE folder_id = ?1")?;
        let rows = stmt.query_map([folder_id], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }) {
        Ok(set) => set,
        Err(e) => return eprintln!("fontface: retrying activations failed: {e}"),
    };
    let subset: HashSet<String> = state.deferred().iter().filter(|p| owned.contains(*p)).cloned().collect();
    if subset.is_empty() {
        return;
    }
    state.deferred().retain(|p| !subset.contains(p));
    if let Err(e) = activation::reconcile(db_path, Some(&subset), |path| {
        state.deferred().insert(path);
    }) {
        eprintln!("fontface: retrying activations failed: {e}");
    }
}

#[tauri::command(async)]
pub fn cancel_scan(state: State<'_, AppState>, folder_id: i64) -> AppResult<()> {
    if let Some(running) = state.scans()?.get(&folder_id) {
        running.cancel.store(true, Relaxed);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn list_fonts(state: State<'_, AppState>) -> AppResult<Vec<FontSummary>> {
    let loaded = activation::available_paths();
    let mut fonts = db::list_fonts(&*state.conn()?)?;
    db::apply_os_state(&mut fonts, loaded.as_ref());
    if loaded.is_some() {
        notice_turned_off_elsewhere(&state, &mut fonts);
    }
    Ok(fonts)
}

/// A font Fontface turned on, that macOS was loading earlier this session, and that's now
/// unloaded while its file is still there: another app (Typeface, Font Book) turned it off.
/// Record that as the user's choice, so the next launch doesn't silently turn it back on.
fn notice_turned_off_elsewhere(state: &AppState, fonts: &mut [FontSummary]) {
    let mut dropped = Vec::new();
    {
        let mut seen = state.seen_loaded();
        for f in fonts.iter().filter(|f| f.activated && !f.installed) {
            if f.os_active {
                seen.insert(f.path.clone());
            } else if seen.contains(&f.path) && Path::new(&f.path).exists() {
                dropped.push(f.path.clone());
            }
        }
    }
    if dropped.is_empty() {
        return;
    }
    // Confirm under the activation lock, so an on/off request in flight isn't misread.
    let _guard = activation::lock();
    let loaded = activation::available_paths().unwrap_or_default();
    let dropped: HashSet<String> = dropped.into_iter().filter(|p| !loaded.contains(p)).collect();
    let still_wanted = |path: &String| -> bool {
        state
            .conn()
            .and_then(|c| Ok(c.query_row("SELECT COALESCE(MAX(activated), 0) FROM fonts WHERE path = ?1", [path], |r| r.get(0))?))
            .unwrap_or(false)
    };
    let dropped: HashSet<String> = dropped.into_iter().filter(still_wanted).collect();
    if dropped.is_empty() {
        return;
    }
    let written = state.write(|conn| {
        for path in &dropped {
            conn.execute("UPDATE fonts SET activated = 0 WHERE path = ?1", [path])?;
        }
        Ok(())
    });
    if written.is_ok() {
        state.seen_loaded().retain(|p| !dropped.contains(p));
        for f in fonts.iter_mut().filter(|f| dropped.contains(&f.path)) {
            f.activated = false;
        }
    }
}

#[tauri::command(async)]
pub fn get_font(state: State<'_, AppState>, font_id: i64) -> AppResult<FontDetail> {
    let loaded = activation::available_paths();
    let mut detail =
        db::get_font(&*state.conn()?, font_id)?.ok_or_else(|| AppError::NotFound(format!("font {font_id}")))?;
    db::apply_os_state(std::slice::from_mut(&mut detail.summary), loaded.as_ref());
    Ok(detail)
}

/// Turns fonts on or off, then checks with the OS that it worked. Work is grouped by file,
/// because the OS acts on whole files. Fonts in macOS font folders are always on.
#[tauri::command(async)]
pub fn set_activation(state: State<'_, AppState>, font_ids: Vec<i64>, active: bool) -> AppResult<Vec<ActivationOutcome>> {
    // (path, installed, every face id in that file)
    let files: Vec<(String, bool, Vec<i64>)> = {
        let conn = state.conn()?;
        let mut paths = BTreeSet::new();
        let mut stmt = conn.prepare_cached(
            "SELECT fonts.path, folders.kind = 'system' FROM fonts
             JOIN folders ON folders.id = fonts.folder_id WHERE fonts.id = ?1",
        )?;
        for id in &font_ids {
            if let Some(row) = stmt.query_row([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))).optional()? {
                paths.insert(row);
            }
        }
        let mut ids_stmt = conn.prepare_cached("SELECT id FROM fonts WHERE path = ?1")?;
        let mut files = Vec::with_capacity(paths.len());
        for (path, installed) in paths {
            let ids = ids_stmt.query_map([&path], |r| r.get(0))?.collect::<Result<Vec<i64>, _>>()?;
            files.push((path, installed, ids));
        }
        files
    };

    // One activation lock for the whole request, through verification, so two requests (or a
    // folder removal) never interleave. The DB mutex is not held during CoreText calls, which
    // can take a while (e.g. if a file must download first).
    let _guard = activation::lock();
    let mut outcomes = Vec::with_capacity(files.len());
    let mut to_verify = Vec::new();
    for (path, installed, ids) in files {
        if installed {
            let error = (!active).then(|| "Installed in a macOS font folder, so it's always on".to_string());
            outcomes.push(ActivationOutcome { path, ids, active: true, error });
            continue;
        }
        // Its folder may have been removed while this request waited for the lock.
        let still_listed: bool = state
            .conn()?
            .query_row("SELECT EXISTS(SELECT 1 FROM fonts WHERE path = ?1)", [&path], |r| r.get(0))?;
        if !still_listed {
            outcomes.push(ActivationOutcome { path, ids, active: false, error: Some("Its folder was removed from the library".into()) });
            continue;
        }
        let result = if active {
            activation::activate(Path::new(&path))
        } else {
            activation::deactivate(Path::new(&path))
        };
        match result {
            Ok(()) => {
                state.write(|conn| Ok(conn.execute("UPDATE fonts SET activated = ?1 WHERE path = ?2", params![active, path])?))?;
                to_verify.push(outcomes.len());
                outcomes.push(ActivationOutcome { path, ids, active, error: None });
            }
            Err(e) => outcomes.push(ActivationOutcome { path, ids, active: !active, error: Some(e.to_string()) }),
        }
    }

    verify_with_os(&mut outcomes, &to_verify, active);
    {
        let mut seen = state.seen_loaded();
        for o in &outcomes {
            if o.active {
                seen.insert(o.path.clone());
            } else {
                seen.remove(&o.path);
            }
        }
    }
    Ok(outcomes)
}

/// "Already registered" and "not registered" count as success, but don't prove the OS state
/// changed. Check what's actually loaded, and explain any difference. Runs under the caller's
/// activation lock.
fn verify_with_os(outcomes: &mut [ActivationOutcome], indexes: &[usize], active: bool) {
    let Some(loaded) = activation::available_paths() else { return };
    let mut still_on = Vec::new();
    for &i in indexes {
        let on = loaded.contains(&outcomes[i].path);
        if active && !on {
            outcomes[i].active = false;
            outcomes[i].error = Some("macOS didn't load this font. It may be turned off in Font Book.".into());
        } else if !active && on {
            // Another app (often with session scope) has it on too. Try removing that as well.
            let _ = activation::deactivate_elsewhere(Path::new(&outcomes[i].path));
            still_on.push(i);
        }
    }
    if still_on.is_empty() {
        return;
    }
    let loaded = activation::available_paths().unwrap_or_default();
    for i in still_on {
        if loaded.contains(&outcomes[i].path) {
            outcomes[i].active = true;
            outcomes[i].error = Some(
                "Still on: another app (such as Typeface or Font Book) has turned this font on. Turn it off there.".into(),
            );
        }
    }
}

#[tauri::command(async)]
pub fn reveal_font(state: State<'_, AppState>, font_id: i64) -> AppResult<()> {
    let path: String = state
        .conn()?
        .query_row("SELECT path FROM fonts WHERE id = ?1", [font_id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("font {font_id}")))?;
    reveal(Path::new(&path))
}

#[cfg(target_os = "macos")]
fn reveal(path: &Path) -> AppResult<()> {
    refuse_adobe(path)?;
    std::process::Command::new("open").arg("-R").arg(path).spawn()?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn reveal(path: &Path) -> AppResult<()> {
    refuse_adobe(path)?;
    std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).spawn()?;
    Ok(())
}

/// Creative Cloud's font files are never revealed, read or switched (Adobe's terms).
fn refuse_adobe(path: &Path) -> AppResult<()> {
    if services::adobe::is_adobe_path(path) || std::fs::canonicalize(path).is_ok_and(|p| services::adobe::is_adobe_path(&p)) {
        return Err(AppError::Invalid("That's an Adobe Fonts file managed by Creative Cloud".into()));
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn reveal(_: &Path) -> AppResult<()> {
    Err(AppError::Unsupported("reveal in file manager".into()))
}

// ---------------------------------------------------------------------------------- services

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    id: &'static str,
    folder_id: Option<i64>,
}

/// Each download service with its managed library folder.
#[tauri::command(async)]
pub fn list_services(state: State<'_, AppState>) -> AppResult<Vec<ServiceInfo>> {
    let folders = db::list_folders(&*state.conn()?)?;
    Ok(services::DOWNLOAD_SERVICES
        .iter()
        .map(|(id, _)| ServiceInfo {
            id,
            folder_id: folders
                .iter()
                .find(|f| f.kind == "service" && services::service_for_path(&state.data_dir, Path::new(&f.path)) == Some(*id))
                .map(|f| f.id),
        })
        .collect())
}

#[tauri::command]
pub async fn google_catalog(state: State<'_, AppState>, refresh: bool) -> AppResult<services::google::Catalog> {
    let data_dir = state.data_dir.clone();
    blocking(move || services::google::catalog(&data_dir, refresh)).await
}

/// Runs blocking work (network, disk) off the async worker threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| AppError::Other(e.to_string()))?
}

/// Marks a family as busy for the life of the guard, so two operations on it never overlap.
struct FamilyOp<'a> {
    state: &'a AppState,
    id: String,
}

impl<'a> FamilyOp<'a> {
    fn start(state: &'a AppState, id: &str) -> AppResult<Self> {
        let mut ops = state.service_ops.lock().unwrap_or_else(|p| p.into_inner());
        if !ops.insert(id.to_string()) {
            return Err(AppError::Invalid("Already working on that family".into()));
        }
        Ok(FamilyOp { state, id: id.to_string() })
    }
}

impl Drop for FamilyOp<'_> {
    fn drop(&mut self) {
        self.state.service_ops.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.id);
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleInstallResult {
    dir: String,
    files: Vec<String>,
    /// An earlier copy was replaced (an update).
    updated: bool,
    /// For an update: file names that were on before, so the UI turns exactly those back on.
    was_active_files: Vec<String>,
    /// For an update: every font file name in the copy that was replaced. A new file name that
    /// isn't here replaces a renamed one (e.g. statics rebuilt as a variable font).
    old_files: Vec<String>,
}

/// Downloads (or updates) a Google Fonts family into the managed folder. The new files are
/// downloaded and checked first. Only then are the old fonts turned off and swapped out; if the
/// swap fails, they're turned back on. The UI then rescans the folder and turns fonts on.
#[tauri::command]
pub async fn google_install(app: AppHandle, id: String) -> AppResult<GoogleInstallResult> {
    blocking(move || {
        let state = app.state::<AppState>();
        let _op = FamilyOp::start(&state, &id)?;
        let family = services::google::find(&state.data_dir, &id)?;
        let prepared = services::google::prepare(&state.data_dir, &family)?;
        let files = prepared.files.clone();
        let old_files = prepared.old_files.clone();
        let (updated, turned_off) = match prepared.replaces.clone() {
            Some(dir) => (true, turn_off_under(&state, &dir)?),
            None => (false, Vec::new()),
        };
        let dir = match services::google::commit(prepared) {
            Ok(dir) => dir,
            Err(e) => {
                restore(&state, &turned_off);
                return Err(e);
            }
        };
        let was_active_files = turned_off
            .iter()
            .filter_map(|p| Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()))
            .collect();
        Ok(GoogleInstallResult { dir, files, updated, was_active_files, old_files })
    })
    .await
}

/// Removes a Google Fonts family: its fonts are turned off, then its folder is deleted.
/// The UI rescans the service folder afterwards.
#[tauri::command]
pub async fn google_remove(app: AppHandle, id: String) -> AppResult<()> {
    blocking(move || {
        let state = app.state::<AppState>();
        let _op = FamilyOp::start(&state, &id)?;
        let dir = services::google::installed_dir(&state.data_dir, &id)
            .ok_or_else(|| AppError::NotFound(format!("{id} isn't installed")))?;
        let turned_off = turn_off_under(&state, &dir)?;
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            restore(&state, &turned_off);
            return Err(e.into());
        }
        Ok(())
    })
    .await
}

/// Turns off every active font file under `dir` and records them as off. Returns the paths it
/// turned off. If one fails, the ones already turned off are turned back on and the error returned.
fn turn_off_under(state: &AppState, dir: &Path) -> AppResult<Vec<String>> {
    let _guard = activation::lock();
    let real = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let prefix = format!("{}/", real.to_string_lossy().trim_end_matches('/'));
    let paths: Vec<String> = state
        .conn()?
        .prepare("SELECT DISTINCT path FROM fonts WHERE activated = 1 AND substr(path, 1, length(?1)) = ?1")?
        .query_map([&prefix], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let mut done = Vec::new();
    for path in &paths {
        if let Err(e) = activation::deactivate(Path::new(path)) {
            for p in &done {
                let _ = activation::activate(Path::new(p));
            }
            return Err(e);
        }
        done.push(path.clone());
    }
    state.write(|conn| {
        conn.execute("UPDATE fonts SET activated = 0 WHERE substr(path, 1, length(?1)) = ?1", [&prefix])?;
        Ok(())
    })?;
    state.seen_loaded().retain(|p| !p.starts_with(&prefix));
    Ok(done)
}

/// Turns fonts back on after a failed swap, and records them as on again.
fn restore(state: &AppState, paths: &[String]) {
    let _guard = activation::lock();
    for path in paths {
        if activation::activate(Path::new(path)).is_ok() {
            let _ = state.write(|conn| Ok(conn.execute("UPDATE fonts SET activated = 1 WHERE path = ?1", [path])?));
        }
    }
}

#[tauri::command(async)]
pub fn adobe_status() -> services::adobe::AdobeStatus {
    services::adobe::status()
}

// --------------------------------------------------------------------------------- purchases

use services::purchases;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchFolder {
    path: String,
    /// Why it can't be read right now, if it can't (missing, or no permission).
    problem: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchasesStatus {
    watching: bool,
    folders: Vec<WatchFolder>,
    finds: Vec<purchases::Find>,
    imported: Vec<purchases::Imported>,
    stores: &'static [purchases::Store],
}

/// (Re)starts or stops the purchases watcher to match the saved settings, and checks the
/// watched folders once in the background (catching downloads made while the app was closed).
/// The settings are read while holding the watcher lock, so the last of several quick changes wins.
pub fn restart_purchase_watcher(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut slot = state.purchase_watcher.lock().unwrap_or_else(|p| p.into_inner());
    *slot = None; // stops the old watcher and its worker
    state.purchase_watch_failed.lock().unwrap_or_else(|p| p.into_inner()).clear();
    let Ok(conn) = db::open(&state.db_path) else { return };
    let on = purchases::watching(&conn);
    let folders = purchases::watch_folders(&conn).unwrap_or_default();
    if !on || folders.is_empty() {
        return;
    }
    let (watcher, failed) = services::purchase_watch::start(app.clone(), state.db_path.clone(), &folders);
    *state.purchase_watch_failed.lock().unwrap_or_else(|p| p.into_inner()) = failed.into_iter().collect();
    *slot = watcher;
    drop(slot);
    let (handle, db_path) = (app.clone(), state.db_path.clone());
    std::thread::spawn(move || {
        if let Ok(conn) = db::open(&db_path) {
            if let Ok(new) = purchases::check_folders(&conn) {
                if !new.is_empty() {
                    let _ = handle.emit("purchases-changed", &new);
                }
            }
        }
    });
}

#[tauri::command]
pub async fn purchases_status(app: AppHandle) -> AppResult<PurchasesStatus> {
    blocking(move || {
        let state = app.state::<AppState>();
        let conn = db::open(&state.db_path)?;
        let watching = purchases::watching(&conn);
        let failed = state.purchase_watch_failed.lock().unwrap_or_else(|p| p.into_inner()).clone();
        Ok(PurchasesStatus {
            watching,
            folders: purchases::watch_folders(&conn)?
                .into_iter()
                .map(|path| WatchFolder {
                    problem: purchases::folder_problem(&path).or_else(|| {
                        failed.get(&path).filter(|_| watching).map(|e| format!("Not being watched: {e}"))
                    }),
                    path,
                })
                .collect(),
            finds: purchases::finds(&conn)?,
            imported: purchases::imported(&state.data_dir),
            stores: purchases::STORES,
        })
    })
    .await
}

/// Turns watching on or off. The first time it's turned on with no folders, Downloads is added.
#[tauri::command]
pub async fn purchases_set_watching(app: AppHandle, on: bool) -> AppResult<()> {
    blocking(move || {
        let state = app.state::<AppState>();
        let downloads = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Downloads"));
        state.write(|conn| {
            if on && purchases::watch_folders(conn)?.is_empty() {
                let downloads = downloads.ok_or_else(|| AppError::Other("Couldn't find your Downloads folder".into()))?;
                purchases::add_watch_folder(conn, &purchases::validate_watch_folder(&downloads)?)?;
            }
            purchases::set_watching(conn, on)
        })?;
        restart_purchase_watcher(&app);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn purchases_add_folder(app: AppHandle, path: String) -> AppResult<()> {
    blocking(move || {
        let state = app.state::<AppState>();
        let real = purchases::validate_watch_folder(Path::new(&path))?;
        state.write(|conn| {
            purchases::check_not_nested(&purchases::watch_folders(conn)?, &real)?;
            purchases::add_watch_folder(conn, &real)
        })?;
        restart_purchase_watcher(&app);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn purchases_remove_folder(app: AppHandle, path: String) -> AppResult<()> {
    blocking(move || {
        let state = app.state::<AppState>();
        state.write(|conn| purchases::remove_watch_folder(conn, &path))?;
        restart_purchase_watcher(&app);
        Ok(())
    })
    .await
}

/// Looks through the watched folders now. Returns how many new font downloads were found.
#[tauri::command]
pub async fn purchases_check_now(app: AppHandle) -> AppResult<usize> {
    blocking(move || {
        let state = app.state::<AppState>();
        Ok(purchases::check_folders(&db::open(&state.db_path)?)?.len())
    })
    .await
}

/// Which store a picked file or folder came from, if it can be told (to preselect it).
#[tauri::command]
pub async fn purchases_detect_store(path: String) -> AppResult<Option<String>> {
    blocking(move || Ok(purchases::detect_store(Path::new(&path)).map(str::to_string))).await
}

/// Copies a found download's fonts and licenses into the Purchases folder. The UI then rescans
/// that folder and turns the new fonts on.
#[tauri::command]
pub async fn purchases_import(app: AppHandle, id: i64, store: Option<String>) -> AppResult<purchases::ImportResult> {
    blocking(move || {
        let state = app.state::<AppState>();
        let source = purchases::find_source(&db::open(&state.db_path)?, id)?;
        // One import per download, whether it was picked from the list or by hand.
        let _op = FamilyOp::start(&state, &format!("purchase-path:{}", source.path.display()))?;
        let store = store.filter(|s| !s.is_empty()).or(source.store).unwrap_or_else(|| purchases::OTHER.into());
        let result = purchases::import(&state.data_dir, &source.path, &store, source.origin_url, source.referrer)?;
        state.write(|conn| purchases::mark_imported(conn, id, &store, &result.dir))?;
        Ok(result)
    })
    .await
}

/// Imports a zip, font file or folder the user picked (older purchases, or a lost origin). With
/// no store chosen, the store is read from the file's origin when possible.
#[tauri::command]
pub async fn purchases_import_path(app: AppHandle, path: String, store: Option<String>) -> AppResult<purchases::ImportResult> {
    blocking(move || {
        let state = app.state::<AppState>();
        let source = std::fs::canonicalize(&path)?;
        let _op = FamilyOp::start(&state, &format!("purchase-path:{}", source.display()))?;
        let urls = purchases::origin(&source);
        let store = store
            .filter(|s| !s.is_empty())
            .or_else(|| purchases::store_for(&urls).map(|s| s.id.to_string()))
            .unwrap_or_else(|| purchases::OTHER.into());
        let result = purchases::import(&state.data_dir, &source, &store, urls.first().cloned(), urls.get(1).cloned())?;
        // If the watcher had listed this download, it's now imported.
        state.write(|conn| purchases::mark_path_imported(conn, &source, &store, &result.dir))?;
        Ok(result)
    })
    .await
}

/// Called when the window comes back to the front: if a watched folder couldn't be watched
/// before (a drive that wasn't connected) and can be read now, the watcher is restarted.
#[tauri::command]
pub async fn purchases_retry_watch(app: AppHandle) -> AppResult<bool> {
    blocking(move || {
        let state = app.state::<AppState>();
        let failed: Vec<String> = state.purchase_watch_failed.lock().unwrap_or_else(|p| p.into_inner()).keys().cloned().collect();
        let back = failed.iter().any(|f| purchases::folder_problem(f).is_none());
        if back {
            restart_purchase_watcher(&app);
        }
        Ok(back)
    })
    .await
}

#[tauri::command]
pub async fn purchases_dismiss(app: AppHandle, id: i64) -> AppResult<()> {
    blocking(move || app.state::<AppState>().write(|conn| purchases::dismiss(conn, id))).await
}

/// Removes an imported purchase: its fonts are turned off and the copied files deleted.
/// The original download is not touched.
#[tauri::command]
pub async fn purchases_remove(app: AppHandle, dir: String) -> AppResult<()> {
    blocking(move || remove_import(&app.state::<AppState>(), Path::new(&dir))).await
}

fn remove_import(state: &AppState, dir: &Path) -> AppResult<()> {
    if !purchases::is_import_dir(&state.data_dir, dir) {
        return Err(AppError::Invalid("That isn't a purchase Fontface imported".into()));
    }
    let _op = FamilyOp::start(state, &format!("purchase-dir:{}", dir.display()))?;
    let turned_off = turn_off_under(state, dir)?;
    if let Err(e) = purchases::delete_import_dir(dir) {
        restore(state, &turned_off);
        return Err(e.into());
    }
    state.write(|conn| purchases::forget_removed(conn, &dir.to_string_lossy()))?;
    Ok(())
}

/// Shows an imported purchase's folder (with its license files) in Finder / Explorer.
#[tauri::command(async)]
pub fn purchases_reveal(state: State<'_, AppState>, dir: String) -> AppResult<()> {
    if !purchases::is_import_dir(&state.data_dir, Path::new(&dir)) {
        return Err(AppError::Invalid("That isn't a purchase Fontface imported".into()));
    }
    reveal(Path::new(&dir))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalReport {
    removed: usize,
    /// (folder name, why) for each one that couldn't be removed.
    failed: Vec<(String, String)>,
}

/// For subscription stores (Envato Elements): the license ends with the subscription, so every
/// font imported from that store is turned off and removed. Every item is tried; the report
/// says which ones couldn't be removed.
#[tauri::command]
pub async fn purchases_subscription_ended(app: AppHandle, store: String) -> AppResult<RemovalReport> {
    blocking(move || {
        let state = app.state::<AppState>();
        let mut report = RemovalReport { removed: 0, failed: Vec::new() };
        for item in purchases::imported(&state.data_dir).into_iter().filter(|i| i.store == store && i.subscription_bound) {
            match remove_import(&state, Path::new(&item.dir)) {
                Ok(()) => report.removed += 1,
                Err(e) => report.failed.push((item.label, e.to_string())),
            }
        }
        Ok(report)
    })
    .await
}
