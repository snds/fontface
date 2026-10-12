//! Importing tags from other places: Typeface backups, Fontface's own export, Finder tags and
//! Font Book collections.
//!
//! Every source is read into a [`Source`]: tag names, each with the fonts it holds. Planning
//! matches those fonts against the library without writing anything, so the UI can show a
//! preview. Applying the same source again adds nothing new: tags merge by name (ignoring
//! letter case) and each font gets a tag at most once.

use std::collections::{BTreeSet, HashMap};

use rusqlite::Connection;
use serde::Serialize;

use super::{colors, ensure_tag, find_tag, is_loose, key_postscript_name, list_tags, loose_key, normalize_name, LibraryIndex};
use crate::error::AppResult;

/// How a source names a font.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SourceFont {
    /// A PostScript name. Typeface also writes `<name>_<instance>` for a named instance of a
    /// variable font, where `<name>` is the variable font's own PostScript name.
    PostScript(String),
    /// A Fontface face key, from Fontface's own export.
    Key(String),
    /// Every face in this file (Finder tags are set per file).
    File(String),
    /// Every face of this family (Font Book collections can hold whole families).
    Family(String),
}

#[derive(Debug, Clone)]
pub struct SourceTag {
    pub name: String,
    /// A color from the source, if it has one in the palette.
    pub color: Option<String>,
    pub fonts: Vec<SourceFont>,
    /// Ticked in the preview. Off for lists that aren't really tags, like Typeface's record of
    /// which fonts it had turned on.
    pub suggested: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Source {
    pub label: String,
    pub tags: Vec<SourceTag>,
    /// Plain-language remarks for the preview (what isn't imported, and why).
    pub notes: Vec<String>,
    /// When the source was made (Unix seconds), if it says.
    pub date: Option<f64>,
    /// Location colors from Fontface's own export. Applied only where none is set yet.
    pub location_colors: Vec<(String, String)>,
}

/// One tag in the preview.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedTag {
    pub name: String,
    /// The color it has, or will get.
    pub color: String,
    /// A tag with this name already exists; fonts are added to it.
    pub exists: bool,
    /// Fonts the source lists for it.
    pub fonts: usize,
    /// Library styles it will be on.
    pub matched: usize,
    /// Fonts in the source that aren't in the library.
    pub unmatched: usize,
    /// Library styles that don't have it yet. Zero when the import was already applied.
    pub new: usize,
    pub suggested: bool,
    pub note: Option<String>,
    /// Other spellings in the source that were merged into this one.
    pub merged: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub label: String,
    pub date: Option<f64>,
    pub tags: Vec<PlannedTag>,
    /// Different fonts the source names.
    pub fonts: usize,
    pub matched_fonts: usize,
    pub unmatched_fonts: usize,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub tags_created: usize,
    pub tags_updated: usize,
    /// Styles that got a tag.
    pub added: usize,
    /// Fonts not in the library that will get their tags when they're added.
    pub kept: usize,
    pub location_colors: usize,
}

/// A planned tag with the keys it will write.
struct Resolved {
    tag: PlannedTag,
    matched: BTreeSet<String>,
    pending: BTreeSet<String>,
}

/// What one source font stands for in the library.
struct Match {
    keys: Vec<String>,
    /// Keys to keep if the font isn't in the library yet (empty if it can't be kept).
    pending: Vec<String>,
}

