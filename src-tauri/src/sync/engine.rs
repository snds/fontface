//! One device's side of sync, without threads or Tauri: what it has read, what it has written,
//! and how local tags and on/off choices turn into changes and back.
//!
//! **Local tags → changes** compares the tags now with the tags as sync last left them (the
//! "base"), never with the merged state. So a rename that just arrived from another device isn't
//! mistaken for a local rename back. **Changes → local tags** then writes the merged state into
//! the tag tables, and the base becomes what was written. Applying never makes changes of its own,
//! so two devices can't echo each other.
//!
//! **Tag groups** ("My tags" / "Built-in") go the same way: a top-level tag's group is compared
//! with the base, so moving a tag to the other group (from the menu, Undo, an import or a
//! restore) becomes a change. A group is only written when it isn't the one the tag's name gives
//! it (`tags::is_builtin_name`): the default needs no change, since every computer works it out
//! alike, and the one-time sort when groups arrive (`tags::ensure_schema`) is never shared.
//!
//! **On/off** isn't compared like that, because the library also switches fonts off for reasons
//! that aren't the user's choice (a drive that isn't mounted, "Leave them off" at launch). Only an
//! on/off switch the user flips becomes a change (`choose`). A synced choice is applied once per
//! change (`applied`), so a font switched off by hand here isn't switched back on until somebody
//! changes that font's choice again.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::Path,
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    device,
    hlc::{now_ms, Clock, Hlc},
    merge::{Merged, Source, TagView},
    ops::{self, face_field, group_value, tag_field, DeviceFile, Op, OpKind, ReadError},
    transport::Transport,
};
use crate::{
    error::{AppError, AppResult},
    tags,
};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS sync_meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_outbox (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    line  TEXT NOT NULL
);
";

/// Creates the sync tables if they're missing. Outside the numbered migrations in db.rs, like
/// the tag tables. Idempotent; called once at launch.
pub fn ensure_schema(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(SCHEMA)?;
    Ok(())
}

/// Change files a device keeps before squeezing them into its snapshot.
const COMPACT_AFTER: usize = 24;
/// How often `device.json` is rewritten just to say "still here".
const DEVICE_FILE_EVERY_MS: u64 = 60 * 60 * 1000;

/// This device's settings for sync. Kept in `sync_meta`, not in the app settings, because none
/// of it may ever sync.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub enabled: bool,
    /// The folder the user picked (the "Fontface Sync" folder goes inside it).
    pub folder: Option<String>,
    pub device_id: String,
    pub name: String,
    #[serde(default)]
    pub group: Option<String>,
    /// `device::machine_hash()` when the id was made.
    #[serde(default)]
    pub machine: String,
}

/// What sync knows about another device.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    /// Every change file up to this one has been read (or was covered by a snapshot read).
    pub seq: u64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub app_version: String,
    #[serde(default)]
    pub last_seen: u64,
}

/// A tag as sync last left it in the local tables.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BaseTag {
    /// Sorted; the first gets new adds.
    pub sids: Vec<String>,
    pub name: String,
    pub color: String,
    /// In the Built-in group. `None` in a state saved before tag groups: then the tag's group was
    /// the one the one-time sort gives it, by its name.
    #[serde(default)]
    pub builtin: Option<bool>,
    pub keys: BTreeSet<String>,
}

impl BaseTag {
    /// The group the tag had when sync last left it.
    fn was_builtin(&self) -> bool {
        self.builtin.unwrap_or_else(|| tags::is_builtin_name(&self.name))
    }
}

/// Everything kept between launches, as one JSON value in `sync_meta`. If it's lost or damaged,
/// it's rebuilt from the sync folder.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Saved {
    pub merged: Merged,
    /// Local tag id → the tag as sync last left it.
    pub base: BTreeMap<i64, BaseTag>,
    /// Face key → the `Effective::stamp` last carried out on this device.
    pub applied: BTreeMap<String, Hlc>,
    pub peers: BTreeMap<String, Peer>,
    /// The last change file this device wrote.
    pub seq: u64,
    pub clock: Clock,
    /// This device's fonts that were on when it joined have been shared.
    pub seeded: bool,
    /// When `device.json` was last written (ms).
    pub device_written: u64,
}

#[derive(Debug)]
pub struct Engine {
    pub config: Config,
    pub saved: Saved,
    /// Changes not yet written to the folder, with their `sync_outbox` row ids.
    pub outbox: Vec<(i64, Op)>,
    /// A copy of this app's data was found on another computer, so this one took a new id.
    pub cloned: bool,
    /// Plain words, by device id (or "" for the folder itself).
    pub problems: BTreeMap<String, String>,
    pub newer_formats: Vec<String>,
    pub last_sync: Option<u64>,
    /// Content fingerprints of local files, by (path, size, mtime).
    prints: HashMap<(String, i64, i64), String>,
    /// `device.json` needs writing (name or group changed).
    pub device_dirty: bool,
}

fn meta_get(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn.query_row("SELECT value FROM sync_meta WHERE key = ?1", [key], |r| r.get(0)).optional()?)
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO sync_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// Only fonts with a PostScript name sync. A `file:` key names a path on this computer, which
/// means nothing on another.
pub fn syncable_key(key: &str) -> bool {
    key.starts_with("ps:") && tags::check_key(key).is_ok()
}

// --------------------------------------------------------------------------- local library

#[derive(Debug, Clone)]
pub struct LocalTag {
    pub name: String,
    pub color: String,
    /// In the Built-in group (the same as its top-level tag).
    pub builtin: bool,
    /// Syncable keys only.
    pub keys: BTreeSet<String>,
}

