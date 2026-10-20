//! Font names to library fonts: one matcher for every place that names fonts in text.
//!
//! It takes lines ("Inter-Bold", "Inter Bold", "Helvetica Neue") and finds the library's styles
//! for each. "Turn on fonts from a list…" uses it today. It's written for anything else that
//! names fonts as well: a command-line tool, design tokens files, apps asking for a font they're
//! missing, and imports. Everything here is pure (no database, no files), apart from
//! [`NameIndex::load`] and the command at the end.
//!
//! **How a line matches.** The first rule that finds anything wins:
//!
//! 1. A family name: every style in it ("Inter", "Helvetica Neue"). This comes first because a
//!    family's Regular often has the family's name as its PostScript or full name too
//!    ("Helvetica", "Georgia"), and a list that names a family means all of it.
//! 2. A PostScript name, exactly as written ("Inter-Bold").
//! 3. A PostScript name written another way ("inter bold", "INTER_BOLD").
//! 4. A full name (name ID 4: "Inter Bold Italic").
//! 5. A family and a style together, as the font names them ("Inter Semi Bold",
//!    "Inter-SemiBold"), with either of its sets of names (name IDs 16 and 17, or 1 and 2).
//! 6. An older family name (name ID 1) that names one weight ("Inter SemiBold"): that weight's
//!    regular style (else every style with that name).
//! 7. A family and a style written another way: short forms ("Inter Bold It"), Oblique for
//!    Italic ("Helvetica Bold Italic" finds Bold Oblique), Roman for Regular, words in any order.
//! 8. A family and style words, where the family has a variable font: the variable font, since
//!    its styles live inside it ("Roboto Flex Bold").
//!
//! Every comparison ignores letter case, spaces and punctuation ([`name_key`]): "Inter-Bold",
//! "inter bold" and "INTER_BOLD" are the same. A trailing font file extension (".otf") is ignored
//! too, so a list of file names works.
//!
//! **Not found.** A line that matches nothing gets the library's closest names, when any are
//! close enough and it's cheap to tell: the family's other styles when the family is known
//! ("Inter Bld" → "Inter Bold"), else families spelt nearly the same ("Intr" → "Inter").
//!
//! **Never matched:** files in Adobe's Creative Cloud font store. Fontface never touches them
//! (the library doesn't list them either; this is a second guard). Online-only files from cloud
//! storage are matched, and flagged ([`FoundFace::online_only`]): turning one on downloads it.

#[cfg(test)]
mod tests;

use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    error::{AppError, AppResult},
    services::adobe::is_adobe_path,
    tags::LibraryIndex,
    AppState,
};

/// At most this many lines in one call.
pub const MAX_LINES: usize = 5_000;
/// Longer lines aren't font names; they're answered "not found" without being looked at.
pub const MAX_LINE: usize = 512;
/// At most this many closest names for a line that matches nothing.
pub const NEAR_MISSES: usize = 3;
/// Closest names are worked out for this many lines that match nothing; the rest go without.
const NEAR_MISS_LINES: usize = 300;

// ------------------------------------------------------------------------------------ input

/// One font to find: a line of text, or a font named in parts (the Figma plugin's list, a
/// tokens file). Text is "PostScript name", "Full Name", "Family Style" or "Family".
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum NameLine {
    Text(String),
    Font {
        #[serde(default, rename = "postscriptName")]
        postscript_name: Option<String>,
        #[serde(default)]
        family: Option<String>,
        #[serde(default)]
        style: Option<String>,
    },
}

// ----------------------------------------------------------------------------------- output

/// Which rule found a line's fonts (see the top of this file).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum How {
    /// Every style of a family.
    Family,
    PostScript,
    FullName,
    /// A family and style, as written or written another way, or an older family name that
    /// names one weight.
    FamilyStyle,
    /// A style inside a variable font of that family.
    NamedStyle,
}

/// A style a line found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundFace {
    /// Its face key (tags/mod.rs), which the UI's styles are keyed by too.
    pub key: String,
    pub family: String,
    pub style: String,
    pub postscript_name: Option<String>,
    /// Its copies that Fontface may use: their rows in the library.
    pub ids: Vec<i64>,
    pub variable: bool,
    pub italic: bool,
    /// A copy is in a macOS font folder: it's always on.
    pub installed: bool,
    /// Every copy is an online-only file in cloud storage: turning it on downloads it first.
    pub online_only: bool,
}

