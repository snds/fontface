//! The OpenType features a face really has: the feature lists of its `GSUB` (substitution) and
//! `GPOS` (positioning) tables, with the font's own names for stylistic sets and character
//! variants (their feature parameters point into the `name` table), the scripts and languages
//! the tables are written for, and a short sample of the characters each substitution changes.
//!
//! The feature and script lists are read from the raw tables here (ttf-parser skips feature
//! parameters); the samples follow each feature's lookups through ttf-parser. Every count is
//! capped, so a damaged table can't make this slow.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde::Serialize;
use ttf_parser::{
    gsub::SubstitutionSubtable,
    opentype_layout::{Coverage, LayoutTable},
    Face, GlyphId,
};

use crate::tags::named_styles::{be16, name_string};

/// At most this many feature records and scripts are read from one table.
const MAX_RECORDS: usize = 2048;
/// At most this many lookups per feature are kept (from each record, and for each tag once a
/// table's records are merged) and followed for its sample.
pub const MAX_LOOKUPS: usize = 16;
/// At most this many subtables per lookup are looked at for a sample. Real fonts split a big
/// lookup into a few dozen at most (SF India's need more than 32).
const MAX_SUBTABLES: usize = 64;
/// At most this many covered glyphs per subtable are looked at for a sample.
const MAX_COVERED: usize = 400;
/// At most this many glyphs in all are looked at for one feature's sample, however its lookups
/// are built. Far more than any real font's features need.
const MAX_GLYPHS: usize = 200_000;
/// A ligature of more glyphs than this isn't a sample anyone could read: left out.
const MAX_COMPONENTS: u16 = 15;
/// At most this many ligatures are collected to choose a sample from.
const MAX_LIGATURES: usize = SAMPLE_ITEMS * 4;
/// A sample shows at most this many characters (or ligatures).
pub const SAMPLE_ITEMS: usize = 10;
/// At most this many code points are mapped back to glyphs for samples.
const MAX_CODEPOINTS: usize = 200_000;

/// One feature of the face.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Feature {
    /// The four-letter tag, such as "liga" or "ss01".
    pub tag: String,
    /// The font's own name for it (stylistic sets and character variants), if it gives one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Characters it changes, space-separated ("a g y", "fi fl"), when that can be worked out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample: Option<String>,
    /// In the substitution table (`GSUB`), the positioning table (`GPOS`), or both.
    pub gsub: bool,
    pub gpos: bool,
}

/// A script the tables are written for, with the languages they treat specially.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Script {
    /// The OpenType script tag, trimmed ("latn", "cyrl", "dev2").
    pub tag: String,
    /// OpenType language tags, trimmed ("TRK", "ROM").
    pub languages: Vec<String>,
}

/// A feature record as read from one table.
#[derive(Debug, Clone, PartialEq)]
pub struct RawFeature {
    pub tag: [u8; 4],
    /// Where its parameters start in the table, if it has any.
    pub params: Option<usize>,
    /// Its first `MAX_LOOKUPS` lookup indexes: only those are ever followed.
    pub lookups: Vec<u16>,
}

/// A table's feature records (in order, repeats kept) and its scripts.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RawLayout {
    pub features: Vec<RawFeature>,
    pub scripts: Vec<([u8; 4], Vec<[u8; 4]>)>,
}

fn tag_at(t: &[u8], at: usize) -> Option<[u8; 4]> {
    t.get(at..at + 4).map(|b| [b[0], b[1], b[2], b[3]])
}

/// Printable ASCII, as tags must be. A tag with anything else is damage, and is skipped.
pub fn valid_tag(tag: &[u8; 4]) -> bool {
    tag.iter().all(|b| (0x20..=0x7E).contains(b)) && tag[0] != b' ' && !tag.contains(&b'"') && !tag.contains(&b'\\')
}

fn tag_text(tag: &[u8; 4]) -> String {
    String::from_utf8_lossy(tag).trim_end().to_string()
}

