mod activation;
mod backups;
mod cloud;
mod commands;
mod db;
mod error;
#[cfg(target_os = "macos")]
mod login_item;
mod model;
mod preview;
mod protocol;
mod scanner;
mod services;
mod settings;
mod sfnt;
mod sync;
mod tags;
mod window;

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc, Mutex, MutexGuard},
};

use rusqlite::Connection;
use tauri::{Emitter, Manager};

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
    /// The app settings, mirrored from the database so window and quit handlers never wait on
    /// it. Take this lock first or alone, never while holding the activation lock or the DB mutex.
    settings: Mutex<settings::AppSettings>,
    /// "Ask" policy: font files that were on last time and aren't now, waiting for the user's answer.
    pending_restore: Mutex<Vec<String>>,
    /// Becomes true once launch has worked out what to ask about.
    launch_checked: tokio::sync::watch::Sender<bool>,
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

    pub fn settings(&self) -> MutexGuard<'_, settings::AppSettings> {
        self.settings.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn pending_restore(&self) -> MutexGuard<'_, Vec<String>> {
        self.pending_restore.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// A UI-initiated write: takes the DB mutex first, then asks running scans to yield
    /// SQLite's write lock for exactly as long as this write needs it. Wakes sync afterwards,
    /// since local tags may have changed.
    pub fn write<T>(&self, f: impl FnOnce(&mut Connection) -> AppResult<T>) -> AppResult<T> {
        let out = self.write_cache(f);
        sync::note_local_write();
        out
    }

    /// `write`, for data Fontface works out by itself rather than a choice the user made
    /// (preview profiles). Sync shares none of it, so it isn't woken.
    pub fn write_cache<T>(&self, f: impl FnOnce(&mut Connection) -> AppResult<T>) -> AppResult<T> {
        let mut conn = self.conn()?;
        let _gate = db::UiWriteGate::raise();
        f(&mut conn)
    }
}