/// What one line found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    /// The rule that found its styles; None when nothing matched.
    pub how: Option<How>,
    /// The styles, by family and then style name.
    pub faces: Vec<FoundFace>,
    /// When nothing matched: the closest names in the library, closest first.
    pub near: Vec<String>,
}

// ------------------------------------------------------------------------------- name keys

/// A name as the matcher compares it: lowercase, letters and digits only. "Inter-Bold",
/// "inter bold" and "INTER_BOLD" all become "interbold"; "Abaddon™" becomes "abaddon".
pub fn name_key(s: &str) -> String {
    s.chars().flat_map(char::to_lowercase).filter(|c| c.is_alphanumeric()).collect()
}

/// Font file extensions a pasted name may end with (a list of file names).
const FILE_EXTENSIONS: &[&str] = &[".otf", ".ttf", ".ttc", ".otc", ".dfont", ".woff2", ".woff"];

/// The line without spaces around it, and without a font file extension at the end.
fn clean(line: &str) -> &str {
    let line = line.trim();
    for ext in FILE_EXTENSIONS {
        if line.len() > ext.len() && line.is_char_boundary(line.len() - ext.len()) && line[line.len() - ext.len()..].eq_ignore_ascii_case(ext) {
            return line[..line.len() - ext.len()].trim_end();
        }
    }
    line
}

// ------------------------------------------------------------------------------ style words

/// Words styles are named with, as written (in name-key form), and what each means. Short forms
/// and other spellings mean the same as the full word: "It" and "Oblique" are Italic, "Roman" and
/// "Normal" are Regular, "Demi" and "SemiBd" are SemiBold.
const STYLE_WORDS: &[(&str, &str)] = &[
    ("hairline", "hairline"),
    ("thin", "thin"),
    ("extralight", "extralight"),
    ("ultralight", "extralight"),
    ("xlight", "extralight"),
    ("light", "light"),
    ("lt", "light"),
    ("book", "book"),
    ("regular", "regular"),
    ("reg", "regular"),
    ("rg", "regular"),
    ("normal", "regular"),
    ("roman", "regular"),
    ("plain", "regular"),
    ("medium", "medium"),
    ("med", "medium"),
    ("md", "medium"),
    ("semibold", "semibold"),
    ("semibd", "semibold"),
    ("demibold", "semibold"),
    ("demibd", "semibold"),
    ("demi", "semibold"),
    ("semi", "semibold"),
    ("sb", "semibold"),
    ("bold", "bold"),
    ("bd", "bold"),
    ("extrabold", "extrabold"),
    ("extrabd", "extrabold"),
    ("ultrabold", "extrabold"),
    ("xbold", "extrabold"),
    ("heavy", "heavy"),
    ("hv", "heavy"),
    ("black", "black"),
    ("blk", "black"),
    ("extrablack", "extrablack"),
    ("ultrablack", "extrablack"),
    ("italic", "italic"),
    ("ital", "italic"),
    ("ita", "italic"),
    ("it", "italic"),
    ("oblique", "italic"),
    ("obl", "italic"),
    ("slanted", "italic"),
    ("condensed", "condensed"),
    ("cond", "condensed"),
    ("cn", "condensed"),
    ("semicondensed", "semicondensed"),
    ("semicond", "semicondensed"),
    ("extracondensed", "extracondensed"),
    ("extracond", "extracondensed"),
    ("ultracondensed", "ultracondensed"),
    ("compressed", "compressed"),
    ("narrow", "narrow"),
    ("expanded", "expanded"),
    ("extended", "expanded"),
    ("wide", "expanded"),
    ("semiexpanded", "semiexpanded"),
    ("semiextended", "semiexpanded"),
    ("extraexpanded", "extraexpanded"),
    ("extraextended", "extraexpanded"),
];

