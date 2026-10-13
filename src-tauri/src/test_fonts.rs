//! Small synthetic fonts for tests, built byte by byte so tests need no fixture files.
//!
//! A font has TrueType outlines (`glyf`): each glyph is a rectangle, empty, or deliberately
//! broken. Character maps can be Unicode (format 4, plus format 12 when a code point is past
//! U+FFFF), Microsoft Symbol (3,0) or Mac Roman (1,0) format 0. Optional tables: `name`, `post`
//! (format 2 with glyph names, or 3 without), `OS/2`, `meta` and any raw table (`sbix`).

/// A glyph's outline.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Shape {
    /// No outline at all (like a space).
    Empty,
    /// A filled rectangle, in font units.
    Rect { x0: i16, y0: i16, x1: i16, y1: i16 },
    /// Outline data that can't be read: as if a variable glyph failed to outline.
    Broken,
}

impl Shape {
    /// A rectangle from the baseline up to `top`, `width` wide.
    pub fn bar(width: i16, top: i16) -> Shape {
        Shape::Rect { x0: 10, y0: 0, x1: 10 + width, y1: top }
    }
}

struct Glyph {
    shape: Shape,
    advance: u16,
    name: Option<String>,
}

/// Which character map a code point goes into.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cmap {
    Unicode,
    Symbol,
    MacRoman,
}

pub struct FontBuilder {
    pub units_per_em: u16,
    glyphs: Vec<Glyph>,
    maps: Vec<(Cmap, u32, u16)>,
    names: Vec<(u16, String)>,
    /// Write glyph names (`post` format 2). Otherwise `post` format 3.
    pub glyph_names: bool,
    /// hhea ascender, descender (negative below the baseline).
    pub hhea: (i16, i16),
    /// OS/2 typo ascender and descender, and win ascent and descent.
    pub os2: Option<(i16, i16, u16, u16)>,
    /// Sets OS/2 fsSelection's USE_TYPO_METRICS bit.
    pub use_typo_metrics: bool,
    meta: Vec<([u8; 4], String)>,
    raw: Vec<([u8; 4], Vec<u8>)>,
}

impl Default for FontBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl FontBuilder {
    pub fn new() -> Self {
        FontBuilder {
            units_per_em: 1000,
            glyphs: vec![Glyph { shape: Shape::bar(400, 700), advance: 500, name: Some(".notdef".into()) }],
            maps: Vec::new(),
            names: Vec::new(),
            glyph_names: false,
            hhea: (800, -200),
            os2: Some((800, -200, 1000, 250)),
            use_typo_metrics: false,
            meta: Vec::new(),
            raw: Vec::new(),
        }
    }

    /// A family name (IDs 1 and 4 as "<family> Regular", 2 "Regular", 6 PostScript).
    pub fn named(mut self, family: &str) -> Self {
        self.names = vec![
            (1, family.into()),
            (2, "Regular".into()),
            (4, format!("{family} Regular")),
            (6, format!("{}-Regular", family.replace(' ', ""))),
        ];
        self
    }

    /// Sets (or replaces) one `name` record.
    pub fn name(mut self, id: u16, text: &str) -> Self {
        self.names.retain(|(i, _)| *i != id);
        self.names.push((id, text.into()));
        self
    }

    /// Adds a glyph and returns its id.
    pub fn glyph(&mut self, shape: Shape, name: Option<&str>) -> u16 {
        self.glyphs.push(Glyph { shape, advance: 600, name: name.map(String::from) });
        (self.glyphs.len() - 1) as u16
    }

    /// Maps a code into one of the character maps.
    pub fn map(&mut self, cmap: Cmap, code: u32, gid: u16) {
        self.maps.push((cmap, code, gid));
    }

    /// A new glyph mapped from `cp` in the Unicode map. Its shape is unique to it (the width
    /// follows the glyph id), unless `shape` says otherwise.
    pub fn char(&mut self, cp: u32, shape: Option<Shape>) -> u16 {
        let next = self.glyphs.len() as i16;
        let name = char::from_u32(cp).filter(|c| c.is_ascii_alphanumeric()).map(String::from);
        let gid = self.glyph(shape.unwrap_or(Shape::bar(100 + next * 3, 700)), name.as_deref());
        self.map(Cmap::Unicode, cp, gid);
        gid
    }