#[cfg(test)]
impl AppState {
    /// The app's state over this library, without a window, settings from disk or threads.
    pub(crate) fn for_tests(db_path: &std::path::Path, data_dir: &std::path::Path) -> AppResult<AppState> {
        Ok(AppState {
            db: Mutex::new(db::open(db_path)?),
            db_path: db_path.to_path_buf(),
            data_dir: data_dir.to_path_buf(),
            scans: Mutex::default(),
            deferred: Mutex::default(),
            seen_loaded: Mutex::default(),
            service_ops: Mutex::default(),
            purchase_watcher: Mutex::default(),
            purchase_watch_failed: Mutex::default(),
            settings: Mutex::new(settings::AppSettings::default()),
            pending_restore: Mutex::default(),
            launch_checked: tokio::sync::watch::channel(false).0,
        })
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // macOS: the menu bar adds Settings… to the app menu. Other systems keep Tauri's default.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(window::app_menu).on_menu_event(window::on_menu_event);
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("ff", |ctx, req, resp| protocol::handle(ctx, req, resp))
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db_path = dir.join("library.sqlite3");
            let mut conn = db::open(&db_path)?;
            tags::ensure_schema(&conn)?;
            preview::ensure_schema(&conn)?;
            settings::ensure_schema(&conn)?;
            activation::ensure_schema(&conn)?;
            sync::ensure_schema(&conn)?;
            // Before the window can change any tag: sync's saved state from an older build.
            if let Err(e) = sync::upgrade_saved_state(&conn) {
                eprintln!("fontface: sync couldn't update its saved state: {e}");
            }
            // The macOS font folders and the service folders are always in the library; the UI
            // scans them at launch.
            db::ensure_system_folders(&mut conn)?;
            db::purge_adobe_rows(&mut conn)?;
            services::ensure_service_folders(&mut conn, &dir)?;
            settings::refresh_launch_at_login();
            let mut app_settings = settings::load(&conn)?;
            app_settings.launch_at_login = settings::launch_at_login_enabled();
            window::paint_background(app.handle(), app_settings.theme);
            #[cfg(target_os = "macos")]
            if let Some(main) = app.get_webview_window("main") {
                window::full_screen::watch(&main);
            }
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
                settings: Mutex::new(app_settings.clone()),
                pending_restore: Mutex::default(),
                launch_checked: tokio::sync::watch::channel(false).0,
            });
            commands::restart_purchase_watcher(app.handle());
            sync::start(app.handle());
            // Preview profiles for fonts scanned before profiles existed (or after a PREVIEW_REV
            // bump). It waits a moment, so the window's first list and the launch scans go first.
            {
                let (handle, db_path) = (app.handle().clone(), db_path.clone());
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let result = preview::backfill(&db_path, 2, |batch| {
                        let _ = handle.emit("preview-profiles", batch);
                    });
                    match result {
                        Ok(r) if r.files > 0 => eprintln!(
                            "fontface: preview profiles for {} faces in {} files ({} online-only and {} other files skipped)",
                            r.written, r.files, r.cloud, r.other
                        ),
                        Ok(_) => {}
                        Err(e) => eprintln!("fontface: preview backfill failed: {e}"),
                    }
                });
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || restore_at_launch(&handle, app_settings.restore_on_launch));
            if app_settings.tag_backups {
                let keep = app_settings.tag_backup_keep as usize;
                std::thread::spawn(move || {
                    let made = db::open(&db_path).and_then(|conn| backups::at_launch(&conn, &backups::dir(&dir), backups::now(), keep));
                    if let Err(e) = made {
                        eprintln!("fontface: tag backup failed: {e}");
                    }
                });
            }
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
            commands::preview_profiles,
            commands::font_characters,
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
            commands::settings_get,
            commands::settings_update,
            commands::settings_reset,
            commands::activation_pending_restore,
            commands::activation_restore_decide,
            commands::activation_turn_off_all,
            commands::backups_list,
            commands::backups_create,
            commands::backups_reveal,
            commands::app_data_reveal,
            window::title_bar_double_click,
            tags::commands::tags_list,
            tags::commands::tags_create,
            tags::commands::tags_rename,
            tags::commands::tags_recolor,
            tags::commands::tags_set_group,
            tags::commands::tags_delete,
            tags::commands::tags_assign,
            tags::commands::location_color_set,
            tags::commands::folder_relocate,
            tags::commands::tags_import_preview,
            tags::commands::tags_import_apply,
            tags::commands::tags_export,
            tags::commands::tags_export_finder,
            tags::commands::tags_export_font_book,
            sync::commands::sync_status,
            sync::commands::sync_set_folder,
            sync::commands::sync_turn_off,
            sync::commands::sync_set_device,
            sync::commands::sync_now,
            sync::commands::sync_poke,
            sync::commands::sync_exceptions,
            sync::commands::sync_set_exception,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Fontface");

    app.run(|app, event| match event {
        // "Keep running when the window is closed" (macOS): hide instead of closing. Cmd+Q
        // still quits, because quitting doesn't go through the window's close request.
        tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. } if label == "main" => {
            #[cfg(target_os = "macos")]
            if app.try_state::<AppState>().is_some_and(|s| s.settings().keep_running_in_background) {
                api.prevent_close();
                if let Some(main) = app.get_webview_window("main") {
                    window::hide(&main);
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = api;
        }
        // With Appearance set to System, keep the window colour in step when macOS switches
        // between light and dark (the page follows by itself).
        tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::ThemeChanged(_), .. } if label == "main" => {
            if let Some(state) = app.try_state::<AppState>() {
                let theme = state.settings().theme;
                if theme == settings::Theme::System {
                    window::paint_background(app, theme);
                }
            }
        }
        // Clicking the Dock icon brings the hidden window back.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Some(main) = app.get_webview_window("main") {
                window::show(&main);
            }
        }
        tauri::RunEvent::Exit => {
            let Some(state) = app.try_state::<AppState>() else { return };
            let clear = state.settings().clear_temporary_on_quit;
            if clear {
                if let Err(e) = activation::clear_temporary(&state) {
                    eprintln!("fontface: couldn't turn off temporary fonts at quit: {e}");
                }
            }
        }
        _ => {}
    });
}

/// At launch, on its own thread: temporary activations whose login ended are recorded as off,
/// then fonts that were on last time but aren't now are handled by the restore policy. For
/// "ask", the list is kept and "restore-pending" is sent, so the UI can ask.
fn restore_at_launch(handle: &tauri::AppHandle, policy: settings::RestorePolicy) {
    let state = handle.state::<AppState>();
    // However this ends, activation_pending_restore must stop waiting.
    struct Checked<'a>(&'a tokio::sync::watch::Sender<bool>);
    impl Drop for Checked<'_> {
        fn drop(&mut self) {
            self.0.send_replace(true);
        }
    }
    let mut checked = Some(Checked(&state.launch_checked));
    let plan = match activation::plan_launch(&state, policy) {
        Ok(Some(plan)) => plan,
        Ok(None) => return,
        Err(e) => return eprintln!("fontface: reconcile failed: {e}"),
    };
    if !plan.ask.is_empty() {
        *state.pending_restore() = plan.ask.clone();
        drop(checked.take());
        match commands::pending_restore(&state) {
            Ok(pending) => {
                let _ = handle.emit("restore-pending", pending);
            }
            Err(e) => eprintln!("fontface: couldn't list fonts to restore: {e}"),
        }
    }
    drop(checked);
    // Each missing path is recorded the moment it's found, so a scan that finishes while this
    // is still running can already retry it.
    if let Err(e) = activation::apply_launch(&state, &plan, |path| {
        state.deferred().insert(path);
    }) {
        eprintln!("fontface: reconcile failed: {e}");
    }
}

#[cfg(test)]
mod settings_tests;
#[cfg(test)]
mod test_fonts;
#[cfg(test)]
mod tests;
