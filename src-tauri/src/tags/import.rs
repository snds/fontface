//! Importing tags from other places: Typeface backups, Fontface's own export, Finder tags and
//! Font Book collections.
//!
//! Every source is read into a [`Source`]: tag names, each with the fonts it holds. Planning
//! matches those fonts against the library without writing anything, so the UI can show a
//! preview. Applying the same source again adds nothing new: tags merge by name (ignoring
//! letter case) and each font gets a tag at most once.
//!
//! A source made before a folder was moved with Locate… names that folder by its old path.
//! Preview and import both point those paths at the folder's current place first
//! ([`follow_moves`]), so they agree and the colors and fonts land where the folder is now.

use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet, HashMap},
};

use rusqlite::Connection;
use serde::Serialize;

use super::{
    colors, ensure_tag, find_tag, is_loose, key_postscript_name, list_tags, loose_key, named_styles, normalize_name,
    relocate::Moves, LibraryIndex,
};
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
    /// Fonts matched as named styles inside variable fonts (see [`named_styles`]).
    pub named_style_matches: usize,
    /// Fonts matched once their library name was tidied the way macOS writes it.
    pub tidied_matches: usize,
    /// The fonts that aren't in the library, with the tags that name them (at most
    /// [`MAX_MISSING_LISTED`]; `unmatched_fonts` has the full count).
    pub missing: Vec<MissingFont>,
    pub notes: Vec<String>,
}

/// A font the source names that isn't in the library.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingFont {
    /// Its PostScript name (or file, or family, as the source gives it).
    pub name: String,
    pub tags: Vec<String>,
}

/// The preview lists at most this many missing fonts. Real backups have a few thousand.
pub const MAX_MISSING_LISTED: usize = 20_000;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// Tags created, including parents a nested name needed.
    pub tags_created: usize,
    pub tags_updated: usize,
    /// Tags added to styles (a style that got three tags counts three times).
    pub added: usize,
    /// Different styles that got at least one tag.
    pub styles: usize,
    /// Different fonts not in the library whose tags were kept for when they're added.
    pub kept: usize,
    pub location_colors: usize,
    /// Tags deleted first, when replacing (see [`replace`]).
    pub tags_removed: usize,
}

/// A planned tag with the keys it will write.
struct Resolved {
    tag: PlannedTag,
    matched: BTreeSet<String>,
    /// For each font not in the library: the keys that keep its tag for later.
    pending: Vec<(SourceFont, Vec<String>)>,
}

/// How a source font was found in the library.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum How {
    /// By the name or key as written, or as `<variable font>_<instance>`.
    Direct,
    /// As a named style inside a variable font.
    NamedStyle,
    /// Once the library's name was tidied the way macOS writes it.
    Tidied,
}

/// What one source font stands for in the library.
struct Match {
    keys: Vec<String>,
    /// Keys to keep if the font isn't in the library yet (empty if it can't be kept).
    pending: Vec<String>,
    how: How,
}

/// A PostScript name the way macOS reports it: spaces become hyphens, and characters a
/// PostScript name can't hold are dropped ("MDRS-FD01(c)Zhimetcardozo,2009" becomes
/// "MDRS-FD01cZhimetcardozo,2009"). Typeface backups hold names in this form.
pub fn tidy_postscript(name: &str) -> String {
    name.trim()
        .chars()
        .filter_map(|c| match c {
            ' ' => Some('-'),
            '[' | ']' | '(' | ')' | '{' | '}' | '<' | '>' | '/' | '%' => None,
            c if ('!'..='~').contains(&c) => Some(c),
            _ => None,
        })
        .collect()
}

/// The library, ready to match an import against.
///
/// Building it is quick. [`Matcher::with_named_styles`] reads font files, so the commands run
/// it without holding the database lock.
#[derive(Default)]
pub struct Matcher {
    index: LibraryIndex,
    /// PostScript names of named styles inside variable fonts → the variable fonts' keys.
    named: HashMap<String, Vec<String>>,
    /// Library PostScript names that aren't valid as written ("D3 Factorism Katakana"), by the
    /// form macOS and Typeface use ("D3-Factorism-Katakana").
    tidied: HashMap<String, Vec<String>>,
}