    /// Unique rectangles for every character of `chars`.
    pub fn chars(mut self, chars: &str) -> Self {
        for c in chars.chars() {
            self.char(c as u32, None);
        }
        self
    }

    /// Adds a `meta` entry, such as (`slng`, "Arab").
    pub fn meta(mut self, tag: &[u8; 4], value: &str) -> Self {
        self.meta.push((*tag, value.into()));
        self
    }

    /// Adds a table as raw bytes.
    pub fn raw_table(mut self, tag: &[u8; 4], bytes: Vec<u8>) -> Self {
        self.raw.push((*tag, bytes));
        self
    }

    pub fn glyph_count(&self) -> u16 {
        self.glyphs.len() as u16
    }

    /// The font's tables, sorted by tag.
    pub fn tables(&self) -> Vec<([u8; 4], Vec<u8>)> {
        let (glyf, loca) = self.glyf_and_loca();
        let mut t = vec![
            (*b"head", self.head()),
            (*b"hhea", self.hhea_table()),
            (*b"maxp", self.maxp()),
            (*b"hmtx", self.hmtx()),
            (*b"loca", loca),
            (*b"glyf", glyf),
            (*b"cmap", self.cmap()),
            (*b"post", self.post()),
        ];
        if !self.names.is_empty() {
            t.push((*b"name", name_table(&self.names)));
        }
        if let Some(os2) = self.os2 {
            t.push((*b"OS/2", os2_table(os2, self.use_typo_metrics)));
        }
        if !self.meta.is_empty() {
            t.push((*b"meta", meta_table(&self.meta)));
        }
        t.extend(self.raw.iter().cloned());
        t.sort_by(|a, b| a.0.cmp(&b.0));
        t
    }

    /// A standalone font file.
    pub fn build(&self) -> Vec<u8> {
        sfnt(&self.tables())
    }

    fn head(&self) -> Vec<u8> {
        let mut t = Vec::new();
        t.extend(0x0001_0000u32.to_be_bytes()); // version
        t.extend(0x0001_0000u32.to_be_bytes()); // fontRevision
        t.extend(0u32.to_be_bytes()); // checksumAdjustment
        t.extend(0x5F0F_3CF5u32.to_be_bytes()); // magic
        t.extend(0u16.to_be_bytes()); // flags
        t.extend(self.units_per_em.to_be_bytes());
        t.extend([0u8; 16]); // created, modified
        for v in [0i16, -200, 1000, 800] {
            t.extend(v.to_be_bytes()); // xMin, yMin, xMax, yMax
        }
        t.extend(0u16.to_be_bytes()); // macStyle
        t.extend(8u16.to_be_bytes()); // lowestRecPPEM
        t.extend(2i16.to_be_bytes()); // fontDirectionHint
        t.extend(1i16.to_be_bytes()); // indexToLocFormat: long offsets
        t.extend(0i16.to_be_bytes()); // glyphDataFormat
        t
    }

    fn hhea_table(&self) -> Vec<u8> {
        let mut t = Vec::new();
        t.extend(0x0001_0000u32.to_be_bytes());
        t.extend(self.hhea.0.to_be_bytes());
        t.extend(self.hhea.1.to_be_bytes());
        t.extend(0i16.to_be_bytes()); // lineGap
        t.extend(1000u16.to_be_bytes()); // advanceWidthMax
        t.extend([0u8; 20]); // minLSB, minRSB, xMaxExtent, caret (3), reserved (4)
        t.extend(0i16.to_be_bytes()); // metricDataFormat
        t.extend(self.glyph_count().to_be_bytes()); // numberOfHMetrics
        t
    }

    fn maxp(&self) -> Vec<u8> {
        let mut t = Vec::new();
        t.extend(0x0001_0000u32.to_be_bytes());
        t.extend(self.glyph_count().to_be_bytes());
        t.extend([0u8; 26]);
        t
    }