/// What a style name says, as a set of style words: `key` (a [`name_key`]) cut into words of
/// [`STYLE_WORDS`], in as few words as it takes. Sorted, each word once, and Regular left out
/// when there's anything else ("Regular Italic" is Italic); nothing at all is Regular. None when
/// `key` isn't made of style words only.
pub fn style_words(key: &str) -> Option<Vec<&'static str>> {
    let chars: Vec<char> = key.chars().collect();
    // best[i]: the fewest words that make up the first i characters, and the last word.
    let mut best: Vec<Option<(usize, usize, &'static str)>> = vec![None; chars.len() + 1];
    best[0] = Some((0, 0, ""));
    for end in 1..=chars.len() {
        for &(written, means) in STYLE_WORDS {
            let n = written.chars().count();
            if n > end {
                continue;
            }
            let Some((count, _, _)) = best[end - n] else { continue };
            if !chars[end - n..end].iter().copied().eq(written.chars()) {
                continue;
            }
            if best[end].is_none_or(|(c, _, _)| count + 1 < c) {
                best[end] = Some((count + 1, end - n, means));
            }
        }
    }
    let mut words = Vec::new();
    let mut at = chars.len();
    while at > 0 {
        let (_, from, means) = best[at]?;
        words.push(means);
        at = from;
    }
    words.sort_unstable();
    words.dedup();
    if words.len() > 1 {
        words.retain(|w| *w != "regular");
    }
    if words.is_empty() {
        words.push("regular");
    }
    Some(words)
}

// ----------------------------------------------------------------------------- near misses

/// The fewest single-character edits that turn `a` into the start of `b` (into `b` cut anywhere),
/// if it's at most `max`. "inter" is 1 from "intrbold" (its start "intr"). Stops as soon as it
/// can't be within `max`.
fn distance_to_start(a: &[char], b: &[char], max: usize) -> Option<usize> {
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, &ca) in a.iter().enumerate() {
        let mut next = vec![i + 1; b.len() + 1];
        for (j, &cb) in b.iter().enumerate() {
            let swap = row[j] + usize::from(ca != cb);
            next[j + 1] = swap.min(row[j + 1] + 1).min(next[j] + 1);
        }
        if next.iter().min().is_some_and(|&m| m > max) {
            return None;
        }
        row = next;
    }
    row.into_iter().min().filter(|&d| d <= max)
}

/// The fewest single-character edits between two strings.
fn distance(a: &[char], b: &[char]) -> usize {
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, &ca) in a.iter().enumerate() {
        let mut next = vec![i + 1; b.len() + 1];
        for (j, &cb) in b.iter().enumerate() {
            next[j + 1] = (row[j] + usize::from(ca != cb)).min(row[j + 1] + 1).min(next[j] + 1);
        }
        row = next;
    }
    row[b.len()]
}

/// How many typos a family name may have and still be offered: none for very short names.
fn typos_allowed(len: usize) -> usize {
    match len {
        0..=3 => 0,
        4..=7 => 1,
        8..=14 => 2,
        _ => 3,
    }
}

// ----------------------------------------------------------------------------------- index

/// A family as the matcher knows it: its name as a font spells it, and its styles.
#[derive(Debug, Default)]
struct FamilyNames {
    name: String,
    /// (face, style name as that copy spells it).
    styles: Vec<(usize, String)>,
}

impl FamilyNames {
    fn add(&mut self, name: &str, face: usize, style: &str) {
        if self.name.is_empty() {
            self.name = name.to_string();
        }
        if !self.styles.iter().any(|(f, s)| *f == face && s == style) {
            self.styles.push((face, style.to_string()));
        }
    }

    fn faces(&self) -> Vec<usize> {
        let mut out = Vec::new();
        for &(face, _) in &self.styles {
            if !out.contains(&face) {
                out.push(face);
            }
        }
        out
    }
}

/// The library, ready to match names against. Building it takes a moment for a big library
/// (one pass over every copy); keep it for as many lines as there are.
#[derive(Debug, Default)]
pub struct NameIndex {
    lib: LibraryIndex,
    /// Each face's copies that Fontface may use (all but Creative Cloud's). Faces with none are
    /// left out of every lookup.
    usable: Vec<Vec<usize>>,
    /// PostScript names as written, and as name keys.
    postscript_exact: HashMap<String, Vec<usize>>,
    postscript: HashMap<String, Vec<usize>>,
    full: HashMap<String, Vec<usize>>,
    /// Family and style keys run together ("inter" + "semibold").
    family_style: HashMap<String, Vec<usize>>,
    /// By the family the library lists them under (name ID 16, else 1).
    families: HashMap<String, FamilyNames>,
    /// By name ID 1, where it differs from the family above ("Inter SemiBold").
    older_families: HashMap<String, FamilyNames>,
}

