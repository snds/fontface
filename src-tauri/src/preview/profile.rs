//! The preview profile: what the library list draws for a face so the preview shows the font's
//! own glyphs, never the system font standing in for missing characters.
//!
//! Each string (the family name for family rows, the full name for style rows) goes through:
//! 1. **The name as is**, if every character is a real glyph.
//! 2. **Trimmed:** missing ™ ® © ℠ ℗ dropped, missing `-` and `_` turned into spaces.
//! 3. **Case change:** UPPER, then lower. Skipped for icon fonts (an icon word in the name),
//!    whose letter keys hold pictures.
//! 4. **Name ID 19**, the font's own sample text, when it's all real glyphs.
//! 5. **A sample of the font's real characters** (see `sample`).
//!
//! Expert sets and symbol-only fonts go straight to step 5.

use std::{cell::OnceCell, collections::{BTreeMap, HashSet}};

use ttf_parser::{Face, GlyphId};

use super::{
    font::{FontView, Lookup},
    unicode,
};

/// What a preview draws.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// The name, as is.
    Name,
    /// The name without missing ™ ® ©, or with spaces for missing `-` `_`.
    Trim,
    /// The name in UPPER or lower case.
    Case,
    /// The font's own sample text (name ID 19).
    Sample19,
    /// A run of letters from the font's script (Arabic, Hebrew, Han …).
    Script,
    /// Symbols or icons.
    Symbols,
    /// The real characters of an Expert set.
    Expert,
    /// Letters and digits of a font that only has some of them.
    Partial,
    /// Nothing real to draw: the name falls back to the system font.
    None,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Name => "name",
            Kind::Trim => "trim",
            Kind::Case => "case",
            Kind::Sample19 => "sample19",
            Kind::Script => "script",
            Kind::Symbols => "symbols",
            Kind::Expert => "expert",
            Kind::Partial => "partial",
            Kind::None => "none",
        }
    }

    /// Draws a sample of characters instead of the name.
    pub fn is_sample(self) -> bool {
        matches!(self, Kind::Script | Kind::Symbols | Kind::Expert | Kind::Partial)
    }
}

/// Why a face got its profile; stored as bits in `face_previews.flags`, for tests and debugging.
pub mod flags {
    pub const PLACEHOLDER: u32 = 1;
    pub const EMPTY_LETTERS: u32 = 2;
    pub const EXPERT_GLYPH_NAMES: u32 = 4;
    pub const SYMBOL_CMAP: u32 = 8;
    pub const MAC_ROMAN_ONLY: u32 = 16;
    pub const EXPERT_NAME: u32 = 32;
    pub const ICON_WORD: u32 = 64;
    pub const EXPERT: u32 = 128;
}

/// The names a profile is worked out from.
#[derive(Clone, Copy, Debug, Default)]
pub struct Names<'s> {
    pub family: &'s str,
    pub subfamily: &'s str,
    /// The full name; empty means "<family> <subfamily>", as the list shows it.
    pub full: &'s str,
    pub postscript: &'s str,
    /// The file name without its extension: some Expert sets say so only there ("…_Exp").
    pub file_stem: &'s str,
}