    fn hmtx(&self) -> Vec<u8> {
        self.glyphs.iter().flat_map(|g| [g.advance.to_be_bytes(), 0i16.to_be_bytes()].concat()).collect()
    }

    fn glyf_and_loca(&self) -> (Vec<u8>, Vec<u8>) {
        let mut glyf = Vec::new();
        let mut loca = Vec::new();
        for g in &self.glyphs {
            loca.extend((glyf.len() as u32).to_be_bytes());
            match g.shape {
                Shape::Empty => {}
                Shape::Broken => {
                    // One contour claimed, then the data stops.
                    glyf.extend(1i16.to_be_bytes());
                    glyf.extend([0u8; 8]);
                    glyf.extend(40u16.to_be_bytes());
                    glyf.extend([0u8; 2]);
                }
                Shape::Rect { x0, y0, x1, y1 } => {
                    glyf.extend(1i16.to_be_bytes()); // numberOfContours
                    for v in [x0, y0, x1, y1] {
                        glyf.extend(v.to_be_bytes());
                    }
                    glyf.extend(3u16.to_be_bytes()); // endPtsOfContours
                    glyf.extend(0u16.to_be_bytes()); // instructionLength
                    glyf.extend([1u8; 4]); // flags: on curve, 16-bit deltas
                    for dx in [x0, x1 - x0, 0, x0 - x1] {
                        glyf.extend(dx.to_be_bytes());
                    }
                    for dy in [y0, 0, y1 - y0, 0] {
                        glyf.extend(dy.to_be_bytes());
                    }
                }
            }
            glyf.resize((glyf.len() + 3) & !3, 0);
        }
        loca.extend((glyf.len() as u32).to_be_bytes());
        (glyf, loca)
    }

    fn cmap(&self) -> Vec<u8> {
        let pick = |kind: Cmap| -> Vec<(u32, u16)> {
            let mut v: Vec<(u32, u16)> = self.maps.iter().filter(|m| m.0 == kind).map(|m| (m.1, m.2)).collect();
            v.sort();
            v.dedup_by_key(|m| m.0);
            v
        };
        let unicode = pick(Cmap::Unicode);
        let mut subtables: Vec<(u16, u16, Vec<u8>)> = Vec::new();
        let mac = pick(Cmap::MacRoman);
        if !mac.is_empty() {
            subtables.push((1, 0, format0(&mac)));
        }
        let symbol = pick(Cmap::Symbol);
        if !symbol.is_empty() {
            subtables.push((3, 0, format4(&symbol)));
        }
        if !unicode.is_empty() {
            let bmp: Vec<(u32, u16)> = unicode.iter().copied().filter(|m| m.0 <= 0xFFFF).collect();
            subtables.push((3, 1, format4(&bmp)));
            if unicode.iter().any(|m| m.0 > 0xFFFF) {
                subtables.push((3, 10, format12(&unicode)));
            }
        }
        let mut t = Vec::new();
        t.extend(0u16.to_be_bytes());
        t.extend((subtables.len() as u16).to_be_bytes());
        let mut offset = 4 + 8 * subtables.len();
        for (platform, encoding, data) in &subtables {
            t.extend(platform.to_be_bytes());
            t.extend(encoding.to_be_bytes());
            t.extend((offset as u32).to_be_bytes());
            offset += data.len();
        }
        for (_, _, data) in &subtables {
            t.extend(data);
        }
        t
    }

    fn post(&self) -> Vec<u8> {
        let mut t = Vec::new();
        t.extend(if self.glyph_names { 0x0002_0000u32 } else { 0x0003_0000u32 }.to_be_bytes());
        t.extend([0u8; 28]); // italicAngle … maxMemType1
        if self.glyph_names {
            t.extend(self.glyph_count().to_be_bytes());
            let mut strings = Vec::new();
            let mut custom = 0u16;
            for g in &self.glyphs {
                match g.name.as_deref() {
                    None | Some(".notdef") => t.extend(0u16.to_be_bytes()),
                    Some(n) => {
                        t.extend((258 + custom).to_be_bytes());
                        custom += 1;
                        strings.push(n.len() as u8);
                        strings.extend(n.as_bytes());
                    }
                }
            }
            t.extend(strings);
        }
        t
    }

