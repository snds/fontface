//! Sync: the user's choices (tags, which fonts are on, per-device exceptions) shared between
//! their computers through a folder they pick. Font files never sync. See docs/SYNC.md.
//!
//! - `ops`: the file formats. `hlc`: the clock that orders changes.
//! - `merge`: the merge rules, pure data.
//! - `engine`: one device's side (reading, writing, local tags and fonts), no threads.
//! - `transport`: where files live (`FolderTransport` today; OpenDAL connections later).
//! - this file: the sync thread, what wakes it, and the commands.
//!
//! **Threads and locks.** All file work happens on the sync thread, never while a lock is
//! held, because reading from an online-only cloud folder can download. Lock order: the cycle
//! lock, then the engine lock, then the database mutex. Fonts are switched (`commands::switch`,
//! `turn_on_later`) under the cycle lock only: they take the activation lock, then the database
//! mutex, never the engine lock.

pub mod commands;
pub mod device;
pub mod engine;
pub mod hlc;
pub mod merge;
pub mod ops;
pub mod transport;

#[cfg(test)]
mod tests;

use std::{
    cell::Cell,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Condvar, Mutex, MutexGuard, OnceLock,
    },
    time::{Duration, Instant},
};

use notify::Watcher;
use tauri::{AppHandle, Emitter, Manager};

use crate::{error::AppResult, model::ActivationOutcome, AppState};
use engine::{Engine, LocalFaces};
use transport::{FolderTransport, Transport};

pub use engine::{ensure_schema, upgrade_saved_state};