impl Matcher {
    pub fn load(conn: &Connection) -> AppResult<Self> {
        Ok(Self::new(LibraryIndex::load(conn)?))
    }

    pub fn new(index: LibraryIndex) -> Self {
        let mut tidied: HashMap<String, Vec<String>> = HashMap::new();
        for face in &index.faces {
            if let Some(ps) = &face.postscript_name {
                let t = tidy_postscript(ps);
                if !t.is_empty() && t != *ps {
                    tidied.entry(t).or_default().push(face.key.clone());
                }
            }
        }
        Matcher { index, named: HashMap::new(), tidied }
    }

    /// Learns the named styles of the library's variable fonts, if the source has PostScript
    /// names that nothing else matches. Reads font files (only their `fvar` and `name` tables).
    pub fn with_named_styles(mut self, source: &Source) -> Self {
        let needed = source
            .tags
            .iter()
            .flat_map(|t| t.fonts.iter())
            .any(|f| matches!(f, SourceFont::PostScript(_)) && match_font(&self, f).keys.is_empty());
        if !needed {
            return self;
        }
        let mut named: HashMap<String, Vec<String>> = HashMap::new();
        for face in self.index.faces.iter().filter(|f| f.variable) {
            // Copies of a font have the same styles; the first copy that has any is enough.
            for file in &face.files {
                let names = named_styles::postscript_names(&file.path, file.face_index);
                if names.is_empty() {
                    continue;
                }
                for name in names {
                    let keys = named.entry(name).or_default();
                    if !keys.contains(&face.key) {
                        keys.push(face.key.clone());
                    }
                }
                break;
            }
        }
        self.named = named;
        self
    }
}

/// Longest font name an import accepts. Real PostScript names are at most 63 characters; this
/// leaves room for Typeface's `<name>_<instance>` form while keeping hostile files cheap to read.
pub const MAX_FONT_NAME: usize = 512;

fn match_font(matcher: &Matcher, font: &SourceFont) -> Match {
    let index = &matcher.index;
    let keys_of = |faces: Vec<&super::LibraryFace>| -> Vec<String> { faces.into_iter().map(|f| f.key.clone()).collect() };
    let found = |keys: Vec<String>, how: How| Match { keys, pending: vec![], how };
    match font {
        SourceFont::PostScript(name) => {
            let exact = keys_of(index.by_postscript_name(name).collect());
            if !exact.is_empty() {
                return found(exact, How::Direct);
            }
            // "<variable font>_<instance>": the longest prefix that names a variable font in the
            // library. Only variable fonts: a static font with that name is a different style.
            for (i, _) in name.rmatch_indices('_') {
                let variable: Vec<_> = index.by_postscript_name(&name[..i]).filter(|f| f.variable).collect();
                if !variable.is_empty() {
                    return found(keys_of(variable), How::Direct);
                }
            }
            // A named style's own PostScript name ("SFPro-CondensedThin"): its variable font.
            if let Some(keys) = matcher.named.get(name.as_str()) {
                return found(keys.clone(), How::NamedStyle);
            }
            // A library font whose name isn't valid as written ("D3 Factorism Katakana").
            if let Some(keys) = matcher.tidied.get(&tidy_postscript(name)) {
                return found(keys.clone(), How::Tidied);
            }
            // Not in the library. Keep the name itself, and for "<base>_<instance>" also the
            // variable font it would come from (cut at the last "_", as Typeface writes it).
            let mut pending = vec![loose_key(name)];
            if let Some((base, _)) = name.rsplit_once('_').filter(|(b, _)| !b.is_empty()) {
                pending.push(super::face_key(Some(base), true, false, "", 0));
                pending.push(super::face_key(Some(base), true, true, "", 0));
            }
            Match { keys: vec![], pending, how: How::Direct }
        }
        SourceFont::Key(key) => {
            let mut keys = keys_of(index.resolve(key));
            // The exact font isn't here (say it was exported as a static font and this library
            // has the variable one): fall back to its PostScript name, as other sources match.
            if keys.is_empty() {
                if let Some(ps) = key_postscript_name(key) {
                    keys = keys_of(index.by_postscript_name(ps).collect());
                }
            }
            let pending = if keys.is_empty() { vec![key.clone()] } else { vec![] };
            Match { keys, pending, how: How::Direct }
        }
        SourceFont::File(path) => found(keys_of(index.in_file(path).collect()), How::Direct),
        SourceFont::Family(family) => found(keys_of(index.by_family(family).collect()), How::Direct),
    }
}