pub fn load_local_tags(conn: &Connection) -> AppResult<BTreeMap<i64, LocalTag>> {
    let mut out: BTreeMap<i64, LocalTag> = BTreeMap::new();
    for t in tags::list_tags(conn)? {
        out.insert(t.id, LocalTag { name: t.name, color: t.color, builtin: t.builtin, keys: BTreeSet::new() });
    }
    let mut stmt = conn.prepare("SELECT tag_id, face_key FROM tag_fonts")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (id, key) = row?;
        if syncable_key(&key) {
            if let Some(t) = out.get_mut(&id) {
                t.keys.insert(key);
            }
        }
    }
    Ok(out)
}

#[derive(Debug, Clone)]
pub struct Copy {
    pub id: i64,
    pub path: String,
    /// In a macOS font folder: always on.
    pub installed: bool,
    pub activated: bool,
    /// In Fontface's Purchases folder: fingerprints are worth knowing.
    pub purchase: bool,
    pub size: i64,
    pub mtime: i64,
}

#[derive(Debug, Clone, Default)]
pub struct LocalFace {
    pub family: String,
    pub style: String,
    pub copies: Vec<Copy>,
}

impl LocalFace {
    /// Fontface has it on (or it's installed, which is always on).
    pub fn is_on(&self) -> bool {
        self.copies.iter().any(|c| c.activated && !c.installed)
    }
}

pub struct LocalFaces {
    pub faces: BTreeMap<String, LocalFace>,
    /// Path → the face keys in that file.
    pub by_path: HashMap<String, Vec<String>>,
}

pub fn load_faces(conn: &Connection) -> AppResult<LocalFaces> {
    let mut stmt = conn.prepare(
        "SELECT fonts.id, fonts.path, fonts.face_index, fonts.postscript_name, fonts.variable, fonts.italic,
                fonts.family, fonts.subfamily, fonts.activated, folders.kind, folders.path, fonts.file_size, fonts.mtime
         FROM fonts JOIN folders ON folders.id = fonts.folder_id",
    )?;
    let mut faces: BTreeMap<String, LocalFace> = BTreeMap::new();
    let mut by_path: HashMap<String, Vec<String>> = HashMap::new();
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, u32>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, bool>(4)?,
            r.get::<_, bool>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, bool>(8)?,
            r.get::<_, String>(9)?,
            r.get::<_, String>(10)?,
            r.get::<_, i64>(11)?,
            r.get::<_, i64>(12)?,
        ))
    })?;
    for row in rows {
        let (id, path, face_index, ps, variable, italic, family, style, activated, kind, folder, size, mtime) = row?;
        let key = tags::face_key(ps.as_deref(), variable, italic, &path, face_index);
        if !syncable_key(&key) {
            continue;
        }
        by_path.entry(path.clone()).or_default().push(key.clone());
        let face = faces.entry(key).or_insert_with(|| LocalFace { family, style, ..Default::default() });
        let purchase = kind == "service" && Path::new(&folder).file_name().is_some_and(|n| n == "Purchases");
        face.copies.push(Copy { id, path, installed: kind == "system", activated, purchase, size, mtime });
    }
    Ok(LocalFaces { faces, by_path })
}

// ------------------------------------------------------------------------------ reading

/// What reading the folder found. Collected without holding any lock.
#[derive(Debug, Default)]
pub struct Incoming {
    pub ops: Vec<Op>,
    /// Device → every change file up to here is now read.
    pub progress: BTreeMap<String, u64>,
    pub devices: BTreeMap<String, DeviceFile>,
    /// Device (or "" for the folder) → plain words. A device with nothing wrong maps to None.
    pub problems: BTreeMap<String, Option<String>>,
    pub newer_formats: Vec<String>,
}

/// Reads every device's new changes. `progress`: what was read before, by device. Reading may
/// download online-only files, so this runs on the sync thread with no lock held. A file that
/// can't be read yet is skipped and tried again next time; nothing here ever changes local data.
pub fn read_folder(transport: &dyn Transport, progress: &BTreeMap<String, u64>) -> Incoming {
    let mut inc = Incoming { newer_formats: transport.newer_formats(), ..Default::default() };
    let devices = match transport.devices() {
        Ok(d) => {
            inc.problems.insert(String::new(), None);
            d
        }
        Err(e) => {
            inc.problems.insert(String::new(), Some(format!("Couldn't read the sync folder: {e}")));
            return inc;
        }
    };
    for dev in devices {
        let files = match transport.list(&dev) {
            Ok(f) => f,
            Err(e) => {
                inc.problems.insert(dev, Some(format!("Couldn't list its files: {e}")));
                continue;
            }
        };
        let have = progress.get(&dev).copied().unwrap_or(0);
        let mut problem: Option<String> = None;
        let mut newer = false;
        let info = files.iter().any(|f| f == ops::DEVICE_NAME).then(|| transport.read(&dev, ops::DEVICE_NAME));
        let mut last_seq = 0;
        match info {
            Some(Ok(bytes)) => match ops::read_device(&bytes) {
                Ok(d) if d.id == dev => {
                    last_seq = d.last_seq;
                    inc.devices.insert(dev.clone(), d);
                }
                Ok(_) => problem = Some("Its device file names another device".into()),
                Err(ReadError::Newer(_)) => newer = true,
                Err(ReadError::Bad(_)) => problem = Some("Its device file isn't readable yet".into()),
            },
            Some(Err(e)) => problem = Some(format!("Couldn't read its device file: {e}")),
            None => {}
        }
        if newer {
            inc.problems.insert(dev, Some(NEWER_DEVICE.into()));
            continue;
        }
        let seqs: Vec<u64> = files.iter().filter_map(|f| ops::change_seq(f)).collect();
        let newest = seqs.iter().copied().max().unwrap_or(0).max(last_seq);
        // The snapshot is needed the first time, and when the files after what was read are gone
        // (the device squeezed them into its snapshot).
        let gap = newest > have && !seqs.contains(&(have + 1));
        let mut covered = have;
        if files.iter().any(|f| f == ops::SNAPSHOT_NAME) && (have == 0 || gap) {
            match transport.read(&dev, ops::SNAPSHOT_NAME).map_err(|e| ReadError::Bad(e.to_string())).and_then(|b| ops::read_snapshot(&b, &dev)) {
                Ok(snap) => {
                    covered = covered.max(snap.upto);
                    inc.ops.extend(snap.ops);
                }
                Err(ReadError::Newer(_)) => {
                    inc.problems.insert(dev, Some(NEWER_DEVICE.into()));
                    continue;
                }
                Err(ReadError::Bad(why)) => problem = Some(format!("Its summary file isn't readable yet ({why})")),
            }
        }
        let mut contiguous = covered;
        let mut sorted = seqs.clone();
        sorted.sort_unstable();
        for seq in sorted.into_iter().filter(|s| *s > covered) {
            let read = transport
                .read(&dev, &ops::change_name(seq))
                .map_err(|e| ReadError::Bad(e.to_string()))
                .and_then(|b| ops::read_changes(&b, &dev));
            match read {
                Ok((_, ops)) => {
                    inc.ops.extend(ops);
                    if seq == contiguous + 1 {
                        contiguous = seq;
                    }
                }
                Err(ReadError::Newer(_)) => {
                    problem = Some(NEWER_DEVICE.into());
                    break;
                }
                // Later files are still read: changes apply in any order. This one is tried again.
                Err(ReadError::Bad(why)) => {
                    problem.get_or_insert_with(|| format!("A change file isn't readable yet ({why}); trying again later"));
                }
            }
        }
        inc.progress.insert(dev.clone(), contiguous);
        inc.problems.insert(dev, problem);
    }
    inc
}

