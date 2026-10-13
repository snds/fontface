//! Exporting tags: Fontface's own JSON (which also imports back), CSV for spreadsheets, and a
//! Typeface backup. Finder tags and Font Book collections are written by `macos.rs`.
//! docs/TAGS.md describes every format.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::{
    import::{Source, SourceFont, SourceTag},
    is_loose, key_postscript_name, list_tags, location_colors, LibraryIndex, Tag,
};
use crate::error::{AppError, AppResult};

pub const JSON_FORMAT: &str = "fontface-tags";
pub const JSON_VERSION: u32 = 1;

/// One font under a tag, described well enough to find it again in another library.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportFont {
    /// Fontface's key for the font (see TAGS.md).
    pub key: String,
    #[serde(default)]
    pub postscript_name: Option<String>,
    #[serde(default)]
    pub family: Option<String>,
    #[serde(default)]
    pub style: Option<String>,
    #[serde(default)]
    pub variable: Option<bool>,
    #[serde(default)]
    pub italic: Option<bool>,
    /// Every copy in the library. Empty for a font that isn't in the library yet.
    #[serde(default)]
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportTag {
    pub name: String,
    pub color: String,
    pub fonts: Vec<ExportFont>,
    /// The tag's group: Built-in (`true`) or the user's own (`false`). Fontface always writes it,
    /// so a backup restores groups as they were. Files from before groups don't have it; their
    /// new tags start where the name rule puts them (`BUILTIN_NAMES`). Optional, so the format
    /// stays version 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builtin: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFile {
    pub format: String,
    pub version: u32,
    #[serde(default)]
    pub exported_at: Option<String>,
    pub tags: Vec<ExportTag>,
    #[serde(default)]
    pub location_colors: BTreeMap<String, String>,
}

/// All tags, or the chosen ones and everything nested under them.
fn chosen_tags(conn: &Connection, only: Option<&[i64]>) -> AppResult<Vec<Tag>> {
    let all = list_tags(conn)?;
    Ok(match only {
        None => all,
        Some(ids) => {
            let roots: Vec<String> = all.iter().filter(|t| ids.contains(&t.id)).map(|t| t.name.clone()).collect();
            all.into_iter().filter(|t| roots.iter().any(|r| super::is_within(&t.name, r))).collect()
        }
    })
}