/// How a missing font is listed in the preview.
fn describe(font: &SourceFont) -> String {
    match font {
        SourceFont::PostScript(name) => name.clone(),
        SourceFont::Key(key) => key_postscript_name(key).map(str::to_string).unwrap_or_else(|| key.clone()),
        SourceFont::File(path) => path.clone(),
        SourceFont::Family(family) => format!("{family} (family)"),
    }
}

/// The source with paths under a folder that has moved since (Locate…) pointed at the folder's
/// current place: location colors, and fonts kept by file (`file:` keys and Finder's files). A
/// file the library still lists at its path is left as it is. Location colors that were already
/// at a current path come first, so they win over ones that moved there.
fn follow_moves<'a>(conn: &Connection, matcher: &Matcher, source: &'a Source) -> AppResult<Cow<'a, Source>> {
    let moves = Moves::load(conn)?;
    if moves.is_empty() {
        return Ok(Cow::Borrowed(source));
    }
    let moved_file = |path: &str| -> Option<String> {
        if matcher.index.in_file(path).next().is_some() {
            return None;
        }
        moves.current(path)
    };
    let moved_font = |font: &SourceFont| -> Option<SourceFont> {
        match font {
            SourceFont::Key(key) => {
                let (path, face) = key.strip_prefix("file:")?.rsplit_once('#')?;
                moved_file(path).map(|p| SourceFont::Key(format!("file:{p}#{face}")))
            }
            SourceFont::File(path) => moved_file(path).map(SourceFont::File),
            SourceFont::PostScript(_) | SourceFont::Family(_) => None,
        }
    };
    let mut out: Option<Source> = None;
    for (i, tag) in source.tags.iter().enumerate() {
        for (j, font) in tag.fonts.iter().enumerate() {
            if let Some(moved) = moved_font(font) {
                out.get_or_insert_with(|| source.clone()).tags[i].fonts[j] = moved;
            }
        }
    }
    let (mut kept, mut moved_colors) = (Vec::new(), Vec::new());
    for (location, color) in &source.location_colors {
        match moves.current(location) {
            Some(now) => moved_colors.push((now, color.clone())),
            None => kept.push((location.clone(), color.clone())),
        }
    }
    if !moved_colors.is_empty() {
        kept.extend(moved_colors);
        out.get_or_insert_with(|| source.clone()).location_colors = kept;
    }
    Ok(out.map_or(Cow::Borrowed(source), Cow::Owned))
}

