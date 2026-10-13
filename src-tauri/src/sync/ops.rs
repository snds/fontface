//! What's written to the sync folder: changes, snapshots and the device file.
//!
//! **Format version.** Every file says which format it is and its version. The version is the
//! major version: a newer one changes meanings and is refused with a plain message. Smaller
//! additions (a new field, a new kind of change) keep the version, and older apps skip what they
//! don't know.
//!
//! A change file is JSON Lines: a header line, then one change per line.
//!
//! ```text
//! {"format":"fontface-sync-changes","version":1,"device":"3f2a…","seq":7}
//! {"hlc":"1760280000000.0.3f2a…","op":"tag","id":"9b1c…","set":{"name":"Star Trek","parent":"77aa…","color":"blue"}}
//! {"hlc":"1760280000000.1.3f2a…","op":"tag","id":"77aa…","set":{"group":"builtin"}}
//! {"hlc":"1760280000000.2.3f2a…","op":"add","tag":"9b1c…","key":"ps:Okuda|static|r"}
//! {"hlc":"1760280000001.0.3f2a…","op":"face","key":"ps:Okuda|static|r","set":{"on":true,"family":"Okuda","style":"Regular"}}
//! ```

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::hlc::Hlc;

pub const VERSION: u32 = 1;
pub const CHANGES_FORMAT: &str = "fontface-sync-changes";
pub const SNAPSHOT_FORMAT: &str = "fontface-sync-snapshot";
pub const DEVICE_FORMAT: &str = "fontface-sync-device";

/// Files bigger than this are refused unread, so a damaged or hostile file stays cheap.
pub const MAX_FILE: usize = 64 * 1024 * 1024;
const MAX_LINE: usize = 256 * 1024;

/// One change. Applying the same change twice, or changes in any order, gives the same result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Op {
    pub hlc: Hlc,
    #[serde(flatten)]
    pub kind: OpKind,
}

/// Field names in a tag's `set`. A field map rather than fixed fields, so later versions can add
/// fields (older apps keep them and pass them on).
pub mod tag_field {
    /// The tag's own level only ("Star Trek", never "Sci-Fi/Star Trek").
    pub const NAME: &str = "name";
    /// The sync id of the tag it sits in, or null at the top level.
    pub const PARENT: &str = "parent";
    pub const COLOR: &str = "color";
    /// A top-level tag's group: [`GROUP_BUILTIN`] or [`GROUP_MINE`]. Tags nested under it are in
    /// its group whatever their own field says. Left out while the group is the one the tag's
    /// name gives it (`tags::is_builtin_name`), which every computer works out for itself; see
    /// `Merged::chosen_group` and docs/SYNC.md. Files from before tag groups never have it.
    pub const GROUP: &str = "group";
    /// "Built-in": tags that came with Font Book and Typeface.
    pub const GROUP_BUILTIN: &str = "builtin";
    /// "My tags": the user's own.
    pub const GROUP_MINE: &str = "mine";
}

/// The `group` value for a tag in Built-in (`true`) or in My tags (`false`).
pub fn group_value(builtin: bool) -> Value {
    Value::String(if builtin { tag_field::GROUP_BUILTIN } else { tag_field::GROUP_MINE }.into())
}

/// Reads a `group` value: `Some(true)` for Built-in, `Some(false)` for My tags. Anything else
/// (null, or a group from a newer version) counts as no choice.
pub fn read_group(value: &Value) -> Option<bool> {
    match value.as_str()? {
        tag_field::GROUP_BUILTIN => Some(true),
        tag_field::GROUP_MINE => Some(false),
        _ => None,
    }
}

/// Field names in a font's `set`.
pub mod face_field {
    /// The shared on/off choice.
    pub const ON: &str = "on";
    /// For "Not on this device": the family and style, as the writing device saw them.
    pub const FAMILY: &str = "family";
    pub const STYLE: &str = "style";
    /// Content fingerprints of the writer's copies, where it knows them (see `fingerprint`).
    pub const PRINTS: &str = "prints";
    /// `x:<device id>`: that device's exception. `xg:<group>`: a device group's.
    /// Values: "on", "off", or null (follow the shared choice).
    pub const DEVICE_PREFIX: &str = "x:";
    pub const GROUP_PREFIX: &str = "xg:";
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum OpKind {
    /// Sets fields of a tag. `id` is the tag's sync id, never the local database id.
    Tag { id: String, set: BTreeMap<String, Value> },
    /// Deletes a tag for good. A later rename doesn't bring it back.
    TagDel { id: String },
    /// Puts a tag on a font. The change's clock value is its unique id (a "dot").
    Add { tag: String, key: String },
    /// Takes a tag off a font: removes the adds this device had seen. An add it hadn't seen
    /// (made at the same time elsewhere) survives: adding wins.
    Remove { tag: String, key: String, dots: Vec<Hlc> },
    /// Sets fields of a font, by its face key.
    Face { key: String, set: BTreeMap<String, Value> },
    /// A kind of change from a newer version. Skipped.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub format: String,
    pub version: u32,
    pub device: String,
    #[serde(default)]
    pub seq: u64,
}

/// A device's own changes up to `upto`, squeezed to the latest value of each field. Older change
/// files it covers are deleted after it's written.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub format: String,
    pub version: u32,
    pub device: String,
    pub upto: u64,
    pub ops: Vec<Op>,
}