const NEWER_DEVICE: &str = "It uses a newer version of Fontface's sync format. Update Fontface here to sync with it.";

// ------------------------------------------------------------------------------ the engine

/// What applying the merged state did, and the fonts to switch now.
#[derive(Debug, Default)]
pub struct Applied {
    /// The local tag tables changed.
    pub tags_changed: bool,
    pub turn_on: Vec<(String, Vec<i64>)>,
    pub turn_off: Vec<(String, Vec<i64>)>,
    /// Face key → stamp to record once the switches above are done.
    pub stamps: BTreeMap<String, Hlc>,
}

impl Applied {
    pub fn switches(&self) -> bool {
        !self.turn_on.is_empty() || !self.turn_off.is_empty()
    }
}

/// "Follow sync", "Always on here" or "Never on here".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Exception {
    Follow,
    On,
    Off,
}

/// Who an exception is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExceptionFor {
    ThisDevice,
    ThisGroup,
}

impl Engine {
    /// Loads this device's sync state. `machine`: this computer's `device::machine_hash()`.
    /// If the stored hash is another computer's, this app data was copied here: this device
    /// takes a new id, so the two never write the same folder.
    pub fn load(conn: &Connection, machine: &str, default_name: &str) -> AppResult<Engine> {
        let config: Option<Config> = meta_get(conn, "config")?.and_then(|s| serde_json::from_str(&s).ok());
        let mut cloned = false;
        let config = match config {
            Some(c) if !c.machine.is_empty() && !machine.is_empty() && c.machine != machine => {
                cloned = true;
                Config { device_id: device::new_id(), name: default_name.to_string(), machine: machine.to_string(), ..c }
            }
            Some(mut c) => {
                if c.machine.is_empty() {
                    c.machine = machine.to_string();
                }
                c
            }
            None => Config {
                enabled: false,
                folder: None,
                device_id: device::new_id(),
                name: default_name.to_string(),
                group: None,
                machine: machine.to_string(),
            },
        };
        // A damaged state is rebuilt from the folder: tags merge by name, so nothing is lost.
        let saved: Saved = meta_get(conn, "state")?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let mut engine = Engine {
            config,
            saved,
            outbox: Vec::new(),
            cloned: false,
            problems: BTreeMap::new(),
            newer_formats: Vec::new(),
            last_sync: None,
            prints: HashMap::new(),
            device_dirty: true,
        };
        let mut stmt = conn.prepare("SELECT id, line FROM sync_outbox ORDER BY id")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (id, line) = row?;
            if let Ok(op) = serde_json::from_str::<Op>(&line) {
                engine.saved.merged.apply(&op);
                engine.saved.clock.observe(&op.hlc);
                engine.outbox.push((id, op));
            }
        }
        drop(stmt);
        if cloned {
            engine.take_new_id(conn, None)?;
        }
        engine.save_config(conn)?;
        Ok(engine)
    }

    /// Gives this device a new id: its app data was copied from another computer. Changes not
    /// yet written get new clock values under the new id, so no two changes ever share one.
    pub fn take_new_id(&mut self, conn: &Connection, name: Option<&str>) -> AppResult<()> {
        let old = std::mem::replace(&mut self.config.device_id, device::new_id());
        if let Some(name) = name {
            self.config.name = name.to_string();
        }
        self.cloned = true;
        self.saved.seq = 0;
        self.saved.device_written = 0;
        self.saved.peers.remove(&self.config.device_id);
        self.device_dirty = true;
        let pending = std::mem::take(&mut self.outbox);
        conn.execute("DELETE FROM sync_outbox", [])?;
        for (_, op) in pending {
            // An add's clock value is its id; a fresh one makes it a fresh add.
            let hlc = self.saved.clock.tick(&self.config.device_id, now_ms());
            let op = Op { hlc, kind: op.kind };
            self.saved.merged.apply(&op);
            self.push(conn, op)?;
        }
        eprintln!("fontface: sync: this app data came from another computer ({old}); this one is now {}", self.config.device_id);
        Ok(())
    }

    pub fn save_config(&self, conn: &Connection) -> AppResult<()> {
        meta_set(conn, "config", &serde_json::to_string(&self.config).map_err(|e| AppError::Other(e.to_string()))?)
    }

    pub fn save_state(&self, conn: &Connection) -> AppResult<()> {
        meta_set(conn, "state", &serde_json::to_string(&self.saved).map_err(|e| AppError::Other(e.to_string()))?)
    }

    pub fn me(&self) -> &str {
        &self.config.device_id
    }

    fn tick(&mut self) -> Hlc {
        self.saved.clock.tick(&self.config.device_id, now_ms())
    }

    /// Records a change made here: into the merged state and the outbox.
    fn push(&mut self, conn: &Connection, op: Op) -> AppResult<()> {
        self.saved.merged.apply(&op);
        let line = serde_json::to_string(&op).map_err(|e| AppError::Other(e.to_string()))?;
        conn.execute("INSERT INTO sync_outbox (line) VALUES (?1)", [line])?;
        self.outbox.push((conn.last_insert_rowid(), op));
        Ok(())
    }

    fn new_op(&mut self, conn: &Connection, kind: OpKind) -> AppResult<Hlc> {
        let hlc = self.tick();
        self.push(conn, Op { hlc: hlc.clone(), kind })?;
        Ok(hlc)
    }

    /// Starts over: used when sync is turned off, or pointed at another folder. Local tags and
    /// fonts aren't touched.
    pub fn reset(&mut self, conn: &Connection) -> AppResult<()> {
        let clock = self.saved.clock.clone();
        self.saved = Saved { clock, ..Saved::default() };
        self.outbox.clear();
        self.problems.clear();
        self.newer_formats.clear();
        self.last_sync = None;
        self.device_dirty = true;
        conn.execute("DELETE FROM sync_outbox", [])?;
        self.save_state(conn)
    }

    /// Takes in what reading the folder found.
    pub fn merge(&mut self, inc: Incoming) {
        for op in &inc.ops {
            self.saved.clock.observe(&op.hlc);
            self.saved.merged.apply(op);
        }
        let me = self.config.device_id.clone();
        for (dev, seq) in inc.progress {
            let peer = self.saved.peers.entry(dev).or_default();
            peer.seq = peer.seq.max(seq);
        }
        for (dev, info) in inc.devices {
            if dev == me {
                continue;
            }
            let peer = self.saved.peers.entry(dev).or_default();
            peer.name = info.name;
            peer.group = info.group;
            peer.app_version = info.app_version;
            peer.last_seen = peer.last_seen.max(info.last_seen);
        }
        for (dev, problem) in inc.problems {
            match problem {
                Some(p) => {
                    self.problems.insert(dev, p);
                }
                None => {
                    self.problems.remove(&dev);
                }
            }
        }
        self.newer_formats = inc.newer_formats;
    }

    /// Fonts with the same face key here and elsewhere that are clearly different fonts: the other
    /// device's copies have known fingerprints, this device's copies have known fingerprints, none
    /// match, and the family names differ too. (Same family, different fingerprint is taken to be
    /// another version of the same font.) Their tags and on/off stay local.
    pub fn mismatched(&mut self, faces: &LocalFaces) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        let candidates: Vec<(String, Vec<String>)> = self
            .saved
            .merged
            .faces
            .keys()
            .filter_map(|k| {
                let prints = self.saved.merged.face_prints(k);
                let family = self.saved.merged.face_str(k, face_field::FAMILY)?;
                let local = faces.faces.get(k)?;
                (!prints.is_empty() && !family.eq_ignore_ascii_case(&local.family)).then(|| (k.clone(), prints))
            })
            .collect();
        for (key, remote) in candidates {
            let local = self.local_prints(&faces.faces[&key], false);
            if !local.is_empty() && !local.iter().any(|p| remote.contains(p)) {
                out.insert(key);
            }
        }
        out
    }

    /// Fingerprints of a face's local copies. `purchases_only`: just copies in the Purchases
    /// folder (always on this disk, so reading never downloads anything).
    fn local_prints(&mut self, face: &LocalFace, purchases_only: bool) -> Vec<String> {
        let mut out = Vec::new();
        for c in face.copies.iter().filter(|c| c.purchase || !purchases_only) {
            let cache_key = (c.path.clone(), c.size, c.mtime);
            if let Some(p) = self.prints.get(&cache_key) {
                out.push(p.clone());
                continue;
            }
            let Ok(meta) = std::fs::metadata(&c.path) else { continue };
            if crate::cloud::is_dataless(&meta) || meta.len() > 96 * 1024 * 1024 {
                continue;
            }
            if let Ok(bytes) = std::fs::read(&c.path) {
                let p = crate::services::purchases::fingerprint(&bytes);
                self.prints.insert(cache_key, p.clone());
                out.push(p);
            }
        }
        out.sort();
        out.dedup();
        out
    }

    /// The fields that describe a font for other devices.
    fn face_meta(&mut self, face: Option<&LocalFace>) -> BTreeMap<String, Value> {
        let mut set = BTreeMap::new();
        if let Some(face) = face {
            set.insert(face_field::FAMILY.into(), json!(face.family));
            set.insert(face_field::STYLE.into(), json!(face.style));
            let prints = self.local_prints(face, true);
            if !prints.is_empty() {
                set.insert(face_field::PRINTS.into(), json!(prints));
            }
        }
        set
    }

    /// Turns local tag changes since the last sync into changes. Returns how many were made.
    pub fn local_changes(&mut self, conn: &Connection, mismatched: &BTreeSet<String>) -> AppResult<usize> {
        let local = load_local_tags(conn)?;
        let before = self.outbox.len();
        let mut base = std::mem::take(&mut self.saved.base);
        // A tag that's gone, and a new one with the same name: the same tag, deleted and made
        // again in one go (restoring a backup with "Replace my tags"). It keeps its sync ids.
        let gone: Vec<i64> = base.keys().filter(|id| !local.contains_key(id)).copied().collect();
        for id in gone {
            let name = base[&id].name.clone();
            let reborn = local.iter().find(|(lid, lt)| !base.contains_key(lid) && lt.name.eq_ignore_ascii_case(&name)).map(|(lid, _)| *lid);
            if let Some(new_id) = reborn {
                let b = base.remove(&id).unwrap_or_default();
                base.insert(new_id, b);
            }
        }
        // Base names, for telling a moved tag from a renamed parent.
        let base_names: HashMap<String, i64> = base.iter().map(|(id, b)| (b.name.to_ascii_lowercase(), *id)).collect();
        for id in base.keys().filter(|id| !local.contains_key(id)).copied().collect::<Vec<_>>() {
            for sid in base.remove(&id).unwrap_or_default().sids {
                if !self.saved.merged.dead.contains_key(&sid) {
                    self.new_op(conn, OpKind::TagDel { id: sid })?;
                }
            }
        }
        // Parents first, so a new tag's parent already has a sync id.
        let mut order: Vec<(&i64, &LocalTag)> = local.iter().collect();
        order.sort_by(|a, b| a.1.name.matches('/').count().cmp(&b.1.name.matches('/').count()).then_with(|| a.1.name.cmp(&b.1.name)));
        let by_name: HashMap<String, i64> = local.iter().map(|(id, t)| (t.name.to_ascii_lowercase(), *id)).collect();
        for (id, lt) in order {
            let (parent_name, leaf) = match lt.name.rsplit_once('/') {
                Some((p, l)) => (Some(p), l),
                None => (None, lt.name.as_str()),
            };
            let parent_sids: Vec<String> = parent_name
                .and_then(|p| by_name.get(&p.to_ascii_lowercase()))
                .and_then(|pid| base.get(pid))
                .map(|b| b.sids.clone())
                .unwrap_or_default();
            let parent_value = parent_sids.first().map(|s| json!(s)).unwrap_or(Value::Null);
            match base.get(id).cloned() {
                None => {
                    let sid = device::new_id();
                    let mut set = BTreeMap::from([
                        (tag_field::NAME.to_string(), json!(leaf)),
                        (tag_field::PARENT.to_string(), parent_value),
                        (tag_field::COLOR.to_string(), json!(lt.color)),
                    ]);
                    // A top-level tag's group, only when its name wouldn't put it there. Where the
                    // name decides, every computer works it out alike; so a computer that joins
                    // with the groups its one-time sort gave never outvotes a choice made elsewhere.
                    if parent_name.is_none() && lt.builtin != tags::is_builtin_name(&lt.name) {
                        set.insert(tag_field::GROUP.to_string(), group_value(lt.builtin));
                    }
                    self.new_op(conn, OpKind::Tag { id: sid.clone(), set })?;
                    base.insert(
                        *id,
                        BaseTag {
                            sids: vec![sid],
                            name: lt.name.clone(),
                            color: lt.color.clone(),
                            builtin: Some(lt.builtin),
                            keys: BTreeSet::new(),
                        },
                    );
                }
                Some(b) => {
                    let mut set = BTreeMap::new();
                    if b.name != lt.name {
                        // Compared with the base, not the merged state, so a rename that just
                        // arrived for this tag isn't undone. A tag's parent changes only when it
                        // sits in a different tag; renaming the parent changes neither.
                        let (old_parent, old_leaf) = match b.name.rsplit_once('/') {
                            Some((p, l)) => (Some(p), l),
                            None => (None, b.name.as_str()),
                        };
                        let old_parent_id = old_parent.and_then(|p| base_names.get(&p.to_ascii_lowercase())).copied();
                        let new_parent_id = parent_name.and_then(|p| by_name.get(&p.to_ascii_lowercase())).copied();
                        if old_leaf != leaf {
                            set.insert(tag_field::NAME.to_string(), json!(leaf));
                        }
                        if old_parent_id != new_parent_id {
                            set.insert(tag_field::PARENT.to_string(), parent_value.clone());
                        }
                    }
                    // Only a top-level tag carries a group; a nested one is in its top-level
                    // tag's, on every computer.
                    if parent_name.is_none() && self.group_to_write(&b, lt) {
                        set.insert(tag_field::GROUP.to_string(), group_value(lt.builtin));
                    }
                    if !set.is_empty() {
                        for sid in &b.sids {
                            self.new_op(conn, OpKind::Tag { id: sid.clone(), set: set.clone() })?;
                        }
                    }
                    if b.color != lt.color {
                        for sid in &b.sids {
                            let set = BTreeMap::from([(tag_field::COLOR.to_string(), json!(lt.color))]);
                            self.new_op(conn, OpKind::Tag { id: sid.clone(), set })?;
                        }
                    }
                }
            }
            let b = base.get(id).cloned().unwrap_or_default();
            for key in lt.keys.difference(&b.keys).filter(|k| !mismatched.contains(*k)) {
                if self.saved.merged.dots_of(&b.sids, key).is_empty() {
                    self.new_op(conn, OpKind::Add { tag: b.sids[0].clone(), key: key.clone() })?;
                }
            }
            for key in b.keys.difference(&lt.keys).filter(|k| !mismatched.contains(*k)) {
                for sid in &b.sids {
                    let dots = self.saved.merged.dots_of(std::slice::from_ref(sid), key);
                    if !dots.is_empty() {
                        self.new_op(conn, OpKind::Remove { tag: sid.clone(), key: key.clone(), dots })?;
                    }
                }
            }
        }
        self.saved.base = base;
        Ok(self.outbox.len() - before)
    }

    /// Whether a tag that's at the top level here needs its group written: it was moved to the
    /// other group here, or the other computers would now work out another group for it.
    fn group_to_write(&self, b: &BaseTag, lt: &LocalTag) -> bool {
        if b.was_builtin() != lt.builtin {
            // Moved to the other group here: from the menu, Undo, an import or a restore.
            return true;
        }
        if b.name == lt.name {
            return false;
        }
        let chosen = self.saved.merged.chosen_group(&b.sids);
        if b.name.contains('/') {
            // Taken out to the top level, it keeps the group it had. That came from its old
            // top-level tag, not from anything written for this one, so write it unless the
            // others would work out the same.
            chosen.unwrap_or_else(|| tags::is_builtin_name(&lt.name)) != lt.builtin
        } else {
            // Renamed at the top level. A group someone chose stays with the tag (and a change
            // to it made elsewhere meanwhile isn't undone); with none, the new name must still
            // give the group it has.
            chosen.is_none() && tags::is_builtin_name(&lt.name) != lt.builtin
        }
    }

    /// When this device first syncs: its fonts that are on and that nobody has chosen to have on
    /// are shared as "on". Joining adds fonts; it never turns other computers' fonts off.
    pub fn seed(&mut self, conn: &Connection, faces: &LocalFaces) -> AppResult<usize> {
        let mut made = 0;
        let (me, group) = (self.config.device_id.clone(), self.config.group.clone());
        for (key, face) in &faces.faces {
            if !face.is_on() {
                continue;
            }
            match self.saved.merged.effective(key, &me, group.as_deref()) {
                Some(e) if e.on => {}
                _ => {
                    let mut set = self.face_meta(Some(face));
                    set.insert(face_field::ON.into(), json!(true));
                    let hlc = self.new_op(conn, OpKind::Face { key: key.clone(), set })?;
                    self.saved.applied.insert(key.clone(), hlc);
                    made += 1;
                }
            }
        }
        self.saved.seeded = true;
        Ok(made)
    }

    /// The user switched fonts on or off here. Each becomes the shared choice, unless this device
    /// (or its group) has an exception for it: then this device's exception changes, so the
    /// switch and the exception never disagree. Already done locally, so it's recorded as applied.
    pub fn choose(&mut self, conn: &Connection, keys: &[String], on: bool) -> AppResult<usize> {
        let faces = load_faces(conn)?;
        let (me, group) = (self.config.device_id.clone(), self.config.group.clone());
        let mut made = 0;
        for key in keys.iter().filter(|k| syncable_key(k)) {
            let eff = self.saved.merged.effective(key, &me, group.as_deref());
            let mut set = self.face_meta(faces.faces.get(key));
            match eff.map(|e| e.source) {
                Some(Source::Device) | Some(Source::Group) => {
                    set.insert(format!("{}{me}", face_field::DEVICE_PREFIX), json!(if on { "on" } else { "off" }));
                }
                _ => {
                    set.insert(face_field::ON.into(), json!(on));
                }
            }
            self.new_op(conn, OpKind::Face { key: key.clone(), set })?;
            if let Some(e) = self.saved.merged.effective(key, &me, group.as_deref()) {
                self.saved.applied.insert(key.clone(), e.stamp);
            }
            made += 1;
        }
        Ok(made)
    }

    /// Sets an exception for fonts: this device (or its group) always has them on, never has
    /// them on, or follows the shared choice. Carried out by the next `apply`.
    pub fn set_exception(&mut self, conn: &Connection, keys: &[String], value: Exception, target: ExceptionFor) -> AppResult<usize> {
        let field = match target {
            ExceptionFor::ThisDevice => format!("{}{}", face_field::DEVICE_PREFIX, self.config.device_id),
            ExceptionFor::ThisGroup => match &self.config.group {
                Some(g) => format!("{}{g}", face_field::GROUP_PREFIX),
                None => return Err(AppError::Invalid("This computer isn't in a device group".into())),
            },
        };
        let value = match value {
            Exception::Follow => Value::Null,
            Exception::On => json!("on"),
            Exception::Off => json!("off"),
        };
        let faces = load_faces(conn)?;
        let mut made = 0;
        for key in keys.iter().filter(|k| syncable_key(k)) {
            let mut set = self.face_meta(faces.faces.get(key));
            set.insert(field.clone(), value.clone());
            self.new_op(conn, OpKind::Face { key: key.clone(), set })?;
            made += 1;
        }
        Ok(made)
    }

    /// Writes the merged tags into the local tag tables, and works out which fonts to switch.
    /// Makes no changes of its own.
    pub fn apply(&mut self, conn: &Connection, faces: &LocalFaces, mismatched: &BTreeSet<String>) -> AppResult<Applied> {
        let view = self.saved.merged.tag_view();
        let mut out = Applied { tags_changed: write_tags(conn, &view, &self.saved.base, mismatched)?, ..Default::default() };
        // The base is now exactly what's in the tables.
        let local = load_local_tags(conn)?;
        let mut base = BTreeMap::new();
        for vt in &view.tags {
            if let Some((id, lt)) = local.iter().find(|(_, lt)| lt.name.eq_ignore_ascii_case(&vt.name)) {
                let keys = lt.keys.iter().filter(|k| !mismatched.contains(*k)).cloned().collect();
                base.insert(
                    *id,
                    BaseTag { sids: vt.sids.clone(), name: lt.name.clone(), color: lt.color.clone(), builtin: Some(lt.builtin), keys },
                );
            }
        }
        self.saved.base = base;
        self.plan_switches(faces, mismatched, &mut out);
        Ok(out)
    }

    fn plan_switches(&self, faces: &LocalFaces, mismatched: &BTreeSet<String>, out: &mut Applied) {
        let (me, group) = (self.config.device_id.as_str(), self.config.group.as_deref());
        let wanted_on = |key: &str| self.saved.merged.effective(key, me, group).is_some_and(|e| e.on);
        for key in self.saved.merged.faces.keys() {
            if mismatched.contains(key) {
                continue;
            }
            let Some(eff) = self.saved.merged.effective(key, me, group) else { continue };
            if self.saved.applied.get(key).is_some_and(|done| *done >= eff.stamp) {
                continue;
            }
            // Not on this device: keep the choice and try again when the font turns up.
            let Some(face) = faces.faces.get(key) else { continue };
            let own: Vec<&Copy> = face.copies.iter().filter(|c| !c.installed).collect();
            if eff.on {
                // Installed fonts are always on; a copy that's already on is enough.
                if face.copies.iter().any(|c| c.installed) || own.iter().any(|c| c.activated) || own.is_empty() {
                    out.stamps.insert(key.clone(), eff.stamp);
                    continue;
                }
                // One copy: a file with only this font in it, if there is one.
                let pick = own.iter().min_by_key(|c| (faces.by_path.get(&c.path).map_or(1, Vec::len), c.path.clone())).map(|c| c.id);
                out.turn_on.extend(pick.map(|id| (key.clone(), vec![id])));
            } else {
                // Every copy that's on, except files that also hold a font that should stay on.
                let ids: Vec<i64> = own
                    .iter()
                    .filter(|c| c.activated)
                    .filter(|c| faces.by_path.get(&c.path).is_none_or(|keys| keys.iter().all(|k| k == key || !wanted_on(k))))
                    .map(|c| c.id)
                    .collect();
                if !ids.is_empty() {
                    out.turn_off.push((key.clone(), ids));
                }
            }
            out.stamps.insert(key.clone(), eff.stamp);
        }
    }

    /// Records switches as carried out.
    pub fn mark_applied(&mut self, stamps: BTreeMap<String, Hlc>) {
        self.saved.applied.extend(stamps);
    }

    /// Fonts that should be on here but aren't on this device: (key, family, style).
    pub fn missing(&self, faces: &LocalFaces) -> Vec<(String, String, String)> {
        let (me, group) = (self.config.device_id.as_str(), self.config.group.as_deref());
        self.saved
            .merged
            .faces
            .keys()
            .filter(|k| !faces.faces.contains_key(*k))
            .filter(|k| self.saved.merged.effective(k, me, group).is_some_and(|e| e.on))
            .map(|k| {
                let family = self.saved.merged.face_str(k, face_field::FAMILY).unwrap_or_default().to_string();
                let style = self.saved.merged.face_str(k, face_field::STYLE).unwrap_or_default().to_string();
                (k.clone(), family, style)
            })
            .collect()
    }

    /// This device's exceptions, by face key.
    pub fn exceptions(&self) -> BTreeMap<String, Exception> {
        let me = self.me();
        self.saved
            .merged
            .faces
            .keys()
            .filter_map(|k| match self.saved.merged.exception(k, me)? {
                true => Some((k.clone(), Exception::On)),
                false => Some((k.clone(), Exception::Off)),
            })
            .collect()
    }

    // -------------------------------------------------------------------------- writing

    /// The change file to write next, if there's anything to write: (seq, row id of the last
    /// change in it, bytes). `existing`: change files already in this device's folder, so a
    /// number is never reused (after a reinstall, say).
    pub fn next_file(&self, existing: &[String]) -> Option<(u64, i64, Vec<u8>)> {
        let (last_row, _) = self.outbox.last()?;
        let used = existing.iter().filter_map(|f| ops::change_seq(f)).max().unwrap_or(0);
        let seq = self.saved.seq.max(used) + 1;
        let ops: Vec<Op> = self.outbox.iter().map(|(_, op)| op.clone()).collect();
        Some((seq, *last_row, ops::write_changes(&self.config.device_id, seq, &ops)))
    }

    /// The file `next_file` made was written.
    pub fn written(&mut self, conn: &Connection, seq: u64, last_row: i64) -> AppResult<()> {
        conn.execute("DELETE FROM sync_outbox WHERE id <= ?1", [last_row])?;
        self.outbox.retain(|(id, _)| *id > last_row);
        self.saved.seq = seq;
        let me = self.config.device_id.clone();
        let peer = self.saved.peers.entry(me).or_default();
        peer.seq = peer.seq.max(seq);
        Ok(())
    }

    pub fn device_file(&self, app_version: &str, now: u64) -> Vec<u8> {
        let d = DeviceFile {
            format: ops::DEVICE_FORMAT.into(),
            version: ops::VERSION,
            id: self.config.device_id.clone(),
            name: self.config.name.clone(),
            group: self.config.group.clone(),
            machine: self.config.machine.clone(),
            app_version: app_version.into(),
            last_seen: now,
            last_seq: self.saved.seq,
        };
        serde_json::to_vec_pretty(&d).unwrap_or_default()
    }

    pub fn device_file_due(&self, now: u64) -> bool {
        self.device_dirty || now.saturating_sub(self.saved.device_written) > DEVICE_FILE_EVERY_MS
    }

    /// When this device has written enough change files: its snapshot, and the files it covers.
    pub fn compaction(&self, existing: &[String]) -> Option<(Vec<u8>, Vec<String>)> {
        let covered: Vec<String> =
            existing.iter().filter(|f| ops::change_seq(f).is_some_and(|s| s <= self.saved.seq)).cloned().collect();
        if covered.len() < COMPACT_AFTER || !self.outbox.is_empty() {
            return None;
        }
        let ops = self.saved.merged.ops_by(&self.config.device_id);
        Some((ops::write_snapshot(&self.config.device_id, self.saved.seq, ops), covered))
    }

    /// Checks this device's own folder: if its device file was written by another computer, two
    /// computers share this id (app data copied, and the copy synced first). This one moves on.
    pub fn check_own_device_file(&mut self, conn: &Connection, own: Option<&DeviceFile>) -> AppResult<bool> {
        match own {
            Some(d) if !d.machine.is_empty() && !self.config.machine.is_empty() && d.machine != self.config.machine => {
                let name = device::default_name();
                self.take_new_id(conn, Some(&name))?;
                self.save_config(conn)?;
                Ok(true)
            }
            _ => Ok(false),
        }
    }
}

