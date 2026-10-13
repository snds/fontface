//! The merged state of every device's changes, and what it means for this device.
//!
//! Pure data, no files or database, so the merge rules are tested on their own.
//!
//! - **Single values** (a tag's name, parent, color and group; a font's on/off; exceptions) are
//!   "last writer wins" registers: each field keeps the value with the latest clock.
//! - **Tag groups** ("My tags" / "Built-in") belong to top-level tags; a nested tag is in its
//!   top-level tag's group. A top-level tag nobody chose a group for is where its name puts it
//!   (`tags::is_builtin_name`), the same rule every computer uses, so that default never needs
//!   a change of its own and can't fight a choice made elsewhere.
//! - **Deletes** are tombstones: a deleted tag stays deleted, whatever arrives later for it.
//! - **Tags on fonts** are an add-wins set: each add has its own id (its clock value, a "dot"); a
//!   remove names the dots it saw. An add made at the same time elsewhere wasn't seen, so it stays.
//!
//! Every rule is idempotent and order-free: the same changes in any order, any number of times,
//! give the same state.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    hlc::Hlc,
    ops::{self, face_field, tag_field, Op, OpKind},
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reg {
    pub hlc: Hlc,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Removal {
    pub hlc: Hlc,
    pub tag: String,
    pub key: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Merged {
    /// Tag sync id → field → register.
    pub tags: BTreeMap<String, BTreeMap<String, Reg>>,
    /// Deleted tags, with the delete's clock value.
    pub dead: BTreeMap<String, Hlc>,
    /// Tag sync id → face key → live dots.
    pub dots: BTreeMap<String, BTreeMap<String, BTreeSet<Hlc>>>,
    /// Every dot ever removed, so an add that arrives after its remove stays removed.
    pub removed: BTreeMap<Hlc, Removal>,
    /// Face key → field → register.
    pub faces: BTreeMap<String, BTreeMap<String, Reg>>,
}

fn set_fields(target: &mut BTreeMap<String, Reg>, hlc: &Hlc, set: &BTreeMap<String, Value>) -> bool {
    let mut changed = false;
    for (field, value) in set {
        let newer = target.get(field).is_none_or(|r| *hlc > r.hlc);
        if newer {
            target.insert(field.clone(), Reg { hlc: hlc.clone(), value: value.clone() });
            changed = true;
        }
    }
    changed
}

impl Merged {
    /// Applies one change. Returns whether anything changed.
    pub fn apply(&mut self, op: &Op) -> bool {
        match &op.kind {
            OpKind::Tag { id, set } => set_fields(self.tags.entry(id.clone()).or_default(), &op.hlc, set),
            OpKind::TagDel { id } => match self.dead.get(id) {
                // Keep the earliest delete, so the value doesn't depend on arrival order.
                Some(when) if *when <= op.hlc => false,
                _ => {
                    self.dead.insert(id.clone(), op.hlc.clone());
                    true
                }
            },
            OpKind::Add { tag, key } => {
                if self.removed.contains_key(&op.hlc) {
                    return false;
                }
                self.dots.entry(tag.clone()).or_default().entry(key.clone()).or_default().insert(op.hlc.clone())
            }
            OpKind::Remove { tag, key, dots } => {
                let mut changed = false;
                for dot in dots {
                    if !self.removed.contains_key(dot) {
                        self.removed.insert(dot.clone(), Removal { hlc: op.hlc.clone(), tag: tag.clone(), key: key.clone() });
                        changed = true;
                    }
                    if let Some(keys) = self.dots.get_mut(tag) {
                        if let Some(set) = keys.get_mut(key) {
                            changed |= set.remove(dot);
                            if set.is_empty() {
                                keys.remove(key);
                            }
                        }
                        if keys.is_empty() {
                            self.dots.remove(tag);
                        }
                    }
                }
                changed
            }
            OpKind::Face { key, set } => set_fields(self.faces.entry(key.clone()).or_default(), &op.hlc, set),
            OpKind::Unknown => false,
        }
    }

    /// The live dots of a tag on a font, across these sync ids.
    pub fn dots_of(&self, sids: &[String], key: &str) -> Vec<Hlc> {
        sids.iter().filter_map(|s| self.dots.get(s)?.get(key)).flatten().cloned().collect()
    }

    /// Everything one device wrote, squeezed to what still counts: its latest value of each field,
    /// its deletes, its adds that are still live, and its removes. Used for that device's snapshot.
    pub fn ops_by(&self, device: &str) -> Vec<Op> {
        let mut out = Vec::new();
        let mut regs = |kind: fn(String, BTreeMap<String, Value>) -> OpKind, map: &BTreeMap<String, BTreeMap<String, Reg>>| {
            for (id, fields) in map {
                // One change per clock value, so fields set together stay together.
                let mut by_hlc: BTreeMap<&Hlc, BTreeMap<String, Value>> = BTreeMap::new();
                for (field, reg) in fields.iter().filter(|(_, r)| r.hlc.device == device) {
                    by_hlc.entry(&reg.hlc).or_default().insert(field.clone(), reg.value.clone());
                }
                for (hlc, set) in by_hlc {
                    out.push(Op { hlc: hlc.clone(), kind: kind(id.clone(), set) });
                }
            }
        };
        regs(|id, set| OpKind::Tag { id, set }, &self.tags);
        regs(|key, set| OpKind::Face { key, set }, &self.faces);
        for (id, hlc) in self.dead.iter().filter(|(_, h)| h.device == device) {
            out.push(Op { hlc: hlc.clone(), kind: OpKind::TagDel { id: id.clone() } });
        }
        for (tag, keys) in &self.dots {
            for (key, dots) in keys {
                for dot in dots.iter().filter(|d| d.device == device) {
                    out.push(Op { hlc: dot.clone(), kind: OpKind::Add { tag: tag.clone(), key: key.clone() } });
                }
            }
        }
        let mut removes: BTreeMap<(&Hlc, &String, &String), Vec<Hlc>> = BTreeMap::new();
        for (dot, r) in self.removed.iter().filter(|(_, r)| r.hlc.device == device) {
            removes.entry((&r.hlc, &r.tag, &r.key)).or_default().push(dot.clone());
        }
        for ((hlc, tag, key), dots) in removes {
            out.push(Op { hlc: hlc.clone(), kind: OpKind::Remove { tag: tag.clone(), key: key.clone(), dots } });
        }
        out.sort_by(|a, b| a.hlc.cmp(&b.hlc));
        out
    }

    fn tag_str(&self, sid: &str, field: &str) -> Option<&str> {
        self.tags.get(sid)?.get(field)?.value.as_str()
    }

    /// The group someone chose for a tag with these sync ids: the latest `group` written for any
    /// of them (`Some(true)`: Built-in). `None` if nobody chose one, so the name decides.
    pub fn chosen_group(&self, sids: &[String]) -> Option<bool> {
        sids.iter()
            .filter_map(|s| self.tags.get(s)?.get(tag_field::GROUP))
            .filter_map(|r| Some((&r.hlc, ops::read_group(&r.value)?)))
            .max_by(|a, b| a.0.cmp(b.0))
            .map(|(_, builtin)| builtin)
    }

    /// The tags as this device should show them.
    pub fn tag_view(&self) -> TagView {
        tag_view(self)
    }

    /// What this device should do with a font: its own exception, else its group's, else the
    /// shared choice. `None`: nobody has chosen.
    pub fn effective(&self, key: &str, device: &str, group: Option<&str>) -> Option<Effective> {
        let fields = self.faces.get(key)?;
        let pick = |field: &str| -> Option<(bool, &Hlc)> {
            let reg = fields.get(field)?;
            match &reg.value {
                Value::String(s) if s == "on" => Some((true, &reg.hlc)),
                Value::String(s) if s == "off" => Some((false, &reg.hlc)),
                Value::Bool(b) if field == face_field::ON => Some((*b, &reg.hlc)),
                _ => None,
            }
        };
        let device_field = format!("{}{device}", face_field::DEVICE_PREFIX);
        let group_field = group.map(|g| format!("{}{g}", face_field::GROUP_PREFIX));
        // Any change to any of the three counts as a change to what this device should do, so
        // going back to "follow" re-applies the shared choice even if it's older.
        let stamp = [Some(&device_field), group_field.as_ref(), Some(&face_field::ON.to_string())]
            .into_iter()
            .flatten()
            .filter_map(|f| fields.get(f.as_str()).map(|r| &r.hlc))
            .max()?
            .clone();
        let (on, source) = if let Some((on, _)) = pick(&device_field) {
            (on, Source::Device)
        } else if let Some((on, _)) = group_field.as_deref().and_then(pick) {
            (on, Source::Group)
        } else {
            (pick(face_field::ON)?.0, Source::Shared)
        };
        Some(Effective { on, source, stamp })
    }

    /// This device's exception for a font: Some(true) always on, Some(false) never on.
    pub fn exception(&self, key: &str, device: &str) -> Option<bool> {
        match &self.faces.get(key)?.get(&format!("{}{device}", face_field::DEVICE_PREFIX))?.value {
            Value::String(s) if s == "on" => Some(true),
            Value::String(s) if s == "off" => Some(false),
            _ => None,
        }
    }

    pub fn face_str(&self, key: &str, field: &str) -> Option<&str> {
        self.faces.get(key)?.get(field)?.value.as_str()
    }

    pub fn face_prints(&self, key: &str) -> Vec<String> {
        match self.faces.get(key).and_then(|f| f.get(face_field::PRINTS)).map(|r| &r.value) {
            Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
            _ => Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Device,
    Group,
    Shared,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Effective {
    pub on: bool,
    pub source: Source,
    /// The latest clock value among the fields that decide it.
    pub stamp: Hlc,
}

/// One tag as this device shows it. Several sync ids end up as one tag when they have the same
/// full name (two computers that each had "Sci-Fi" before they first synced).
#[derive(Debug, Clone, PartialEq)]
pub struct ViewTag {
    /// Sorted. The first one gets new adds.
    pub sids: Vec<String>,
    /// The full name, e.g. "Sci-Fi/Star Trek".
    pub name: String,
    pub color: String,
    /// In the Built-in group. Always the same as its top-level tag's.
    pub builtin: bool,
    pub keys: BTreeSet<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TagView {
    /// Parents before children.
    pub tags: Vec<ViewTag>,
    /// Tags left out because their name or parent can't be used.
    pub unusable: usize,
}

/// A name level from another device, tidied the way a local name is. `None` if it can't be one.
fn clean_level(raw: &str) -> Option<String> {
    let level = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    (!level.is_empty() && !level.contains('/') && !level.chars().any(char::is_control)).then_some(level)
}

fn tag_view(m: &Merged) -> TagView {
    // Live tags with a usable name.
    let mut unusable = 0;
    let mut level: HashMap<&str, String> = HashMap::new();
    for sid in m.tags.keys() {
        if m.dead.contains_key(sid) {
            continue;
        }
        match m.tag_str(sid, tag_field::NAME).and_then(clean_level) {
            Some(l) => {
                level.insert(sid.as_str(), l);
            }
            None => unusable += 1,
        }
    }
    let parent_of = |sid: &str| -> Option<&str> { m.tag_str(sid, tag_field::PARENT).filter(|p| !p.is_empty()) };
    // Two moves made at the same time can make a loop (A into B, B into A). The tag whose move
    // came last in each loop goes to the top level instead.
    let mut top: BTreeSet<&str> = BTreeSet::new();
    let parent_hlc = |sid: &str| m.tags.get(sid).and_then(|f| f.get(tag_field::PARENT)).map(|r| r.hlc.clone()).unwrap_or_default();
    for &start in level.keys() {
        let mut seen: Vec<&str> = Vec::new();
        let mut at = start;
        loop {
            if top.contains(at) {
                break;
            }
            if let Some(i) = seen.iter().position(|s| *s == at) {
                let cycle = &seen[i..];
                if let Some(breaker) = cycle.iter().max_by_key(|s| (parent_hlc(s), s.to_string())) {
                    top.insert(breaker);
                }
                break;
            }
            seen.push(at);
            match parent_of(at) {
                Some(p) if level.contains_key(p) => at = level.get_key_value(p).map(|(k, _)| *k).unwrap_or(p),
                _ => break,
            }
        }
    }
    // Full names. A tag whose parent is deleted, unknown or unusable is left out, and so is
    // everything inside it: deleting a tag deletes the tags inside it.
    let mut full: HashMap<&str, Option<String>> = HashMap::new();
    fn resolve<'a>(
        sid: &'a str,
        level: &HashMap<&'a str, String>,
        top: &BTreeSet<&'a str>,
        parent_of: &dyn Fn(&'a str) -> Option<&'a str>,
        full: &mut HashMap<&'a str, Option<String>>,
        depth: usize,
    ) -> Option<String> {
        if let Some(done) = full.get(sid) {
            return done.clone();
        }
        let own = level.get(sid)?.clone();
        let name = match parent_of(sid).filter(|_| !top.contains(sid)) {
            None => Some(own),
            Some(_) if depth > 64 => None,
            Some(p) => {
                let key = level.get_key_value(p).map(|(k, _)| *k);
                key.and_then(|k| resolve(k, level, top, parent_of, full, depth + 1)).map(|pn| format!("{pn}/{own}"))
            }
        };
        let name = name.filter(|n| n.chars().count() <= crate::tags::MAX_NAME);
        full.insert(sid, name.clone());
        name
    }
    let sids: Vec<&str> = level.keys().copied().collect();
    for sid in &sids {
        resolve(sid, &level, &top, &parent_of, &mut full, 0);
    }
    // Same full name (ignoring letter case, as the local unique index does) → one tag.
    let mut groups: BTreeMap<String, Vec<&str>> = BTreeMap::new();
    for (sid, name) in &full {
        // None: inside a deleted or missing tag, or too long to be a name.
        if let Some(n) = name {
            groups.entry(n.to_ascii_lowercase()).or_default().push(sid);
        }
    }
    let mut tags: Vec<ViewTag> = groups
        .into_values()
        .map(|mut sids| {
            sids.sort();
            // The spelling and color come from the most recently written of them.
            let latest = |field: &str| {
                sids.iter()
                    .filter_map(|s| m.tags.get(*s)?.get(field))
                    .max_by(|a, b| a.hlc.cmp(&b.hlc))
                    .and_then(|r| r.value.as_str().map(String::from))
            };
            let name_sid = sids
                .iter()
                .max_by_key(|s| m.tags.get(**s).and_then(|f| f.get(tag_field::NAME)).map(|r| r.hlc.clone()))
                .copied()
                .unwrap_or(sids[0]);
            let color = latest(tag_field::COLOR).filter(|c| crate::tags::colors::is_valid(c)).unwrap_or_else(|| "gray".into());
            let keys = sids
                .iter()
                .filter_map(|s| m.dots.get(*s))
                .flat_map(|k| k.iter().filter(|(_, d)| !d.is_empty()).map(|(key, _)| key.clone()))
                .filter(|k| crate::tags::check_key(k).is_ok())
                .collect();
            ViewTag {
                name: full[name_sid].clone().unwrap_or_default(),
                sids: sids.into_iter().map(String::from).collect(),
                color,
                builtin: false, // set below, once the top-level tags are known
                keys,
            }
        })
        .collect();
    // Within a group the parent part of every name is the same (it's one group), but letter case
    // may differ; use the spelling of the parent group, so children always match their parent.
    tags.sort_by(|a, b| a.name.matches('/').count().cmp(&b.name.matches('/').count()).then_with(|| a.name.cmp(&b.name)));
    let mut spelled: HashMap<String, String> = HashMap::new();
    for t in &mut tags {
        if let Some((parent, leaf)) = t.name.rsplit_once('/') {
            if let Some(p) = spelled.get(&parent.to_ascii_lowercase()) {
                t.name = format!("{p}/{leaf}");
            }
        }
        spelled.insert(t.name.to_ascii_lowercase(), t.name.clone());
    }
    // Groups. A top-level tag is in the group chosen last for any of its sync ids (two
    // computers' tags with the same name: the later choice wins, as for colors), else where its
    // name puts it. A nested tag is in its top-level tag's group, which comes first in `tags`.
    let mut tops: HashMap<String, bool> = HashMap::new();
    for t in &mut tags {
        let top = crate::tags::top_level(&t.name).to_ascii_lowercase();
        t.builtin = if t.name.contains('/') {
            tops.get(&top).copied().unwrap_or_else(|| crate::tags::is_builtin_name(&t.name))
        } else {
            let builtin = m.chosen_group(&t.sids).unwrap_or_else(|| crate::tags::is_builtin_name(&t.name));
            tops.insert(top, builtin);
            builtin
        };
    }
    TagView { tags, unusable }
}