/// Reads the feature list and the script list of a `GSUB` or `GPOS` table. None if the table
/// isn't one (wrong version, or offsets past its end).
pub fn read_layout(t: &[u8]) -> Option<RawLayout> {
    if be16(t, 0)? != 1 {
        return None;
    }
    let script_list = be16(t, 4)? as usize;
    let feature_list = be16(t, 6)? as usize;
    let mut out = RawLayout::default();
    if feature_list != 0 {
        let count = (be16(t, feature_list)? as usize).min(MAX_RECORDS);
        for i in 0..count {
            let rec = feature_list + 2 + i * 6;
            let (Some(tag), Some(offset)) = (tag_at(t, rec), be16(t, rec + 4)) else { break };
            let at = feature_list + offset as usize;
            let (Some(params), Some(n)) = (be16(t, at), be16(t, at + 2)) else { continue };
            let lookups = (0..(n as usize).min(MAX_LOOKUPS)).filter_map(|k| be16(t, at + 4 + 2 * k)).collect();
            out.features.push(RawFeature { tag, params: (params != 0).then_some(at + params as usize), lookups });
        }
    }
    if script_list != 0 {
        let count = (be16(t, script_list)? as usize).min(MAX_RECORDS);
        for i in 0..count {
            let rec = script_list + 2 + i * 6;
            let (Some(tag), Some(offset)) = (tag_at(t, rec), be16(t, rec + 4)) else { break };
            let at = script_list + offset as usize;
            let n = be16(t, at + 2).unwrap_or(0) as usize;
            let languages = (0..n.min(MAX_RECORDS)).filter_map(|k| tag_at(t, at + 4 + 6 * k)).collect();
            out.scripts.push((tag, languages));
        }
    }
    Some(out)
}

/// A stylistic set's name: its parameters' UI name id, looked up in `name`.
fn set_name(t: &[u8], params: usize, name: &[u8]) -> Option<String> {
    if be16(t, params)? != 0 {
        return None;
    }
    named(name, be16(t, params + 2)?)
}

/// A character variant's parameters: its label (from `name`) and the characters it changes.
fn variant_params(t: &[u8], params: usize, name: &[u8]) -> (Option<String>, Vec<char>) {
    let read = || -> Option<(Option<String>, Vec<char>)> {
        if be16(t, params)? != 0 {
            return None;
        }
        let label = named(name, be16(t, params + 2)?);
        let count = be16(t, params + 12)? as usize;
        let chars = (0..count.min(SAMPLE_ITEMS * 4))
            .filter_map(|k| {
                let at = params + 14 + 3 * k;
                let b = t.get(at..at + 3)?;
                char::from_u32(u32::from_be_bytes([0, b[0], b[1], b[2]]))
            })
            .collect();
        Some((label, chars))
    };
    read().unwrap_or_default()
}

/// A name id from feature parameters, if the font has that name: ids under 256 are reserved for
/// the font's own names (family, style…), never a feature's.
fn named(name: &[u8], id: u16) -> Option<String> {
    if !(256..=32767).contains(&id) {
        return None;
    }
    name_string(name, id).map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && s.chars().count() <= 200)
}

fn is_set(tag: &[u8; 4]) -> bool {
    tag[0] == b's' && tag[1] == b's' && tag[2].is_ascii_digit() && tag[3].is_ascii_digit()
}

fn is_variant(tag: &[u8; 4]) -> bool {
    tag[0] == b'c' && tag[1] == b'v' && tag[2].is_ascii_digit() && tag[3].is_ascii_digit()
}

/// Features that aren't switched on and off: `size` only carries the font's optical size range.
fn listed(tag: &[u8; 4]) -> bool {
    valid_tag(tag) && tag != b"size"
}