fn tag_keys(conn: &Connection, tag_id: i64) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare_cached("SELECT face_key FROM tag_fonts WHERE tag_id = ?1 ORDER BY face_key")?;
    let rows = stmt.query_map([tag_id], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Which Finder tags each font file gets: file → tag names. Copies in the macOS font folders
/// are left alone; the second value counts them.
pub fn finder_plan(conn: &Connection, only: Option<&[i64]>) -> AppResult<(BTreeMap<String, BTreeSet<String>>, usize)> {
    let index = LibraryIndex::load(conn)?;
    let mut plan: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut skipped = BTreeSet::new();
    for tag in chosen_tags(conn, only)? {
        for key in tag_keys(conn, tag.id)? {
            for face in index.resolve(&key) {
                for file in &face.files {
                    if file.installed {
                        skipped.insert(file.path.clone());
                    } else {
                        plan.entry(file.path.clone()).or_default().insert(tag.name.clone());
                    }
                }
            }
        }
    }
    Ok((plan, skipped.len()))
}

/// The tags to export (all of them, or the chosen ones and everything nested under them),
/// each with its fonts described from the library.
pub fn collect(conn: &Connection, only: Option<&[i64]>) -> AppResult<Vec<ExportTag>> {
    let chosen = chosen_tags(conn, only)?;
    let index = LibraryIndex::load(conn)?;
    let mut out = Vec::with_capacity(chosen.len());
    for tag in chosen {
        let keys = tag_keys(conn, tag.id)?;
        let mut fonts: BTreeMap<String, ExportFont> = BTreeMap::new();
        for key in keys {
            let faces = index.resolve(&key);
            if faces.is_empty() {
                // Kept from an import, or the font has left the library: export what's known.
                let ps = key_postscript_name(&key).map(str::to_string);
                let file = key.strip_prefix("file:").and_then(|f| f.rsplit_once('#')).map(|(p, _)| p.to_string());
                let (variable, italic) = full_key_traits(&key);
                fonts.entry(key.clone()).or_insert(ExportFont {
                    key,
                    postscript_name: ps,
                    family: None,
                    style: None,
                    variable,
                    italic,
                    files: file.into_iter().collect(),
                });
                continue;
            }
            for face in faces {
                fonts.entry(face.key.clone()).or_insert_with(|| ExportFont {
                    key: face.key.clone(),
                    postscript_name: face.postscript_name.clone(),
                    family: Some(face.family.clone()),
                    style: Some(face.style.clone()),
                    variable: Some(face.variable),
                    italic: Some(face.italic),
                    files: face.files.iter().map(|f| f.path.clone()).collect::<BTreeSet<_>>().into_iter().collect(),
                });
            }
        }
        let mut fonts: Vec<ExportFont> = fonts.into_values().collect();
        fonts.sort_by(|a, b| {
            (a.family.as_deref().unwrap_or("~"), a.style.as_deref(), &a.key).cmp(&(b.family.as_deref().unwrap_or("~"), b.style.as_deref(), &b.key))
        });
        out.push(ExportTag { name: tag.name, color: tag.color, fonts, builtin: Some(tag.builtin) });
    }
    Ok(out)
}

/// (variable, italic) from a full key; unknown for loose and file keys.
fn full_key_traits(key: &str) -> (Option<bool>, Option<bool>) {
    if !key.starts_with("ps:") || is_loose(key) {
        return (None, None);
    }
    let mut parts = key.rsplitn(3, '|');
    let slant = parts.next();
    let kind = parts.next();
    (kind.map(|k| k == "var"), slant.map(|s| s == "i"))
}

pub fn to_json(conn: &Connection, tags: Vec<ExportTag>, now: i64) -> AppResult<String> {
    let file = ExportFile {
        format: JSON_FORMAT.into(),
        version: JSON_VERSION,
        exported_at: Some(iso8601(now)),
        tags,
        location_colors: location_colors(conn)?,
    };
    Ok(serde_json::to_string_pretty(&file).expect("plain data always serializes"))
}

/// Reads Fontface's own export back as an import source.
pub fn parse_json(bytes: &[u8]) -> AppResult<Source> {
    let file: ExportFile =
        serde_json::from_slice(bytes).map_err(|e| AppError::Invalid(format!("That isn't a Fontface tags file ({e})")))?;
    if file.format != JSON_FORMAT {
        return Err(AppError::Invalid("That isn't a Fontface tags file".into()));
    }
    if file.version > JSON_VERSION {
        return Err(AppError::Invalid(format!(
            "That file is from a newer Fontface (format {}). Update Fontface to import it.",
            file.version
        )));
    }
    let tags = file
        .tags
        .into_iter()
        .map(|t| SourceTag {
            name: t.name,
            color: Some(t.color),
            fonts: t.fonts.into_iter().filter_map(source_font).collect(),
            suggested: true,
            note: None,
            builtin: t.builtin,
        })
        .collect();
    Ok(Source {
        label: "Fontface tags file".into(),
        tags,
        notes: vec![],
        date: None,
        location_colors: file.location_colors.into_iter().collect(),
    })
}

/// The key if it's one Fontface makes; otherwise rebuilt from the PostScript name and traits.
/// Anything oversized is dropped, so a hostile file stays cheap to read.
fn source_font(f: ExportFont) -> Option<SourceFont> {
    if super::check_key(&f.key).is_ok() {
        return Some(SourceFont::Key(f.key));
    }
    let ps = f.postscript_name.filter(|p| !p.is_empty() && p.len() <= super::import::MAX_FONT_NAME);
    match (ps, f.variable, f.italic) {
        (Some(ps), Some(v), Some(i)) => Some(SourceFont::Key(super::face_key(Some(&ps), v, i, "", 0))),
        (Some(ps), _, _) => Some(SourceFont::PostScript(ps)),
        (None, _, _) => f.files.into_iter().next().filter(|p| p.len() < 4096).map(SourceFont::File),
    }
}

/// One row per font and tag. Columns: tag, color, postscript_name, family, style, variable,
/// italic, file (the first copy).
pub fn to_csv(tags: &[ExportTag]) -> String {
    let mut out = String::from("tag,color,postscript_name,family,style,variable,italic,file\r\n");
    for tag in tags {
        for f in &tag.fonts {
            let flag = |b: Option<bool>| match b {
                Some(true) => "yes",
                Some(false) => "no",
                None => "",
            };
            let row = [
                tag.name.as_str(),
                tag.color.as_str(),
                f.postscript_name.as_deref().unwrap_or(""),
                f.family.as_deref().unwrap_or(""),
                f.style.as_deref().unwrap_or(""),
                flag(f.variable),
                flag(f.italic),
                f.files.first().map(String::as_str).unwrap_or(""),
            ];
            out.push_str(&row.iter().map(|v| csv_field(v)).collect::<Vec<_>>().join(","));
            out.push_str("\r\n");
        }
    }
    out
}

/// Quotes a CSV field when needed (RFC 4180). Font names come from font files, so a value that
/// a spreadsheet would run as a formula gets a leading apostrophe (OWASP's advice). Semicolons
/// and tabs are quoted too: spreadsheets in some regions split on them.
fn csv_field(v: &str) -> String {
    let v = if v.starts_with(['=', '+', '-', '@', '\t', '\r']) { format!("'{v}") } else { v.to_string() };
    if v.contains([',', ';', '\t', '"', '\n', '\r']) || v.starts_with(' ') || v.ends_with(' ') {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v
    }
}

/// A Typeface backup with the same tags. Fonts without a PostScript name are left out.
/// Returns the file and how many different fonts were left out.
pub fn to_typeface(tags: &[ExportTag], now: i64) -> (String, usize) {
    let list: Vec<(String, Vec<String>)> = tags
        .iter()
        .map(|t| {
            let names: BTreeSet<String> = t.fonts.iter().filter_map(|f| f.postscript_name.clone()).collect();
            (t.name.clone(), names.into_iter().collect())
        })
        .collect();
    (super::typeface::write(&list, now as f64), without_postscript_name(tags))
}

/// Different fonts across these tags.
pub fn font_count(tags: &[ExportTag]) -> usize {
    tags.iter().flat_map(|t| t.fonts.iter().map(|f| &f.key)).collect::<BTreeSet<_>>().len()
}

/// Different fonts across these tags that have no PostScript name.
pub fn without_postscript_name(tags: &[ExportTag]) -> usize {
    tags.iter().flat_map(|t| t.fonts.iter()).filter(|f| f.postscript_name.is_none()).map(|f| &f.key).collect::<BTreeSet<_>>().len()
}

/// Writes a file next to its destination first, then moves it into place, so a failed export
/// never leaves half a file behind. The temporary file gets a fresh name and is only ever
/// created new, so it can't follow a planted link or clash with another export.
pub fn write_file(path: &Path, contents: &str) -> AppResult<()> {
    use std::io::Write;
    let name = path.file_name().ok_or_else(|| AppError::Invalid("Choose a file name".into()))?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = path.with_file_name(format!(".{}.{}-{stamp}.fontface-tmp", name.to_string_lossy(), std::process::id()));
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .and_then(|mut f| f.write_all(contents.as_bytes()).and_then(|_| f.sync_all()))
        .and_then(|_| std::fs::rename(&tmp, path));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

/// Unix seconds → "2026-10-12T14:05:00Z".
pub fn iso8601(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}