    /// Sets a glyph's name (for `post` format 2).
    pub fn set_glyph_name(&mut self, gid: u16, name: &str) {
        self.glyphs[gid as usize].name = Some(name.into());
        self.glyph_names = true;
    }
}

/// Mac Roman (1,0) format 0: one byte per code.
fn format0(map: &[(u32, u16)]) -> Vec<u8> {
    let mut ids = [0u8; 256];
    for &(code, gid) in map {
        if code < 256 && gid < 256 {
            ids[code as usize] = gid as u8;
        }
    }
    let mut t = Vec::new();
    t.extend(0u16.to_be_bytes());
    t.extend(262u16.to_be_bytes());
    t.extend(0u16.to_be_bytes());
    t.extend(ids);
    t
}

/// Format 4 with one segment per code (plus the closing 0xFFFF segment).
fn format4(map: &[(u32, u16)]) -> Vec<u8> {
    let segs = map.len() + 1;
    let mut ends = Vec::new();
    let mut starts = Vec::new();
    let mut deltas = Vec::new();
    for &(code, gid) in map {
        ends.extend((code as u16).to_be_bytes());
        starts.extend((code as u16).to_be_bytes());
        deltas.extend((gid.wrapping_sub(code as u16)).to_be_bytes());
    }
    ends.extend(0xFFFFu16.to_be_bytes());
    starts.extend(0xFFFFu16.to_be_bytes());
    deltas.extend(1u16.to_be_bytes());
    let length = 16 + 8 * segs;
    let mut t = Vec::new();
    for v in [4u16, length as u16, 0, (segs * 2) as u16, 0, 0, 0] {
        t.extend(v.to_be_bytes());
    }
    t.extend(ends);
    t.extend(0u16.to_be_bytes()); // reservedPad
    t.extend(starts);
    t.extend(deltas);
    t.extend(vec![0u8; 2 * segs]); // idRangeOffsets
    t
}

/// Format 12 with one group per code.
fn format12(map: &[(u32, u16)]) -> Vec<u8> {
    let mut t = Vec::new();
    t.extend(12u16.to_be_bytes());
    t.extend(0u16.to_be_bytes());
    t.extend(((16 + 12 * map.len()) as u32).to_be_bytes());
    t.extend(0u32.to_be_bytes());
    t.extend((map.len() as u32).to_be_bytes());
    for &(code, gid) in map {
        t.extend(code.to_be_bytes());
        t.extend(code.to_be_bytes());
        t.extend((gid as u32).to_be_bytes());
    }
    t
}

/// A `name` table with Windows English records.
pub fn name_table(records: &[(u16, String)]) -> Vec<u8> {
    let mut head = Vec::new();
    let mut strings = Vec::new();
    head.extend(0u16.to_be_bytes());
    head.extend((records.len() as u16).to_be_bytes());
    head.extend(((6 + 12 * records.len()) as u16).to_be_bytes());
    for (id, text) in records {
        let utf16: Vec<u8> = text.encode_utf16().flat_map(u16::to_be_bytes).collect();
        for v in [3u16, 1, 0x0409, *id, utf16.len() as u16, strings.len() as u16] {
            head.extend(v.to_be_bytes());
        }
        strings.extend(utf16);
    }
    head.extend(strings);
    head
}

fn os2_table((typo_ascender, typo_descender, win_ascent, win_descent): (i16, i16, u16, u16), use_typo: bool) -> Vec<u8> {
    let mut t = vec![0u8; 96];
    t[0..2].copy_from_slice(&4u16.to_be_bytes()); // version
    t[4..6].copy_from_slice(&400u16.to_be_bytes()); // usWeightClass
    t[6..8].copy_from_slice(&5u16.to_be_bytes()); // usWidthClass
    let fs_selection: u16 = if use_typo { 0xC0 } else { 0x40 }; // regular, maybe USE_TYPO_METRICS
    t[62..64].copy_from_slice(&fs_selection.to_be_bytes());
    t[68..70].copy_from_slice(&typo_ascender.to_be_bytes());
    t[70..72].copy_from_slice(&typo_descender.to_be_bytes());
    t[74..76].copy_from_slice(&win_ascent.to_be_bytes());
    t[76..78].copy_from_slice(&win_descent.to_be_bytes());
    t
}

