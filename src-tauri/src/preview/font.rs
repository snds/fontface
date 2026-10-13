//! What CoreText (the macOS text engine under the web view) draws for each character of a face,
//! and how tall it is.
//!
//! **Character lookup** follows CoreText, checked against it on real fonts:
//! - A Unicode character map wins whenever the font has one.
//! - A font whose only map is Microsoft Symbol (3,0): a character is looked up as is, then at
//!   U+F000 plus the character for codes up to 0xFF. So typing "A" draws the glyph at U+F041.
//! - A font with only a Mac Roman (1,0) map: characters are converted to Mac Roman first.
//! - A font with a Symbol map and a Unicode map (Trekbats): the Unicode map only, no remap.
//!
//! **A real glyph** has a glyph id other than 0, has ink (an outline with area, or a COLR,
//! sbix, CBDT or SVG image), and isn't the placeholder shape (see `find_placeholder`).

use std::{
    cell::RefCell,
    collections::{BTreeMap, HashMap},
    hash::{Hash, Hasher},
};

use ttf_parser::{Face, GlyphId, OutlineBuilder, PlatformId, Tag};

/// Which character map CoreText uses for this face.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lookup {
    Unicode,
    Symbol,
    MacRoman,
    None,
}

impl Lookup {
    pub fn as_str(self) -> &'static str {
        match self {
            Lookup::Unicode => "unicode",
            Lookup::Symbol => "symbol",
            Lookup::MacRoman => "macRoman",
            Lookup::None => "none",
        }
    }
}

/// Mac OS Roman bytes 0x80–0xFF as Unicode (0xF0 is the Apple logo, U+F8FF).
const MAC_ROMAN_HIGH: [u16; 128] = [
    0x00C4, 0x00C5, 0x00C7, 0x00C9, 0x00D1, 0x00D6, 0x00DC, 0x00E1, 0x00E0, 0x00E2, 0x00E4, 0x00E3, 0x00E5, 0x00E7, 0x00E9, 0x00E8, //
    0x00EA, 0x00EB, 0x00ED, 0x00EC, 0x00EE, 0x00EF, 0x00F1, 0x00F3, 0x00F2, 0x00F4, 0x00F6, 0x00F5, 0x00FA, 0x00F9, 0x00FB, 0x00FC, //
    0x2020, 0x00B0, 0x00A2, 0x00A3, 0x00A7, 0x2022, 0x00B6, 0x00DF, 0x00AE, 0x00A9, 0x2122, 0x00B4, 0x00A8, 0x2260, 0x00C6, 0x00D8, //
    0x221E, 0x00B1, 0x2264, 0x2265, 0x00A5, 0x00B5, 0x2202, 0x2211, 0x220F, 0x03C0, 0x222B, 0x00AA, 0x00BA, 0x03A9, 0x00E6, 0x00F8, //
    0x00BF, 0x00A1, 0x00AC, 0x221A, 0x0192, 0x2248, 0x2206, 0x00AB, 0x00BB, 0x2026, 0x00A0, 0x00C0, 0x00C3, 0x00D5, 0x0152, 0x0153, //
    0x2013, 0x2014, 0x201C, 0x201D, 0x2018, 0x2019, 0x00F7, 0x25CA, 0x00FF, 0x0178, 0x2044, 0x20AC, 0x2039, 0x203A, 0xFB01, 0xFB02, //
    0x2021, 0x00B7, 0x201A, 0x201E, 0x2030, 0x00C2, 0x00CA, 0x00C1, 0x00CB, 0x00C8, 0x00CD, 0x00CE, 0x00CF, 0x00CC, 0x00D3, 0x00D4, //
    0xF8FF, 0x00D2, 0x00DA, 0x00DB, 0x00D9, 0x0131, 0x02C6, 0x02DC, 0x00AF, 0x02D8, 0x02D9, 0x02DA, 0x00B8, 0x02DD, 0x02DB, 0x02C7, //
];