fn match_font(index: &LibraryIndex, font: &SourceFont) -> Match {
    let keys_of = |faces: Vec<&super::LibraryFace>| -> Vec<String> { faces.into_iter().map(|f| f.key.clone()).collect() };
    match font {
        SourceFont::PostScript(name) => {
            let exact = keys_of(index.by_postscript_name(name).collect());
            if !exact.is_empty() {
                return Match { keys: exact, pending: vec![] };
            }
            // "<variable font>_<instance>": try the longest prefix that's a PostScript name in
            // the library, preferring its variable fonts.
            for (i, _) in name.rmatch_indices('_') {
                let base = &name[..i];
                let faces: Vec<_> = index.by_postscript_name(base).collect();
                if !faces.is_empty() {
                    let variable: Vec<_> = faces.iter().copied().filter(|f| f.variable).collect();
                    return Match { keys: keys_of(if variable.is_empty() { faces } else { variable }), pending: vec![] };
                }
            }
            let mut pending = vec![loose_key(name)];
            if let Some((base, _)) = name.split_once('_').filter(|(b, _)| !b.is_empty()) {
                pending.push(loose_key(base));
            }
            Match { keys: vec![], pending }
        }
        SourceFont::Key(key) => {
            let keys = keys_of(index.resolve(key));
            let pending = if keys.is_empty() { vec![key.clone()] } else { vec![] };
            Match { keys, pending }
        }
        SourceFont::File(path) => Match { keys: keys_of(index.in_file(path).collect()), pending: vec![] },
        SourceFont::Family(family) => Match { keys: keys_of(index.by_family(family).collect()), pending: vec![] },
    }
}

/// Matches a source against the library. Writes nothing.
fn resolve(conn: &Connection, index: &LibraryIndex, source: &Source) -> AppResult<(Vec<Resolved>, ImportPreview)> {
    // Merge tags whose names differ only in letter case (ASCII, like SQLite's NOCASE).
    let mut order: Vec<String> = Vec::new();
    let mut merged: HashMap<String, (String, Vec<&SourceTag>)> = HashMap::new();
    for tag in &source.tags {
        let Ok(name) = normalize_name(&tag.name) else { continue };
        let folded = name.to_ascii_lowercase();
        match merged.get_mut(&folded) {
            Some((_, list)) => list.push(tag),
            None => {
                order.push(folded.clone());
                merged.insert(folded, (name, vec![tag]));
            }
        }
    }
    // Parents before their children, so a parent's color is settled first. (Stable: the
    // source's order is kept within each level.)
    order.sort_by_key(|n| n.matches('/').count());

    // Colors for tags that will be created: the source's, else the parent's, else the
    // least-used color among top-level tags (counting ones this import creates).
    let existing = list_tags(conn)?;
    let mut top_colors: Vec<String> = existing.iter().filter(|t| !t.name.contains('/')).map(|t| t.color.clone()).collect();
    let mut planned_colors: HashMap<String, String> = HashMap::new();

    let mut matches: HashMap<&SourceFont, Match> = HashMap::new();
    let mut out = Vec::new();
    for folded in &order {
        let (name, parts) = &merged[folded];
        let found = find_tag(conn, name)?;
        let display = found.as_ref().map(|t| t.name.clone()).unwrap_or_else(|| name.clone());
        let color = match &found {
            Some(t) => t.color.clone(),
            None => {
                let from_source = parts.iter().find_map(|p| p.color.clone()).filter(|c| colors::is_valid(c));
                let parent = super::parent_names(name).into_iter().rev().find_map(|p| {
                    planned_colors.get(&p.to_ascii_lowercase()).cloned().or_else(|| {
                        existing.iter().find(|t| t.name.eq_ignore_ascii_case(&p)).map(|t| t.color.clone())
                    })
                });
                match from_source.or(parent) {
                    Some(c) => c,
                    None => colors::least_used(top_colors.iter().map(String::as_str)).to_string(),
                }
            }
        };
        if found.is_none() && !name.contains('/') {
            top_colors.push(color.clone());
        }
        planned_colors.insert(folded.clone(), color.clone());

        let fonts: BTreeSet<&SourceFont> = parts.iter().flat_map(|p| p.fonts.iter()).collect();
        let mut matched = BTreeSet::new();
        let mut pending = BTreeSet::new();
        let mut unmatched = 0;
        for font in &fonts {
            let m = matches.entry(font).or_insert_with(|| match_font(index, font));
            if m.keys.is_empty() {
                unmatched += 1;
                pending.extend(m.pending.iter().cloned());
            } else {
                matched.extend(m.keys.iter().cloned());
            }
        }
        let new = match &found {
            Some(t) => {
                let have = assigned_keys(conn, t.id)?;
                matched.iter().filter(|k| !have.contains(*k) && !has_loose(&have, k)).count()
            }
            None => matched.len(),
        };
        let mut spellings: Vec<String> = parts.iter().map(|p| p.name.trim().to_string()).collect();
        spellings.sort();
        spellings.dedup();
        spellings.retain(|s| *s != display);
        out.push(Resolved {
            tag: PlannedTag {
                name: display,
                color,
                exists: found.is_some(),
                fonts: fonts.len(),
                matched: matched.len(),
                unmatched,
                new,
                suggested: parts.iter().all(|p| p.suggested),
                note: parts.iter().find_map(|p| p.note.clone()),
                merged: spellings,
            },
            matched,
            pending,
        });
    }

    let matched_fonts = matches.values().filter(|m| !m.keys.is_empty()).count();
    let preview = ImportPreview {
        label: source.label.clone(),
        date: source.date,
        tags: out.iter().map(|r| r.tag.clone()).collect(),
        fonts: matches.len(),
        matched_fonts,
        unmatched_fonts: matches.len() - matched_fonts,
        notes: source.notes.clone(),
    };
    Ok((out, preview))
}