/// The face's features from both tables, each tag once, sorted by tag; and its scripts.
/// `name` is the raw `name` table (empty when the font has none).
pub fn features(face: &Face, name: &[u8]) -> (Vec<Feature>, Vec<Script>) {
    let raw = |tag: &[u8; 4]| face.raw_face().table(ttf_parser::Tag::from_bytes(tag));
    let gsub_bytes = raw(b"GSUB");
    let gpos_bytes = raw(b"GPOS");
    let gsub = gsub_bytes.and_then(read_layout).unwrap_or_default();
    let gpos = gpos_bytes.and_then(read_layout).unwrap_or_default();
    let glyph_chars = std::cell::OnceCell::new();

    let mut by_tag: HashMap<[u8; 4], Feature> = HashMap::new();
    let mut lookups: HashMap<[u8; 4], Vec<u16>> = HashMap::new();
    let mut variant_chars: HashMap<[u8; 4], Vec<char>> = HashMap::new();
    // Each tag's parameters are read once per table: a table that repeats a record for every
    // script (or a damaged one that repeats it thousands of times) doesn't look its name up again.
    let mut named_in: HashSet<([u8; 4], bool)> = HashSet::new();
    for (table, bytes, from_gsub) in [(&gsub, gsub_bytes, true), (&gpos, gpos_bytes, false)] {
        let Some(bytes) = bytes else { continue };
        for f in table.features.iter().filter(|f| listed(&f.tag)) {
            let entry = by_tag.entry(f.tag).or_insert_with(|| Feature { tag: tag_text(&f.tag), name: None, sample: None, gsub: false, gpos: false });
            if from_gsub {
                entry.gsub = true;
                // The first MAX_LOOKUPS distinct ones: only those are followed.
                let list = lookups.entry(f.tag).or_default();
                for l in &f.lookups {
                    if list.len() >= MAX_LOOKUPS {
                        break;
                    }
                    if !list.contains(l) {
                        list.push(*l);
                    }
                }
            } else {
                entry.gpos = true;
            }
            let Some(params) = f.params else { continue };
            if entry.name.is_some() || !named_in.insert((f.tag, from_gsub)) {
                continue;
            }
            if is_set(&f.tag) {
                entry.name = set_name(bytes, params, name);
            } else if is_variant(&f.tag) {
                let (label, chars) = variant_params(bytes, params, name);
                entry.name = label;
                if !chars.is_empty() {
                    variant_chars.entry(f.tag).or_insert(chars);
                }
            }
        }
    }

    let table = face.tables().gsub;
    for (tag, feature) in by_tag.iter_mut() {
        if let Some(chars) = variant_chars.get(tag) {
            feature.sample = sample_of_chars(chars.iter().copied());
        } else if let (Some(table), Some(list)) = (table, lookups.get(tag)) {
            feature.sample = lookup_sample(&table, list, glyph_chars.get_or_init(|| reverse_cmap(face)));
        }
    }
    let mut features: Vec<Feature> = by_tag.into_values().collect();
    features.sort_by(|a, b| a.tag.cmp(&b.tag));

    let mut scripts: Vec<Script> = Vec::new();
    for (tag, languages) in gsub.scripts.iter().chain(gpos.scripts.iter()) {
        if !valid_tag(tag) || tag == b"DFLT" {
            continue;
        }
        let tag = tag_text(tag);
        let at = match scripts.iter().position(|s| s.tag == tag) {
            Some(i) => i,
            None => {
                scripts.push(Script { tag, languages: Vec::new() });
                scripts.len() - 1
            }
        };
        for l in languages.iter().filter(|l| valid_tag(l)) {
            let l = tag_text(l);
            if !scripts[at].languages.contains(&l) {
                scripts[at].languages.push(l);
            }
        }
    }
    (features, scripts)
}

/// Each glyph's character, from the face's Unicode character maps (the lowest code point when
/// several map to one glyph; letters and digits win over anything else).
fn reverse_cmap(face: &Face) -> HashMap<u16, char> {
    let mut map: HashMap<u16, char> = HashMap::new();
    let Some(cmap) = face.tables().cmap else { return map };
    let mut seen = 0usize;
    for st in cmap.subtables.into_iter().filter(|st| st.is_unicode()) {
        st.codepoints(|cp| {
            seen += 1;
            if seen > MAX_CODEPOINTS {
                return;
            }
            let (Some(c), Some(g)) = (char::from_u32(cp), st.glyph_index(cp)) else { return };
            if g.0 == 0 || c.is_control() || c.is_whitespace() || (0xE000..=0xF8FF).contains(&cp) || cp >= 0xF0000 {
                return;
            }
            map.entry(g.0)
                .and_modify(|old| {
                    let better = |x: char| x.is_alphanumeric();
                    if (better(c) && !better(*old)) || (better(c) == better(*old) && c < *old) {
                        *old = c;
                    }
                })
                .or_insert(c);
        });
    }
    map
}

fn covered(coverage: &Coverage, limit: usize) -> Vec<GlyphId> {
    let mut out = Vec::new();
    match coverage {
        Coverage::Format1 { glyphs } => out.extend((*glyphs).into_iter().take(limit)),
        Coverage::Format2 { records } => {
            for r in (*records).into_iter() {
                for g in r.start.0..=r.end.0 {
                    if out.len() >= limit {
                        return out;
                    }
                    out.push(GlyphId(g));
                }
            }
        }
    }
    out
}

