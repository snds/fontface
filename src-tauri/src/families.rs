//! Family grouping: your choices, and the names it reads from fonts.
//!
//! The rules themselves live in the UI (src/familyGroups.ts), which groups the whole library on
//! every list load. This side keeps what they need that the list didn't have:
//!
//! - **Your choices**, as Fontface's own records. They never change a font file.
//!   - `family_overrides`: your choice for one font, by face key (the key tags use, so copies
//!     and rescans keep it): a family and maybe a style, or family NULL for "keep it under its
//!     own name".
//!   - `family_rules`: your rule for a family name, by its squash key (lowercase, without
//!     spaces, hyphens, underscores, dots, ™ and ®; worked out by the UI): merge it into a
//!     family, or keep it separate. Fonts that arrive later with that name follow it.
//!
//!   Every change goes through `apply`, which returns the change that undoes it, so Undo (and
//!   redo) is the same call. Side tables outside db.rs's numbered migrations, like the tag
//!   tables; `ensure_schema` is safe at every launch. **Not synced yet** (docs/SYNC.md): they're
//!   keyed like tags, so a later version can share them.
//!
//! - **The font's own names**: name IDs 16 (its own grouping family, if it has one), 1 and 2,
//!   in `fonts.typo_family`, `legacy_family` and `legacy_style`. The scanner writes them; for
//!   fonts scanned before, `backfill_names` reads them once at launch, reading only each file's
//!   `name` table. Like the preview backfill it never reads Creative Cloud's files and never
//!   downloads an online-only file (those wait for a later launch).

use std::{
    collections::{BTreeMap, HashMap},
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering::Relaxed},
        mpsc::{self, RecvTimeoutError},
        Arc,
    },
    time::{Duration, Instant},
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    cloud, db,
    error::{AppError, AppResult},
    preview::{self, Unreadable},
    AppState,
};

/// Bump to read every font's names again at the next launch.
pub const NAMES_REV: i64 = 1;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS family_overrides (
    face_key  TEXT PRIMARY KEY,
    family    TEXT,
    style     TEXT,
    set_at    INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS family_rules (
    name_key     TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    decision     TEXT NOT NULL CHECK (decision IN ('merge', 'separate')),
    into_family  TEXT,
    set_at       INTEGER NOT NULL
) WITHOUT ROWID;
";

/// Creates the tables if they're missing. Idempotent; called at launch.
pub fn ensure_schema(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(SCHEMA)?;
    Ok(())
}

// ----------------------------------------------------------------------------- choices

/// Your choice for one font. Must match FaceChoice in src/familyGroups.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceChoice {
    pub face_key: String,
    /// None: under its own name, whatever grouping by name would do.
    pub family: Option<String>,
    /// None: worked out from its names.
    pub style: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Merge,
    Separate,
}

impl Decision {
    fn as_str(self) -> &'static str {
        match self {
            Decision::Merge => "merge",
            Decision::Separate => "separate",
        }
    }
}

/// Your rule for a family name. Must match NameRule in src/familyGroups.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NameRule {
    pub name_key: String,
    /// The name as it was spelled when you chose.
    pub name: String,
    pub decision: Decision,
    /// For a merge: the family it goes into.
    pub into: Option<String>,
}

/// Everything you've chosen.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyChoices {
    pub choices: Vec<FaceChoice>,
    pub rules: Vec<NameRule>,
}

/// A font's choice to set, or none to clear it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceValue {
    pub family: Option<String>,
    pub style: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceEdit {
    pub face_key: String,
    pub set: Option<ChoiceValue>,
}

/// A name's rule to set, or none to clear it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleValue {
    pub name: String,
    pub decision: Decision,
    pub into: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NameEdit {
    pub name_key: String,
    pub set: Option<RuleValue>,
}

/// Changes to your choices. `apply` returns another of these: the one that undoes it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FamilyChange {
    pub faces: Vec<FaceEdit>,
    pub names: Vec<NameEdit>,
}

/// At most this many edits in one change ("Merge all suggestions" on a big library stays well under).
const MAX_EDITS: usize = 50_000;
/// Family, style and name text, in characters.
const MAX_TEXT: usize = 200;
const MAX_KEY: usize = 1024;