fn assigned_keys(conn: &Connection, tag_id: i64) -> AppResult<BTreeSet<String>> {
    let mut stmt = conn.prepare("SELECT face_key FROM tag_fonts WHERE tag_id = ?1")?;
    let rows = stmt.query_map([tag_id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The face already has this tag through a loose key for its PostScript name.
fn has_loose(have: &BTreeSet<String>, key: &str) -> bool {
    !is_loose(key) && key_postscript_name(key).is_some_and(|ps| have.contains(&loose_key(ps)))
}

pub fn preview(conn: &Connection, source: &Source) -> AppResult<ImportPreview> {
    let index = LibraryIndex::load(conn)?;
    Ok(resolve(conn, &index, source)?.1)
}

/// Applies the chosen tags (by name, as the preview showed them). With `keep_unmatched`,
/// fonts that aren't in the library keep their tags for later.
pub fn apply(conn: &mut Connection, source: &Source, chosen: &[String], keep_unmatched: bool) -> AppResult<ImportResult> {
    let index = LibraryIndex::load(conn)?;
    let (resolved, _) = resolve(conn, &index, source)?;
    let chosen: BTreeSet<String> = chosen.iter().map(|n| n.trim().to_ascii_lowercase()).collect();
    let mut result = ImportResult::default();
    let tx = conn.transaction()?;
    let mut touched = BTreeSet::new();
    for r in resolved.iter().filter(|r| chosen.contains(&r.tag.name.to_ascii_lowercase())) {
        let (tag, created) = ensure_tag(&tx, &r.tag.name, &r.tag.color)?;
        let mut added = 0;
        {
            let mut insert =
                tx.prepare_cached("INSERT OR IGNORE INTO tag_fonts (tag_id, face_key, added_at) VALUES (?1, ?2, ?3)")?;
            let now = super::now();
            for key in &r.matched {
                added += insert.execute(rusqlite::params![tag.id, key, now])?;
            }
            if keep_unmatched {
                for key in &r.pending {
                    result.kept += insert.execute(rusqlite::params![tag.id, key, now])?;
                }
            }
        }
        result.added += added;
        if created {
            result.tags_created += 1;
        } else if added > 0 {
            touched.insert(tag.id);
        }
    }
    result.tags_updated = touched.len();
    for (location, color) in &source.location_colors {
        if colors::is_valid(color) && super::set_location_color_if_unset(&tx, location, color)? {
            result.location_colors += 1;
        }
    }
    tx.commit()?;
    Ok(result)
}
