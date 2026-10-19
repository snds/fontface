//! Named styles inside variable fonts.
//!
//! A variable font can name points on its axes ("Condensed Thin") and give each one a
//! PostScript name of its own ("SFPro-CondensedThin"), in its `fvar` table. macOS lists those
//! like separate fonts, so Typeface backups name them too. Fontface keeps one row per variable
//! file, so an import that names one of these styles should tag the variable font it lives in.
//!
//! The names aren't stored in the library: they're read from the files when an import has
//! names it can't otherwise place. Only the table directory, `fvar` and `name` are read, never
//! the outlines. Results are cached by file size and modification time.

use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::Mutex,
    time::UNIX_EPOCH,
};

/// A real `name` or `fvar` table is a few KB. Anything far larger isn't worth reading.
const MAX_TABLE: u32 = 2 * 1024 * 1024;

pub(crate) fn be16(b: &[u8], at: usize) -> Option<u16> {
    b.get(at..at + 2).map(|s| u16::from_be_bytes([s[0], s[1]]))
}

pub(crate) fn be32(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

/// A PostScript name as the OpenType spec allows it: printable ASCII without `[](){}<>/%`,
/// at most 127 characters (63 is the recommended limit, but real fonts exceed it).
fn valid_postscript(s: &str) -> bool {
    !s.is_empty() && s.len() <= 127 && s.bytes().all(|b| (33..=126).contains(&b) && !b"[](){}<>/%".contains(&b))
}

/// One string from a `name` table: Windows English first, then any Unicode entry, then Mac Roman.
pub(crate) fn name_string(name: &[u8], id: u16) -> Option<String> {
    let count = be16(name, 2)? as usize;
    let strings = be16(name, 4)? as usize;
    let (mut unicode, mut mac) = (None, None);
    for i in 0..count {
        let rec = 6 + i * 12;
        let (platform, encoding, language, name_id) = (be16(name, rec)?, be16(name, rec + 2)?, be16(name, rec + 4)?, be16(name, rec + 6)?);
        if name_id != id {
            continue;
        }
        let (len, off) = (be16(name, rec + 8)? as usize, be16(name, rec + 10)? as usize);
        let Some(raw) = name.get(strings + off..strings + off + len) else { continue };
        let utf16 = || {
            let units: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
            String::from_utf16(&units).ok()
        };
        match platform {
            3 if language == 0x0409 && matches!(encoding, 1 | 10) => {
                if let Some(s) = utf16() {
                    return Some(s);
                }
            }
            0 | 3 if unicode.is_none() => unicode = utf16(),
            // Mac Roman matches ASCII, which is all a PostScript name may hold.
            1 if encoding == 0 && mac.is_none() => mac = Some(raw.iter().map(|&b| b as char).collect::<String>()),
            _ => {}
        }
    }
    unicode.or(mac)
}

/// The PostScript names of the named styles in an `fvar` table, looked up in `name`.
/// Fonts that don't give their styles PostScript names (most don't) yield nothing.
pub fn parse(fvar: &[u8], name: &[u8]) -> Vec<String> {
    let parsed = || -> Option<Vec<String>> {
        let axes_at = be16(fvar, 4)? as usize;
        let (axis_count, axis_size) = (be16(fvar, 8)? as usize, be16(fvar, 10)? as usize);
        let (count, size) = (be16(fvar, 12)? as usize, be16(fvar, 14)? as usize);
        // The PostScript name id follows the coordinates, and is only there if the record
        // has room for it.
        let ps_at = 4 + axis_count * 4;
        if size < ps_at + 2 {
            return Some(Vec::new());
        }
        let first = axes_at + axis_count * axis_size;
        let mut out = Vec::new();
        for i in 0..count {
            let id = be16(fvar, first + i * size + ps_at)?;
            if id == 0 || id == 0xFFFF {
                continue;
            }
            if let Some(s) = name_string(name, id).map(|s| s.trim().to_string()).filter(|s| valid_postscript(s)) {
                if !out.contains(&s) {
                    out.push(s);
                }
            }
        }
        Some(out)
    };
    parsed().unwrap_or_default()
}

/// A named style of a variable font (an `fvar` instance): its name, its PostScript name if the
/// font gives one, and where it sits on each axis.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedInstance {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub postscript_name: Option<String>,
    /// (axis tag, value), in the font's axis order.
    pub values: Vec<(String, f32)>,
}

/// At most this many named styles are read from one font.
const MAX_INSTANCES: usize = 1024;