pub fn load(conn: &Connection) -> AppResult<FamilyChoices> {
    let mut out = FamilyChoices::default();
    let mut stmt = conn.prepare("SELECT face_key, family, style FROM family_overrides ORDER BY face_key")?;
    out.choices = stmt
        .query_map([], |r| Ok(FaceChoice { face_key: r.get(0)?, family: r.get(1)?, style: r.get(2)? }))?
        .collect::<Result<_, _>>()?;
    let mut stmt = conn.prepare("SELECT name_key, name, decision, into_family FROM family_rules ORDER BY name_key")?;
    out.rules = stmt
        .query_map([], |r| {
            let decision: String = r.get(2)?;
            Ok(NameRule {
                name_key: r.get(0)?,
                name: r.get(1)?,
                decision: if decision == "merge" { Decision::Merge } else { Decision::Separate },
                into: r.get(3)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(out)
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Invalid(message.into())
}

/// Trimmed text, or an error naming what it was. Empty is refused.
fn text(value: &str, what: &str) -> AppResult<String> {
    let t = value.trim();
    if t.is_empty() {
        return Err(invalid(format!("{what} can't be empty")));
    }
    if t.chars().count() > MAX_TEXT {
        return Err(invalid(format!("{what} can be at most {MAX_TEXT} characters")));
    }
    if t.chars().any(char::is_control) {
        return Err(invalid(format!("{what} can't contain control characters")));
    }
    Ok(t.to_string())
}

fn key(value: &str, what: &str) -> AppResult<()> {
    if value.is_empty() || value.len() > MAX_KEY || value.contains('\0') {
        return Err(invalid(format!("That {what} isn't one Fontface knows")));
    }
    Ok(())
}

/// Checks and tidies a change: text trimmed, an empty style counts as none, and a key given
/// twice keeps its last edit. All or nothing: one bad edit refuses the lot.
fn validated(change: &FamilyChange) -> AppResult<FamilyChange> {
    if change.faces.len() + change.names.len() > MAX_EDITS {
        return Err(invalid("That's too many changes at once"));
    }
    let mut faces: BTreeMap<String, Option<ChoiceValue>> = BTreeMap::new();
    for edit in &change.faces {
        key(&edit.face_key, "font")?;
        if !edit.face_key.starts_with("ps:") && !edit.face_key.starts_with("file:") {
            return Err(invalid("That font isn't one Fontface knows"));
        }
        let set = match &edit.set {
            None => None,
            Some(v) => Some(ChoiceValue {
                family: v.family.as_deref().map(|f| text(f, "A family name")).transpose()?,
                style: match v.style.as_deref().map(str::trim) {
                    None | Some("") => None,
                    Some(s) => Some(text(s, "A style name")?),
                },
            }),
        };
        faces.insert(edit.face_key.clone(), set);
    }
    let mut names: BTreeMap<String, Option<RuleValue>> = BTreeMap::new();
    for edit in &change.names {
        key(&edit.name_key, "family name")?;
        let set = match &edit.set {
            None => None,
            Some(v) => {
                let into = match v.decision {
                    Decision::Merge => Some(text(v.into.as_deref().unwrap_or_default(), "The family to merge into")?),
                    Decision::Separate => None,
                };
                Some(RuleValue { name: text(&v.name, "A family name")?, decision: v.decision, into })
            }
        };
        names.insert(edit.name_key.clone(), set);
    }
    Ok(FamilyChange {
        faces: faces.into_iter().map(|(face_key, set)| FaceEdit { face_key, set }).collect(),
        names: names.into_iter().map(|(name_key, set)| NameEdit { name_key, set }).collect(),
    })
}

/// Makes a change in one transaction and returns the change that undoes it (the rows as they
/// were, or none where there was none). Applying that returns this change again: redo.
pub fn apply(conn: &mut Connection, change: &FamilyChange) -> AppResult<FamilyChange> {
    let change = validated(change)?;
    let now = db::now();
    let tx = conn.transaction()?;
    let mut undo = FamilyChange::default();
    for edit in &change.faces {
        let before = tx
            .query_row("SELECT family, style FROM family_overrides WHERE face_key = ?1", [&edit.face_key], |r| {
                Ok(ChoiceValue { family: r.get(0)?, style: r.get(1)? })
            })
            .optional()?;
        match &edit.set {
            Some(v) => {
                tx.execute(
                    "INSERT INTO family_overrides (face_key, family, style, set_at) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT (face_key) DO UPDATE SET family = excluded.family, style = excluded.style, set_at = excluded.set_at",
                    params![edit.face_key, v.family, v.style, now],
                )?;
            }
            None => {
                tx.execute("DELETE FROM family_overrides WHERE face_key = ?1", [&edit.face_key])?;
            }
        }
        undo.faces.push(FaceEdit { face_key: edit.face_key.clone(), set: before });
    }
    for edit in &change.names {
        let before = tx
            .query_row("SELECT name, decision, into_family FROM family_rules WHERE name_key = ?1", [&edit.name_key], |r| {
                let decision: String = r.get(1)?;
                Ok(RuleValue {
                    name: r.get(0)?,
                    decision: if decision == "merge" { Decision::Merge } else { Decision::Separate },
                    into: r.get(2)?,
                })
            })
            .optional()?;
        match &edit.set {
            Some(v) => {
                tx.execute(
                    "INSERT INTO family_rules (name_key, name, decision, into_family, set_at) VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT (name_key) DO UPDATE SET name = excluded.name, decision = excluded.decision,
                        into_family = excluded.into_family, set_at = excluded.set_at",
                    params![edit.name_key, v.name, v.decision.as_str(), v.into, now],
                )?;
            }
            None => {
                tx.execute("DELETE FROM family_rules WHERE name_key = ?1", [&edit.name_key])?;
            }
        }
        undo.names.push(NameEdit { name_key: edit.name_key.clone(), set: before });
    }
    tx.commit()?;
    Ok(undo)
}

/// A family name, for a rule: its squash key (the UI's) and its spelling.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NameRef {
    pub name_key: String,
    pub name: String,
}

/// Merge: these names go into `into` from now on (fonts that arrive later too), and these
/// fonts, chosen into another family before, go there with them.
pub fn merge_change(names: &[NameRef], into: &str, faces: &[String]) -> FamilyChange {
    FamilyChange {
        names: names
            .iter()
            .map(|n| NameEdit {
                name_key: n.name_key.clone(),
                set: Some(RuleValue { name: n.name.clone(), decision: Decision::Merge, into: Some(into.to_string()) }),
            })
            .collect(),
        faces: faces
            .iter()
            .map(|k| FaceEdit { face_key: k.clone(), set: Some(ChoiceValue { family: Some(into.to_string()), style: None }) })
            .collect(),
    }
}

/// Keep separate: these names are never grouped by name, and these fonts stay under their own
/// names whatever any rule says.
pub fn keep_separate_change(names: &[NameRef], faces: &[String]) -> FamilyChange {
    FamilyChange {
        names: names
            .iter()
            .map(|n| NameEdit {
                name_key: n.name_key.clone(),
                set: Some(RuleValue { name: n.name.clone(), decision: Decision::Separate, into: None }),
            })
            .collect(),
        faces: faces.iter().map(|k| FaceEdit { face_key: k.clone(), set: Some(ChoiceValue { family: None, style: None }) }).collect(),
    }
}

/// Group these fonts into a family (with a style, for one font).
pub fn move_change(faces: &[String], family: &str, style: Option<&str>) -> FamilyChange {
    FamilyChange {
        faces: faces
            .iter()
            .map(|k| FaceEdit {
                face_key: k.clone(),
                set: Some(ChoiceValue { family: Some(family.to_string()), style: style.map(str::to_string) }),
            })
            .collect(),
        names: vec![],
    }
}

/// Forget your choices for these fonts and your rules for these names: grouping by name (or
/// the fonts' own names) decides again.
pub fn reset_change(faces: &[String], name_keys: &[String]) -> FamilyChange {
    FamilyChange {
        faces: faces.iter().map(|k| FaceEdit { face_key: k.clone(), set: None }).collect(),
        names: name_keys.iter().map(|k| NameEdit { name_key: k.clone(), set: None }).collect(),
    }
}

#[tauri::command(async)]
pub fn families_get(state: State<'_, AppState>) -> AppResult<FamilyChoices> {
    load(&*state.conn()?)
}

/// Returns the change that undoes it (for `families_undo`).
#[tauri::command(async)]
pub fn families_merge(state: State<'_, AppState>, names: Vec<NameRef>, into: String, faces: Vec<String>) -> AppResult<FamilyChange> {
    let change = merge_change(&names, &into, &faces);
    state.write_local(|conn| apply(conn, &change))
}

#[tauri::command(async)]
pub fn families_keep_separate(state: State<'_, AppState>, names: Vec<NameRef>, faces: Vec<String>) -> AppResult<FamilyChange> {
    let change = keep_separate_change(&names, &faces);
    state.write_local(|conn| apply(conn, &change))
}

#[tauri::command(async)]
pub fn families_move(state: State<'_, AppState>, faces: Vec<String>, family: String, style: Option<String>) -> AppResult<FamilyChange> {
    let change = move_change(&faces, &family, style.as_deref());
    state.write_local(|conn| apply(conn, &change))
}

#[tauri::command(async)]
pub fn families_reset(state: State<'_, AppState>, faces: Vec<String>, name_keys: Vec<String>) -> AppResult<FamilyChange> {
    let change = reset_change(&faces, &name_keys);
    state.write_local(|conn| apply(conn, &change))
}

/// Applies a change another command returned: Undo, and Undo again (redo).
#[tauri::command(async)]
pub fn families_undo(state: State<'_, AppState>, change: FamilyChange) -> AppResult<FamilyChange> {
    state.write_local(|conn| apply(conn, &change))
}

/// Several changes as one, with one undo ("Merge all suggestions").
#[tauri::command(async)]
pub fn families_apply(state: State<'_, AppState>, change: FamilyChange) -> AppResult<FamilyChange> {
    state.write_local(|conn| apply(conn, &change))
}

// ------------------------------------------------------------------------ names backfill

/// One face's names, as read from its `name` table.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FaceNames {
    pub index: u32,
    /// Name ID 16.
    pub typo_family: Option<String>,
    /// Name ID 1.
    pub family: Option<String>,
    /// Name ID 2.
    pub style: Option<String>,
}

/// The largest `name` table read (real ones are a few kilobytes; a hostile file can claim more).
const MAX_NAME_TABLE: u32 = 4 * 1024 * 1024;

/// Reads the names of some faces of a library file, reading only the file's headers and its
/// `name` table. `stamp` is the (size, modified time) the library has for it: a file that no
/// longer matches isn't read (its next scan reads it). Creative Cloud's files are never read,
/// and an online-only file isn't downloaded: the calling thread must fail fast on those
/// (`cloud::fail_fast_on_this_thread`).
pub fn read_names(path: &str, stamp: (i64, i64), indices: &[u32]) -> Result<Vec<FaceNames>, Unreadable> {
    if preview::never_read(path) {
        return Err(Unreadable::Adobe);
    }
    let meta = std::fs::metadata(path).map_err(|_| Unreadable::Missing)?;
    if cloud::is_dataless(&meta) {
        return Err(Unreadable::Cloud);
    }
    if stamp != (meta.len() as i64, crate::scanner::mtime_secs(&meta)) {
        return Err(Unreadable::Changed);
    }
    let size = meta.len();
    let mut file = std::fs::File::open(path).map_err(|e| if cloud::is_not_downloaded(&e) { Unreadable::Cloud } else { Unreadable::Missing })?;
    let broken = |what: &str| Unreadable::Broken(what.to_string());
    let mut read_at = |offset: u64, len: u32| -> Result<Vec<u8>, Unreadable> {
        if offset.checked_add(u64::from(len)).is_none_or(|end| end > size) {
            return Err(broken("a table runs past the end of the file"));
        }
        file.seek(SeekFrom::Start(offset)).map_err(|_| broken("couldn't read the file"))?;
        let mut buf = vec![0; len as usize];
        file.read_exact(&mut buf).map_err(|e| if cloud::is_not_downloaded(&e) { Unreadable::Cloud } else { broken("couldn't read the file") })?;
        Ok(buf)
    };
    let u16_at = |b: &[u8], o: usize| u16::from_be_bytes([b[o], b[o + 1]]);
    let u32_at = |b: &[u8], o: usize| u32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
    let header = read_at(0, 12)?;
    // Where each face's table directory starts.
    let dirs: Vec<u64> = if &header[..4] == b"ttcf" {
        let count = u32_at(&header, 8).min(256);
        let offsets = read_at(12, 4 * count)?;
        (0..count as usize).map(|i| u64::from(u32_at(&offsets, 4 * i))).collect()
    } else {
        vec![0]
    };
    let mut out = Vec::with_capacity(indices.len());
    for &index in indices {
        let dir = *dirs.get(index as usize).ok_or_else(|| broken("the face isn't in the file"))?;
        let head = read_at(dir, 12)?;
        let tables = u32::from(u16_at(&head, 4)).min(1024);
        let records = read_at(dir + 12, 16 * tables)?;
        let name = (0..tables as usize).map(|i| 16 * i).find(|&r| &records[r..r + 4] == b"name");
        let mut names = FaceNames { index, ..Default::default() };
        if let Some(r) = name {
            let (offset, length) = (u32_at(&records, r + 8), u32_at(&records, r + 12));
            if length > MAX_NAME_TABLE {
                return Err(broken("its name table is too large"));
            }
            let bytes = read_at(u64::from(offset), length)?;
            if let Some(table) = ttf_parser::name::Table::parse(&bytes) {
                names.typo_family = crate::scanner::names_string(table.names, 16);
                names.family = crate::scanner::names_string(table.names, 1);
                names.style = crate::scanner::names_string(table.names, 2);
            }
        }
        out.push(names);
    }
    Ok(out)
}

/// A file whose faces' names haven't been read yet: (path, size, mtime) and (row id, face index).
type Unread = ((String, i64, i64), Vec<(i64, u32)>);

fn unread_files(conn: &Connection) -> AppResult<Vec<Unread>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, face_index, file_size, mtime FROM fonts WHERE names_rev IS NULL OR names_rev < ?1 ORDER BY path, face_index",
    )?;
    let rows = stmt.query_map([NAMES_REV], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, u32>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?)))?;
    let mut files: Vec<Unread> = Vec::new();
    let mut at: HashMap<(String, i64, i64), usize> = HashMap::new();
    for row in rows {
        let (id, path, index, size, mtime) = row?;
        if preview::never_read(&path) {
            continue;
        }
        let file = (path, size, mtime);
        match at.get(&file) {
            Some(&i) => files[i].1.push((id, index)),
            None => {
                at.insert(file.clone(), files.len());
                files.push((file, vec![(id, index)]));
            }
        }
    }
    Ok(files)
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct NamesReport {
    pub files: usize,
    /// Faces whose names were saved.
    pub written: usize,
    /// Online-only files, left for a later launch.
    pub cloud: usize,
    /// Missing, changed since the scan, or unreadable.
    pub other: usize,
}