/// Combining marks (which draw on the character before them) and private-use characters (which
/// mean nothing outside the font) make poor samples on their own.
fn shows_alone(c: char) -> bool {
    let cp = c as u32;
    let mark = matches!(cp, 0x0300..=0x036F | 0x0483..=0x0489 | 0x0591..=0x05BD | 0x0610..=0x061A | 0x064B..=0x065F
        | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F);
    let private = matches!(cp, 0xE000..=0xF8FF | 0xF0000..=0x10FFFF);
    !c.is_control() && !c.is_whitespace() && !mark && !private
}

/// The best `SAMPLE_ITEMS` distinct characters offered so far: letters first, then digits, then
/// the rest, each group in code point order. It keeps only those, however many it's offered.
#[derive(Default)]
struct BestChars(BTreeSet<(u8, char)>);

impl BestChars {
    fn offer(&mut self, c: char) {
        if !shows_alone(c) {
            return;
        }
        self.0.insert((if c.is_alphabetic() { 0 } else if c.is_numeric() { 1 } else { 2 }, c));
        if self.0.len() > SAMPLE_ITEMS {
            self.0.pop_last();
        }
    }

    /// Joined by spaces, or None if there are none.
    fn sample(self) -> Option<String> {
        (!self.0.is_empty()).then(|| self.0.into_iter().map(|(_, c)| c.to_string()).collect::<Vec<_>>().join(" "))
    }
}

/// Up to `SAMPLE_ITEMS` distinct characters (`BestChars`), joined by spaces.
fn sample_of_chars(chars: impl Iterator<Item = char>) -> Option<String> {
    let mut best = BestChars::default();
    chars.for_each(|c| best.offer(c));
    best.sample()
}

/// What a substitution feature changes: the ligatures it forms ("fi fl ffi"), else the
/// characters its lookups cover. Every loop is capped (`MAX_LOOKUPS` lookups, `MAX_SUBTABLES`
/// subtables each, `MAX_GLYPHS` glyphs in all), and only the best characters so far are kept,
/// so a damaged or crafted table can't make this slow or big.
fn lookup_sample(table: &LayoutTable, lookups: &[u16], chars: &HashMap<u16, char>) -> Option<String> {
    let mut ligatures: Vec<String> = Vec::new();
    let mut singles = BestChars::default();
    let mut budget = MAX_GLYPHS;
    'lookups: for &index in lookups.iter().take(MAX_LOOKUPS) {
        let Some(lookup) = table.lookups.get(index) else { continue };
        for subtable in lookup.subtables.into_iter::<SubstitutionSubtable>().take(MAX_SUBTABLES) {
            if budget == 0 {
                break 'lookups;
            }
            match subtable {
                SubstitutionSubtable::Ligature(lig) => {
                    if ligatures.len() >= MAX_LIGATURES {
                        continue;
                    }
                    let firsts = covered(&lig.coverage, MAX_COVERED);
                    budget = budget.saturating_sub(firsts.len());
                    'sets: for (i, set) in lig.ligature_sets.into_iter().enumerate().take(MAX_COVERED) {
                        let Some(first) = firsts.get(i).and_then(|g| chars.get(&g.0)) else { continue };
                        for l in set.into_iter().take(8) {
                            if budget == 0 {
                                break 'sets;
                            }
                            if l.components.len() > MAX_COMPONENTS {
                                continue;
                            }
                            budget = budget.saturating_sub(l.components.len() as usize);
                            let rest: Option<String> = l.components.into_iter().map(|g| chars.get(&g.0).copied()).collect();
                            if let Some(rest) = rest {
                                let text = format!("{first}{rest}");
                                if !ligatures.contains(&text) {
                                    ligatures.push(text);
                                    if ligatures.len() >= MAX_LIGATURES {
                                        break 'sets;
                                    }
                                }
                            }
                        }
                    }
                }
                other => {
                    let glyphs = covered(&other.coverage(), MAX_COVERED.min(budget));
                    budget -= glyphs.len();
                    glyphs.iter().filter_map(|g| chars.get(&g.0)).for_each(|&c| singles.offer(c));
                }
            }
        }
    }
    if !ligatures.is_empty() {
        // Letter ligatures first ("fi" before "--"), then shorter ones.
        ligatures.sort_by_key(|l| (!l.chars().all(char::is_alphabetic), l.chars().count(), l.clone()));
        ligatures.truncate(SAMPLE_ITEMS);
        return Some(ligatures.join(" "));
    }
    singles.sample()
}