/// The Unicode character a Mac Roman byte stands for.
pub fn mac_roman_to_unicode(byte: u8) -> u32 {
    if byte < 0x80 {
        byte as u32
    } else {
        MAC_ROMAN_HIGH[(byte - 0x80) as usize] as u32
    }
}

/// How a glyph puts ink on the page.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Ink {
    /// Nothing visible (a space, or an empty slot).
    None,
    /// An outline, with its vertical extent in font units (y up).
    Outline { y_min: i16, y_max: i16 },
    /// A color or bitmap image (COLR, sbix, CBDT, SVG): visible, size unknown here.
    Image,
    /// Outline data that couldn't be read. Counted as ink, so a font isn't wrongly judged empty.
    Unknown,
}

impl Ink {
    pub fn visible(self) -> bool {
        self != Ink::None
    }
}

/// Hashes an outline with its points rounded to font units.
struct ShapeHasher {
    hash: std::collections::hash_map::DefaultHasher,
    any: bool,
}

impl OutlineBuilder for ShapeHasher {
    fn move_to(&mut self, x: f32, y: f32) {
        self.any = true;
        (0u8, x.round() as i32, y.round() as i32).hash(&mut self.hash);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        (1u8, x.round() as i32, y.round() as i32).hash(&mut self.hash);
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        (2u8, [x1, y1, x, y].map(|v| v.round() as i32)).hash(&mut self.hash);
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        (3u8, [x1, y1, x2, y2, x, y].map(|v| v.round() as i32)).hash(&mut self.hash);
    }
    fn close(&mut self) {
        4u8.hash(&mut self.hash);
    }
}

fn u16_at(d: &[u8], o: usize) -> Option<u16> {
    d.get(o..o + 2).map(|b| u16::from_be_bytes([b[0], b[1]]))
}

fn i16_at(d: &[u8], o: usize) -> Option<i16> {
    u16_at(d, o).map(|v| v as i16)
}