/// A device or tag id: lowercase hex.
pub fn is_device_id(s: &str) -> bool {
    (8..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The fallback check for other devices' changes, when the folder watcher misses them (some
/// sync services write in ways file events don't report).
const POLL: Duration = Duration::from_secs(5 * 60);
/// Quiet time before acting on a burst of local changes or folder events.
const LOCAL_SETTLE: Duration = Duration::from_millis(1500);
const REMOTE_SETTLE: Duration = Duration::from_secs(3);
const MAX_SETTLE: Duration = Duration::from_secs(15);

#[derive(Default)]
struct Wake {
    local: bool,
    remote: bool,
    /// Bumped by every wake, so settling can tell whether more arrived.
    count: u64,
}

struct Shared {
    app: AppHandle,
    engine: Mutex<Option<Engine>>,
    /// One cycle at a time (the sync thread, or "Sync now").
    cycle: Mutex<()>,
    wake: Mutex<Wake>,
    cv: Condvar,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    syncing: AtomicBool,
}

static SHARED: OnceLock<Shared> = OnceLock::new();
/// Sync is on; read without a lock by the hooks.
static ENABLED: AtomicBool = AtomicBool::new(false);

thread_local! {
    /// Set while sync writes the database itself, so its own writes don't wake it.
    static QUIET: Cell<bool> = const { Cell::new(false) };
}

fn shared() -> Option<&'static Shared> {
    SHARED.get()
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Starts sync's thread. Called once at launch; does nothing until sync is turned on.
pub fn start(app: &AppHandle) {
    let _ = SHARED.set(Shared {
        app: app.clone(),
        engine: Mutex::new(None),
        cycle: Mutex::new(()),
        wake: Mutex::new(Wake::default()),
        cv: Condvar::new(),
        watcher: Mutex::new(None),
        syncing: AtomicBool::new(false),
    });
    std::thread::Builder::new()
        .name("fontface-sync".into())
        .spawn(worker)
        .map_err(|e| eprintln!("fontface: couldn't start sync: {e}"))
        .ok();
}

fn worker() {
    let Some(sh) = shared() else { return };
    // Reading the hardware id runs a small tool, so it happens here rather than at launch.
    let (machine, name) = (device::machine_hash(), device::default_name());
    let loaded = {
        let state = sh.app.state::<AppState>();
        let conn = state.conn();
        conn.and_then(|c| Engine::load(&c, &machine, &name))
    };
    match loaded {
        Ok(e) => {
            ENABLED.store(e.config.enabled, Ordering::SeqCst);
            *lock(&sh.engine) = Some(e);
        }
        Err(e) => return eprintln!("fontface: sync couldn't start: {e}"),
    }
    if ENABLED.load(Ordering::SeqCst) {
        restart_watcher();
        run_logged(true);
    }
    loop {
        let (local, remote) = wait_for_wake();
        if !ENABLED.load(Ordering::SeqCst) || !(local || remote) {
            continue;
        }
        run_logged(remote);
    }
}

/// Waits for something to do, then for things to settle. Returns (local, remote).
fn wait_for_wake() -> (bool, bool) {
    let Some(sh) = shared() else { return (false, false) };
    let mut w = lock(&sh.wake);
    if !w.local && !w.remote {
        let (g, timeout) = sh.cv.wait_timeout(w, POLL).unwrap_or_else(|p| p.into_inner());
        w = g;
        if timeout.timed_out() {
            w.remote = true;
        }
    }
    // Settle: wait until no more wakes arrive for a moment (but not forever).
    let started = Instant::now();
    loop {
        let settle = if w.remote { REMOTE_SETTLE } else { LOCAL_SETTLE };
        let seen = w.count;
        let (g, _) = sh.cv.wait_timeout(w, settle).unwrap_or_else(|p| p.into_inner());
        w = g;
        if w.count == seen || started.elapsed() > MAX_SETTLE {
            break;
        }
    }
    let out = (w.local, w.remote);
    w.local = false;
    w.remote = false;
    out
}

fn wake(local: bool, remote: bool) {
    let Some(sh) = shared() else { return };
    let mut w = lock(&sh.wake);
    w.local |= local;
    w.remote |= remote;
    w.count += 1;
    sh.cv.notify_all();
}

/// After every write the UI makes to the database (`AppState::write`): local tags may have
/// changed. Cheap: it only wakes the sync thread, which compares and writes later.
pub fn note_local_write() {
    if ENABLED.load(Ordering::Relaxed) && !QUIET.with(Cell::get) {
        wake(true, false);
    }
}

/// Wakes sync to read other devices' changes (window focus, a folder event, "Sync now").
pub fn note_remote() {
    if ENABLED.load(Ordering::Relaxed) {
        wake(false, true);
    }
}

fn quietly<T>(f: impl FnOnce() -> T) -> T {
    QUIET.with(|q| q.set(true));
    let out = f();
    QUIET.with(|q| q.set(false));
    out
}

/// The user switched fonts on or off (`set_activation`). Each font that ended up the way they
/// asked becomes a change. Called after the switch, with no lock held.
pub fn activation_chosen(state: &AppState, font_ids: &[i64], active: bool, outcomes: &[ActivationOutcome]) {
    record_switch(state, font_ids, active, outcomes, |engine, conn, keys| engine.choose(conn, keys, active).map(|_| true));
}

/// Fontface turned on fonts that just came into the library (a download or an import), not the
/// user's switch: see `Engine::arrived`. Called after the switch, with no lock held. (An update
/// or a replacement putting back what was on records nothing at all.)
pub fn activation_arrived(state: &AppState, font_ids: &[i64], outcomes: &[ActivationOutcome]) {
    record_switch(state, font_ids, true, outcomes, |engine, conn, keys| engine.arrived(conn, keys));
}

/// The face keys of the fonts that ended up the way `active` asked, handed to `record` in one
/// database write. Wakes sync if anything changed.
fn record_switch(
    state: &AppState,
    font_ids: &[i64],
    active: bool,
    outcomes: &[ActivationOutcome],
    record: impl FnOnce(&mut Engine, &rusqlite::Connection, &[String]) -> AppResult<bool>,
) {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let Some(sh) = shared() else { return };
    let done: std::collections::HashSet<&str> =
        outcomes.iter().filter(|o| o.active == active && o.error.is_none()).map(|o| o.path.as_str()).collect();
    let keys: Vec<String> = match state.conn() {
        Ok(conn) => font_ids
            .iter()
            .filter_map(|id| {
                conn.query_row(
                    "SELECT postscript_name, variable, italic, path, face_index FROM fonts WHERE id = ?1",
                    [id],
                    |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, bool>(1)?, r.get::<_, bool>(2)?, r.get::<_, String>(3)?, r.get::<_, u32>(4)?)),
                )
                .ok()
            })
            .filter(|(_, _, _, path, _)| done.contains(path.as_str()))
            .map(|(ps, v, i, path, idx)| crate::tags::face_key(ps.as_deref(), v, i, &path, idx))
            .collect(),
        Err(_) => return,
    };
    if keys.is_empty() {
        return;
    }
    let mut guard = lock(&sh.engine);
    let Some(engine) = guard.as_mut() else { return };
    let result = quietly(|| {
        state.write(|conn| {
            let tx = conn.transaction()?;
            let changed = record(engine, &tx, &keys)?;
            engine.save_state(&tx)?;
            tx.commit()?;
            Ok(changed)
        })
    });
    drop(guard);
    match result {
        Ok(true) => wake(true, false),
        Ok(false) => {}
        Err(e) => eprintln!("fontface: sync couldn't record an on/off change: {e}"),
    }
}