/// Reads the names of fonts scanned before Fontface stored them, once, at launch, in the
/// background: two reader threads (failing fast on online-only files, which are left for later)
/// and one writer that saves what they've read about every 400 ms in a short transaction,
/// taking the scan write turn after any waiting UI write. A file whose `name` table can't be
/// read counts as read (no names), so it isn't tried at every launch; files that are missing,
/// online-only or changed since the scan are tried again next time.
pub fn backfill_names(db_path: &Path) -> AppResult<NamesReport> {
    backfill_names_with(db_path, 2, read_names)
}

type ReadNames = dyn Fn(&str, (i64, i64), &[u32]) -> Result<Vec<FaceNames>, Unreadable> + Send + Sync;

pub(crate) fn backfill_names_with(
    db_path: &Path,
    threads: usize,
    read: impl Fn(&str, (i64, i64), &[u32]) -> Result<Vec<FaceNames>, Unreadable> + Send + Sync + 'static,
) -> AppResult<NamesReport> {
    let mut conn = db::open(db_path)?;
    let jobs = Arc::new(unread_files(&conn)?);
    let mut report = NamesReport { files: jobs.len(), ..Default::default() };
    if jobs.is_empty() {
        return Ok(report);
    }
    let read: Arc<ReadNames> = Arc::new(read);
    let next = Arc::new(AtomicUsize::new(0));
    let (tx, rx) = mpsc::channel::<(usize, Result<Vec<FaceNames>, Unreadable>)>();
    for _ in 0..threads.clamp(1, jobs.len()) {
        let (jobs, next, tx, read) = (jobs.clone(), next.clone(), tx.clone(), read.clone());
        std::thread::spawn(move || {
            cloud::fail_fast_on_this_thread();
            loop {
                let i = next.fetch_add(1, Relaxed);
                let Some(((path, size, mtime), faces)) = jobs.get(i) else { break };
                let indices: Vec<u32> = faces.iter().map(|&(_, index)| index).collect();
                if tx.send((i, read(path, (*size, *mtime), &indices))).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);

    // (row id, size, mtime, names) read and not saved yet.
    let mut ready: Vec<(i64, i64, i64, FaceNames)> = Vec::new();
    let mut last_save = Instant::now();
    loop {
        let finished = match rx.recv_timeout(Duration::from_millis(250)) {
            Ok((i, result)) => {
                let ((_, size, mtime), faces) = &jobs[i];
                match result {
                    Ok(names) => {
                        for n in names {
                            if let Some(&(id, _)) = faces.iter().find(|&&(_, index)| index == n.index) {
                                ready.push((id, *size, *mtime, n));
                            }
                        }
                    }
                    // Unreadable: no names to save, but it's been looked at.
                    Err(Unreadable::Broken(_)) => {
                        for &(id, index) in faces {
                            ready.push((id, *size, *mtime, FaceNames { index, ..Default::default() }));
                        }
                    }
                    Err(Unreadable::Cloud) => report.cloud += 1,
                    Err(_) => report.other += 1,
                }
                false
            }
            Err(RecvTimeoutError::Timeout) => false,
            Err(RecvTimeoutError::Disconnected) => true,
        };
        if !ready.is_empty() && (finished || last_save.elapsed() >= Duration::from_millis(400)) {
            while db::ui_write_waiting() {
                std::thread::sleep(Duration::from_millis(2));
            }
            let _turn = db::scan_write_turn();
            let tx = conn.transaction()?;
            {
                // Only while the row is still that version of the file: a scan that read it since
                // has written its names itself.
                let mut stmt = tx.prepare_cached(
                    "UPDATE fonts SET typo_family = ?1, legacy_family = ?2, legacy_style = ?3, names_rev = ?4
                     WHERE id = ?5 AND file_size = ?6 AND mtime = ?7",
                )?;
                for (id, size, mtime, n) in ready.drain(..) {
                    report.written += stmt.execute(params![n.typo_family, n.family, n.style, NAMES_REV, id, size, mtime])?;
                }
            }
            tx.commit()?;
            last_save = Instant::now();
        }
        if finished {
            break;
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use std::sync::{atomic::AtomicBool, Arc};

    use super::*;
    use crate::test_fonts::{collection, sfnt, FontBuilder};

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("fontface-families-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("fonts")).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    fn library(dir: &Path) -> Connection {
        let conn = db::open(&dir.join("library.sqlite3")).unwrap();
        ensure_schema(&conn).unwrap();
        conn
    }

    fn rule(key: &str, name: &str, decision: Decision, into: Option<&str>) -> NameEdit {
        NameEdit { name_key: key.into(), set: Some(RuleValue { name: name.into(), decision, into: into.map(str::to_string) }) }
    }

    #[test]
    fn schema_is_idempotent_and_starts_empty() {
        let dir = temp("schema");
        let conn = library(&dir);
        ensure_schema(&conn).unwrap();
        ensure_schema(&conn).unwrap();
        assert_eq!(load(&conn).unwrap(), FamilyChoices::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_keep_separate_move_reset_and_undo() {
        let dir = temp("apply");
        let mut conn = library(&dir);
        let names = [NameRef { name_key: "aauxprobold".into(), name: "Aaux ProBold".into() }];

        // Merge, and its undo.
        let undo = apply(&mut conn, &merge_change(&names, "Aaux Pro", &[])).unwrap();
        assert_eq!(
            load(&conn).unwrap().rules,
            vec![NameRule { name_key: "aauxprobold".into(), name: "Aaux ProBold".into(), decision: Decision::Merge, into: Some("Aaux Pro".into()) }]
        );
        assert_eq!(undo, FamilyChange { faces: vec![], names: vec![NameEdit { name_key: "aauxprobold".into(), set: None }] });
        let redo = apply(&mut conn, &undo).unwrap();
        assert!(load(&conn).unwrap().rules.is_empty(), "undo takes the rule away");
        apply(&mut conn, &redo).unwrap();
        assert_eq!(load(&conn).unwrap().rules.len(), 1, "and undoing the undo puts it back");

        // Keep separate replaces the merge; undo brings the merge back.
        let undo = apply(&mut conn, &keep_separate_change(&names, &["ps:AmintaBold|static|r".into()])).unwrap();
        let now = load(&conn).unwrap();
        assert_eq!(now.rules[0].decision, Decision::Separate);
        assert_eq!(now.rules[0].into, None);
        assert_eq!(now.choices, vec![FaceChoice { face_key: "ps:AmintaBold|static|r".into(), family: None, style: None }]);
        apply(&mut conn, &undo).unwrap();
        let back = load(&conn).unwrap();
        assert_eq!(back.rules[0].decision, Decision::Merge);
        assert!(back.choices.is_empty());

        // Move, with a style for one font; text is trimmed, an empty style is none.
        apply(&mut conn, &move_change(&["ps:A|static|r".into()], "  Display Faces ", Some("Bold Swash"))).unwrap();
        apply(&mut conn, &move_change(&["ps:B|static|r".into()], "Display Faces", Some("  "))).unwrap();
        let moved = load(&conn).unwrap().choices;
        assert_eq!(moved[0], FaceChoice { face_key: "ps:A|static|r".into(), family: Some("Display Faces".into()), style: Some("Bold Swash".into()) });
        assert_eq!(moved[1].style, None);

        // Reset forgets choices and rules.
        let undo = apply(&mut conn, &reset_change(&["ps:A|static|r".into(), "ps:B|static|r".into()], &["aauxprobold".into()])).unwrap();
        assert_eq!(load(&conn).unwrap(), FamilyChoices::default());
        apply(&mut conn, &undo).unwrap();
        assert_eq!(load(&conn).unwrap().choices.len(), 2);
        assert_eq!(load(&conn).unwrap().rules.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bad_changes_are_refused_whole() {
        let dir = temp("invalid");
        let mut conn = library(&dir);
        let good = rule("dynasty", "Dynasty", Decision::Separate, None);
        for bad in [
            FamilyChange { names: vec![good.clone(), rule("x", "X", Decision::Merge, Some("  "))], faces: vec![] },
            FamilyChange { names: vec![good.clone(), rule("", "X", Decision::Separate, None)], faces: vec![] },
            FamilyChange {
                names: vec![good.clone()],
                faces: vec![FaceEdit { face_key: "nonsense".into(), set: None }],
            },
            FamilyChange {
                names: vec![good.clone()],
                faces: vec![FaceEdit { face_key: "ps:A|static|r".into(), set: Some(ChoiceValue { family: Some("x".repeat(201)), style: None }) }],
            },
        ] {
            assert!(matches!(apply(&mut conn, &bad), Err(AppError::Invalid(_))), "{bad:?}");
            assert_eq!(load(&conn).unwrap(), FamilyChoices::default(), "nothing written");
        }
        // The same key twice keeps its last edit, and undo restores the first state.
        let twice = FamilyChange { names: vec![rule("k", "K", Decision::Separate, None), rule("k", "K", Decision::Merge, Some("Kay"))], faces: vec![] };
        let undo = apply(&mut conn, &twice).unwrap();
        assert_eq!(load(&conn).unwrap().rules[0].decision, Decision::Merge);
        apply(&mut conn, &undo).unwrap();
        assert!(load(&conn).unwrap().rules.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn font(family: &str, style: &str, typo: Option<&str>) -> Vec<([u8; 4], Vec<u8>)> {
        let mut b = FontBuilder::new().named(family).name(2, style).name(6, &format!("{}-{style}", family.replace(' ', "")));
        if let Some(t) = typo {
            b = b.name(16, t);
        }
        b.chars("AB").tables()
    }

    /// The scanner stores names 1, 2 and 16; the list says whether the font named its own
    /// family, and its name 1 where that differs. Your choices aren't touched by rescans or by
    /// reopening the library.
    #[test]
    fn the_scanner_stores_names_and_choices_survive_rescans_and_reopening() {
        let dir = temp("scan");
        let fonts = dir.join("fonts");
        std::fs::write(fonts.join("AmintaBold.ttf"), sfnt(&font("AmintaBold", "Regular", None))).unwrap();
        std::fs::write(fonts.join("Avenir.ttf"), sfnt(&font("Avenir Next Medium", "Regular", Some("Avenir Next")))).unwrap();
        // A name 16 that only repeats name 1 groups nothing.
        std::fs::write(fonts.join("Din.ttf"), sfnt(&font("DIN-Black", "Regular", Some("DIN-Black")))).unwrap();
        let db_path = dir.join("library.sqlite3");
        let mut conn = library(&dir);
        let folder = db::insert_folder(&mut conn, &fonts, "user").unwrap();
        crate::scanner::scan_folder(&db_path, folder, &fonts, &Arc::new(AtomicBool::new(false)), |_| {}).unwrap();
        let list = db::list_fonts(&conn).unwrap();
        let amin = list.iter().find(|f| f.family == "AmintaBold").unwrap();
        assert_eq!((amin.has_typo_family, amin.legacy_family.as_deref()), (Some(false), None));
        let avenir = list.iter().find(|f| f.family == "Avenir Next").unwrap();
        assert_eq!((avenir.has_typo_family, avenir.legacy_family.as_deref()), (Some(true), Some("Avenir Next Medium")));
        let din = list.iter().find(|f| f.family == "DIN-Black").unwrap();
        assert_eq!((din.has_typo_family, din.legacy_family.as_deref()), (Some(false), None));
        let json = serde_json::to_value(amin).unwrap();
        assert_eq!(json["hasTypoFamily"], serde_json::json!(false));
        assert!(json.get("legacyFamily").is_none(), "left out when it's the family");

        apply(&mut conn, &move_change(&["ps:AmintaBold-Regular|static|r".into()], "Aminta", None)).unwrap();
        std::fs::write(fonts.join("AmintaBold.ttf"), sfnt(&font("AmintaBold", "Regular", None)).into_iter().chain([0u8; 4]).collect::<Vec<_>>()).unwrap();
        crate::scanner::scan_folder(&db_path, folder, &fonts, &Arc::new(AtomicBool::new(false)), |_| {}).unwrap();
        drop(conn);
        let conn = library(&dir);
        assert_eq!(load(&conn).unwrap().choices[0].family.as_deref(), Some("Aminta"), "kept through a rescan and a reopen");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_names_reads_only_the_name_table_of_each_face() {
        let dir = temp("read");
        let single = dir.join("fonts/single.ttf");
        std::fs::write(&single, sfnt(&font("Dynasty Heavy", "Italic", None))).unwrap();
        let ttc = dir.join("fonts/both.ttc");
        std::fs::write(&ttc, collection(&[font("Gill Sans", "Regular", Some("Gill Sans")), font("Gill Sans Light", "Regular", Some("Gill Sans"))])).unwrap();
        let stamp = |p: &Path| {
            let m = std::fs::metadata(p).unwrap();
            (m.len() as i64, crate::scanner::mtime_secs(&m))
        };
        let names = read_names(single.to_str().unwrap(), stamp(&single), &[0]).unwrap();
        assert_eq!(names, vec![FaceNames { index: 0, typo_family: None, family: Some("Dynasty Heavy".into()), style: Some("Italic".into()) }]);
        let names = read_names(ttc.to_str().unwrap(), stamp(&ttc), &[1, 0]).unwrap();
        assert_eq!(names[0], FaceNames { index: 1, typo_family: Some("Gill Sans".into()), family: Some("Gill Sans Light".into()), style: Some("Regular".into()) });
        assert_eq!(names[1].family.as_deref(), Some("Gill Sans"));
        assert!(matches!(read_names(single.to_str().unwrap(), (1, 1), &[0]), Err(Unreadable::Changed)), "a file that changed waits for its scan");
        assert!(matches!(read_names(ttc.to_str().unwrap(), stamp(&ttc), &[5]), Err(Unreadable::Broken(_))));
        assert!(matches!(read_names("/nowhere/x.ttf", (1, 1), &[0]), Err(Unreadable::Missing)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Rows from before names were stored get them once; unreadable files count as read,
    /// missing and online-only ones wait for a later launch; a row a scan rewrote meanwhile is
    /// left as the scan wrote it.
    #[test]
    fn backfill_reads_older_rows_once() {
        let dir = temp("backfill");
        let fonts = dir.join("fonts");
        std::fs::write(fonts.join("a.ttf"), sfnt(&font("AmintaBold", "Regular", None))).unwrap();
        std::fs::write(fonts.join("b.ttf"), sfnt(&font("Avenir Next Medium", "Regular", Some("Avenir Next")))).unwrap();
        let db_path = dir.join("library.sqlite3");
        let mut conn = library(&dir);
        let folder = db::insert_folder(&mut conn, &fonts, "user").unwrap();
        crate::scanner::scan_folder(&db_path, folder, &fonts, &Arc::new(AtomicBool::new(false)), |_| {}).unwrap();
        // As a library from before: no names.
        conn.execute("UPDATE fonts SET typo_family = NULL, legacy_family = NULL, legacy_style = NULL, names_rev = NULL", []).unwrap();
        let typo = |conn: &Connection| -> Vec<Option<bool>> { db::list_fonts(conn).unwrap().iter().map(|f| f.has_typo_family).collect() };
        assert_eq!(typo(&conn), vec![None, None], "not known yet");

        let report = backfill_names(&db_path).unwrap();
        assert_eq!((report.files, report.written), (2, 2));
        let mut known = typo(&conn);
        known.sort();
        assert_eq!(known, vec![Some(false), Some(true)]);
        assert_eq!(backfill_names(&db_path).unwrap(), NamesReport::default(), "nothing left to read");

        // Cloud and missing files wait; broken ones count as read.
        conn.execute("UPDATE fonts SET names_rev = NULL", []).unwrap();
        let report = backfill_names_with(&db_path, 1, |path, _, indices| {
            if path.ends_with("a.ttf") {
                Err(Unreadable::Cloud)
            } else {
                assert_eq!(indices, &[0]);
                Err(Unreadable::Broken("damaged".into()))
            }
        })
        .unwrap();
        assert_eq!((report.cloud, report.written), (1, 1));
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM fonts WHERE names_rev IS NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 1, "the online-only file is tried again next launch");

        // A scan that rewrote a row while its file was being read keeps what it wrote.
        conn.execute("UPDATE fonts SET names_rev = NULL", []).unwrap();
        let other = db_path.clone();
        let report = backfill_names_with(&db_path, 1, move |path, _, _| {
            let scan = db::open(&other).unwrap();
            scan.execute("UPDATE fonts SET mtime = mtime + 1, names_rev = ?1 WHERE path = ?2", params![NAMES_REV, path]).unwrap();
            Ok(vec![FaceNames { index: 0, typo_family: Some("Stale".into()), ..Default::default() }])
        })
        .unwrap();
        assert_eq!(report.written, 0);
        let stale: i64 = conn.query_row("SELECT COUNT(*) FROM fonts WHERE typo_family = 'Stale'", [], |r| r.get(0)).unwrap();
        assert_eq!(stale, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The names backfill on a real library: how long it takes and what it finds. Point it at a
    /// copy, never the live file (opening a library adds columns); it reads the fonts' `name`
    /// tables (never Creative Cloud's files, never downloading online-only ones):
    /// `FONTFACE_BENCH_DB=/path/to/copy/library.sqlite3 cargo test --release names_backfill_timing -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn names_backfill_timing() {
        let Some(path) = std::env::var_os("FONTFACE_BENCH_DB") else { return };
        let path = std::path::PathBuf::from(path);
        let start = Instant::now();
        let report = backfill_names(&path).unwrap();
        let took = start.elapsed();
        let conn = db::open(&path).unwrap();
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        eprintln!(
            "names backfill: {} files, {} faces read in {:.1} s ({} online-only, {} other left for later); {} faces name their own family (ID 16), {} don't, {} unknown",
            report.files,
            report.written,
            took.as_secs_f64(),
            report.cloud,
            report.other,
            count("SELECT COUNT(*) FROM fonts WHERE names_rev IS NOT NULL AND typo_family IS NOT NULL"),
            count("SELECT COUNT(*) FROM fonts WHERE names_rev IS NOT NULL AND typo_family IS NULL"),
            count("SELECT COUNT(*) FROM fonts WHERE names_rev IS NULL"),
        );
    }
}