/// Every named style in an `fvar` table, with its axis values, named from `name`. A style whose
/// name isn't in the table is left out, and so is a second style with the same name and values.
pub fn instances(fvar: &[u8], name: &[u8]) -> Vec<NamedInstance> {
    let parsed = || -> Option<Vec<NamedInstance>> {
        let axes_at = be16(fvar, 4)? as usize;
        let (axis_count, axis_size) = (be16(fvar, 8)? as usize, be16(fvar, 10)? as usize);
        let (count, size) = (be16(fvar, 12)? as usize, be16(fvar, 14)? as usize);
        if axis_size < 20 || size < 4 + axis_count * 4 {
            return Some(Vec::new());
        }
        let tags: Vec<String> = (0..axis_count)
            .map(|i| fvar.get(axes_at + i * axis_size..axes_at + i * axis_size + 4).map(|t| String::from_utf8_lossy(t).into_owned()))
            .collect::<Option<_>>()?;
        let first = axes_at + axis_count * axis_size;
        let ps_at = 4 + axis_count * 4;
        let mut out: Vec<NamedInstance> = Vec::new();
        for i in 0..count.min(MAX_INSTANCES) {
            let at = first + i * size;
            let Some(name_id) = be16(fvar, at) else { break };
            let Some(style) = name_string(name, name_id).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) else { continue };
            let mut values = Vec::with_capacity(axis_count);
            for (k, tag) in tags.iter().enumerate() {
                let fixed = be32(fvar, at + 4 + k * 4)? as i32;
                values.push((tag.clone(), (fixed as f64 / 65536.0) as f32));
            }
            let postscript_name = (size >= ps_at + 2)
                .then(|| be16(fvar, at + ps_at))
                .flatten()
                .filter(|&id| id != 0 && id != 0xFFFF)
                .and_then(|id| name_string(name, id))
                .map(|s| s.trim().to_string())
                .filter(|s| valid_postscript(s));
            let instance = NamedInstance { name: style, postscript_name, values };
            if !out.iter().any(|o| o.name == instance.name && o.values == instance.values) {
                out.push(instance);
            }
        }
        Some(out)
    };
    parsed().unwrap_or_default()
}

fn read_table(file: &mut File, offset: u32, length: u32) -> Option<Vec<u8>> {
    if length > MAX_TABLE {
        return None;
    }
    let mut buf = vec![0u8; length as usize];
    file.seek(SeekFrom::Start(offset as u64)).ok()?;
    file.read_exact(&mut buf).ok()?;
    Some(buf)
}

fn read(path: &Path, face_index: u32) -> Option<Vec<String>> {
    let mut file = File::open(path).ok()?;
    let mut head = [0u8; 12];
    file.read_exact(&mut head).ok()?;
    let mut start = 0u64;
    if &head[..4] == b"ttcf" {
        if face_index >= be32(&head, 8)? {
            return None;
        }
        let mut at = [0u8; 4];
        file.seek(SeekFrom::Start(12 + 4 * face_index as u64)).ok()?;
        file.read_exact(&mut at).ok()?;
        start = u32::from_be_bytes(at) as u64;
        file.seek(SeekFrom::Start(start)).ok()?;
        file.read_exact(&mut head).ok()?;
    }
    let tables = be16(&head, 4)? as usize;
    if tables > 256 {
        return None;
    }
    let mut dir = vec![0u8; tables * 16];
    file.seek(SeekFrom::Start(start + 12)).ok()?;
    file.read_exact(&mut dir).ok()?;
    let find = |tag: &[u8; 4]| {
        (0..tables).find(|i| &dir[i * 16..i * 16 + 4] == tag).and_then(|i| Some((be32(&dir, i * 16 + 8)?, be32(&dir, i * 16 + 12)?)))
    };
    let (fvar_at, fvar_len) = find(b"fvar")?;
    let (name_at, name_len) = find(b"name")?;
    let fvar = read_table(&mut file, fvar_at, fvar_len)?;
    let name = read_table(&mut file, name_at, name_len)?;
    Some(parse(&fvar, &name))
}

type Stamp = (u64, i64);

static CACHE: Mutex<Option<HashMap<(String, u32), (Stamp, Vec<String>)>>> = Mutex::new(None);

fn stamp(path: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    Some((meta.len(), mtime))
}

/// The PostScript names of a face's named styles. Empty if it has none, or the file can't be
/// read. Never reads Adobe Fonts files (they aren't in the library, but this checks again).
pub fn postscript_names(path: &str, face_index: u32) -> Vec<String> {
    let p = Path::new(path);
    if crate::services::adobe::is_adobe_path(p) || crate::services::google::previews::is_preview_cache_path(p) {
        return Vec::new();
    }
    let Some(stamp) = stamp(p) else { return Vec::new() };
    let key = (path.to_string(), face_index);
    if let Some((s, names)) = CACHE.lock().ok().and_then(|c| c.as_ref().and_then(|m| m.get(&key)).cloned()) {
        if s == stamp {
            return names;
        }
    }
    let names = read(p, face_index).unwrap_or_default();
    if let Ok(mut cache) = CACHE.lock() {
        cache.get_or_insert_with(HashMap::new).insert(key, (stamp, names.clone()));
    }
    names
}