fn run_logged(remote: bool) {
    if let Err(e) = run_cycle(remote) {
        eprintln!("fontface: sync failed: {e}");
        if let Some(sh) = shared() {
            if let Some(engine) = lock(&sh.engine).as_mut() {
                engine.problems.insert("cycle".into(), format!("Sync stopped partway: {e}"));
            }
        }
    }
    emit_status();
}

/// One sync: read other devices' changes (`remote`), turn local tag changes into changes,
/// write the merged state into the library, switch fonts, and write this device's files.
pub fn run_cycle(remote: bool) -> AppResult<()> {
    let Some(sh) = shared() else { return Ok(()) };
    let _cycle = lock(&sh.cycle);
    let state = sh.app.state::<AppState>();
    let (folder, me, progress) = {
        let guard = lock(&sh.engine);
        let Some(e) = guard.as_ref() else { return Ok(()) };
        let Some(folder) = e.config.folder.clone().filter(|_| e.config.enabled) else { return Ok(()) };
        let progress = e.saved.peers.iter().map(|(d, p)| (d.clone(), p.seq)).collect();
        (PathBuf::from(folder), e.config.device_id.clone(), progress)
    };
    sh.syncing.store(true, Ordering::SeqCst);
    struct Done<'a>(&'a AtomicBool);
    impl Drop for Done<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _done = Done(&sh.syncing);
    if remote {
        emit_status();
    }
    let transport = FolderTransport::new(&folder, &me);
    // File work first, with no lock held.
    let incoming = remote.then(|| engine::read_folder(&transport, &progress));
    let read_ok = incoming.as_ref().is_some_and(|i| i.problems.get("").is_some_and(Option::is_none));

    // Merge, compare and apply in one database write, so no tag edit can slip in between.
    let applied = {
        let mut guard = lock(&sh.engine);
        let Some(e) = guard.as_mut() else { return Ok(()) };
        if e.me() != me || !e.config.enabled {
            return Ok(()); // turned off or given a new id meanwhile
        }
        quietly(|| {
            state.write(|conn| {
                let tx = conn.transaction()?;
                if let Some(inc) = incoming {
                    e.check_own_device_file(&tx, inc.devices.get(&me))?;
                    e.merge(inc);
                }
                let faces = engine::load_faces(&tx)?;
                let mismatched = e.mismatched(&faces);
                e.local_changes(&tx, &mismatched)?;
                if remote && read_ok && !e.saved.seeded {
                    e.seed(&tx, &faces)?;
                }
                let applied = e.apply(&tx, &faces, &mismatched)?;
                e.save_state(&tx)?;
                tx.commit()?;
                Ok(applied)
            })
        })?
    };

    // Switch fonts: the same path as the switches in the window, without the engine lock, and
    // without recording them as choices (they came from sync). A font whose file isn't there is
    // turned on after its folder's next scan instead.
    let switched = engine::carry_out(
        &applied,
        |path| Path::new(path).exists(),
        |ids, on| match quietly(|| crate::commands::switch(&state, ids, on, None)) {
            Ok(outcomes) => outcomes.iter().all(|o| o.error.is_none()),
            Err(e) => {
                eprintln!("fontface: sync couldn't switch a font: {e}");
                false
            }
        },
        |path| match quietly(|| turn_on_later(&state, path)) {
            Ok(()) => true,
            Err(e) => {
                eprintln!("fontface: sync couldn't record {path} as on: {e}");
                false
            }
        },
    );

    // Write this device's files.
    let me_now;
    {
        let mut guard = lock(&sh.engine);
        let Some(e) = guard.as_mut() else { return Ok(()) };
        e.switched(&applied, &switched);
        me_now = e.me().to_string();
        quietly(|| state.write(|conn| e.save_state(conn)))?;
    }
    let transport = FolderTransport::new(&folder, &me_now);
    write_files(sh, &state, &transport)?;

    {
        let mut guard = lock(&sh.engine);
        if let Some(e) = guard.as_mut() {
            if remote && read_ok {
                e.last_sync = Some(hlc::now_ms());
            }
            e.problems.remove("cycle");
            quietly(|| state.write(|conn| e.save_state(conn)))?;
        }
    }
    if applied.tags_changed || applied.switches() {
        let _ = sh.app.emit("sync-changed", ());
    }
    Ok(())
}

