//! The detail panel's character grid: every real character of a face, grouped by Unicode block.
//! Worked out on demand, never stored.

use serde::Serialize;

use super::{
    font::FontView,
    profile::{self, Names},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontCharacters {
    /// Real characters, over all blocks.
    pub total: usize,
    /// Code points that draw the shared placeholder shape (hidden from the grid).
    pub placeholders: usize,
    /// Code points mapped to a glyph with no ink (hidden from the grid).
    pub empty: usize,
    /// How CoreText looks characters up: "unicode", "symbol", "macRoman" or "none".
    pub lookup: &'static str,
    pub expert: bool,
    /// Line ascent and descent in em, as in the preview profile.
    pub ascent: f32,
    pub descent: f32,
    /// The ink most characters stay within, in em (98th percentile above and below the
    /// baseline), for sizing grid cells. Zero when no character has an outline.
    pub ink_top: f32,
    pub ink_bottom: f32,
    /// Blocks in code point order.
    pub blocks: Vec<CharacterBlock>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterBlock {
    pub name: &'static str,
    /// Consecutive code points as [first, last] runs.
    pub runs: Vec<[u32; 2]>,
    /// Glyph names, one per code point in run order ("" when the font has none).
    pub glyph_names: Vec<String>,
}

#[cfg(test)]
impl CharacterBlock {
    pub fn count(&self) -> usize {
        self.runs.iter().map(|[a, b]| (b - a + 1) as usize).sum()
    }
}

pub fn characters(face: &ttf_parser::Face, names: &Names) -> FontCharacters {
    let f = FontView::new(face);
    let expert = profile::expertise(&f, names).expert;
    let (ascent, descent) = f.line_metrics();
    let (mut placeholders, mut empty, mut total) = (0, 0, 0);
    let mut blocks: Vec<CharacterBlock> = Vec::new();
    let (mut tops, mut bottoms) = (Vec::new(), Vec::new());
    for (&cp, &g) in &f.map {
        if profile::invisible(cp) {
            continue;
        }
        if !f.inked(g) {
            empty += 1;
            continue;
        }
        if !f.real(g) {
            placeholders += 1;
            continue;
        }
        total += 1;
        if let Some((top, bottom)) = f.glyph_extent(g) {
            tops.push(top);
            bottoms.push(bottom);
        }
        let name = profile::block(cp);
        if blocks.last().map_or(true, |b| b.name != name) {
            blocks.push(CharacterBlock { name, runs: Vec::new(), glyph_names: Vec::new() });
        }
        let block = blocks.last_mut().expect("just pushed");
        match block.runs.last_mut() {
            Some(run) if run[1] + 1 == cp => run[1] = cp,
            _ => block.runs.push([cp, cp]),
        }
        block.glyph_names.push(face.glyph_name(g).unwrap_or_default().to_string());
    }
    let p98 = |v: &mut Vec<f32>| -> f32 {
        if v.is_empty() {
            return 0.0;
        }
        v.sort_by(|a, b| a.total_cmp(b));
        v[((v.len() - 1) as f32 * 0.98).round() as usize].max(0.0)
    };
    FontCharacters {
        total,
        placeholders,
        empty,
        lookup: f.lookup.as_str(),
        expert,
        ascent,
        descent,
        ink_top: p98(&mut tops),
        ink_bottom: p98(&mut bottoms),
        blocks,
    }
}