impl Names<'_> {
    pub fn full_or_default(&self) -> String {
        if self.full.trim().is_empty() {
            format!("{} {}", self.family, self.subfamily)
        } else {
            self.full.to_string()
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    pub kind: Kind,
    /// What a family row draws; None = the family name as is.
    pub family_text: Option<String>,
    /// What a style row draws; None = the full name as is.
    pub full_text: Option<String>,
    /// The sample of real characters, when one was needed.
    pub sample: Option<String>,
    /// A short label for sample kinds: "Symbols", "Expert set", a script name, "Partial set".
    pub label: Option<String>,
    /// Printable ASCII characters the face can't draw.
    pub ascii_missing: String,
    pub flags: u32,
    /// Line ascent and descent in em (descent positive below the baseline).
    pub ascent: f32,
    pub descent: f32,
    /// The ink of the family and full preview texts together, in em: top above the baseline,
    /// bottom below it (positive down). None when nothing in them has an outline.
    pub ink: Option<(f32, f32)>,
}

/// Words in a name that mark an icon or symbol font, whose letter keys hold pictures.
const ICON_WORDS: &[&str] = &[
    "glyph", "glyphs", "icon", "icons", "symbol", "symbols", "dingbat", "dingbats", "ornament", "ornaments", "pi", "bats",
    "emoji", "border", "borders", "frame", "frames", "fleuron", "fleurons", "flourish", "flourishes", "awesome",
    "wingdings", "webdings", "pictogram", "pictograms", "pictos", "icomoon", "entypo", "fontawesome",
];

/// Splits a name into lowercase words: at punctuation and spaces, lower→Upper changes, between
/// an acronym and the next word ("SCExpert" → sc, expert) and between letters and digits.
pub fn tokens(s: &str) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = vec![];
    let mut cur = String::new();
    for (i, &c) in chars.iter().enumerate() {
        let prev = i.checked_sub(1).map(|p| chars[p]);
        let next_lower = chars.get(i + 1).is_some_and(|n| n.is_lowercase());
        let boundary = !c.is_alphanumeric()
            || prev.is_some_and(|p| {
                (p.is_lowercase() && c.is_uppercase())
                    || (p.is_uppercase() && c.is_uppercase() && next_lower)
                    || (p.is_alphabetic() != c.is_alphabetic())
            });
        if boundary && !cur.is_empty() {
            out.push(cur.to_lowercase());
            cur.clear();
        }
        if c.is_alphanumeric() {
            cur.push(c);
        }
    }
    if !cur.is_empty() {
        out.push(cur.to_lowercase());
    }
    out
}

/// "expert", "exp", "ep", or "exp" plus sc, cn, it, ita, italic or scitalic.
fn expert_token(t: &str) -> bool {
    matches!(t, "expert" | "exp" | "ep")
        || t.strip_prefix("exp").is_some_and(|rest| matches!(rest, "sc" | "cn" | "it" | "ita" | "italic" | "scitalic"))
}

/// An old Expert-set glyph name (small caps, old-style figures, superiors, fractions,
/// f-ligatures). Names with a "." are modern alternates (`zero.oldstyle`) and don't count.
fn expert_glyph_name(n: &str) -> bool {
    !n.contains('.')
        && (n.ends_with("small")
            || n.ends_with("oldstyle")
            || n.ends_with("superior")
            || n.ends_with("inferior")
            || matches!(
                n,
                "ff" | "fi" | "fl" | "ffi" | "ffl" | "onequarter" | "onehalf" | "threequarters" | "onethird" | "twothirds"
                    | "oneeighth" | "threeeighths" | "fiveeighths" | "seveneighths" | "figuredash" | "colonmonetary" | "rupiah"
            ))
}

/// The signals behind the Expert decision, kept for the character grid's summary too.
pub struct Expertise {
    pub expert: bool,
    pub flags: u32,
    pub icon_word: bool,
}