/// `device.json`: who a device folder belongs to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFile {
    pub format: String,
    pub version: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub group: Option<String>,
    /// A hash of the computer's hardware id, to notice app data copied to another computer.
    #[serde(default)]
    pub machine: String,
    #[serde(default)]
    pub app_version: String,
    /// Milliseconds since 1970 (UTC).
    #[serde(default)]
    pub last_seen: u64,
    /// The newest change file written.
    #[serde(default)]
    pub last_seq: u64,
}

/// Why a file couldn't be used.
#[derive(Debug, Clone, PartialEq)]
pub enum ReadError {
    /// Written by a newer Fontface. Never guessed at.
    Newer(u32),
    /// Unfinished, damaged or not ours. Tried again later.
    Bad(String),
}

impl ReadError {
    fn bad(what: impl Into<String>) -> Self {
        ReadError::Bad(what.into())
    }
}

fn check_header(format: &str, version: u32, want: &str) -> Result<(), ReadError> {
    if format != want {
        return Err(ReadError::bad(format!("not a {want} file")));
    }
    if version > VERSION {
        return Err(ReadError::Newer(version));
    }
    if version == 0 {
        return Err(ReadError::bad("no version"));
    }
    Ok(())
}

pub fn write_changes(device: &str, seq: u64, ops: &[Op]) -> Vec<u8> {
    let header = Header { format: CHANGES_FORMAT.into(), version: VERSION, device: device.into(), seq };
    let mut out = serde_json::to_vec(&header).unwrap_or_default();
    for op in ops {
        out.push(b'\n');
        out.extend(serde_json::to_vec(op).unwrap_or_default());
    }
    out.push(b'\n');
    out
}

/// Reads a change file. The whole file must be readable: a file a sync service is still
/// downloading may end mid-line, so any bad line fails it, to be tried again later.
/// Changes of kinds this version doesn't know are dropped.
pub fn read_changes(bytes: &[u8], device: &str) -> Result<(Header, Vec<Op>), ReadError> {
    if bytes.len() > MAX_FILE {
        return Err(ReadError::bad("too big"));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| ReadError::bad("not text"))?;
    // A finished file always ends with a line break.
    if !text.ends_with('\n') {
        return Err(ReadError::bad("unfinished"));
    }
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let header: Header =
        serde_json::from_str(lines.next().ok_or_else(|| ReadError::bad("empty"))?).map_err(|_| ReadError::bad("no header"))?;
    check_header(&header.format, header.version, CHANGES_FORMAT)?;
    if header.device != device {
        return Err(ReadError::bad("from another device folder"));
    }
    let mut ops = Vec::new();
    for line in lines {
        if line.len() > MAX_LINE {
            return Err(ReadError::bad("line too long"));
        }
        let op: Op = serde_json::from_str(line).map_err(|e| ReadError::bad(format!("damaged line: {e}")))?;
        if op.kind != OpKind::Unknown {
            ops.push(op);
        }
    }
    Ok((header, ops))
}

pub fn write_snapshot(device: &str, upto: u64, ops: Vec<Op>) -> Vec<u8> {
    let snap = Snapshot { format: SNAPSHOT_FORMAT.into(), version: VERSION, device: device.into(), upto, ops };
    serde_json::to_vec(&snap).unwrap_or_default()
}

pub fn read_snapshot(bytes: &[u8], device: &str) -> Result<Snapshot, ReadError> {
    if bytes.len() > MAX_FILE {
        return Err(ReadError::bad("too big"));
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ReadError::bad("damaged or unfinished"))?;
    let format = value.get("format").and_then(Value::as_str).unwrap_or_default();
    let version = value.get("version").and_then(Value::as_u64).unwrap_or(0) as u32;
    check_header(format, version, SNAPSHOT_FORMAT)?;
    let mut snap: Snapshot = serde_json::from_value(value).map_err(|e| ReadError::bad(format!("damaged: {e}")))?;
    if snap.device != device {
        return Err(ReadError::bad("from another device folder"));
    }
    snap.ops.retain(|op| op.kind != OpKind::Unknown);
    Ok(snap)
}

pub fn read_device(bytes: &[u8]) -> Result<DeviceFile, ReadError> {
    if bytes.len() > 1024 * 1024 {
        return Err(ReadError::bad("too big"));
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ReadError::bad("damaged or unfinished"))?;
    let format = value.get("format").and_then(Value::as_str).unwrap_or_default();
    let version = value.get("version").and_then(Value::as_u64).unwrap_or(0) as u32;
    check_header(format, version, DEVICE_FORMAT)?;
    serde_json::from_value(value).map_err(|e| ReadError::bad(format!("damaged: {e}")))
}

/// `changes-000042.jsonl` → 42. Anything else (a sync service's "conflicted copy", a temporary
/// file, a stray note) isn't a change file and is ignored.
pub fn change_seq(name: &str) -> Option<u64> {
    let digits = name.strip_prefix("changes-")?.strip_suffix(".jsonl")?;
    (!digits.is_empty() && digits.len() <= 12 && digits.bytes().all(|b| b.is_ascii_digit())).then(|| digits.parse().ok())?
}

pub fn change_name(seq: u64) -> String {
    format!("changes-{seq:06}.jsonl")
}

pub const SNAPSHOT_NAME: &str = "snapshot.json";
pub const DEVICE_NAME: &str = "device.json";
