//! Typeface backups (`.typeface-backup`), the file Typeface writes with File > Export > Backup
//! Tags. Typeface's help describes it as plain JSON. This reader is built from the user's own
//! backups (formats 2, 3 and 4), not from Typeface's code:
//!
//! ```json
//! { "version": 4, "date": 1778460977.6,
//!   "tags": [ { "tag": { "name": "Sci-Fi/Star Trek" }, "fonts": ["Okuda", "Inter-Regular_Bold"] } ],
//!   "families": [], "mainFonts": [], "locations": ["/Users/…/Fonts"] }
//! ```
//!
//! - `tags[].fonts` holds PostScript names. A named instance of a variable font is written as
//!   `<variable font's PostScript name>_<instance>`.
//! - `/` nests tags, as in Fontface. Parents usually appear as tags of their own, often empty.
//! - `typeface/active…` and `quick-collection` are Typeface's own lists, not tags the user made.
//! - `families` (custom families), `mainFonts` and `locations` (watched folders) have no
//!   Fontface equivalent; the preview says so instead of importing them.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::import::{Source, SourceFont, SourceTag, MAX_FONT_NAME};
use crate::error::{AppError, AppResult};

/// Backups are small (a few hundred KB for ~9,000 fonts). Anything far larger isn't one.
pub const MAX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Deserialize)]
struct Backup {
    #[serde(default)]
    version: Option<i64>,
    #[serde(default)]
    date: Option<f64>,
    tags: Vec<Entry>,
    #[serde(default)]
    families: Vec<Value>,
    #[serde(default, rename = "mainFonts")]
    main_fonts: Vec<Value>,
    #[serde(default)]
    locations: Vec<Value>,
}

#[derive(Deserialize)]
struct Entry {
    tag: EntryTag,
    #[serde(default)]
    fonts: Vec<Value>,
}

#[derive(Deserialize)]
struct EntryTag {
    name: String,
}

/// Why a list in the backup isn't a tag the user made, if it isn't.
fn system_list(name: &str) -> Option<&'static str> {
    let n = name.trim().to_ascii_lowercase();
    if n == "typeface/active" {
        Some("Typeface's record of the fonts it had turned on")
    } else if n.starts_with("typeface/") || n == "typeface" {
        Some("One of Typeface's own lists")
    } else if n == "quick-collection" || n == "saved-quick-collection" {
        Some("Typeface's quick collection")
    } else {
        None
    }
}

pub fn parse(bytes: &[u8]) -> AppResult<Source> {
    let backup: Backup = serde_json::from_slice(bytes)
        .map_err(|e| AppError::Invalid(format!("That doesn't look like a Typeface backup ({e})")))?;
    let mut source = Source {
        label: match backup.version {
            Some(v) => format!("Typeface backup (format {v})"),
            None => "Typeface backup".into(),
        },
        date: backup.date,
        ..Default::default()
    };
    let mut too_long = 0;
    for entry in backup.tags {
        let note = system_list(&entry.tag.name);
        let fonts = entry
            .fonts
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .filter(|s| {
                let ok = s.len() <= MAX_FONT_NAME;
                too_long += usize::from(!ok);
                ok
            })
            .map(|s| SourceFont::PostScript(s.to_string()))
            .collect();
        source.tags.push(SourceTag {
            name: entry.tag.name,
            color: None,
            fonts,
            suggested: note.is_none(),
            note: note.map(str::to_string),
        });
    }
    if too_long > 0 {
        source.notes.push(format!("{too_long} font names were too long to be real fonts and were left out."));
    }
    if !backup.families.is_empty() {
        source.notes.push(format!(
            "{} custom families aren't imported. Fontface groups fonts by the family names inside the files.",
            backup.families.len()
        ));
    }
    if !backup.main_fonts.is_empty() {
        source.notes.push(format!("{} family settings (main styles) aren't imported.", backup.main_fonts.len()));
    }
    let locations: Vec<&str> = backup.locations.iter().filter_map(Value::as_str).collect();
    if !locations.is_empty() {
        source.notes.push(format!(
            "Typeface was watching {} folders. Fonts are matched by name, so they don't need to be in the same place. \
             Add any folder that's missing under Folders.",
            locations.len()
        ));
    }
    Ok(source)
}

#[derive(Serialize)]
struct OutBackup<'a> {
    version: i64,
    date: f64,
    tags: Vec<OutEntry<'a>>,
    families: [(); 0],
    #[serde(rename = "mainFonts")]
    main_fonts: [(); 0],
}

#[derive(Serialize)]
struct OutEntry<'a> {
    tag: OutTag<'a>,
    fonts: Vec<&'a str>,
}

#[derive(Serialize)]
struct OutTag<'a> {
    name: &'a str,
}

/// Writes tags in the same layout as Typeface's own backups (format 3). Typeface matches fonts
/// by PostScript name, so fonts without one are left out.
pub fn write(tags: &[(String, Vec<String>)], date: f64) -> String {
    let backup = OutBackup {
        version: 3,
        date,
        tags: tags
            .iter()
            .map(|(name, fonts)| OutEntry { tag: OutTag { name }, fonts: fonts.iter().map(String::as_str).collect() })
            .collect(),
        families: [],
        main_fonts: [],
    };
    serde_json::to_string_pretty(&backup).expect("plain data always serializes")
}