/// Is this face an Expert set (or a similar custom-encoded companion font)?
/// - Its names say so ("Expert", "Exp", "AltExp" …) and it has an anomaly (a placeholder shape,
///   empty letter slots, Expert glyph names) or can't draw its family name; or
/// - at least 10 letter slots carry old Expert glyph names.
pub fn expertise(f: &FontView, names: &Names) -> Expertise {
    let mut flags = 0;
    let (mut empty_letters, mut expert_named) = (0, 0);
    for c in ('A'..='Z').chain('a'..='z').chain('0'..='9') {
        if let Some(g) = f.glyph(c as u32) {
            if !f.inked(g) {
                empty_letters += 1;
            }
            if c.is_alphabetic() && f.face.glyph_name(g).is_some_and(expert_glyph_name) {
                expert_named += 1;
            }
        }
    }
    if f.placeholder.is_some() {
        flags |= flags::PLACEHOLDER;
    }
    if empty_letters >= 10 {
        flags |= flags::EMPTY_LETTERS;
    }
    if expert_named >= 5 {
        flags |= flags::EXPERT_GLYPH_NAMES;
    }
    match f.lookup {
        Lookup::Symbol => flags |= flags::SYMBOL_CMAP,
        Lookup::MacRoman => flags |= flags::MAC_ROMAN_ONLY,
        _ => {}
    }
    let anomaly = flags & (flags::PLACEHOLDER | flags::EMPTY_LETTERS | flags::EXPERT_GLYPH_NAMES) != 0;
    let words: Vec<String> = [names.family, names.full, names.subfamily, names.postscript, names.file_stem]
        .iter()
        .flat_map(|s| tokens(s))
        .collect();
    let expert_name = words.iter().any(|t| expert_token(t));
    let icon_word = words.iter().any(|t| ICON_WORDS.contains(&t.as_str()));
    if expert_name {
        flags |= flags::EXPERT_NAME;
    }
    if icon_word {
        flags |= flags::ICON_WORD;
    }
    let expert = (expert_name && (anomaly || !f.draws(names.family))) || expert_named >= 10;
    if expert {
        flags |= flags::EXPERT;
    }
    Expertise { expert, flags, icon_word }
}

/// The profile of a parsed face.
pub fn profile(face: &Face, names: &Names) -> Profile {
    let f = FontView::new(face);
    profile_of(&f, names)
}

pub fn profile_of(f: &FontView, names: &Names) -> Profile {
    let Expertise { expert, flags, icon_word } = expertise(f, names);
    let force_sample = expert || f.lookup == Lookup::Symbol;
    let full = names.full_or_default();

    // Worked out only when a name fails, which most faces never do.
    let sample_cell: OnceCell<Option<Sample>> = OnceCell::new();
    let sample = || sample_cell.get_or_init(|| make_sample(f, expert, icon_word)).as_ref();
    let id19_cell = OnceCell::new();
    let id19 = || id19_cell.get_or_init(|| sample_text(f)).clone();

    let choose = |text: &str| -> (Kind, Option<String>) {
        if !force_sample {
            if f.draws(text) {
                return (Kind::Name, None);
            }
            let t = trimmed(f, text);
            if f.draws(&t) {
                return (Kind::Trim, Some(t));
            }
            if !icon_word {
                for v in [t.to_uppercase(), t.to_lowercase()] {
                    if f.draws(&v) {
                        return (Kind::Case, Some(v));
                    }
                }
            }
            if let Some(s) = id19() {
                return (Kind::Sample19, Some(s));
            }
        }
        match sample() {
            Some(s) => (s.kind, Some(s.text.clone())),
            None => (Kind::None, None),
        }
    };
    let (kind, family_text) = choose(names.family);
    let (_, full_text) = choose(&full);
    let label = if kind.is_sample() { sample().map(|s| s.label.clone()) } else { None };
    let ascii_missing: String = (0x21u8..0x7F).map(char::from).filter(|c| !f.real_char(*c)).collect();
    let (ascent, descent) = f.line_metrics();
    let shown_family = family_text.as_deref().unwrap_or(names.family);
    let shown_full = full_text.as_deref().unwrap_or(&full);
    let ink = match (f.text_extent(shown_family), f.text_extent(shown_full)) {
        (Some(a), Some(b)) => Some((a.0.max(b.0), a.1.max(b.1))),
        (a, b) => a.or(b),
    };
    Profile {
        kind,
        family_text,
        full_text,
        sample: sample_cell.get().and_then(|s| s.as_ref().map(|s| s.text.clone())),
        label,
        ascii_missing,
        flags,
        ascent,
        descent,
        ink,
    }
}