fn u32_at(d: &[u8], o: usize) -> Option<u32> {
    d.get(o..o + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

/// A face seen the way CoreText draws it. Glyph facts are worked out on demand and cached.
pub struct FontView<'f, 'a> {
    pub face: &'f Face<'a>,
    pub units_per_em: f32,
    /// Code point (as CoreText would look it up) → glyph. Glyph 0 is never listed.
    pub map: BTreeMap<u32, GlyphId>,
    pub lookup: Lookup,
    ink: RefCell<HashMap<u16, Ink>>,
    shapes: RefCell<HashMap<u16, u64>>,
    /// The shape shared by many letter slots in Expert-style fonts, if this face has one.
    pub placeholder: Option<u64>,
}

impl<'f, 'a> FontView<'f, 'a> {
    pub fn new(face: &'f Face<'a>) -> Self {
        let (map, lookup) = character_map(face);
        let mut view = FontView {
            face,
            units_per_em: face.units_per_em().max(1) as f32,
            map,
            lookup,
            ink: RefCell::default(),
            shapes: RefCell::default(),
            placeholder: None,
        };
        view.placeholder = view.find_placeholder();
        view
    }

    /// The glyph CoreText draws for a character, if the font has one.
    pub fn glyph(&self, cp: u32) -> Option<GlyphId> {
        if let Some(g) = self.map.get(&cp) {
            return Some(*g);
        }
        if self.lookup == Lookup::Symbol && cp <= 0xFF {
            return self.map.get(&(0xF000 + cp)).copied();
        }
        None
    }

    fn raw(&self, tag: &[u8; 4]) -> Option<&'a [u8]> {
        self.face.raw_face().table(Tag::from_bytes(tag))
    }

    pub fn ink(&self, g: GlyphId) -> Ink {
        if let Some(ink) = self.ink.borrow().get(&g.0) {
            return *ink;
        }
        let ink = self.measure(g);
        self.ink.borrow_mut().insert(g.0, ink);
        ink
    }

    fn measure(&self, g: GlyphId) -> Ink {
        if let Some(r) = self.face.glyph_bounding_box(g) {
            if r.x_max > r.x_min || r.y_max > r.y_min {
                return Ink::Outline { y_min: r.y_min, y_max: r.y_max };
            }
        }
        if self.has_image(g) {
            return Ink::Image;
        }
        if self.glyf_bytes(g) > 0 {
            return Ink::Unknown;
        }
        Ink::None
    }

    /// A color or bitmap image for this glyph.
    fn has_image(&self, g: GlyphId) -> bool {
        self.face.is_color_glyph(g)
            || self.face.glyph_raster_image(g, u16::MAX).is_some()
            || self.face.glyph_svg_image(g).is_some()
            || self.has_sbix_image(g)
    }

    /// An `sbix` image in any strike. Read directly: ttf-parser can't decode Apple's own image
    /// format, and Apple Color Emoji puts a stand-in box outline under every emoji.
    fn has_sbix_image(&self, g: GlyphId) -> bool {
        let Some(t) = self.raw(b"sbix") else { return false };
        let strikes = u32_at(t, 4).unwrap_or(0) as usize;
        (0..strikes.min(32)).any(|i| {
            let Some(strike) = u32_at(t, 8 + 4 * i) else { return false };
            let at = strike as usize + 4 + 4 * g.0 as usize;
            matches!((u32_at(t, at), u32_at(t, at + 4)), (Some(a), Some(b)) if b > a.saturating_add(8))
        })
    }

    /// Bytes of `glyf` data for a glyph: zero for an empty one (or a font without `glyf`).
    fn glyf_bytes(&self, g: GlyphId) -> usize {
        let (Some(head), Some(loca)) = (self.raw(b"head"), self.raw(b"loca")) else { return 0 };
        let long = i16_at(head, 50) == Some(1);
        let i = g.0 as usize;
        let at = |n: usize| if long { u32_at(loca, 4 * n).map(|v| v as usize) } else { u16_at(loca, 2 * n).map(|v| 2 * v as usize) };
        match (at(i), at(i + 1)) {
            (Some(a), Some(b)) if b > a => b - a,
            _ => 0,
        }
    }

    pub fn inked(&self, g: GlyphId) -> bool {
        self.ink(g).visible()
    }

    /// The glyph's shape: its outline (rounded to font units) plus its advance. Glyphs drawn
    /// as images never match another glyph, even when they share a stand-in outline (Apple
    /// Color Emoji has the same box under every emoji); nor do glyphs whose outline can't be read.
    pub fn shape(&self, g: GlyphId) -> u64 {
        if let Some(h) = self.shapes.borrow().get(&g.0) {
            return *h;
        }
        let mut h = ShapeHasher { hash: Default::default(), any: false };
        self.face.outline_glyph(g, &mut h);
        if !h.any || matches!(self.ink(g), Ink::Image | Ink::Unknown) || self.has_image(g) {
            (0xB17u16, g.0).hash(&mut h.hash);
        }
        self.face.glyph_hor_advance(g).hash(&mut h.hash);
        let shape = h.hash.finish();
        self.shapes.borrow_mut().insert(g.0, shape);
        shape
    }

    /// One outline that many slots share, letters among them: the filler Expert sets and some
    /// demo fonts put in every slot they don't use. It counts only when:
    /// - the font has 8–400 code points with ink (more is a modern multi-script font, where
    ///   letters can share shapes legitimately);
    /// - it's the most common shape, used by at least 8 code points and at least 5 of A–Z/a–z;
    /// - it covers under 90% of the inked code points (BLOKK and Redacted are one shape by design).
    fn find_placeholder(&self) -> Option<u64> {
        // Cheap first: the placeholder must be shared by at least 5 letters.
        let mut letters: HashMap<u64, usize> = HashMap::new();
        for c in ('A'..='Z').chain('a'..='z') {
            if let Some(g) = self.glyph(c as u32).filter(|g| self.inked(*g)) {
                *letters.entry(self.shape(g)).or_default() += 1;
            }
        }
        if !letters.values().any(|n| *n >= 5) {
            return None;
        }
        let mut inked = 0usize;
        let mut counts: HashMap<u64, usize> = HashMap::new();
        for g in self.map.values() {
            if self.inked(*g) {
                inked += 1;
                if inked > 400 {
                    return None;
                }
                *counts.entry(self.shape(*g)).or_default() += 1;
            }
        }
        if inked < 8 {
            return None;
        }
        let letters_of = |h: &u64| letters.get(h).copied().unwrap_or(0);
        let (shape, n) = counts.iter().max_by_key(|(h, n)| (**n, letters_of(h), **h)).map(|(h, n)| (*h, *n))?;
        (n >= 8 && letters_of(&shape) >= 5 && (n as f64) < 0.9 * inked as f64).then_some(shape)
    }

    /// Glyph id isn't 0, has ink, and isn't the placeholder.
    pub fn real(&self, g: GlyphId) -> bool {
        g.0 != 0 && self.inked(g) && self.placeholder.map_or(true, |p| self.shape(g) != p)
    }

    pub fn real_char(&self, c: char) -> bool {
        self.glyph(c as u32).is_some_and(|g| self.real(g))
    }

    /// Every character other than spaces draws a real glyph (and there is at least one).
    pub fn draws(&self, s: &str) -> bool {
        let mut any = false;
        for c in s.chars().filter(|c| !c.is_whitespace()) {
            if !self.real_char(c) {
                return false;
            }
            any = true;
        }
        any
    }

    /// Line ascent and descent in em (descent positive below the baseline), as CoreText reports
    /// them. Checked against CoreText on every face of a 12,000-face library:
    /// - hhea's ascender and descender. A descender stored with the wrong sign (Monica's +250)
    ///   still counts as below the baseline. In a CFF font a zero descender takes the font's
    ///   lowest point (head yMin) instead; in a TrueType font it stays zero.
    /// - Variable fonts with USE_TYPO_METRICS set use the OS/2 typo values. Static fonts with
    ///   the flag still use hhea.
    /// - When hhea's are both zero: OS/2 typo, then OS/2 win.
    pub fn line_metrics(&self) -> (f32, f32) {
        let em = self.units_per_em;
        let os2 = self.raw(b"OS/2");
        let typo = os2.map(|t| (i16_at(t, 68).unwrap_or(0), i16_at(t, 70).unwrap_or(0))).filter(|(a, d)| *a != 0 || *d != 0);
        let use_typo = os2.and_then(|t| u16_at(t, 62)).is_some_and(|fs| fs & 0x80 != 0);
        if let (Some((ta, td)), true, true) = (typo, use_typo, self.face.is_variable()) {
            return (ta as f32 / em, (td as f32).abs() / em);
        }
        let hhea = self.raw(b"hhea").unwrap_or(&[]);
        let (a, d) = (i16_at(hhea, 4).unwrap_or(0), i16_at(hhea, 6).unwrap_or(0));
        if a != 0 || d != 0 {
            let cff = self.face.tables().cff.is_some();
            let d = if d == 0 && cff { self.face.global_bounding_box().y_min } else { d };
            return (a as f32 / em, (d as f32).abs() / em);
        }
        if let Some(os2) = os2 {
            let (ta, td) = (i16_at(os2, 68).unwrap_or(0), i16_at(os2, 70).unwrap_or(0));
            if ta != 0 || td != 0 {
                return (ta as f32 / em, (td as f32).abs() / em);
            }
            let (wa, wd) = (u16_at(os2, 74).unwrap_or(0), u16_at(os2, 76).unwrap_or(0));
            if wa != 0 || wd != 0 {
                return (wa as f32 / em, wd as f32 / em);
            }
        }
        let b = self.face.global_bounding_box();
        (b.y_max as f32 / em, -(b.y_min as f32) / em)
    }

    /// The vertical ink of a glyph in em: (top, bottom), up positive for top and down positive
    /// for bottom, like canvas's actualBoundingBoxAscent/Descent. None without an outline.
    pub fn glyph_extent(&self, g: GlyphId) -> Option<(f32, f32)> {
        match self.ink(g) {
            Ink::Outline { y_min, y_max } => Some((y_max as f32 / self.units_per_em, -(y_min as f32) / self.units_per_em)),
            _ => None,
        }
    }

    /// The vertical ink of the glyphs this font draws for a string, in em, as in `glyph_extent`.
    pub fn text_extent(&self, s: &str) -> Option<(f32, f32)> {
        let mut out: Option<(f32, f32)> = None;
        for c in s.chars() {
            if let Some((top, bottom)) = self.glyph(c as u32).and_then(|g| self.glyph_extent(g)) {
                out = Some(out.map_or((top, bottom), |(t, b)| (t.max(top), b.max(bottom))));
            }
        }
        out
    }

    /// Script tags from the `meta` table's slng, then dlng entries, such as "Arab".
    pub fn meta_scripts(&self) -> Vec<String> {
        let Some(m) = self.raw(b"meta") else { return vec![] };
        let count = u32_at(m, 12).unwrap_or(0) as usize;
        let mut out = vec![];
        for want in [b"slng", b"dlng"] {
            for i in 0..count.min(64) {
                let o = 16 + i * 12;
                let (Some(tag), Some(off), Some(len)) = (m.get(o..o + 4), u32_at(m, o + 4), u32_at(m, o + 8)) else { break };
                if tag != want {
                    continue;
                }
                let Some(bytes) = m.get(off as usize..(off as usize).saturating_add(len as usize)) else { continue };
                for t in String::from_utf8_lossy(bytes).split(',') {
                    let t = t.trim();
                    let script = t.rsplit('-').next().unwrap_or(t);
                    if script.len() == 4 && script.chars().all(|c| c.is_ascii_alphabetic()) {
                        out.push(script.to_string());
                    }
                }
            }
        }
        out
    }
}

/// The face's code points as CoreText sees them, and which map they came from.
fn character_map(face: &Face) -> (BTreeMap<u32, GlyphId>, Lookup) {
    let (mut unicode, mut symbol, mut mac) = (BTreeMap::new(), BTreeMap::new(), BTreeMap::new());
    let Some(cmap) = face.tables().cmap else { return (BTreeMap::new(), Lookup::None) };
    // Full-repertoire Unicode maps first, so they win where two maps disagree.
    let mut subtables: Vec<_> = cmap.subtables.into_iter().collect();
    subtables.sort_by_key(|st| !matches!((st.platform_id, st.encoding_id), (PlatformId::Unicode, 4 | 6) | (PlatformId::Windows, 10)));
    for st in subtables {
        if matches!(st.format, ttf_parser::cmap::Format::UnicodeVariationSequences(_)) {
            continue;
        }
        let (target, mac_roman) = match (st.platform_id, st.encoding_id) {
            (PlatformId::Unicode, 5) => continue,
            (PlatformId::Unicode, _) | (PlatformId::Windows, 1 | 10) => (&mut unicode, false),
            (PlatformId::Windows, 0) => (&mut symbol, false),
            (PlatformId::Macintosh, 0) => (&mut mac, true),
            _ => continue,
        };
        st.codepoints(|code| {
            if let Some(g) = st.glyph_index(code).filter(|g| g.0 != 0) {
                let cp = if mac_roman { if code > 0xFF { return } else { mac_roman_to_unicode(code as u8) } } else { code };
                target.entry(cp).or_insert(g);
            }
        });
    }
    if !unicode.is_empty() {
        (unicode, Lookup::Unicode)
    } else if !symbol.is_empty() {
        (symbol, Lookup::Symbol)
    } else if !mac.is_empty() {
        (mac, Lookup::MacRoman)
    } else {
        (BTreeMap::new(), Lookup::None)
    }
}