/// Matches a source against the library. Writes nothing. The source has followed any moves.
fn resolve(conn: &Connection, matcher: &Matcher, source: &Source) -> AppResult<(Vec<Resolved>, ImportPreview)> {
    // Merge tags whose names differ only in letter case (ASCII, like SQLite's NOCASE).
    let mut order: Vec<String> = Vec::new();
    let mut merged: HashMap<String, (String, Vec<&SourceTag>)> = HashMap::new();
    let mut skipped = 0;
    for tag in &source.tags {
        let Ok(name) = normalize_name(&tag.name) else {
            skipped += 1;
            continue;
        };
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
    let mut missing: BTreeMap<&SourceFont, BTreeSet<String>> = BTreeMap::new();
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
        let mut pending = Vec::new();
        let mut unmatched = 0;
        for font in &fonts {
            let m = matches.entry(font).or_insert_with(|| match_font(matcher, font));
            if m.keys.is_empty() {
                unmatched += 1;
                missing.entry(*font).or_default().insert(display.clone());
                if !m.pending.is_empty() {
                    pending.push(((*font).clone(), m.pending.clone()));
                }
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
    let found_by = |how: How| -> Vec<&SourceFont> {
        let mut fonts: Vec<&SourceFont> = matches.iter().filter(|(_, m)| m.how == how && !m.keys.is_empty()).map(|(f, _)| *f).collect();
        fonts.sort();
        fonts
    };
    let (named, tidied) = (found_by(How::NamedStyle), found_by(How::Tidied));
    let mut notes = source.notes.clone();
    if let Some(first) = named.first() {
        notes.push(format!(
            "{} {} named {} inside variable fonts you have, such as “{}”. {} the variable font.",
            named.len(),
            if named.len() == 1 { "font is a" } else { "fonts are" },
            if named.len() == 1 { "style" } else { "styles" },
            describe(first),
            if named.len() == 1 { "It tags" } else { "They tag" },
        ));
    }
    if let Some(first) = tidied.first() {
        notes.push(format!(
            "{} {} matched once spaces and brackets were taken out of the name in the font file, the way macOS writes it (such as “{}”).",
            tidied.len(),
            if tidied.len() == 1 { "font" } else { "fonts" },
            describe(first),
        ));
    }
    if skipped > 0 {
        notes.push(format!(
            "{skipped} {} left out because {} empty, too long (over {} characters) or {} control characters.",
            if skipped == 1 { "tag was" } else { "tags were" },
            if skipped == 1 { "its name is" } else { "their names are" },
            super::MAX_NAME,
            if skipped == 1 { "holds" } else { "hold" },
        ));
    }
    // Nested tags need their parents. Ones that neither exist nor appear in the source are
    // created along the way; say so, since they aren't in the list.
    let mut implied: BTreeSet<String> = BTreeSet::new();
    for (name, _) in merged.values() {
        for parent in super::parent_names(name) {
            let folded = parent.to_ascii_lowercase();
            if !merged.contains_key(&folded) && !existing.iter().any(|t| t.name.eq_ignore_ascii_case(&parent)) {
                implied.insert(folded);
            }
        }
    }
    if !implied.is_empty() {
        notes.push(format!(
            "{} parent {} not in this list will be created if you import the tags nested under {}.",
            implied.len(),
            if implied.len() == 1 { "tag" } else { "tags" },
            if implied.len() == 1 { "it" } else { "them" },
        ));
    }
    let preview = ImportPreview {
        label: source.label.clone(),
        date: source.date,
        tags: out.iter().map(|r| r.tag.clone()).collect(),
        fonts: matches.len(),
        matched_fonts,
        unmatched_fonts: matches.len() - matched_fonts,
        named_style_matches: named.len(),
        tidied_matches: tidied.len(),
        missing: missing
            .into_iter()
            .take(MAX_MISSING_LISTED)
            .map(|(font, tags)| MissingFont { name: describe(font), tags: tags.into_iter().collect() })
            .collect(),
        notes,
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

/// Builds the matcher and previews in one step, holding `conn` throughout (tests use this).
#[cfg(test)]
pub fn preview(conn: &Connection, source: &Source) -> AppResult<ImportPreview> {
    let matcher = Matcher::load(conn)?.with_named_styles(source);
    preview_with(conn, &matcher, source)
}

/// What an import would do, without changing anything. The commands build the matcher
/// without holding the lock (see [`Matcher`]).
pub fn preview_with(conn: &Connection, matcher: &Matcher, source: &Source) -> AppResult<ImportPreview> {
    let source = follow_moves(conn, matcher, source)?;
    Ok(resolve(conn, matcher, &source)?.1)
}

/// [`apply_with`] in one step, holding `conn` throughout (tests use this).
#[cfg(test)]
pub fn apply(conn: &mut Connection, source: &Source, chosen: &[String], keep_unmatched: bool) -> AppResult<ImportResult> {
    let matcher = Matcher::load(conn)?.with_named_styles(source);
    apply_with(conn, &matcher, source, chosen, keep_unmatched)
}

/// Applies the chosen tags (by name, as the preview showed them). With `keep_unmatched`,
/// fonts that aren't in the library keep their tags for later.
pub fn apply_with(
    conn: &mut Connection,
    matcher: &Matcher,
    source: &Source,
    chosen: &[String],
    keep_unmatched: bool,
) -> AppResult<ImportResult> {
    write(conn, matcher, source, chosen, keep_unmatched, false)
}

/// Like [`apply_with`], but in place of the tags there now: every tag, tag link and location
/// color is deleted first, in the same transaction, so a backup comes back as it was (names,
/// colors, fonts) and nothing changes if any step fails.
pub fn replace_with(
    conn: &mut Connection,
    matcher: &Matcher,
    source: &Source,
    chosen: &[String],
    keep_unmatched: bool,
) -> AppResult<ImportResult> {
    write(conn, matcher, source, chosen, keep_unmatched, true)
}

/// [`replace_with`] in one step, holding `conn` throughout (tests use this).
#[cfg(test)]
pub fn replace(conn: &mut Connection, source: &Source, chosen: &[String], keep_unmatched: bool) -> AppResult<ImportResult> {
    let matcher = Matcher::load(conn)?.with_named_styles(source);
    replace_with(conn, &matcher, source, chosen, keep_unmatched)
}

fn write(
    conn: &mut Connection,
    matcher: &Matcher,
    source: &Source,
    chosen: &[String],
    keep_unmatched: bool,
    replace: bool,
) -> AppResult<ImportResult> {
    let chosen: BTreeSet<String> = chosen.iter().map(|n| n.trim().to_ascii_lowercase()).collect();
    // The same paths the preview showed (see `follow_moves`).
    let source = follow_moves(conn, matcher, source)?;
    let source = &*source;
    let mut result = ImportResult::default();
    let mut styles = BTreeSet::new();
    let mut kept_fonts = BTreeSet::new();
    let tx = conn.transaction()?;
    if replace {
        tx.execute("DELETE FROM tag_fonts", [])?;
        result.tags_removed = tx.execute("DELETE FROM tags", [])?;
        tx.execute("DELETE FROM location_colors", [])?;
    }
    // Planned inside the transaction, so a replace plans against no tags: each one is created
    // again with the source's color. (The matcher only knows the library's fonts, not its tags.)
    let (resolved, _) = resolve(&tx, matcher, source)?;
    let mut touched = BTreeSet::new();
    for r in resolved.iter().filter(|r| chosen.contains(&r.tag.name.to_ascii_lowercase())) {
        let (tag, created) = ensure_tag(&tx, &r.tag.name, &r.tag.color)?;
        // Styles that already have the tag through a key kept from an earlier import are left
        // alone, so the preview's "new" count is exactly what gets added.
        let have = assigned_keys(&tx, tag.id)?;
        let mut added = 0;
        {
            let mut insert =
                tx.prepare_cached("INSERT OR IGNORE INTO tag_fonts (tag_id, face_key, added_at) VALUES (?1, ?2, ?3)")?;
            let now = super::now();
            for key in r.matched.iter().filter(|k| !has_loose(&have, k)) {
                if insert.execute(rusqlite::params![tag.id, key, now])? > 0 {
                    added += 1;
                    styles.insert(key.clone());
                }
            }
            if keep_unmatched {
                for (font, keys) in &r.pending {
                    let mut kept = false;
                    for key in keys {
                        kept |= insert.execute(rusqlite::params![tag.id, key, now])? > 0;
                    }
                    if kept {
                        kept_fonts.insert(font.clone());
                    }
                }
            }
        }
        result.added += added;
        result.tags_created += created;
        if created == 0 && added > 0 {
            touched.insert(tag.id);
        }
    }
    result.tags_updated = touched.len();
    result.styles = styles.len();
    result.kept = kept_fonts.len();
    for (location, color) in &source.location_colors {
        // A location this library can't use is skipped, not a reason to drop the whole import.
        match super::set_location_color_if_unset(&tx, location, color) {
            Ok(true) => result.location_colors += 1,
            Ok(false) | Err(crate::error::AppError::Invalid(_)) => {}
            Err(e) => return Err(e),
        }
    }
    tx.commit()?;
    Ok(result)
}