/// A synced turn-on whose file isn't there (on a drive that isn't connected, say): recorded as
/// on, and turned on by the retry that runs after its folder's next scan, the way launch handles
/// a font whose file is missing. Takes the activation lock, then the database mutex.
fn turn_on_later(state: &AppState, path: &str) -> AppResult<()> {
    let _guard = crate::activation::lock();
    state.write(|conn| {
        conn.execute("UPDATE fonts SET activated = 1 WHERE path = ?1", [path])?;
        Ok(())
    })?;
    state.deferred().insert(path.to_string());
    Ok(())
}

/// Writes waiting changes, `device.json` when it's due, and the snapshot when it's due. Each
/// file is written whole and renamed into place; the engine lock is never held while writing.
fn write_files(sh: &Shared, state: &AppState, transport: &FolderTransport) -> AppResult<()> {
    let me = lock(&sh.engine).as_ref().map(|e| e.me().to_string()).unwrap_or_default();
    let existing = transport.list(&me).unwrap_or_default();
    let next = lock(&sh.engine).as_ref().and_then(|e| e.next_file(&existing));
    let wrote = next.is_some();
    if let Some((seq, last_row, bytes)) = next {
        match transport.write_atomic(&ops::change_name(seq), &bytes) {
            Ok(()) => {
                let mut guard = lock(&sh.engine);
                if let Some(e) = guard.as_mut() {
                    quietly(|| state.write(|conn| e.written(conn, seq, last_row)))?;
                    e.problems.remove("write");
                }
            }
            Err(err) => {
                if let Some(e) = lock(&sh.engine).as_mut() {
                    e.problems.insert("write".into(), format!("Couldn't write to the sync folder: {err}. Your changes are kept and sent later."));
                }
                return Ok(());
            }
        }
    }
    let now = hlc::now_ms();
    let version = sh.app.package_info().version.to_string();
    let device_file = lock(&sh.engine).as_ref().filter(|e| e.device_file_due(now) || wrote).map(|e| e.device_file(&version, now));
    if let Some(bytes) = device_file {
        if transport.write_atomic(ops::DEVICE_NAME, &bytes).is_ok() {
            if let Some(e) = lock(&sh.engine).as_mut() {
                e.saved.device_written = now;
                e.device_dirty = false;
            }
        }
    }
    let existing = transport.list(&me).unwrap_or_default();
    let compact = lock(&sh.engine).as_ref().and_then(|e| e.compaction(&existing));
    if let Some((bytes, covered)) = compact {
        if transport.write_atomic(ops::SNAPSHOT_NAME, &bytes).is_ok() {
            for name in covered {
                let _ = transport.remove(&name);
            }
        }
    }
    Ok(())
}

/// Watches the devices folder for other devices' files.
fn restart_watcher() {
    let Some(sh) = shared() else { return };
    let mut slot = lock(&sh.watcher);
    *slot = None;
    let target = {
        let guard = lock(&sh.engine);
        guard.as_ref().filter(|e| e.config.enabled).and_then(|e| Some((PathBuf::from(e.config.folder.clone()?), e.me().to_string())))
    };
    let Some((folder, me)) = target else { return };
    let transport = FolderTransport::new(&folder, &me);
    let dir = transport.watch_dir();
    let _ = std::fs::create_dir_all(&dir);
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if event.paths.iter().any(|p| !transport.is_own(p)) {
                note_remote();
            }
        }
    });
    match watcher {
        Ok(mut w) => match w.watch(&dir, notify::RecursiveMode::Recursive) {
            Ok(()) => *slot = Some(w),
            Err(e) => eprintln!("fontface: sync can't watch {}: {e}; checking every few minutes instead", dir.display()),
        },
        Err(e) => eprintln!("fontface: sync can't watch folders: {e}"),
    }
}

fn emit_status() {
    let Some(sh) = shared() else { return };
    if let Ok(status) = commands::status(sh) {
        let _ = sh.app.emit("sync-status", status);
    }
}

/// True for a folder inside a cloud provider's folder, where files can be online-only.
fn is_cloud_folder(path: &Path) -> bool {
    let p = path.to_string_lossy();
    ["/Library/CloudStorage/", "/Library/Mobile Documents/", "/Dropbox", "/OneDrive", "\\OneDrive", "iCloudDrive", "Google Drive"]
        .iter()
        .any(|m| p.contains(m))
}

/// Local fonts, for status (what's missing here).
fn local_faces(state: &AppState) -> AppResult<LocalFaces> {
    engine::load_faces(&*state.conn()?)
}