fn meta_table(entries: &[([u8; 4], String)]) -> Vec<u8> {
    let mut t = Vec::new();
    t.extend(1u32.to_be_bytes()); // version
    t.extend(0u32.to_be_bytes()); // flags
    t.extend(0u32.to_be_bytes()); // reserved
    t.extend((entries.len() as u32).to_be_bytes());
    let mut offset = 16 + 12 * entries.len();
    for (tag, value) in entries {
        t.extend(tag);
        t.extend((offset as u32).to_be_bytes());
        t.extend((value.len() as u32).to_be_bytes());
        offset += value.len();
    }
    for (_, value) in entries {
        t.extend(value.as_bytes());
    }
    t
}

/// An `sbix` table with one strike, where the listed glyphs have a (fake) PNG image.
pub fn sbix_table(glyph_count: u16, with_image: &[u16]) -> Vec<u8> {
    let mut t = Vec::new();
    t.extend(1u16.to_be_bytes()); // version
    t.extend(1u16.to_be_bytes()); // flags
    t.extend(1u32.to_be_bytes()); // numStrikes
    t.extend(12u32.to_be_bytes()); // strike offset
    let strike_header = 4 + 4 * (glyph_count as usize + 1);
    let mut offsets = Vec::new();
    let mut data = Vec::new();
    for g in 0..=glyph_count {
        offsets.extend(((strike_header + data.len()) as u32).to_be_bytes());
        if g < glyph_count && with_image.contains(&g) {
            data.extend([0u8; 4]); // origin
            data.extend(b"png ");
            data.extend([0x89, b'P', b'N', b'G', 0, 0, 0, 0]);
        }
    }
    t.extend(72u16.to_be_bytes()); // ppem
    t.extend(72u16.to_be_bytes()); // ppi
    t.extend(offsets);
    t.extend(data);
    t
}

/// Writes tables as a standalone font file.
pub fn sfnt(tables: &[([u8; 4], Vec<u8>)]) -> Vec<u8> {
    collection_or_single(&[tables.to_vec()], false)
}

/// A collection (.ttc) of the given faces.
pub fn collection(faces: &[Vec<([u8; 4], Vec<u8>)>]) -> Vec<u8> {
    collection_or_single(faces, true)
}

fn collection_or_single(faces: &[Vec<([u8; 4], Vec<u8>)>], ttc: bool) -> Vec<u8> {
    let dir_len = |n: usize| 12 + 16 * n;
    let header = if ttc { 12 + 4 * faces.len() } else { 0 };
    let dirs: usize = faces.iter().map(|t| dir_len(t.len())).sum();
    let mut out = Vec::new();
    if ttc {
        out.extend(b"ttcf");
        out.extend(0x0001_0000u32.to_be_bytes());
        out.extend((faces.len() as u32).to_be_bytes());
        let mut at = header;
        for t in faces {
            out.extend((at as u32).to_be_bytes());
            at += dir_len(t.len());
        }
    }
    let mut data_at = header + dirs;
    let mut data = Vec::new();
    for tables in faces {
        let n = tables.len();
        let entry_selector = (n.max(1) as f64).log2().floor() as u16;
        let search_range = (1u16 << entry_selector) * 16;
        out.extend(0x0001_0000u32.to_be_bytes());
        out.extend((n as u16).to_be_bytes());
        out.extend(search_range.to_be_bytes());
        out.extend(entry_selector.to_be_bytes());
        out.extend(((n as u16 * 16).saturating_sub(search_range)).to_be_bytes());
        for (tag, bytes) in tables {
            out.extend(tag);
            out.extend(0u32.to_be_bytes()); // checksum (not checked)
            out.extend((data_at as u32).to_be_bytes());
            out.extend((bytes.len() as u32).to_be_bytes());
            data.extend(bytes);
            data.resize((data.len() + 3) & !3, 0);
            data_at = header + dirs + data.len();
        }
    }
    out.extend(data);
    out
}