/// Drops missing ™ ® © ℠ ℗ and turns missing `-` `_` into spaces.
fn trimmed(f: &FontView, s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if f.real_char(c) || c.is_whitespace() {
            out.push(c);
            continue;
        }
        match c {
            '™' | '®' | '©' | '℠' | '℗' => {}
            '-' | '_' => out.push(' '),
            _ => out.push(c),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Name ID 19 when it's usable: all real glyphs, 3–400 non-space characters, a letter or digit
/// among them. Cut to 64 characters.
fn sample_text(f: &FontView) -> Option<String> {
    let s = crate::scanner::name_string(f.face, 19)?;
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let n = s.chars().filter(|c| !c.is_whitespace()).count();
    if !(3..=400).contains(&n) || !s.chars().any(char::is_alphanumeric) || !f.draws(&s) {
        return None;
    }
    Some(s.chars().take(64).collect::<String>().trim_end().to_string())
}

// ---------------------------------------------------------------------------------- samples

/// Where a character belongs, for choosing a sample.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Group {
    Latin,
    Digit,
    Punct,
    Pua,
    Symbol,
    /// A script, by a short key such as "Arabic" or "Han".
    Script(&'static str),
}

fn in_ranges(table: &[(u32, u32)], cp: u32) -> bool {
    table
        .binary_search_by(|(a, b)| {
            if cp < *a {
                std::cmp::Ordering::Greater
            } else if cp > *b {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// Left out of samples: marks, controls, format characters, spaces, surrogates, variation
/// selectors, noncharacters.
pub fn skipped(cp: u32) -> bool {
    in_ranges(unicode::SKIP, cp)
}

/// Never shown in the character grid: everything `skipped` leaves out except marks.
pub fn invisible(cp: u32) -> bool {
    in_ranges(unicode::INVISIBLE, cp)
}

/// The Unicode block a code point is in, or "No Block".
pub fn block(cp: u32) -> &'static str {
    let t = unicode::BLOCKS;
    match t.binary_search_by(|(a, b, _)| {
        if cp < *a {
            std::cmp::Ordering::Greater
        } else if cp > *b {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Equal
        }
    }) {
        Ok(i) => t[i].2,
        Err(_) => "No Block",
    }
}

const PUNCT_BLOCKS: &[&str] =
    &["General Punctuation", "Currency Symbols", "Number Forms", "Superscripts and Subscripts", "Spacing Modifier Letters"];
const SYMBOL_WORDS: &[&str] = &[
    "Arrows", "Mathematical", "Technical", "Control Pictures", "Optical", "Enclosed", "Box Drawing", "Block Elements",
    "Geometric", "Symbols", "Dingbats", "Braille", "Musical", "Tiles", "Cards", "Emoticons", "Pictographs", "Alchemical",
    "Chess", "Letterlike", "Hexagram", "Tai Xuan", "Specials", "Halfwidth and Fullwidth", "Small Form", "Vertical Forms",
    "Phaistos", "Legacy Computing", "Ancient",
];

pub fn group(cp: u32) -> Group {
    let b = block(cp);
    if b == "Basic Latin" || b == "Latin-1 Supplement" {
        let c = char::from_u32(cp).unwrap_or(' ');
        return if c.is_alphabetic() {
            Group::Latin
        } else if c.is_ascii_digit() {
            Group::Digit
        } else {
            Group::Punct
        };
    }
    if b == "Alphabetic Presentation Forms" {
        return match cp {
            0xFB13..=0xFB17 => Group::Script("Armenian"),
            0xFB1D..=0xFB4F => Group::Script("Hebrew"),
            _ => Group::Latin,
        };
    }
    if b.starts_with("Latin") || b == "IPA Extensions" || b.starts_with("Phonetic Extensions") {
        return Group::Latin;
    }
    if matches!(b, "Private Use Area" | "Supplementary Private Use Area-A" | "Supplementary Private Use Area-B") {
        return Group::Pua;
    }
    if PUNCT_BLOCKS.contains(&b) || b == "Supplemental Punctuation" {
        return Group::Punct;
    }
    if SYMBOL_WORDS.iter().any(|w| b.contains(w)) && !b.starts_with("CJK Symbols") {
        return Group::Symbol;
    }
    Group::Script(if b.starts_with("CJK") || b.starts_with("Kangxi") || b.starts_with("Ideographic") || b.starts_with("Bopomofo") {
        "Han"
    } else if b.starts_with("Hangul") {
        "Hangul"
    } else if b == "Hiragana" || b.starts_with("Katakana") || b.contains("Kana") {
        "Kana"
    } else if b.starts_with("Greek") {
        "Greek"
    } else if b.starts_with("Yi ") {
        "Yi"
    } else {
        script_of_block(b)
    })
}

/// "Arabic Presentation Forms-A" → "Arabic", "Cyrillic Extended-B" → "Cyrillic".
fn script_of_block(b: &'static str) -> &'static str {
    let mut k = b;
    for suffix in [
        " Supplement", " Extended-A", " Extended-B", " Extended-C", " Extended-D", " Extended", " Presentation Forms-A",
        " Presentation Forms-B", " Presentation Forms", " Extensions", " Extension", " Numbers", " Numerals",
    ] {
        if let Some(x) = k.strip_suffix(suffix) {
            k = x;
        }
    }
    k
}

/// An ISO 15924 script tag (from the `meta` table) as a script key.
fn script_key(tag: &str) -> Option<&'static str> {
    Some(match tag {
        "Arab" => "Arabic",
        "Hebr" => "Hebrew",
        "Deva" => "Devanagari",
        "Beng" => "Bengali",
        "Guru" => "Gurmukhi",
        "Gujr" => "Gujarati",
        "Orya" => "Oriya",
        "Taml" => "Tamil",
        "Telu" => "Telugu",
        "Knda" => "Kannada",
        "Mlym" => "Malayalam",
        "Sinh" => "Sinhala",
        "Thai" => "Thai",
        "Laoo" => "Lao",
        "Tibt" => "Tibetan",
        "Mymr" => "Myanmar",
        "Geor" => "Georgian",
        "Armn" => "Armenian",
        "Ethi" => "Ethiopic",
        "Khmr" => "Khmer",
        "Cyrl" => "Cyrillic",
        "Grek" => "Greek",
        "Syrc" => "Syriac",
        "Thaa" => "Thaana",
        "Nkoo" => "NKo",
        "Tfng" => "Tifinagh",
        "Cher" => "Cherokee",
        "Mong" => "Mongolian",
        "Copt" => "Coptic",
        "Hani" | "Hans" | "Hant" => "Han",
        "Jpan" | "Kana" | "Hira" => "Kana",
        "Kore" | "Hang" => "Hangul",
        "Yiii" => "Yi",
        _ => return None,
    })
}

/// How a script key reads as a label.
fn script_label(key: &str) -> String {
    match key {
        "Han" => "Han (CJK)".into(),
        "Kana" => "Japanese kana".into(),
        "Hangul" => "Hangul (Korean)".into(),
        other => other.to_string(),
    }
}

struct Sample {
    kind: Kind,
    text: String,
    label: String,
}

/// `n` items spread evenly across `v` (all of them if there are no more than `n`).
fn spread<T: Clone>(v: &[T], n: usize) -> Vec<T> {
    if v.len() <= n {
        return v.to_vec();
    }
    if n < 2 {
        return v.iter().take(n).cloned().collect();
    }
    (0..n).map(|i| v[(i * (v.len() - 1) + (n - 1) / 2) / (n - 1)].clone()).collect()
}

#[derive(Clone)]
struct Candidate {
    cp: u32,
    glyph: GlyphId,
    group: Group,
}

/// A run of the font's real characters, and what kind of font that makes it:
/// 1. **Expert:** 12 characters spread evenly across all of them.
/// 2. **Symbols** (symbol-only map, an icon word in the name, mostly private-use and symbol
///    characters, or no letters, digits or script at all): 12 spread evenly, preferring
///    glyphs within normal height and code points above U+00FF (which skips emoji keycap
///    digits), never regional-indicator letters.
/// 3. **Script:** the script `meta` names (5+ characters), else the biggest one (10+, and at
///    least as many as Latin letters): its first 10 letters, or 10 spread evenly across 300+.
/// 4. **Partial:** the first 12 Latin letters and digits, or 12 spread evenly when fewer than 4.
fn make_sample(f: &FontView, expert: bool, icon_word: bool) -> Option<Sample> {
    let mut seen_glyphs = HashSet::new();
    let mut seen_shapes = HashSet::new();
    let dedupe_shapes = f.map.len() <= 4000;
    let mut cands: Vec<Candidate> = vec![];
    for (&cp, &g) in &f.map {
        if skipped(cp) || cp == 0xFFFD || !f.real(g) || !seen_glyphs.insert(g.0) {
            continue;
        }
        if dedupe_shapes && !seen_shapes.insert(f.shape(g)) {
            continue;
        }
        cands.push(Candidate { cp, glyph: g, group: group(cp) });
    }
    if cands.is_empty() {
        return None;
    }
    let normal = |v: &[Candidate]| -> Vec<Candidate> {
        let ok: Vec<Candidate> = v
            .iter()
            .filter(|c| f.glyph_extent(c.glyph).is_some_and(|(top, bottom)| top <= 1.15 && bottom <= 0.35))
            .cloned()
            .collect();
        if ok.len() >= 6 {
            ok
        } else {
            v.to_vec()
        }
    };
    let text = |v: &[Candidate], sep: &str| v.iter().filter_map(|c| char::from_u32(c.cp)).map(String::from).collect::<Vec<_>>().join(sep);
    if expert {
        return Some(Sample { kind: Kind::Expert, text: text(&spread(&normal(&cands), 12), " "), label: "Expert set".into() });
    }
    let symbolish = cands.iter().filter(|c| matches!(c.group, Group::Pua | Group::Symbol)).count();
    let no_letters = !cands.iter().any(|c| matches!(c.group, Group::Latin | Group::Digit | Group::Script(_)));
    if f.lookup == Lookup::Symbol || icon_word || symbolish * 2 >= cands.len() || (no_letters && symbolish > 0) {
        let pool: Vec<Candidate> = cands.iter().filter(|c| c.cp > 0xFF && !(0x1F1E6..=0x1F1FF).contains(&c.cp)).cloned().collect();
        let pool = if pool.len() >= 6 { pool } else { cands.clone() };
        return Some(Sample { kind: Kind::Symbols, text: text(&spread(&normal(&pool), 12), " "), label: "Symbols".into() });
    }
    let mut by_script: BTreeMap<&'static str, Vec<Candidate>> = BTreeMap::new();
    for c in &cands {
        if let Group::Script(k) = c.group {
            by_script.entry(k).or_default().push(c.clone());
        }
    }
    let latin = cands.iter().filter(|c| c.group == Group::Latin).count();
    let named = f.meta_scripts().iter().filter_map(|t| script_key(t)).find(|k| by_script.get(k).is_some_and(|v| v.len() >= 5));
    let biggest = by_script.iter().max_by_key(|(_, v)| v.len()).map(|(k, v)| (*k, v.len()));
    if let Some(key) = named.or(biggest.filter(|(_, n)| *n >= 10 && *n >= latin).map(|(k, _)| k)) {
        let all = &by_script[key];
        let letters: Vec<Candidate> = all.iter().filter(|c| char::from_u32(c.cp).is_some_and(char::is_alphabetic)).cloned().collect();
        let v = if letters.len() >= 5 { &letters } else { all };
        let chosen = if v.len() >= 300 { spread(v, 10) } else { v.iter().take(10).cloned().collect() };
        return Some(Sample { kind: Kind::Script, text: text(&chosen, ""), label: script_label(key) });
    }
    let letters: Vec<Candidate> = cands.iter().filter(|c| matches!(c.group, Group::Latin | Group::Digit)).cloned().collect();
    let text = if letters.len() >= 4 {
        text(&letters.iter().take(12).cloned().collect::<Vec<_>>(), "")
    } else {
        text(&spread(&normal(&cands), 12), " ")
    };
    Some(Sample { kind: Kind::Partial, text, label: "Partial set".into() })
}