fn push_once(map: &mut HashMap<String, Vec<usize>>, key: String, face: usize) {
    if key.is_empty() {
        return;
    }
    let list = map.entry(key).or_default();
    if !list.contains(&face) {
        list.push(face);
    }
}

impl NameIndex {
    pub fn load(conn: &Connection) -> AppResult<Self> {
        Ok(Self::new(LibraryIndex::load(conn)?))
    }

    pub fn new(lib: LibraryIndex) -> Self {
        let mut index = NameIndex { usable: Vec::with_capacity(lib.faces.len()), ..Default::default() };
        for (i, face) in lib.faces.iter().enumerate() {
            let usable: Vec<usize> = (0..face.files.len()).filter(|&f| !is_adobe_path(Path::new(&face.files[f].path))).collect();
            if !usable.is_empty() {
                if let Some(ps) = &face.postscript_name {
                    push_once(&mut index.postscript_exact, ps.clone(), i);
                    push_once(&mut index.postscript, name_key(ps), i);
                }
                for &f in &usable {
                    let file = &face.files[f];
                    if let Some(full) = &file.full_name {
                        push_once(&mut index.full, name_key(full), i);
                    }
                    let family = name_key(&file.family);
                    push_once(&mut index.family_style, format!("{family}{}", name_key(&file.style)), i);
                    if !family.is_empty() {
                        index.families.entry(family.clone()).or_default().add(&file.family, i, &file.style);
                    }
                    if let Some(older) = file.legacy_family.as_deref().filter(|f| !f.trim().is_empty()) {
                        let older_key = name_key(older);
                        let style = file.legacy_style.as_deref().unwrap_or("Regular");
                        push_once(&mut index.family_style, format!("{older_key}{}", name_key(style)), i);
                        if !older_key.is_empty() && older_key != family {
                            index.older_families.entry(older_key).or_default().add(older, i, style);
                        }
                    }
                }
            }
            index.usable.push(usable);
        }
        index.lib = lib;
        index
    }

    /// Finds the styles for every line. `online_only` says whether a file is an online-only
    /// placeholder (the command asks the file system; tests make it up).
    pub fn match_lines(&self, lines: &[NameLine], online_only: impl Fn(&str) -> bool) -> Vec<LineMatch> {
        let mut near_budget = NEAR_MISS_LINES;
        lines
            .iter()
            .map(|line| {
                let (how, faces, near) = self.find(line, near_budget > 0);
                if how.is_none() {
                    near_budget = near_budget.saturating_sub(1);
                }
                LineMatch { how, faces: self.describe(faces, &online_only), near }
            })
            .collect()
    }

    /// One line's styles (face indexes), the rule that found them, and the closest names when
    /// none did (only if `near` is asked for).
    fn find(&self, line: &NameLine, near: bool) -> (Option<How>, Vec<usize>, Vec<String>) {
        match line {
            NameLine::Text(text) => self.find_text(text, near),
            NameLine::Font { postscript_name, family, style } => {
                // The PostScript name first, as nothing else names one style so exactly; then
                // the family and style it gives.
                if let Some(ps) = postscript_name.as_deref().map(clean).filter(|p| !p.is_empty()) {
                    if let Some((how, faces)) = self.by_postscript(ps) {
                        return (Some(how), faces, vec![]);
                    }
                }
                let family = family.as_deref().unwrap_or("").trim();
                let style = style.as_deref().unwrap_or("").trim();
                match (family.is_empty(), style.is_empty()) {
                    (false, false) => self.find_text(&format!("{family} {style}"), near),
                    (false, true) => self.find_text(family, near),
                    // A style alone names nothing; a PostScript name that wasn't found gets its
                    // closest names.
                    _ => match postscript_name.as_deref().map(clean).filter(|p| !p.is_empty()) {
                        Some(ps) => self.find_text(ps, near),
                        None => (None, vec![], vec![]),
                    },
                }
            }
        }
    }

