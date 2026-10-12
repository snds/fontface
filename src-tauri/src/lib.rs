mod activation;
mod cloud;
mod commands;
mod db;
mod error;
mod model;
mod protocol;
mod scanner;
mod services;
mod sfnt;

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc, Mutex, MutexGuard},
};

use rusqlite::Connection;
use tauri::Manager;

use error::{AppError, AppResult};

pub struct AppState {
    db: Mutex<Connection>,
    /// Long jobs (scans, reconcile) open their own connection; WAL mode lets them run alongside the UI's.
    db_path: PathBuf,
    /// The app's data folder (database, service downloads, caches).
    data_dir: PathBuf,
    /// Running scans by folder id.
    scans: Mutex<HashMap<i64, RunningScan>>,
    /// Active fonts whose files were unreachable when last re-applied (e.g. a cloud drive that
    /// hadn't mounted). Retried after their folder's next scan.
    deferred: Mutex<HashSet<String>>,
    /// Fonts Fontface wants on that the OS has been seen loading this session. If one later
    /// drops out while its file is still there, another app turned it off: that becomes the
    /// recorded choice, so the next launch doesn't silently turn it back on.
    seen_loaded: Mutex<HashSet<String>>,
    /// Service families (e.g. Google Fonts ids) with an install or removal in progress.
    service_ops: Mutex<HashSet<String>>,
    /// The purchases folder watcher, while watching is on.
    purchase_watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// Watched folders the watcher couldn't watch, with the reason (retried on window focus).
    purchase_watch_failed: Mutex<HashMap<String, String>>,
}

pub struct RunningScan {
    pub cancel: Arc<AtomicBool>,
    /// Becomes `Some` when the scan ends. A second request for the same folder waits on this,
    /// so it gets the same result (e.g. a reloaded window finds a scan that's still running).
    pub done: tokio::sync::watch::Receiver<Option<Result<model::ScanReport, String>>>,
}

impl AppState {
    pub fn conn(&self) -> AppResult<MutexGuard<'_, Connection>> {
        self.db.lock().map_err(|_| AppError::Other("database lock poisoned".into()))
    }

    pub fn scans(&self) -> AppResult<MutexGuard<'_, HashMap<i64, RunningScan>>> {
        self.scans.lock().map_err(|_| AppError::Other("scan registry lock poisoned".into()))
    }

    pub fn deferred(&self) -> MutexGuard<'_, HashSet<String>> {
        self.deferred.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn seen_loaded(&self) -> MutexGuard<'_, HashSet<String>> {
        self.seen_loaded.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// A UI-initiated write: takes the DB mutex first, then asks running scans to yield
    /// SQLite's write lock for exactly as long as this write needs it.
    pub fn write<T>(&self, f: impl FnOnce(&mut Connection) -> AppResult<T>) -> AppResult<T> {
        let mut conn = self.conn()?;
        let _gate = db::UiWriteGate::raise();
        f(&mut conn)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("ff", |ctx, req, resp| protocol::handle(ctx, req, resp))
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db_path = dir.join("library.sqlite3");
            let mut conn = db::open(&db_path)?;
            // The macOS font folders and the service folders are always in the library; the UI
            // scans them at launch.
            db::ensure_system_folders(&mut conn)?;
            db::purge_adobe_rows(&mut conn)?;
            services::ensure_service_folders(&mut conn, &dir)?;
            app.manage(AppState {
                db: Mutex::new(conn),
                db_path: db_path.clone(),
                data_dir: dir.clone(),
                scans: Mutex::default(),
                deferred: Mutex::default(),
                seen_loaded: Mutex::default(),
                service_ops: Mutex::default(),
                purchase_watcher: Mutex::default(),
                purchase_watch_failed: Mutex::default(),
            });
            commands::restart_purchase_watcher(app.handle());
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                // Each missing path is recorded the moment it's found, so a scan that finishes
                // while this is still running can already retry it.
                let state = handle.state::<AppState>();
                if let Err(e) = activation::reconcile(&db_path, None, |path| {
                    state.deferred().insert(path);
                }) {
                    eprintln!("fontface: reconcile failed: {e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_folders,
            commands::add_folder,
            commands::remove_folder,
            commands::scan_folder,
            commands::cancel_scan,
            commands::list_fonts,
            commands::get_font,
            commands::set_activation,
            commands::reveal_font,
            commands::list_services,
            commands::google_catalog,
            commands::google_install,
            commands::google_remove,
            commands::adobe_status,
            commands::purchases_status,
            commands::purchases_set_watching,
            commands::purchases_add_folder,
            commands::purchases_remove_folder,
            commands::purchases_check_now,
            commands::purchases_import,
            commands::purchases_import_path,
            commands::purchases_dismiss,
            commands::purchases_remove,
            commands::purchases_replace,
            commands::purchases_confirm_license,
            commands::purchases_transferred,
            commands::purchases_subscription_ended,
            commands::purchases_reveal,
            commands::purchases_detect_store,
            commands::purchases_retry_watch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Fontface");
}

#[cfg(test)]
mod tests;
