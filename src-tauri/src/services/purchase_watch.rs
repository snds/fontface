//! Watches the purchase folders for new downloads (macOS FSEvents through `notify`).
//!
//! Every event is mapped to the item directly inside a watched folder it belongs to (a file, a
//! zip, or an unzipped folder), so a download counts once however many files it holds. Events
//! are gathered for a couple of seconds, and an item still changing is left until its next event.
//! If macOS reports that it dropped events, the folders are checked in full. New finds are
//! recorded and announced to the UI with `purchases-changed`.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::mpsc,
    time::{Duration, Instant},
};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use super::purchases;
use crate::db;

const SETTLE: Duration = Duration::from_secs(2);

pub enum Msg {
    Item(PathBuf),
    /// Events were dropped: check everything.
    Rescan,
}

/// Starts watching `folders`. Folders that can't be watched are skipped (and reported back);
/// the rest are watched. Dropping the returned watcher stops it and its worker thread.
pub fn start(app: AppHandle, db_path: PathBuf, data_dir: PathBuf, folders: &[String]) -> (Option<RecommendedWatcher>, Vec<(String, String)>) {
    let roots: Vec<PathBuf> = folders.iter().map(PathBuf::from).collect();
    let (tx, rx) = mpsc::channel::<Msg>();
    let callback_roots = roots.clone();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let event = match res {
            Ok(e) => e,
            Err(_) => {
                let _ = tx.send(Msg::Rescan);
                return;
            }
        };
        if event.need_rescan() {
            let _ = tx.send(Msg::Rescan);
            return;
        }
        if matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
            for path in &event.paths {
                if let Some(unit) = purchases::unit_for(&callback_roots, path) {
                    let _ = tx.send(Msg::Item(unit));
                }
            }
        }
    });
    let mut watcher = match watcher {
        Ok(w) => w,
        Err(e) => return (None, folders.iter().map(|f| (f.clone(), e.to_string())).collect()),
    };
    let mut failed = Vec::new();
    let mut watched = 0;
    for folder in folders {
        match watcher.watch(Path::new(folder), RecursiveMode::Recursive) {
            Ok(()) => watched += 1,
            Err(e) => failed.push((folder.clone(), e.to_string())),
        }
    }
    if watched == 0 {
        return (None, failed);
    }
    std::thread::spawn(move || {
        worker(&db_path, &data_dir, rx, |new| {
            let _ = app.emit("purchases-changed", new);
        })
    });
    (Some(watcher), failed)
}

/// Runs until the watcher is dropped (the channel closes). Downloads still waiting in the
/// current batch when that happens are checked first, so none is lost.
pub fn worker(db_path: &Path, data_dir: &Path, rx: mpsc::Receiver<Msg>, announce: impl Fn(&[i64])) {
    let mut closed = false;
    while !closed {
        let Ok(first) = rx.recv() else { return };
        let mut batch: HashSet<PathBuf> = HashSet::new();
        let mut rescan = false;
        let mut take = |m: Msg| match m {
            Msg::Item(p) => {
                batch.insert(p);
            }
            Msg::Rescan => rescan = true,
        };
        take(first);
        let until = Instant::now() + SETTLE;
        while let Some(left) = until.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(m) => take(m),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    closed = true; // finish this batch, then stop
                    break;
                }
            }
        }
        // Still changing? Its next event brings it back.
        let before: Vec<_> = batch.iter().map(|p| (p.clone(), purchases::signature(p))).collect();
        std::thread::sleep(Duration::from_millis(800));
        let settled: Vec<PathBuf> =
            before.into_iter().filter(|(p, s)| s.is_some() && purchases::signature(p) == *s).map(|(p, _)| p).collect();
        if settled.is_empty() && !rescan {
            continue;
        }
        let conn = match db::open(db_path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("fontface: purchases watcher couldn't open the library: {e}");
                continue;
            }
        };
        let mut new: Vec<i64> = Vec::new();
        for p in &settled {
            match purchases::record(&conn, data_dir, p) {
                Ok(Some(id)) => new.push(id),
                Ok(None) => {}
                Err(e) => eprintln!("fontface: couldn't check {}: {e}", p.display()),
            }
        }
        if rescan {
            if let Ok(ids) = purchases::check_folders(&conn, data_dir) {
                new.extend(ids);
            }
        }
        if !new.is_empty() {
            announce(&new);
        }
    }
}