/// Writes the merged tags into the local tables. Returns whether anything changed.
fn write_tags(conn: &Connection, view: &TagView, base: &BTreeMap<i64, BaseTag>, mismatched: &BTreeSet<String>) -> AppResult<bool> {
    let local = load_local_tags(conn)?;
    let mut changed = false;
    // Which local tag each merged tag is: one it was before (by sync id), else one with its name.
    let mut sid_owner: HashMap<&str, i64> = HashMap::new();
    for (id, b) in base {
        if local.contains_key(id) {
            for s in &b.sids {
                sid_owner.insert(s, *id);
            }
        }
    }
    let mut claimed: HashMap<i64, usize> = HashMap::new();
    let mut absorbed: Vec<(i64, i64)> = Vec::new();
    let mut create: Vec<usize> = Vec::new();
    for (i, vt) in view.tags.iter().enumerate() {
        let mut owners: Vec<i64> = vt.sids.iter().filter_map(|s| sid_owner.get(s.as_str())).copied().collect();
        owners.sort_unstable();
        owners.dedup();
        owners.retain(|id| !claimed.contains_key(id));
        let chosen = owners.first().copied().or_else(|| {
            local.iter().find(|(id, lt)| !claimed.contains_key(id) && !base.contains_key(id) && lt.name.eq_ignore_ascii_case(&vt.name)).map(|(id, _)| *id)
        });
        match chosen {
            Some(id) => {
                claimed.insert(id, i);
                // Two local tags that turned out to be the same one: keep one, move the fonts.
                for other in owners.into_iter().skip(1) {
                    absorbed.push((other, id));
                    claimed.insert(other, usize::MAX);
                }
            }
            None => create.push(i),
        }
    }
    for (from, into) in &absorbed {
        conn.execute(
            "INSERT OR IGNORE INTO tag_fonts (tag_id, face_key, added_at) SELECT ?1, face_key, added_at FROM tag_fonts WHERE tag_id = ?2",
            params![into, from],
        )?;
        conn.execute("DELETE FROM tags WHERE id = ?1", [from])?;
        changed = true;
    }
    // Tags sync knew that are no longer in the merged state: deleted elsewhere.
    for id in base.keys().filter(|id| local.contains_key(id) && !claimed.contains_key(id)) {
        conn.execute("DELETE FROM tags WHERE id = ?1", [id])?;
        changed = true;
    }
    // Renames, in two steps, so names that swap never collide.
    let renames: Vec<(i64, &str)> = claimed
        .iter()
        .filter(|(_, i)| **i != usize::MAX)
        .filter(|(id, i)| local[*id].name != view.tags[**i].name)
        .map(|(id, i)| (*id, view.tags[*i].name.as_str()))
        .collect();
    for (id, _) in &renames {
        conn.execute("UPDATE tags SET name = '\u{1}' || id WHERE id = ?1", [id])?;
    }
    for (id, name) in &renames {
        conn.execute("UPDATE tags SET name = ?1 WHERE id = ?2", params![name, id])?;
        changed = true;
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let mut ids: Vec<(i64, usize)> = claimed.into_iter().filter(|(_, i)| *i != usize::MAX).collect();
    for i in create {
        let vt = &view.tags[i];
        conn.execute(
            "INSERT INTO tags (name, color, created_at, builtin) VALUES (?1, ?2, ?3, ?4)",
            params![vt.name, vt.color, now, vt.builtin],
        )?;
        ids.push((conn.last_insert_rowid(), i));
        changed = true;
    }
    for (id, i) in ids {
        let vt = &view.tags[i];
        let (color, builtin, keys) = match local.get(&id) {
            Some(lt) => (lt.color.as_str(), lt.builtin, lt.keys.clone()),
            None => ("", vt.builtin, BTreeSet::new()),
        };
        if color != vt.color && local.contains_key(&id) {
            conn.execute("UPDATE tags SET color = ?1 WHERE id = ?2", params![vt.color, id])?;
            changed = true;
        }
        // The view gives a nested tag its top-level tag's group, so subtrees stay in one group.
        if builtin != vt.builtin {
            conn.execute("UPDATE tags SET builtin = ?1 WHERE id = ?2", params![vt.builtin, id])?;
            changed = true;
        }
        for key in vt.keys.difference(&keys).filter(|k| !mismatched.contains(*k)) {
            changed |= conn.execute(
                "INSERT OR IGNORE INTO tag_fonts (tag_id, face_key, added_at) VALUES (?1, ?2, ?3)",
                params![id, key, now],
            )? > 0;
        }
        for key in keys.difference(&vt.keys).filter(|k| !mismatched.contains(*k)) {
            conn.execute("DELETE FROM tag_fonts WHERE tag_id = ?1 AND face_key = ?2", params![id, key])?;
            changed = true;
        }
    }
    Ok(changed)
}