    fn by_postscript(&self, ps: &str) -> Option<(How, Vec<usize>)> {
        self.lookup(&self.postscript_exact, ps)
            .or_else(|| self.lookup(&self.postscript, &name_key(ps)))
            .map(|faces| (How::PostScript, faces))
    }

    fn find_text(&self, text: &str, near: bool) -> (Option<How>, Vec<usize>, Vec<String>) {
        let text = clean(text);
        if text.is_empty() || text.chars().count() > MAX_LINE {
            return (None, vec![], vec![]);
        }
        let key = name_key(text);
        if key.is_empty() {
            return (None, vec![], vec![]);
        }
        if let Some(family) = self.families.get(&key) {
            return (Some(How::Family), family.faces(), vec![]);
        }
        if let Some((how, faces)) = self.by_postscript(text) {
            return (Some(how), faces, vec![]);
        }
        if let Some(faces) = self.lookup(&self.full, &key) {
            return (Some(How::FullName), faces, vec![]);
        }
        if let Some(faces) = self.lookup(&self.family_style, &key) {
            return (Some(How::FamilyStyle), faces, vec![]);
        }
        if let Some(older) = self.older_families.get(&key) {
            // "Inter SemiBold" names the regular style of that weight; its italic has the same
            // family name.
            let regular: Vec<usize> = older.styles.iter().filter(|(_, s)| style_words(&name_key(s)).as_deref() == Some(&["regular"][..])).map(|&(f, _)| f).collect();
            let faces = if regular.is_empty() { older.faces() } else { dedup(regular) };
            return (Some(How::FamilyStyle), faces, vec![]);
        }
        // A family at the start, and the rest its style: the longest family that fits first
        // ("Inter Display Bold" is Inter Display's Bold, not Inter's).
        let starts = self.families_at_start(&key);
        for (family, rest) in &starts {
            let Some(wanted) = style_words(rest) else { continue };
            let same: Vec<usize> =
                family.styles.iter().filter(|(_, s)| style_words(&name_key(s)).as_ref() == Some(&wanted)).map(|&(f, _)| f).collect();
            if !same.is_empty() {
                return (Some(How::FamilyStyle), dedup(same), vec![]);
            }
            let variable: Vec<usize> = family.faces().into_iter().filter(|&f| self.lib.faces[f].variable).collect();
            if !variable.is_empty() {
                // The variable fonts with the slant asked for; any of them if none has it (one
                // file can hold both, on an axis).
                let italic = wanted.contains(&"italic");
                let slanted: Vec<usize> = variable.iter().copied().filter(|&f| self.lib.faces[f].italic == italic).collect();
                return (Some(How::NamedStyle), if slanted.is_empty() { variable } else { slanted }, vec![]);
            }
        }
        let near = if near { self.near_misses(&key, &starts) } else { vec![] };
        (None, vec![], near)
    }

    /// Families whose name `key` starts with (and goes on past), longest first, with the rest of
    /// `key`. The library's families before older family names of the same length.
    fn families_at_start<'a>(&'a self, key: &'a str) -> Vec<(&'a FamilyNames, &'a str)> {
        let mut out = Vec::new();
        let ends: Vec<usize> = key.char_indices().map(|(i, _)| i).skip(1).collect();
        for &end in ends.iter().rev() {
            let (head, rest) = key.split_at(end);
            for map in [&self.families, &self.older_families] {
                if let Some(family) = map.get(head) {
                    out.push((family, rest));
                }
            }
        }
        out
    }

    /// The closest names to a line that matched nothing. With a family at its start: that
    /// family's styles, closest first. Otherwise families spelt nearly the same as its start,
    /// or that start with it.
    fn near_misses(&self, key: &str, starts: &[(&FamilyNames, &str)]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let push = |name: String, out: &mut Vec<String>| {
            if out.len() < NEAR_MISSES && !out.contains(&name) {
                out.push(name);
            }
        };
        if let Some((family, rest)) = starts.first() {
            let rest: Vec<char> = rest.chars().collect();
            let mut styles: Vec<(usize, String)> = family
                .styles
                .iter()
                .map(|(_, s)| (distance(&rest, &name_key(s).chars().collect::<Vec<_>>()), format!("{} {}", family.name, s.trim())))
                .collect();
            styles.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
            for (_, name) in styles {
                push(name, &mut out);
            }
            return out;
        }
        let line: Vec<char> = key.chars().take(64).collect();
        if line.len() < 3 {
            return out;
        }
        // (typos, letters more or fewer, name)
        let mut found: Vec<(usize, usize, &str)> = Vec::new();
        for (family_key, family) in self.families.iter().chain(self.older_families.iter()) {
            let fk: Vec<char> = family_key.chars().collect();
            if fk.starts_with(&line) {
                found.push((1, fk.len() - line.len(), &family.name));
                continue;
            }
            let allowed = typos_allowed(fk.len());
            if allowed == 0 || fk.len() > line.len() + allowed {
                continue;
            }
            // Only the line's first letters can be that close: compare with those alone.
            let start = &line[..line.len().min(fk.len() + allowed)];
            if let Some(d) = distance_to_start(&fk, start, allowed) {
                found.push((d, line.len().abs_diff(fk.len()), &family.name));
            }
        }
        found.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)).then_with(|| a.2.cmp(b.2)));
        for (_, _, name) in found {
            push(name.to_string(), &mut out);
        }
        out
    }

    fn is_usable(&self, face: usize) -> bool {
        !self.usable[face].is_empty()
    }

    fn lookup(&self, map: &HashMap<String, Vec<usize>>, key: &str) -> Option<Vec<usize>> {
        map.get(key).map(|faces| faces.iter().copied().filter(|&f| self.is_usable(f)).collect::<Vec<_>>()).filter(|f| !f.is_empty())
    }

    /// The styles as the caller sees them: usable copies only, by family and style name.
    fn describe(&self, faces: Vec<usize>, online_only: &impl Fn(&str) -> bool) -> Vec<FoundFace> {
        let mut out: Vec<FoundFace> = faces
            .into_iter()
            .filter(|&f| self.is_usable(f))
            .map(|f| {
                let face = &self.lib.faces[f];
                let files: Vec<_> = self.usable[f].iter().map(|&c| &face.files[c]).collect();
                let installed = files.iter().any(|c| c.installed);
                FoundFace {
                    key: face.key.clone(),
                    family: face.family.clone(),
                    style: face.style.clone(),
                    postscript_name: face.postscript_name.clone(),
                    ids: files.iter().map(|c| c.id).collect(),
                    variable: face.variable,
                    italic: face.italic,
                    installed,
                    online_only: !installed && files.iter().all(|c| online_only(&c.path)),
                }
            })
            .collect();
        out.sort_by(|a, b| {
            a.family
                .to_lowercase()
                .cmp(&b.family.to_lowercase())
                .then(a.italic.cmp(&b.italic))
                .then_with(|| a.style.to_lowercase().cmp(&b.style.to_lowercase()))
                .then_with(|| a.key.cmp(&b.key))
        });
        out
    }
}

/// Each face once, in the order first seen.
fn dedup(faces: Vec<usize>) -> Vec<usize> {
    let mut seen = HashSet::new();
    faces.into_iter().filter(|f| seen.insert(*f)).collect()
}

// --------------------------------------------------------------------------------- command

/// True for an online-only cloud placeholder. Looks at the file's details only, which never
/// downloads it.
fn is_online_only(path: &str) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| crate::cloud::is_dataless(&m))
}

/// "Turn on fonts from a list…" and anything else with names to find: each line's styles, in the
/// order given. Holds the database only while it reads the library.
#[tauri::command(async)]
pub fn match_font_names(state: State<'_, AppState>, lines: Vec<NameLine>) -> AppResult<Vec<LineMatch>> {
    if lines.len() > MAX_LINES {
        return Err(AppError::Invalid(format!(
            "That's {} names. Fontface looks up at most {} at a time.",
            lines.len(),
            MAX_LINES
        )));
    }
    let index = NameIndex::load(&*state.conn()?)?;
    Ok(index.match_lines(&lines, is_online_only))
}
