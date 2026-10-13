//! Preview profiles: the lookup, the cascade, Expert detection, samples, metrics (synthetic
//! fonts from `test_fonts`), the stored table (temporary databases), and an ignored pass over
//! the real library (read-only).

use std::time::{Duration, Instant};

use ttf_parser::{Face, GlyphId};

use super::{
    font::{limits, mac_roman_to_unicode, FontView, Ink, Lookup},
    profile::{self, flags, group, tokens, Group, Kind, Names, Profile},
    PreviewInfo,
};
use crate::test_fonts::{collection, ligature_gsub, sbix_table, Cmap, FontBuilder, Shape};

fn names(family: &str) -> Names<'_> {
    Names { family, subfamily: "Regular", full: "", postscript: "", file_stem: "" }
}

fn profile_of(font: &FontBuilder, family: &str) -> Profile {
    let data = font.build();
    let face = Face::parse(&data, 0).expect("test font parses");
    profile::profile(&face, &names(family))
}

/// A space and every printable ASCII character except `missing`, each its own shape.
fn latin_except(missing: &str) -> FontBuilder {
    let mut b = FontBuilder::new();
    b.char(0x20, Some(Shape::Empty));
    for c in (0x21u8..0x7F).map(char::from).filter(|c| !missing.contains(*c)) {
        b.char(c as u32, None);
    }
    b
}

fn chars_of(s: &str) -> Vec<u32> {
    s.chars().filter(|c| !c.is_whitespace()).map(|c| c as u32).collect()
}

// ------------------------------------------------------------------------- lookup and names

#[test]
fn mac_roman_bytes_map_to_unicode() {
    assert_eq!(mac_roman_to_unicode(b'A'), 'A' as u32);
    assert_eq!(mac_roman_to_unicode(0x80), 'Ä' as u32);
    assert_eq!(mac_roman_to_unicode(0xA0), '†' as u32);
    assert_eq!(mac_roman_to_unicode(0xCA), 0xA0, "no-break space");
    assert_eq!(mac_roman_to_unicode(0xDB), '€' as u32);
    assert_eq!(mac_roman_to_unicode(0xF0), 0xF8FF, "the Apple logo");
    assert_eq!(mac_roman_to_unicode(0xFF), 'ˇ' as u32);
}

#[test]
fn names_split_into_words() {
    assert_eq!(tokens("DistrictPro-BoldAltExpert"), ["district", "pro", "bold", "alt", "expert"]);
    assert_eq!(tokens("ScalaSansSCExpert"), ["scala", "sans", "sc", "expert"]);
    assert_eq!(tokens("Avance_Exp"), ["avance", "exp"]);
    assert_eq!(tokens("ceriph 07_66"), ["ceriph", "07", "66"]);
    assert_eq!(tokens("LI Glyphs"), ["li", "glyphs"]);
}

#[test]
fn presentation_forms_count_as_their_script() {
    assert_eq!(group(0xFB13), Group::Script("Armenian"));
    assert_eq!(group(0xFB2A), Group::Script("Hebrew"));
    assert_eq!(group(0xFB01), Group::Latin, "fi ligature");
    assert_eq!(group('A' as u32), Group::Latin);
    assert_eq!(group('7' as u32), Group::Digit);
    assert_eq!(group('¼' as u32), Group::Punct);
    assert_eq!(group(0xE000), Group::Pua);
    assert_eq!(group(0x2211), Group::Symbol, "∑");
    assert_eq!(group(0x0627), Group::Script("Arabic"));
    assert_eq!(group(0xFE8D), Group::Script("Arabic"), "Arabic presentation forms");
    assert_eq!(group(0x4E00), Group::Script("Han"));
}

// ------------------------------------------------------------------------------- the cascade

#[test]
fn plain_latin_font_draws_its_name() {
    let p = profile_of(&latin_except("|~"), "Plain Sans");
    assert_eq!(p.kind, Kind::Name);
    assert_eq!((p.family_text.as_deref(), p.full_text.as_deref()), (None, None));
    assert_eq!(p.ascii_missing, "|~");
    assert_eq!(p.label, None);
    assert_eq!((p.ascent, p.descent), (0.8, 0.2));
    assert_eq!(p.ink, Some((0.7, 0.0)), "the bars stand on the baseline, 700 units tall");
    assert_eq!(p.sample, None, "no sample is built when the name draws");
}

#[test]
fn caps_only_font_draws_its_name_in_capitals() {
    let font = FontBuilder::new().chars(" ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    let p = profile_of(&font, "Kleemax DEMO");
    assert_eq!(p.kind, Kind::Case);
    assert_eq!(p.family_text.as_deref(), Some("KLEEMAX DEMO"));
    assert_eq!(p.full_text.as_deref(), Some("KLEEMAX DEMO REGULAR"));
    assert!(p.ascii_missing.contains('a') && !p.ascii_missing.contains('A'));
}

#[test]
fn lowercase_only_font_draws_its_name_in_lowercase() {
    let font = FontBuilder::new().chars(" abcdefghijklmnopqrstuvwxyz");
    let p = profile_of(&font, "MacroMX");
    assert_eq!(p.kind, Kind::Case);
    assert_eq!(p.family_text.as_deref(), Some("macromx"));
}

#[test]
fn missing_trademark_is_dropped() {
    let p = profile_of(&latin_except(""), "Abaddon™");
    assert_eq!(p.kind, Kind::Trim);
    assert_eq!(p.family_text.as_deref(), Some("Abaddon"));
}

#[test]
fn missing_hyphen_and_underscore_become_spaces() {
    let p = profile_of(&latin_except("-_"), "LucidaMath-Std_Italic");
    assert_eq!(p.kind, Kind::Trim);
    assert_eq!(p.family_text.as_deref(), Some("LucidaMath Std Italic"));
}

#[test]
fn icon_fonts_skip_the_case_change() {
    let font = FontBuilder::new().chars(" ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    let p = profile_of(&font, "Foo Icons");
    assert_ne!(p.kind, Kind::Case, "capitals of an icon font are pictures, not a name");
    assert_eq!(p.kind, Kind::Symbols);
    assert_eq!(p.label.as_deref(), Some("Symbols"));
    assert!(p.flags & flags::ICON_WORD != 0);
}

#[test]
fn private_use_icon_font_shows_icons_spread_across_its_range() {
    let mut font = FontBuilder::new();
    for cp in 0xE000..=0xE0A5 {
        font.char(cp, None);
    }
    let p = profile_of(&font, "LinkedIn-Glyphs-12px");
    assert_eq!(p.kind, Kind::Symbols);
    let cps = chars_of(p.family_text.as_deref().unwrap());
    assert_eq!(cps.len(), 12);
    assert_eq!((cps[0], cps[11]), (0xE000, 0xE0A5), "spread from the first icon to the last");
    assert!(cps.windows(2).all(|w| w[0] < w[1]));
    assert_eq!(p.family_text, p.full_text);
    assert_eq!(p.ascii_missing.len(), 94);
}

/// A symbol-only font (Wingdings): its codes are U+F0xx, or plain 0x20–0xFF in some fonts.
fn symbol_font(base: u32) -> FontBuilder {
    let mut font = FontBuilder::new();
    for code in 0x21..0x7F {
        let gid = font.glyph(Shape::bar(100 + code as i16, 650), None);
        font.map(Cmap::Symbol, base + code, gid);
    }
    font
}

#[test]
fn symbol_only_fonts_draw_codes_from_their_own_map() {
    for base in [0xF000, 0] {
        let font = symbol_font(base);
        let data = font.build();
        let face = Face::parse(&data, 0).unwrap();
        let view = FontView::new(&face);
        assert_eq!(view.lookup, Lookup::Symbol);
        assert!(view.draws("Wingdings"), "CoreText maps letters onto the symbol codes");
        let p = profile::profile(&face, &names("Wingdings"));
        assert_eq!(p.kind, Kind::Symbols, "base {base:#x}");
        assert!(p.flags & flags::SYMBOL_CMAP != 0);
        let cps = chars_of(p.family_text.as_deref().unwrap());
        assert_eq!(cps.len(), 12);
        assert!(cps.iter().all(|cp| view.map.contains_key(cp)), "codes straight from the font's map: {cps:x?}");
    }
}

#[test]
fn symbol_map_with_a_unicode_map_uses_unicode_only() {
    // Trekbats: the same F0xx codes in a Symbol map and a Unicode map.
    let mut font = symbol_font(0xF000);
    for code in 0x21..0x7F {
        font.map(Cmap::Unicode, 0xF000 + code, (code - 0x20) as u16);
    }
    let data = font.build();
    let face = Face::parse(&data, 0).unwrap();
    let view = FontView::new(&face);
    assert_eq!(view.lookup, Lookup::Unicode);
    assert_eq!(view.glyph('A' as u32), None, "no remap onto U+F041");
    assert!(!view.draws("Trekbats"));
    let p = profile::profile_of(&view, &names("Trekbats"));
    assert_eq!(p.kind, Kind::Symbols);
    assert!(chars_of(p.family_text.as_deref().unwrap()).iter().all(|cp| (0xF021..0xF07F).contains(cp)));
}

/// A symbol-only font whose U+F0xx slots hold ordinary letters, with the given glyph names.
fn symbol_letters(name: fn(char) -> String) -> FontBuilder {
    let mut font = FontBuilder::new();
    for code in 0x20u32..0x7F {
        let shape = if code == 0x20 { Shape::Empty } else { Shape::bar(100 + code as i16, 650) };
        let gid = font.glyph(shape, None);
        font.map(Cmap::Symbol, 0xF000 + code, gid);
        let c = char::from_u32(code).unwrap();
        if c.is_ascii_alphabetic() {
            font.set_glyph_name(gid, &name(c));
        }
    }
    font
}

#[test]
fn symbol_only_fonts_with_plain_letters_draw_their_names() {
    // Monica, Sidewalker and Eco name their letters uniF041…; Jedi Solid and Berette A, B, C.
    let namings: [fn(char) -> String; 2] = [|c| format!("uniF0{:02X}", c as u32), |c| c.to_string()];
    for naming in namings {
        let p = profile_of(&symbol_letters(naming), "Monica");
        assert_eq!(p.kind, Kind::Name, "CoreText draws the name in the font's own letters");
        assert_eq!((p.label, p.family_text), (None, None));
        assert!(p.flags & flags::SYMBOL_CMAP != 0 && p.flags & flags::PICTURE_NAMES == 0);
    }
}

#[test]
fn symbol_only_fonts_with_picture_glyph_names_show_symbols() {
    // Webdings names its letter slots for what they draw ("town", "city"); no icon word needed.
    let p = profile_of(&symbol_letters(|c| format!("town{}", c.to_ascii_lowercase())), "Trek Street");
    assert!(p.flags & flags::PICTURE_NAMES != 0);
    assert_eq!(p.kind, Kind::Symbols);
    assert_eq!(p.label.as_deref(), Some("Symbols"));
}

#[test]
fn mac_roman_only_font_draws_its_name() {
    let mut font = FontBuilder::new();
    for byte in (0x20u32..0x7F).chain([0x8A]) {
        let gid = font.glyph(Shape::bar(100 + byte as i16, 700), None);
        font.map(Cmap::MacRoman, byte, gid);
    }
    let data = font.build();
    let face = Face::parse(&data, 0).unwrap();
    let view = FontView::new(&face);
    assert_eq!(view.lookup, Lookup::MacRoman);
    assert!(view.real_char('ä'), "byte 0x8A is ä");
    let p = profile::profile_of(&view, &names("Krupper"));
    assert_eq!(p.kind, Kind::Name);
    assert!(p.flags & flags::MAC_ROMAN_ONLY != 0);
}

// -------------------------------------------------------------------------- Expert detection

const EXPERT_REAL: &str = "ÐðŁłŠšÝýÞþŽž¼½¾¹²³≠∞≤≥∂∑∏π∫Ω√∆≈◊ﬁﬂ";

/// An Expert-style font: every letter slot holds one shared placeholder shape (each its own
/// glyph, as in District), digits and a set of real characters have their own shapes.
fn placeholder_font(real_capitals: bool) -> FontBuilder {
    let mut font = FontBuilder::new().chars(" 0123456789").chars(EXPERT_REAL);
    let placeholder = Shape::Rect { x0: 50, y0: 0, x1: 650, y1: 600 };
    for c in ('A'..='Z').chain('a'..='z') {
        let shape = if real_capitals && c.is_ascii_uppercase() { None } else { Some(placeholder) };
        font.char(c as u32, shape);
    }
    font
}

#[test]
fn expert_set_with_a_placeholder_shows_only_real_characters() {
    let p = profile_of(&placeholder_font(false), "MetaCond Black Expert");
    assert_eq!(p.kind, Kind::Expert);
    assert_eq!(p.label.as_deref(), Some("Expert set"));
    assert!(p.flags & flags::PLACEHOLDER != 0 && p.flags & flags::EXPERT_NAME != 0);
    let text = p.family_text.unwrap();
    assert_eq!(chars_of(&text).len(), 12);
    assert!(!text.chars().any(|c| c.is_ascii_alphabetic()), "no placeholder slot in the sample: {text}");
    assert!(p.ascii_missing.contains('D') && !p.ascii_missing.contains('5'));
}

#[test]
fn the_name_signal_can_be_only_in_the_file_name() {
    let data = placeholder_font(false).build();
    let face = Face::parse(&data, 0).unwrap();
    let names = Names { family: "Eureka Sans", subfamily: "Regular", full: "", postscript: "", file_stem: "EurekaSans_Exp" };
    assert_eq!(profile::profile(&face, &names).kind, Kind::Expert);
    let names = Names { file_stem: "EurekaSansExpanded", ..names };
    assert_ne!(profile::profile(&face, &names).kind, Kind::Expert, "Expanded isn't Expert");
}

#[test]
fn an_expert_name_and_missing_letters_make_an_expert_set() {
    // BigCaslonExp: small capitals in the letter slots, six letters missing, no placeholder and
    // no empty slots. Its family name draws, as "ᵇIG¢ASLON".
    let mut font = FontBuilder::new().chars(" 0123456789").chars(EXPERT_REAL);
    for c in ('A'..='Z').chain('a'..='z').filter(|c| !"FGJKPQ".contains(*c)) {
        font.char(c as u32, None);
    }
    let data = font.build();
    let face = Face::parse(&data, 0).unwrap();
    let names = Names { family: "BigCaslon", subfamily: "Medium", full: "BigCaslon Medium", postscript: "BigCaslon-Medium", file_stem: "BigCaslonExp" };
    let p = profile::profile(&face, &names);
    assert_eq!(p.kind, Kind::Expert);
    assert!(p.flags & flags::MISSING_LETTERS != 0 && p.flags & flags::EXPERT_NAME != 0);
    let roman = Names { file_stem: "BigCaslonRom", ..names };
    assert_eq!(profile::profile(&face, &roman).kind, Kind::Name, "without the name signal, a few missing letters are just missing");
}

#[test]
fn placeholder_font_without_an_expert_name_is_a_partial_set() {
    let p = profile_of(&placeholder_font(false), "MetaCond Black");
    assert_eq!(p.kind, Kind::Partial);
    assert_eq!(p.label.as_deref(), Some("Partial set"));
    let text = p.family_text.unwrap();
    assert!(text.starts_with("0123456789"), "letters and digits first: {text}");
    assert!(!text.chars().any(|c| c.is_ascii_alphabetic()));
}

#[test]
fn placeholder_lowercase_falls_back_to_capitals() {
    // Demo fonts whose lowercase is a filler (Kalaya, Commander, Mode).
    let p = profile_of(&placeholder_font(true), "Kalaya");
    assert_eq!(p.kind, Kind::Case);
    assert_eq!(p.family_text.as_deref(), Some("KALAYA"));
}

#[test]
fn one_shape_by_design_still_draws_its_name() {
    // BLOKK and Redacted: every character is the same block.
    let mut font = FontBuilder::new();
    font.char(0x20, Some(Shape::Empty));
    for b in 0x21u32..0x7F {
        font.char(b, Some(Shape::Rect { x0: 0, y0: 0, x1: 500, y1: 500 }));
    }
    let p = profile_of(&font, "BLOKK");
    assert_eq!(p.kind, Kind::Name);
    assert_eq!(p.flags & flags::PLACEHOLDER, 0);
}

#[test]
fn big_fonts_may_share_shapes_between_letters() {
    // Over 400 inked code points: letters sharing outlines there is legitimate (Flow Circular).
    let mut font = FontBuilder::new();
    for c in ('A'..='Z').chain('a'..='z') {
        font.char(c as u32, Some(Shape::Rect { x0: 0, y0: 0, x1: 500, y1: 500 }));
    }
    for cp in 0x4E00..0x4E00 + 400 {
        font.char(cp, None);
    }
    let p = profile_of(&font, "FlowCircular");
    assert_eq!(p.kind, Kind::Name);
}

#[test]
fn empty_letter_slots_with_an_expert_name_are_expert() {
    let mut font = FontBuilder::new().chars(" ").chars(EXPERT_REAL);
    for c in ('A'..='Z').chain('a'..='z').chain('0'..='9') {
        font.char(c as u32, Some(Shape::Empty));
    }
    let p = profile_of(&font, "Oneleigh Expert");
    assert_eq!(p.kind, Kind::Expert);
    assert!(p.flags & flags::EMPTY_LETTERS != 0);
    assert!(chars_of(p.family_text.as_deref().unwrap()).iter().all(|cp| EXPERT_REAL.contains(char::from_u32(*cp).unwrap())));
}

#[test]
fn expert_glyph_names_on_letters_make_an_expert_set() {
    // Letter slots named like JeunesseExpert's (D = Ethsmall, G = onequarter), with no Expert
    // word anywhere in the names.
    let expert_names = ["Asmall", "Bsmall", "Csmall", "Ethsmall", "Esmall", "Fsmall", "onequarter", "Hsmall", "Ismall", "Jsmall", "Ksmall", "Lsmall"];
    let mut font = FontBuilder::new().chars(" 0123456789");
    for (i, c) in ('a'..='z').enumerate() {
        let gid = font.char(c as u32, None);
        if let Some(n) = expert_names.get(i) {
            font.set_glyph_name(gid, n);
        }
    }
    let p = profile_of(&font, "Jeunesse");
    assert!(p.flags & flags::EXPERT_GLYPH_NAMES != 0);
    assert_eq!(p.kind, Kind::Expert);
}

#[test]
fn dotted_alternate_names_are_not_expert_names() {
    // Didot names its default figures zero.oldstyle; a "." means a modern alternate.
    let mut font = FontBuilder::new().chars(" ");
    let digits = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
    for (i, d) in digits.iter().enumerate() {
        let gid = font.char('0' as u32 + i as u32, None);
        font.set_glyph_name(gid, &format!("{d}.oldstyle"));
    }
    for c in ('A'..='Z').chain('a'..='z') {
        let gid = font.char(c as u32, None);
        font.set_glyph_name(gid, &format!("{c}.small"));
    }
    let p = profile_of(&font, "Didot");
    assert_eq!(p.flags & (flags::EXPERT_GLYPH_NAMES | flags::EXPERT), 0);
    assert_eq!(p.kind, Kind::Name);
}

// ---------------------------------------------------------------------------- script samples

fn arabic_font() -> FontBuilder {
    let mut font = FontBuilder::new().chars(" ،؟");
    for cp in (0x0621..=0x063A).chain(0x0641..=0x064A) {
        font.char(cp, None);
    }
    font
}

#[test]
fn script_font_uses_its_own_sample_text() {
    let font = arabic_font().name(19, "أبجد هوز");
    let p = profile_of(&font, "Al Nile");
    assert_eq!(p.kind, Kind::Sample19);
    assert_eq!(p.family_text.as_deref(), Some("أبجد هوز"));
    assert_eq!(p.label, None, "the font's own text needs no label");
}

#[test]
fn unusable_sample_text_is_skipped() {
    // Name ID 19 with characters the font lacks (or just "??") doesn't count.
    let p = profile_of(&arabic_font().name(19, "The quick brown fox"), "Al Nile");
    assert_eq!(p.kind, Kind::Script);
    let p = profile_of(&arabic_font().name(19, "؟؟"), "Al Nile");
    assert_eq!(p.kind, Kind::Script);
}

#[test]
fn script_font_without_sample_text_shows_its_first_letters() {
    let p = profile_of(&arabic_font(), "Al Nile");
    assert_eq!(p.kind, Kind::Script);
    assert_eq!(p.label.as_deref(), Some("Arabic"));
    let text = p.family_text.unwrap();
    assert_eq!(text.chars().count(), 10);
    assert!(text.chars().all(char::is_alphabetic), "letters only, no punctuation: {text}");
    assert_eq!(text.chars().next(), Some('\u{0621}'));
}

#[test]
fn meta_table_picks_the_script() {
    // More Cyrillic than Arabic, but the font says it's for Arabic.
    let mut font = arabic_font().meta(b"slng", "Arab");
    for cp in 0x0410..0x0450 {
        font.char(cp, None);
    }
    assert_eq!(profile_of(&font, "Al Nile").label.as_deref(), Some("Arabic"));
    let mut font = arabic_font();
    for cp in 0x0410..0x0450 {
        font.char(cp, None);
    }
    assert_eq!(profile_of(&font, "Al Nile").label.as_deref(), Some("Cyrillic"), "without meta, the biggest script");
}

#[test]
fn hebrew_presentation_forms_are_hebrew() {
    let mut font = FontBuilder::new().chars(" ");
    for cp in (0xFB2A..=0xFB36).chain(0xFB38..=0xFB3C) {
        font.char(cp, None);
    }
    let p = profile_of(&font, "Arial Hebrew");
    assert_eq!(p.kind, Kind::Script);
    assert_eq!(p.label.as_deref(), Some("Hebrew"));
}

// ------------------------------------------------------------------------- metrics and ink

#[test]
fn zero_hhea_falls_back_to_typo_metrics() {
    let mut font = latin_except("");
    font.hhea = (0, 0);
    font.os2 = Some((700, -200, 900, 300));
    assert_eq!(profile_of(&font, "Rix").ascent, 0.7);
    assert_eq!(profile_of(&font, "Rix").descent, 0.2);
    font.hhea = (900, -141);
    font.os2 = Some((800, -200, 1000, 250));
    let p = profile_of(&font, "Kleemax");
    assert_eq!((p.ascent, p.descent), (0.9, 0.141), "hhea wins even when typo metrics differ");
    font.hhea = (1000, 250);
    assert_eq!(profile_of(&font, "Monica").descent, 0.25, "a descender stored as positive is still below the baseline");
    font.hhea = (1000, 0);
    assert_eq!(profile_of(&font, "Futurama").descent, 0.0, "a TrueType font's zero descender stays zero");
}

#[test]
fn variable_fonts_honour_use_typo_metrics() {
    // CoreText reads OS/2 typo metrics for a variable font with USE_TYPO_METRICS (Ardela Edge
    // Variable), but hhea for a static one (Kleemax).
    let mut font = latin_except("");
    font.hhea = (960, -250);
    font.os2 = Some((800, -210, 955, 270));
    font.use_typo_metrics = true;
    assert_eq!(profile_of(&font, "Static").ascent, 0.96);
    let mut fvar = Vec::new();
    for v in [1u16, 0, 16, 2, 1, 20, 0, 8] {
        fvar.extend(v.to_be_bytes()); // version, axes offset, count 1, size 20, no instances
    }
    fvar.extend(b"wght");
    for fixed in [100u32 << 16, 400 << 16, 900 << 16] {
        fvar.extend(fixed.to_be_bytes());
    }
    fvar.extend([0, 0, 1, 0]);
    let font = font.raw_table(b"fvar", fvar);
    let p = profile_of(&font, "Ardela Edge Variable");
    assert_eq!((p.ascent, p.descent), (0.8, 0.21));
}

#[test]
fn variable_glyphs_that_cant_be_outlined_still_count_as_ink() {
    let mut font = FontBuilder::new().chars(" ");
    for c in "Broken".chars() {
        font.char(c as u32, Some(Shape::Broken));
    }
    // A static font: the glyph draws nothing.
    let data = font.build();
    let face = Face::parse(&data, 0).unwrap();
    let view = FontView::new(&face);
    let g = view.glyph('B' as u32).unwrap();
    assert_eq!(face.glyph_bounding_box(g), None, "the outline really fails");
    assert!(!view.real(g));
    // With variation data (here one ttf-parser can't even read), the glyph has ink we can't
    // measure: ttf-parser can't apply some variations, and CoreText draws them.
    let font = font.raw_table(b"gvar", vec![0; 20]);
    let data = font.build();
    let face = Face::parse(&data, 0).unwrap();
    let view = FontView::new(&face);
    assert_eq!(view.ink(g), Ink::Unknown);
    assert!(view.real(g), "unknown ink isn't an empty slot");
    let p = profile::profile_of(&view, &names("Broken"));
    assert_eq!(p.kind, Kind::Name);
    assert_eq!(p.ink, None, "no outline, so no ink extent");
}

#[test]
fn one_point_glyphs_draw_nothing() {
    // Material Icons maps a–z to glyphs of a single point: alone they draw nothing (words such
    // as "home" become icons through ligatures).
    let mut font = FontBuilder::new().chars(" ");
    let letters: Vec<u16> = ('a'..='z').map(|c| font.char(c as u32, Some(Shape::Point))).collect();
    let icons: Vec<u16> = (0xE000..0xE020).map(|cp| font.char(cp, None)).collect();
    let letter = |c: char| letters[(c as u8 - b'a') as usize];
    let data = font.build();
    let face = Face::parse(&data, 0).unwrap();
    let view = FontView::new(&face);
    let g = GlyphId(letter('h'));
    assert_eq!(view.ink(g), Ink::None);
    assert!(!view.real(g));
    let p = profile::profile_of(&view, &names("material icons"));
    assert_eq!(p.kind, Kind::Symbols, "the name would draw as blanks");
    assert!(chars_of(p.family_text.as_deref().unwrap()).iter().all(|cp| (0xE000..0xE020).contains(cp)));
    assert!(p.ascii_missing.contains('h'));

    // With ligatures, a letter that starts one isn't missing: typed "home" draws a house.
    let home = [letter('h'), letter('o'), letter('m'), letter('e')];
    let add = [letter('a'), letter('d'), letter('d')];
    let font = font.raw_table(b"GSUB", ligature_gsub(&[(&home[..], icons[0]), (&add[..], icons[1])]));
    let p = profile_of(&font, "material icons");
    assert_eq!(p.kind, Kind::Symbols);
    assert!(!p.ascii_missing.contains('h') && !p.ascii_missing.contains('a'), "{}", p.ascii_missing);
    assert!(p.ascii_missing.contains('o') && p.ascii_missing.contains('z'), "{}", p.ascii_missing);
}

#[test]
fn sbix_only_glyphs_are_real() {
    let mut font = FontBuilder::new().chars(" ");
    let emoji = font.char(0x1F600, Some(Shape::Empty));
    let plain = font.char(0x1F601, Some(Shape::Empty));
    let font = {
        let count = font.glyph_count();
        font.raw_table(b"sbix", sbix_table(count, &[emoji]))
    };
    let data = font.build();
    let face = Face::parse(&data, 0).unwrap();
    let view = FontView::new(&face);
    assert!(view.real(ttf_parser::GlyphId(emoji)));
    assert!(!view.real(ttf_parser::GlyphId(plain)), "no outline and no image");
    let p = profile::profile_of(&view, &names("Apple Color Emoji"));
    assert_eq!(p.kind, Kind::Symbols);
    assert_eq!(p.family_text.as_deref(), Some("😀"));
}

#[test]
fn emoji_sharing_a_stand_in_outline_stay_distinct() {
    // Apple Color Emoji draws a picture over the same box outline for every emoji; the box
    // mustn't make them all look like one shape (or like a placeholder).
    let mut font = FontBuilder::new().chars(" ");
    let boxed = Shape::Rect { x0: 50, y0: 0, x1: 750, y1: 700 };
    let emoji: Vec<u16> = (0x1F600..0x1F610).map(|cp| font.char(cp, Some(boxed))).collect();
    let font = {
        let count = font.glyph_count();
        font.raw_table(b"sbix", sbix_table(count, &emoji))
    };
    let p = profile_of(&font, "Apple Color Emoji");
    assert_eq!(p.kind, Kind::Symbols);
    assert_eq!(chars_of(p.family_text.as_deref().unwrap()).len(), 12, "12 different emoji, not one");
}

#[test]
fn second_face_of_a_collection() {
    let first = latin_except("").named("First Sans").tables();
    let second = FontBuilder::new().chars(" ABCDEFGHIJKLMNOPQRSTUVWXYZ").named("Kleemax DEMO").tables();
    let data = collection(&[first, second]);
    let face = Face::parse(&data, 1).unwrap();
    let p = profile::profile(&face, &names("Kleemax DEMO"));
    assert_eq!(p.family_text.as_deref(), Some("KLEEMAX DEMO"));
    let face = Face::parse(&data, 0).unwrap();
    assert_eq!(profile::profile(&face, &names("First Sans")).kind, Kind::Name);
}

#[test]
fn tall_icons_record_their_ascent_and_ink() {
    // LI Glyphs: 2048 units per em, icons twice the em tall, and honest metrics to match.
    let mut font = FontBuilder::new();
    font.units_per_em = 2048;
    font.hhea = (4194, -40);
    font.os2 = Some((1638, -410, 4194, 40));
    font.char(0x20, Some(Shape::Empty));
    for c in ('A'..='Z').chain('a'..='d').chain('0'..='9') {
        let i = c as i16;
        font.char(c as u32, Some(Shape::Rect { x0: 0, y0: 0, x1: 1000 + i, y1: 4195 }));
    }
    let p = profile_of(&font, "LI Glyphs");
    assert_eq!(p.kind, Kind::Symbols, "the name has letters the font lacks, and it's an icon font");
    assert!((p.ascent - 2.048).abs() < 0.001 && (p.descent - 0.0195).abs() < 0.001, "{} {}", p.ascent, p.descent);
    let (top, bottom) = p.ink.unwrap();
    assert!((top - 2.048).abs() < 0.001 && bottom.abs() < 0.001, "{top} {bottom}");
}

#[test]
fn each_name_keeps_its_own_kind() {
    // Magdelena: capitals only, and a full name ending in a colon the font lacks. The family row
    // draws MAGDELENA; the style row needs a sample, and gets the badge.
    let data = FontBuilder::new().chars(" ABCDEFGHIJKLMNOPQRSTUVWXYZ").build();
    let face = Face::parse(&data, 0).unwrap();
    let names = Names { family: "Magdelena", subfamily: "Plain", full: "Magdelena Plain:", ..Default::default() };
    let p = profile::profile(&face, &names);
    assert_eq!((p.kind, p.full_kind), (Kind::Case, Kind::Partial));
    assert_eq!(p.family_text.as_deref(), Some("MAGDELENA"));
    assert_eq!(p.full_text.as_deref(), Some("ABCDEFGHIJKL"));
    assert_eq!(p.label.as_deref(), Some("Partial set"));
    assert_eq!(PreviewInfo::from_profile(&p).full_kind.as_deref(), Some("partial"));
    let plain = profile_of(&latin_except(""), "Plain Sans");
    assert_eq!(plain.full_kind, Kind::Name);
    assert_eq!(PreviewInfo::from_profile(&plain).full_kind, None, "sent only when it differs");
}

#[test]
fn glyph_names_are_the_ones_ttf_parser_reads() {
    let mut font = latin_except("");
    font.glyph_names = true;
    let data = font.build();
    let face = Face::parse(&data, 0).unwrap();
    let view = FontView::new(&face);
    let mut named = 0;
    for g in 0..face.number_of_glyphs() {
        let g = GlyphId(g);
        assert_eq!(view.glyph_name(g), face.glyph_name(g), "glyph {}", g.0);
        named += view.glyph_name(g).is_some() as usize;
    }
    assert!(named > 90);
}

// ----------------------------------------------------------------------------------- limits

/// A `cmap` listing each subtable under (3,10), each `repeat` times.
fn cmap_table(subtables: &[Vec<u8>], repeat: usize) -> Vec<u8> {
    let records = subtables.len() * repeat;
    let mut t = Vec::new();
    t.extend(0u16.to_be_bytes());
    t.extend((records as u16).to_be_bytes());
    let mut offsets = Vec::new();
    let mut at = 4 + 8 * records;
    for st in subtables {
        offsets.push(at);
        at += st.len();
    }
    for _ in 0..repeat {
        for offset in &offsets {
            t.extend(3u16.to_be_bytes());
            t.extend(10u16.to_be_bytes());
            t.extend((*offset as u32).to_be_bytes());
        }
    }
    for st in subtables {
        t.extend(st);
    }
    t
}

/// A format 12 (one glyph after another) or 13 (one glyph for the whole range) subtable.
fn groups(format: u16, groups: &[(u32, u32, u32)]) -> Vec<u8> {
    let mut t = Vec::new();
    t.extend(format.to_be_bytes());
    t.extend(0u16.to_be_bytes());
    t.extend(((16 + 12 * groups.len()) as u32).to_be_bytes());
    t.extend(0u32.to_be_bytes());
    t.extend((groups.len() as u32).to_be_bytes());
    for (start, end, glyph) in groups {
        for v in [start, end, glyph] {
            t.extend(v.to_be_bytes());
        }
    }
    t
}

/// A format 4 subtable of `n` segments that all cover U+0000–U+FFFE.
fn overlapping_segments(n: usize) -> Vec<u8> {
    let segs = n + 1;
    let mut t = Vec::new();
    for v in [4u16, (16 + 8 * segs) as u16, 0, (2 * segs) as u16, 0, 0, 0] {
        t.extend(v.to_be_bytes());
    }
    let column = |first: u16, last: u16| -> Vec<u8> { (0..segs).flat_map(|i| if i < n { first } else { last }.to_be_bytes()).collect() };
    t.extend(column(0xFFFE, 0xFFFF)); // ends
    t.extend(0u16.to_be_bytes());
    t.extend(column(0, 0xFFFF)); // starts
    t.extend(column(1, 1)); // deltas: glyph = code + 1
    t.extend(column(0, 0)); // no range offsets
    t
}

/// A font with 60 glyphs whose character map is `cmap`, and the time its profile and its
/// characters took.
fn hostile(cmap: Vec<u8>) -> (Profile, usize, Duration) {
    let mut font = FontBuilder::new();
    for i in 0..60 {
        font.glyph(Shape::bar(100 + i, 700), None);
    }
    let data = font.raw_table(b"cmap", cmap).build();
    let face = Face::parse(&data, 0).unwrap();
    let start = Instant::now();
    let view = FontView::new(&face);
    let p = profile::profile_of(&view, &names("Hostile"));
    let grid = super::characters::characters(&face, &names("Hostile"));
    assert!(grid.total <= limits::CODE_POINTS);
    (p, view.map.len(), start.elapsed())
}

/// How long a hostile font may take (its profile and its character grid). Unoptimized test
/// builds are many times slower than the app, and run the tests side by side.
const QUICK: Duration = if cfg!(debug_assertions) { Duration::from_secs(6) } else { Duration::from_secs(1) };

#[test]
fn a_character_map_claiming_every_code_point_is_cut_short() {
    // One format 12 group from 0 to 0xFFFFFFFF: ttf-parser would walk four billion codes.
    let (p, mapped, took) = hostile(cmap_table(&[groups(12, &[(0, u32::MAX, 1)])], 1));
    assert!(took < QUICK, "{took:?}");
    assert_eq!(mapped, 60, "codes 0–59 reach glyphs 1–60; past glyph 65,535 the group ends");
    assert_eq!(p.flags & flags::LIMITED, 0);
    // The same as format 13: every code point maps to one glyph.
    let (p, mapped, took) = hostile(cmap_table(&[groups(13, &[(0, u32::MAX, 5)])], 1));
    assert!(took < QUICK, "{took:?}");
    assert_eq!(mapped, limits::CODE_POINTS, "kept up to the limit");
    assert_eq!(p.kind, Kind::Name);
    assert!(p.flags & flags::LIMITED != 0);
}

#[test]
fn many_character_maps_share_one_budget() {
    // One full-range subtable listed 2,000 times is read once.
    let (_, mapped, took) = hostile(cmap_table(&[groups(13, &[(0, 0x10FFFF, 5)])], 2000));
    assert!(took < QUICK, "{took:?}");
    assert_eq!(mapped, limits::CODE_POINTS);
    // 40 different subtables that each repeat the same 131,072 codes: the visits run out.
    let many: Vec<Vec<u8>> = (0..40).map(|i| groups(13, &[(0, 0x1FFFF, 5 + i)])).collect();
    let (p, mapped, took) = hostile(cmap_table(&many, 1));
    assert!(took < QUICK, "{took:?}");
    assert_eq!(mapped, 0x20000, "the first subtable's");
    println!("hostile character maps: {took:?} for the profile and the character grid");
    assert!(p.flags & flags::LIMITED != 0);
}

#[test]
fn overlapping_segments_are_visited_once() {
    // 8,000 segments over the whole BMP: two billion codes as ttf-parser lists them.
    let (p, mapped, took) = hostile(cmap_table(&[overlapping_segments(8000)], 1));
    assert!(took < QUICK, "{took:?}");
    assert_eq!(mapped, 60, "codes 0–59 map to glyphs 1–60; the rest point past the font");
    assert_eq!(p.flags & flags::LIMITED, 0);
}

#[test]
fn composite_bombs_are_not_drawn() {
    // Each level places the one below four times: 4^20 outlines from a few hundred bytes.
    let mut font = FontBuilder::new().chars(" ");
    let mut bomb = font.glyph(Shape::bar(300, 700), None);
    for _ in 0..20 {
        bomb = font.glyph(Shape::Composite { glyph: bomb, times: 4 }, None);
    }
    for c in "Bomb".chars() {
        font.map(Cmap::Unicode, c as u32, bomb);
    }
    // A glyph of a few components is fine.
    let base = font.glyph(Shape::bar(300, 700), None);
    let pair = font.glyph(Shape::Composite { glyph: base, times: 2 }, None);
    font.map(Cmap::Unicode, 'x' as u32, pair);
    let data = font.build();
    let face = Face::parse(&data, 0).unwrap();
    let start = Instant::now();
    let view = FontView::new(&face);
    let p = profile::profile_of(&view, &names("Bomb"));
    assert!(start.elapsed() < QUICK, "{:?}", start.elapsed());
    assert_eq!(p.kind, Kind::Name, "drawn, its size unknown");
    assert_eq!(view.ink(GlyphId(bomb)), Ink::Unknown);
    assert!(p.flags & flags::LIMITED != 0);
    assert_eq!(view.ink(GlyphId(pair)), Ink::Outline { y_min: 0, y_max: 700 });
}

#[test]
fn glyphs_drawing_too_many_segments_are_stopped() {
    // 100 copies of a 60,000-point outline: few components, but six million segments.
    let mut font = FontBuilder::new().chars(" ");
    let long = font.glyph(Shape::Zigzag { points: 60_000 }, None);
    let heavy = font.glyph(Shape::Composite { glyph: long, times: 100 }, None);
    for c in "Heavy".chars() {
        font.map(Cmap::Unicode, c as u32, heavy);
    }
    let lone = font.glyph(Shape::Composite { glyph: long, times: 1 }, None);
    font.map(Cmap::Unicode, 'z' as u32, lone);
    let data = font.build();
    let face = Face::parse(&data, 0).unwrap();
    let start = Instant::now();
    let view = FontView::new(&face);
    let p = profile::profile_of(&view, &names("Heavy"));
    assert!(start.elapsed() < QUICK, "{:?}", start.elapsed());
    assert_eq!(view.ink(GlyphId(heavy)), Ink::Unknown);
    assert!(p.flags & flags::LIMITED != 0);
    assert!(matches!(view.ink(GlyphId(lone)), Ink::Outline { .. }), "60,000 segments are within the limit");
}

#[test]
fn reader_threads_answer_and_outlive_a_failed_job() {
    let readers = super::readers();
    tauri::async_runtime::block_on(async {
        assert_eq!(readers.run_if(|| true, || 2 + 2).await.unwrap(), Some(4));
        let failed = readers.run_if(|| true, || -> i32 { std::panic::resume_unwind(Box::new("damaged font")) }).await;
        assert!(failed.is_err());
        let (one, two) = (readers.run_if(|| true, || 1), readers.run_if(|| true, || 2));
        assert_eq!((one.await.unwrap(), two.await.unwrap()), (Some(1), Some(2)), "the threads carry on");
    });
}

/// `threads` reader threads of their own, `held` of them busy with a job until its gate is
/// opened (or dropped): jobs sent meanwhile wait for a free thread. Keep the returned futures
/// until then, since a job nobody waits for is skipped.
#[allow(clippy::type_complexity)]
fn held_readers(
    threads: usize,
    held: usize,
) -> (super::Readers, Vec<std::sync::mpsc::Sender<()>>, Vec<impl std::future::Future<Output = crate::error::AppResult<Option<()>>>>) {
    let readers = super::Readers::start(threads, "fontface-test-reader");
    let (gates, holds) = (0..held)
        .map(|_| {
            let (open, wait) = std::sync::mpsc::channel::<()>();
            let hold = readers.run_if(|| true, move || {
                let _ = wait.recv();
            });
            (open, hold)
        })
        .unzip();
    (readers, gates, holds)
}

#[test]
fn a_lane_skips_jobs_replaced_before_they_started() {
    static LANE: super::Lane = super::Lane::new();
    let (readers, gates, holds) = held_readers(1, 1);
    let ran = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    // Holding an arrow key through five fonts while the only reader is busy.
    let asked: Vec<_> = (0..5)
        .map(|i| {
            let ran = ran.clone();
            LANE.run_on(&readers, move || {
                ran.lock().unwrap().push(i);
                i
            })
        })
        .collect();
    drop(gates);
    tauri::async_runtime::block_on(async {
        for hold in holds {
            hold.await.unwrap();
        }
        let mut answers = Vec::new();
        for job in asked {
            answers.push(job.await.unwrap());
        }
        assert_eq!(answers, vec![None, None, None, None, Some(4)], "only the latest is answered");
        // A job sent after the latest has run is the new latest, and runs.
        let ran2 = ran.clone();
        assert_eq!(LANE.run_on(&readers, move || ran2.lock().unwrap().push(5)).await.unwrap(), Some(()));
    });
    assert_eq!(*ran.lock().unwrap(), vec![4, 5], "replaced jobs read nothing");
}

#[test]
fn a_job_nobody_waits_for_is_skipped() {
    let (readers, gates, holds) = held_readers(1, 1);
    let ran = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = ran.clone();
    // Sent, then given up on before its turn (its caller went away).
    drop(readers.run_if(|| true, move || flag.store(true, std::sync::atomic::Ordering::SeqCst)));
    let unwanted = readers.run_if(|| false, || panic!("not wanted, so never run"));
    drop(gates);
    tauri::async_runtime::block_on(async {
        for hold in holds {
            hold.await.unwrap();
        }
        assert_eq!(unwanted.await.unwrap(), None);
        // One thread takes jobs in order: once this answers, the dropped job has had its turn.
        assert_eq!(readers.run_if(|| true, || 7).await.unwrap(), Some(7));
    });
    assert!(!ran.load(std::sync::atomic::Ordering::SeqCst), "a job nobody waits for reads nothing");
}

#[test]
fn a_hung_read_holds_up_only_its_own_thread() {
    // One of two readers is stuck (a network share that stopped answering); the other carries on.
    let (readers, gates, holds) = held_readers(2, 1);
    let (done, finished) = std::sync::mpsc::channel();
    let jobs: Vec<_> = (0..4)
        .map(|i| {
            let done = done.clone();
            readers.run_if(|| true, move || done.send(i).unwrap())
        })
        .collect();
    let mut answered: Vec<i32> =
        (0..4).map(|_| finished.recv_timeout(Duration::from_secs(5)).expect("the other thread answers")).collect();
    answered.sort();
    assert_eq!(answered, vec![0, 1, 2, 3]);
    drop(gates);
    tauri::async_runtime::block_on(async {
        for hold in holds {
            hold.await.unwrap();
        }
        for job in jobs {
            assert_eq!(job.await.unwrap(), Some(()));
        }
    });
}

#[test]
fn reads_never_run_more_than_two_at_once() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering::SeqCst},
        Arc,
    };
    assert_eq!(super::READER_THREADS, 2);
    let running = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let read = |running: Arc<AtomicUsize>, peak: Arc<AtomicUsize>| {
        move || {
            peak.fetch_max(running.fetch_add(1, SeqCst) + 1, SeqCst);
            std::thread::sleep(Duration::from_millis(10));
            running.fetch_sub(1, SeqCst);
        }
    };
    // Profile calls, character grids and other reads all share the app's two reader threads.
    let mut jobs = Vec::new();
    for _ in 0..6 {
        jobs.push(super::readers().run_if(|| true, read(running.clone(), peak.clone())));
    }
    let profiles = super::PROFILE_LANE.run(read(running.clone(), peak.clone()));
    let characters = super::CHARACTER_LANE.run(read(running.clone(), peak.clone()));
    tauri::async_runtime::block_on(async {
        for job in jobs {
            assert_eq!(job.await.unwrap(), Some(()));
        }
        assert_eq!(profiles.await.unwrap(), Some(()));
        assert_eq!(characters.await.unwrap(), Some(()));
    });
    let peak = peak.load(SeqCst);
    assert!((1..=2).contains(&peak), "{peak} reads at once");
}

#[test]
fn a_skipped_profile_call_asks_for_its_ids_again_later() {
    let ids: Vec<i64> = (1..=70).collect();
    let answers = super::OnDemand::skipped(&ids);
    assert_eq!(answers.len(), super::MAX_ON_DEMAND, "no more than a call carries");
    assert!(answers.iter().all(|a| a.preview.is_none() && a.retry));
    assert_eq!(answers[0].id, 1);
}

// ------------------------------------------------------------------------------- characters

#[test]
fn character_grid_hides_placeholders_and_empty_slots() {
    let mut font = placeholder_font(false);
    font.char('!' as u32, Some(Shape::Empty));
    font.glyph_names = true;
    let data = font.build();
    let face = Face::parse(&data, 0).unwrap();
    let chars = super::characters::characters(&face, &names("MetaCond Black Expert"));
    assert!(chars.expert);
    assert_eq!(chars.placeholders, 52);
    assert_eq!(chars.empty, 1, "the space isn't counted, the empty ! is");
    assert_eq!(chars.total, 10 + EXPERT_REAL.chars().count());
    let first = &chars.blocks[0];
    assert_eq!(first.name, "Basic Latin");
    assert_eq!(first.runs, vec![[0x30, 0x39]]);
    assert_eq!(first.glyph_names.len(), 10);
    assert_eq!(first.glyph_names[0], "0");
    assert!(chars.blocks.iter().any(|b| b.name == "Alphabetic Presentation Forms"));
    assert_eq!(chars.blocks.iter().map(|b| b.count()).sum::<usize>(), chars.total);
    assert!((chars.ink_top - 0.7).abs() < 0.01);
}

// -------------------------------------------------------------------------------- the table

mod stored {
    use std::{
        path::{Path, PathBuf},
        sync::{atomic::AtomicBool, Arc},
    };

    use rusqlite::Connection;

    use super::latin_except;
    use crate::{db, preview, scanner, test_fonts::FontBuilder};

    struct Library {
        dir: PathBuf,
        folder: i64,
    }

    impl Library {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("fontface-preview-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("fonts")).unwrap();
            let dir = std::fs::canonicalize(dir).unwrap();
            let mut conn = db::open(&dir.join("library.sqlite3")).unwrap();
            preview::ensure_schema(&conn).unwrap();
            let folder = db::insert_folder(&mut conn, &dir.join("fonts"), "user").unwrap();
            Library { dir, folder }
        }
        fn db(&self) -> PathBuf {
            self.dir.join("library.sqlite3")
        }
        fn conn(&self) -> Connection {
            db::open(&self.db()).unwrap()
        }
        fn write(&self, name: &str, font: &FontBuilder) -> PathBuf {
            let path = self.dir.join("fonts").join(name);
            std::fs::write(&path, font.build()).unwrap();
            path
        }
        fn scan(&self) {
            scanner::scan_folder(&self.db(), self.folder, &self.dir.join("fonts"), &Arc::new(AtomicBool::new(false)), |_| {}).unwrap();
        }
        fn previews(&self) -> Vec<(String, Option<String>, Option<String>)> {
            db::list_fonts(&self.conn())
                .unwrap()
                .into_iter()
                .map(|f| (f.family, f.preview.as_ref().map(|p| p.kind.clone()), f.preview.and_then(|p| p.family_text)))
                .collect()
        }
        fn rows(&self) -> i64 {
            self.conn().query_row("SELECT COUNT(*) FROM face_previews", [], |r| r.get(0)).unwrap()
        }
    }

    impl Drop for Library {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn two_fonts(lib: &Library) {
        lib.write("Plain.ttf", &latin_except("").named("Plain Sans"));
        lib.write("Kleemax.ttf", &FontBuilder::new().chars(" ABCDEFGHIJKLMNOPQRSTUVWXYZ").named("Kleemax DEMO"));
    }

    #[test]
    fn a_scan_writes_profiles() {
        let lib = Library::new("scan");
        two_fonts(&lib);
        lib.scan();
        assert_eq!(lib.rows(), 2);
        assert_eq!(
            lib.previews(),
            vec![
                ("Kleemax DEMO".into(), Some("case".into()), Some("KLEEMAX DEMO".into())),
                ("Plain Sans".into(), Some("name".into()), None),
            ]
        );
        let detail = db::get_font(&lib.conn(), 1).unwrap().unwrap();
        assert!(detail.summary.preview.is_some(), "the detail view carries the profile too");
        let json = serde_json::to_value(&db::list_fonts(&lib.conn()).unwrap()[1]).unwrap();
        assert_eq!(json["preview"], serde_json::json!({"kind": "name", "ascent": 0.8, "descent": 0.2, "inkTop": 0.7, "inkBottom": 0.0}));
    }

    #[test]
    fn a_style_row_kind_is_stored_when_it_differs() {
        let lib = Library::new("fullkind");
        lib.write("Magdelena.ttf", &FontBuilder::new().chars(" ABCDEFGHIJKLMNOPQRSTUVWXYZ").named("Magdelena").name(4, "Magdelena Plain:"));
        lib.write("Plain.ttf", &latin_except("").named("Plain Sans"));
        lib.scan();
        let fonts = db::list_fonts(&lib.conn()).unwrap();
        let kinds: Vec<(String, Option<String>)> =
            fonts.iter().map(|f| (f.preview.as_ref().unwrap().kind.clone(), f.preview.as_ref().unwrap().full_kind.clone())).collect();
        assert_eq!(kinds, vec![("case".into(), Some("partial".into())), ("name".into(), None)]);
        let json = serde_json::to_value(&fonts[0]).unwrap();
        assert_eq!(json["preview"]["fullKind"], "partial");
        assert_eq!(json["preview"]["label"], "Partial set");
    }

    #[test]
    fn an_older_table_gets_the_new_column() {
        let dir = std::env::temp_dir().join(format!("fontface-preview-oldtable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = db::open(&dir.join("library.sqlite3")).unwrap();
        conn.execute_batch(
            "CREATE TABLE face_previews (font_id INTEGER PRIMARY KEY REFERENCES fonts(id) ON DELETE CASCADE,
             file_size INTEGER NOT NULL, mtime INTEGER NOT NULL, rev INTEGER NOT NULL, kind TEXT NOT NULL,
             family_text TEXT, full_text TEXT, sample TEXT, label TEXT, ascii_missing TEXT NOT NULL DEFAULT '',
             flags INTEGER NOT NULL DEFAULT 0, ascent REAL, descent REAL, ink_top REAL, ink_bottom REAL)",
        )
        .unwrap();
        preview::ensure_schema(&conn).unwrap();
        preview::ensure_schema(&conn).unwrap();
        assert!(db::list_fonts(&conn).unwrap().is_empty(), "the list's join reads the new column");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stale_profiles_read_as_none() {
        let lib = Library::new("stale");
        two_fonts(&lib);
        lib.scan();
        let conn = lib.conn();
        conn.execute("UPDATE face_previews SET rev = rev + 1 WHERE font_id = 1", []).unwrap();
        assert_eq!(db::list_fonts(&conn).unwrap().iter().filter(|f| f.preview.is_none()).count(), 1, "an old rev");
        conn.execute("UPDATE face_previews SET rev = rev - 1", []).unwrap();
        conn.execute("UPDATE fonts SET mtime = mtime + 1 WHERE id = 2", []).unwrap();
        let fonts = db::list_fonts(&conn).unwrap();
        assert!(fonts.iter().find(|f| f.id == 2).unwrap().preview.is_none(), "the file changed since");
        assert!(fonts.iter().find(|f| f.id == 1).unwrap().preview.is_some());
    }

    #[test]
    fn deleting_a_font_removes_its_profile() {
        let lib = Library::new("delete");
        two_fonts(&lib);
        lib.scan();
        std::fs::remove_file(lib.dir.join("fonts/Plain.ttf")).unwrap();
        lib.scan();
        assert_eq!(lib.rows(), 1);
        lib.conn().execute("DELETE FROM fonts", []).unwrap();
        assert_eq!(lib.rows(), 0);
    }

    fn insert_font(conn: &Connection, folder: i64, path: &str, family: &str) -> i64 {
        conn.execute(
            "INSERT INTO fonts (folder_id, path, file_size, mtime, family, subfamily, weight, width, italic,
             monospace, variable, glyph_count, format) VALUES (?1, ?2, 1, 1, ?3, 'Regular', 400, 5, 0, 0, 0, 1, 'TrueType')",
            rusqlite::params![folder, path, family],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn backfill_picks_only_stale_rows_and_never_adobe() {
        let lib = Library::new("stalepick");
        let conn = lib.conn();
        let fonts = lib.dir.join("fonts");
        let current = insert_font(&conn, lib.folder, fonts.join("a.ttf").to_str().unwrap(), "Current");
        let missing = insert_font(&conn, lib.folder, fonts.join("b.ttf").to_str().unwrap(), "Missing");
        let old_rev = insert_font(&conn, lib.folder, fonts.join("c.ttc").to_str().unwrap(), "Old");
        let second_face = {
            conn.execute("INSERT INTO fonts (folder_id, path, face_index, file_size, mtime, family, subfamily, weight, width, italic, monospace, variable, glyph_count, format)
                SELECT folder_id, path, 1, file_size, mtime, 'Old Two', subfamily, weight, width, italic, monospace, variable, glyph_count, format FROM fonts WHERE id = ?1", [old_rev]).unwrap();
            conn.last_insert_rowid()
        };
        insert_font(&conn, lib.folder, "/Users/x/Library/Application Support/Adobe/CoreSync/plugins/livetype/.r/.123", "Adobe");
        let p = super::profile_of(&latin_except(""), "Current");
        assert!(preview::store(&conn, current, 1, 1, &p).unwrap());
        assert!(preview::store(&conn, old_rev, 1, 1, &p).unwrap());
        conn.execute("UPDATE face_previews SET rev = 0 WHERE font_id = ?1", [old_rev]).unwrap();
        assert!(!preview::store(&conn, 9999, 1, 1, &p).unwrap(), "no font row, nothing stored");
        assert!(!preview::store(&conn, missing, 2, 1, &p).unwrap(), "another version of the file, nothing stored");

        let stale = preview::stale_files(&conn).unwrap();
        let ids: Vec<Vec<i64>> = stale.iter().map(|g| g.iter().map(|r| r.id).collect()).collect();
        assert_eq!(ids, vec![vec![missing], vec![old_rev, second_face]], "grouped by file, read once");
    }

    #[test]
    fn backfill_fills_in_missing_profiles() {
        let lib = Library::new("backfill");
        two_fonts(&lib);
        lib.write("Broken.ttf", &FontBuilder::new()); // parses, but not as a library font? it does: no names
        lib.scan();
        let before = lib.rows();
        lib.conn().execute("DELETE FROM face_previews", []).unwrap();
        // An orphan left behind with foreign keys off.
        let conn = lib.conn();
        conn.execute_batch("PRAGMA foreign_keys = OFF; INSERT INTO face_previews (font_id, file_size, mtime, rev, kind) VALUES (777, 1, 1, 1, 'name'); PRAGMA foreign_keys = ON;").unwrap();
        let mut batches = Vec::new();
        let report = preview::backfill(&lib.db(), 2, |b| batches.push(b)).unwrap();
        assert_eq!(report.orphans_removed, 1);
        assert_eq!(report.written as i64, before);
        assert_eq!(lib.rows(), before);
        let last = batches.last().unwrap();
        assert!(last.done);
        assert_eq!(last.written as i64, before, "the list reloads once");
        let sent: usize = batches.iter().map(|b| b.profiles.len()).sum();
        assert_eq!(sent as i64, before);
        let again = preview::backfill(&lib.db(), 2, |_| {}).unwrap();
        assert_eq!((again.files, again.written), (0, 0), "nothing left to do");
    }

    #[test]
    fn a_backfill_that_saves_nothing_says_so() {
        // A file gone since its scan is looked at every launch; the list needn't reload for it.
        let lib = Library::new("nothingnew");
        two_fonts(&lib);
        lib.scan();
        let conn = lib.conn();
        insert_font(&conn, lib.folder, lib.dir.join("fonts/Gone.ttf").to_str().unwrap(), "Gone");
        let mut batches = Vec::new();
        let report = preview::backfill(&lib.db(), 2, |b| batches.push(b)).unwrap();
        assert_eq!((report.files, report.written, report.other), (1, 0, 1));
        assert_eq!(batches.len(), 1);
        assert!(batches[0].done && batches[0].written == 0 && batches[0].profiles.is_empty());
    }

    #[test]
    fn the_backfill_writer_rolls_back_before_giving_up_its_turn() {
        let lib = Library::new("writer");
        two_fonts(&lib);
        lib.scan();
        let mut writer = preview::Writer { conn: lib.conn(), turn: None };
        writer.begin().unwrap();
        writer.conn.execute("DELETE FROM face_previews", []).unwrap();
        drop(writer); // an error mid-batch
        assert_eq!(lib.rows(), 2, "rolled back");
        let mut writer = preview::Writer { conn: lib.conn(), turn: None };
        writer.begin().unwrap();
        writer.conn.execute("DELETE FROM face_previews WHERE font_id = 1", []).unwrap();
        writer.commit().unwrap();
        assert!(!writer.in_transaction());
        assert_eq!(lib.rows(), 1);
        let _turn = db::scan_write_turn(); // free again
    }

    #[test]
    fn on_demand_works_out_and_saves_missing_profiles() {
        let lib = Library::new("ondemand");
        two_fonts(&lib);
        lib.scan();
        let conn = lib.conn();
        conn.execute("DELETE FROM face_previews WHERE font_id = 2", []).unwrap();
        // A row whose file changed since the scan: worth asking again later.
        let path = lib.write("Changed.ttf", &latin_except(""));
        let changed = insert_font(&conn, lib.folder, path.to_str().unwrap(), "Changed");
        let answers = preview::on_demand(
            || preview::rows_for_ids(&conn, &[1, 2, changed, 12345]),
            |fresh| {
                for (row, p) in fresh {
                    preview::store(&conn, row.id, row.file_size, row.mtime, p)?;
                }
                Ok(())
            },
        )
        .unwrap();
        let by_id = |id: i64| answers.iter().find(|a| a.id == id).unwrap();
        assert_eq!(answers.len(), 3, "an unknown id is left out");
        assert!(by_id(1).preview.is_some() && by_id(2).preview.is_some());
        let changed = by_id(changed);
        assert!(changed.preview.is_none() && changed.retry);
        assert_eq!(lib.rows(), 2, "the recomputed profile was saved");
    }

    #[test]
    fn adobe_files_are_never_read() {
        let path = "/Users/x/Library/Application Support/Adobe/CoreSync/plugins/livetype/.r/.4512.otf";
        assert_eq!(preview::read_file(path, None), Err(preview::Unreadable::Adobe));
        assert!(preview::never_read("/Volumes/Backup/CoreSync/fonts/x.otf"));
        assert!(!preview::never_read("/Users/x/Library/Fonts/Inter.ttf"));
        assert_eq!(preview::read_file("/definitely/not/here.ttf", None), Err(preview::Unreadable::Missing));
        let _ = Path::new(path);
    }
}

// --------------------------------------------------------------------- the real library (ignored)

/// Sean's library, read-only: the database through an immutable URI, font files only when
/// they're on disk (online-only files fail fast and are skipped). Never writes anything.
#[cfg(target_os = "macos")]
mod real {
    use std::{collections::BTreeMap, time::Instant};

    use rusqlite::{Connection, OpenFlags};

    use super::super::{read_file, FaceRow, PreviewInfo, Profile, Unreadable};

    fn library() -> Option<Connection> {
        let home = std::env::var("HOME").ok()?;
        let path = format!("{home}/Library/Application Support/design.snds.fontface/library.sqlite3");
        if !std::path::Path::new(&path).exists() {
            return None;
        }
        let uri = format!("file:{}?immutable=1", path.replace(' ', "%20"));
        Connection::open_with_flags(uri, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI).ok()
    }

    fn excluded(path: &str) -> bool {
        let lower = path.to_ascii_lowercase();
        lower.contains("coresync") || lower.contains("livetype") || (lower.contains("/cloudstorage/onedrive-") && !lower.contains("/cloudstorage/onedrive-personal"))
    }

    fn rows(conn: &Connection, filter: &str) -> Vec<FaceRow> {
        let sql = format!(
            "SELECT id, path, face_index, file_size, mtime, family, subfamily, full_name, postscript_name FROM fonts WHERE {filter} ORDER BY path, face_index"
        );
        let mut stmt = conn.prepare(&sql).unwrap();
        stmt.query_map([], |r| {
            Ok(FaceRow {
                id: r.get(0)?,
                path: r.get(1)?,
                face_index: r.get(2)?,
                file_size: r.get(3)?,
                mtime: r.get(4)?,
                family: r.get(5)?,
                subfamily: r.get(6)?,
                full_name: r.get(7)?,
                postscript_name: r.get(8)?,
            })
        })
        .unwrap()
        .map(Result::unwrap)
        .filter(|r| !excluded(&r.path))
        .collect()
    }

    /// Profiles for one file's faces, from the file as it is now: the library's stamps can lag
    /// behind a cloud drive, and these tests only read. Online-only files still fail fast.
    fn profiles_now(faces: &[FaceRow]) -> Result<Vec<(i64, Profile)>, Unreadable> {
        let data = read_file(&faces[0].path, None)?;
        let mut out = Vec::new();
        for row in faces {
            let face = ttf_parser::Face::parse(&data, row.face_index).map_err(|e| Unreadable::Broken(e.to_string()))?;
            out.push((row.id, row.with_names(|names| super::super::profile_safely(&face, names))));
        }
        Ok(out)
    }

    /// The list fit (src/previewFit.ts), for checking the numbers here.
    fn fit(p: &PreviewInfo) -> (f64, f64) {
        let (h, b0, pad) = (1.3, 1.0, 0.03);
        let (a, d) = (p.ink_top.unwrap_or(0.0), p.ink_bottom.unwrap_or(0.0));
        if a + d <= 0.0 {
            return (1.0, b0);
        }
        let k = ((h - 2.0 * pad) / (a + d)).clamp(0.5, 1.0);
        let (lo, hi) = (k * a + pad, h - k * d - pad);
        (k, if lo <= hi { b0_clamp(b0, lo, hi) } else { (lo + hi) / 2.0 })
    }

    fn b0_clamp(b: f64, lo: f64, hi: f64) -> f64 {
        b.max(lo).min(hi)
    }

    /// One example: (SQL filter, what it should come out as). Kind "skip" just prints.
    const EXAMPLES: &[(&str, &str, &str)] = &[
        ("LI Glyphs", "family = 'LI Glyphs'", "symbols"),
        ("LinkedIn-Glyphs-12px", "family = 'LinkedIn-Glyphs-12px'", "symbols"),
        ("LinkedIn-Glyphs-16px", "family = 'LinkedIn-Glyphs-16px'", "symbols"),
        ("LinkedIn-Glyphs-Mobile", "family = 'LinkedIn-Glyphs-Mobile'", "symbols"),
        ("Lucida Math Std Symbol", "postscript_name = 'LucidaMathStd-Symbol'", "symbols"),
        ("Lucida Math Std Extension", "postscript_name = 'LucidaMathStd-Extension'", "symbols"),
        ("Lucida Math Std Italic", "postscript_name = 'LucidaMathStd-Italic'", "name"),
        ("MacroMX", "family = 'MacroMX'", "case"),
        ("Mathematical Pi LT Std", "family = 'Mathematical Pi LT Std'", "symbols"),
        ("MetaCond Black Expert", "family = 'MetaCond Black Expert'", "expert"),
        ("District-BoldAltExpert", "postscript_name = 'District-BoldAltExpert'", "expert"),
        ("District-BoldItalicAltExp", "postscript_name = 'District-BoldItalicAltExp'", "expert"),
        ("District-BoldItalicAlt", "postscript_name = 'District-BoldItalicAlt'", "name"),
        ("Kleemax DEMO", "family = 'Kleemax DEMO'", "case"),
        ("Christiana", "family = 'Christiana'", "name"),
        ("Common Pixel", "family = 'Common Pixel'", "name"),
        ("ceriph 07_66", "family = 'ceriph 07_66'", "name"),
        ("Wingdings", "family = 'Wingdings'", "symbols"),
        ("Trekbats", "family = 'Trekbats'", "symbols"),
        ("Arial Hebrew", "family = 'Arial Hebrew'", "script"),
        ("AlexonMediumTab", "postscript_name = 'AlexonMediumTab'", "partial"),
        ("BLOKK", "family = 'BLOKK'", "name"),
        ("Flow Circular", "family = 'Flow Circular'", "name"),
        ("Redacted", "family = 'Redacted'", "name"),
        ("SF Pro", "family = 'SF Pro' AND subfamily = 'Regular'", "name"),
        ("Roboto Flex", "family = 'Roboto Flex'", "name"),
        ("Didot", "family = 'Didot'", "name"),
        ("Apple Color Emoji", "family = 'Apple Color Emoji'", "symbols"),
        // Lookup checks: Mac Roman only, and another symbol-only font.
        ("Krupper", "family = 'Krupper'", "name"),
        // Symbol-only maps: plain letters draw the name, pictures show symbols.
        ("Monica", "family = 'Monica'", "name"),
        ("Jedi Solid", "family = 'Jedi Solid'", "name"),
        ("Webdings", "family = 'Webdings'", "symbols"),
        ("Wingdings 2", "family = 'Wingdings 2'", "symbols"),
        // Letters of one point (blank alone) and an Expert set named only by its file.
        ("Material Icons", "family = 'Material Icons'", "symbols"),
        ("Trek Signs", "family = 'Trek Signs'", "symbols"),
        ("BigCaslonExp", "path LIKE '%/BigCaslonExp.otf'", "expert"),
        ("BigCaslonRom", "path LIKE '%/BigCaslonRom.otf'", "name"),
        // The family draws in capitals, the full name needs a sample (checked below).
        ("Magdelena", "family = 'Magdelena'", "case"),
        // Fit references for src/previewFit.test.ts.
        ("Zapfino", "family = 'Zapfino'", "name"),
        ("STIXSizeThreeSym", "family = 'STIXSizeThreeSym' AND subfamily = 'Regular'", "symbols"),
    ];

    #[test]
    #[ignore]
    fn seans_examples() {
        let Some(conn) = library() else { return eprintln!("no library database; skipped") };
        crate::cloud::fail_fast_on_this_thread();
        let mut wrong = Vec::new();
        for (label, filter, want) in EXAMPLES {
            let rows = rows(&conn, filter);
            if rows.is_empty() {
                println!("{label:<28} not in the library");
                continue;
            }
            // Each copy of the font: they should all agree.
            let mut by_file: BTreeMap<String, Vec<FaceRow>> = BTreeMap::new();
            for r in rows {
                by_file.entry(r.path.clone()).or_default().push(r);
            }
            for (path, faces) in by_file {
                let result = match profiles_now(&faces) {
                    // The backfill skips files over 96 MB (Apple Color Emoji); the scanner still
                    // profiles them when it reads them. Check the profile itself here.
                    Err(Unreadable::TooLarge) => {
                        let data = std::fs::read(&path).unwrap();
                        Ok(faces
                            .iter()
                            .filter_map(|r| {
                                let face = ttf_parser::Face::parse(&data, r.face_index).ok()?;
                                Some((r.id, r.with_names(|n| super::super::profile_safely(&face, n))))
                            })
                            .collect())
                    }
                    other => other,
                };
                match result {
                    Err(Unreadable::Cloud) => println!("{label:<28} online-only, skipped ({path})"),
                    Err(e) => println!("{label:<28} skipped: {e:?} ({path})"),
                    Ok(profiles) => {
                        for (id, p) in profiles {
                            let info = PreviewInfo::from_profile(&p);
                            let (k, b) = fit(&info);
                            println!(
                                "{label:<28} #{id:<6} {:<8} label={:<14} family={:?} full={:?} ascent={:.3} descent={:.3} ink={:?} fit k={k:.3} B={b:.3} missing={}",
                                info.kind,
                                info.label.as_deref().unwrap_or("-"),
                                info.family_text.as_deref().unwrap_or("(name)"),
                                info.full_text.as_deref().unwrap_or("(name)"),
                                info.ascent,
                                info.descent,
                                p.ink,
                                info.ascii_missing.len(),
                            );
                            if info.kind != *want {
                                wrong.push(format!("{label} #{id}: {} (wanted {want})", info.kind));
                            }
                            if *label == "Magdelena" && info.full_kind.as_deref() != Some("partial") {
                                wrong.push(format!("Magdelena #{id}: its style row draws {:?} (wanted partial)", info.full_kind));
                            }
                            let text = info.family_text.clone().unwrap_or_default();
                            if *label == "Apple Color Emoji" {
                                assert!(!text.chars().any(|c| c.is_ascii_graphic()), "no Basic Latin: {text}");
                            }
                            if *want == "expert" && (label.starts_with("MetaCond") || label.starts_with("District")) {
                                assert!(p.flags & super::flags::PLACEHOLDER != 0, "{label}: the placeholder was found");
                            }
                            if info.kind == "expert" && p.flags & super::flags::PLACEHOLDER != 0 {
                                // Letter slots can hold real Expert glyphs (MetaCond's A is one);
                                // what must never show is the shared placeholder.
                                let data = std::fs::read(&path).unwrap();
                                let face = ttf_parser::Face::parse(&data, faces[0].face_index).unwrap();
                                let view = super::FontView::new(&face);
                                let placeholder = view.placeholder.unwrap();
                                for c in text.chars().filter(|c| !c.is_whitespace()) {
                                    let g = view.glyph(c as u32).unwrap();
                                    assert_ne!(view.shape(g), placeholder, "{label}: {c} is the placeholder");
                                }
                            }
                        }
                    }
                }
            }
        }
        assert!(wrong.is_empty(), "examples that came out differently:\n{}", wrong.join("\n"));
    }

    /// Our character lookup and line metrics against CoreText's own, on the examples. The fonts
    /// are opened from memory (nothing is registered or activated).
    #[test]
    #[ignore]
    fn coretext_agrees_with_our_lookup() {
        let Some(conn) = library() else { return eprintln!("no library database; skipped") };
        crate::cloud::fail_fast_on_this_thread();
        let probe: Vec<char> = (0x20u8..0x7F).map(char::from).chain("™®©–—‘’“”…€£¥ÄÐðŁ¼½ﬁ∑√∞≤אبЖΩ😀".chars()).collect();
        let mut checked = 0;
        let mut differences = Vec::new();
        for (label, filter, _) in EXAMPLES {
            for row in rows(&conn, filter) {
                let Ok(data) = super::super::read_file(&row.path, Some(row.stamp())) else { continue };
                let bytes = crate::sfnt::extract_face(&data, row.face_index).unwrap_or_else(|| data.clone());
                let Ok(desc) = core_text::font_manager::create_font_descriptor(&bytes) else { continue };
                let ct = core_text::font::new_from_descriptor(&desc, 100.0);
                let face = ttf_parser::Face::parse(&data, row.face_index).unwrap();
                let view = super::FontView::new(&face);
                let extra: Vec<char> = row
                    .with_names(|n| super::super::profile_safely(&face, n))
                    .family_text
                    .map(|t| t.chars().filter(|c| !c.is_whitespace()).collect())
                    .unwrap_or_default();
                for c in probe.iter().chain(extra.iter()) {
                    let units: Vec<u16> = c.encode_utf16(&mut [0; 2]).to_vec();
                    let mut glyphs = [0u16; 2];
                    // SAFETY: both buffers hold `units.len()` (1 or 2) elements.
                    unsafe { ct.get_glyphs_for_characters(units.as_ptr(), glyphs.as_mut_ptr(), units.len() as isize) };
                    let ours = view.glyph(*c as u32).map_or(0, |g| g.0);
                    if ours != glyphs[0] {
                        differences.push(format!("{label}: {c:?} U+{:04X}: CoreText glyph {}, ours {ours}", *c as u32, glyphs[0]));
                    }
                }
                let (ascent, descent) = view.line_metrics();
                if (ct.ascent() / 100.0 - ascent as f64).abs() > 0.002 || (ct.descent() / 100.0 - descent as f64).abs() > 0.002 {
                    differences.push(format!(
                        "{label}: CoreText ascent/descent {:.3}/{:.3}, ours {ascent:.3}/{descent:.3}",
                        ct.ascent() / 100.0,
                        ct.descent() / 100.0
                    ));
                }
                checked += 1;
            }
        }
        println!("compared {checked} faces with CoreText");
        for d in &differences {
            println!("  {d}");
        }
        assert!(differences.is_empty(), "{} differences from CoreText", differences.len());
    }

    /// The same comparison over every readable face in the library (printable ASCII and line
    /// metrics). Prints what differs, with the font's metric tables, and fails if anything does.
    #[test]
    #[ignore]
    fn coretext_agrees_across_the_library() {
        let Some(conn) = library() else { return eprintln!("no library database; skipped") };
        crate::cloud::fail_fast_on_this_thread();
        let all = rows(&conn, "1");
        let mut by_file: BTreeMap<(String, i64, i64), Vec<FaceRow>> = BTreeMap::new();
        for r in all {
            by_file.entry((r.path.clone(), r.file_size, r.mtime)).or_default().push(r);
        }
        let (mut faces, mut lookup, mut metrics) = (0, Vec::new(), Vec::new());
        for rows in by_file.values() {
            let Ok(data) = super::super::read_file(&rows[0].path, Some(rows[0].stamp())) else { continue };
            for row in rows {
                let bytes = crate::sfnt::extract_face(&data, row.face_index).unwrap_or_else(|| data.clone());
                let (Ok(desc), Ok(face)) = (core_text::font_manager::create_font_descriptor(&bytes), ttf_parser::Face::parse(&data, row.face_index))
                else {
                    continue;
                };
                let ct = core_text::font::new_from_descriptor(&desc, 100.0);
                let view = super::FontView::new(&face);
                faces += 1;
                for b in 0x21u16..0x7F {
                    let mut g = 0u16;
                    // SAFETY: one character in, one glyph out.
                    unsafe { ct.get_glyphs_for_characters(&b, &mut g, 1) };
                    let ours = view.glyph(b as u32).map_or(0, |g| g.0);
                    if ours != g {
                        lookup.push(format!("{} ({}): {:?} CoreText {g}, ours {ours}", row.family, row.path, b as u8 as char));
                        break;
                    }
                }
                let (ascent, descent) = view.line_metrics();
                if (ct.ascent() / 100.0 - ascent as f64).abs() > 0.002 || (ct.descent() / 100.0 - descent as f64).abs() > 0.002 {
                    let raw = |tag: &[u8; 4], at: usize| {
                        face.raw_face().table(ttf_parser::Tag::from_bytes(tag)).and_then(|t| t.get(at..at + 2)).map(|b| i16::from_be_bytes([b[0], b[1]]))
                    };
                    metrics.push(format!(
                        "{} {}: CoreText {:.3}/{:.3}, ours {ascent:.3}/{descent:.3} (upm {}, hhea {:?}/{:?}, typo {:?}/{:?}, win {:?}/{:?}, fsSelection {:?}, MVAR {}, fvar {}, head yMin/yMax {}/{})",
                        row.family,
                        row.subfamily,
                        ct.ascent() / 100.0,
                        ct.descent() / 100.0,
                        face.units_per_em(),
                        raw(b"hhea", 4),
                        raw(b"hhea", 6),
                        raw(b"OS/2", 68),
                        raw(b"OS/2", 70),
                        raw(b"OS/2", 74).map(|v| v as u16),
                        raw(b"OS/2", 76).map(|v| v as u16),
                        raw(b"OS/2", 62).map(|v| format!("{:#x}", v as u16)),
                        face.raw_face().table(ttf_parser::Tag::from_bytes(b"MVAR")).is_some(),
                        face.is_variable(),
                        face.global_bounding_box().y_min,
                        face.global_bounding_box().y_max,
                    ));
                }
            }
        }
        println!("compared {faces} faces: {} lookup differences, {} metric differences", lookup.len(), metrics.len());
        for d in lookup.iter().take(20).chain(metrics.iter().take(40)) {
            println!("  {d}");
        }
        assert!(lookup.is_empty() && metrics.is_empty());
    }

    #[test]
    #[ignore]
    fn whole_library_pass() {
        let Some(conn) = library() else { return eprintln!("no library database; skipped") };
        let rows = rows(&conn, "1");
        let mut by_file: BTreeMap<(String, i64, i64), Vec<FaceRow>> = BTreeMap::new();
        for r in rows {
            by_file.entry((r.path.clone(), r.file_size, r.mtime)).or_default().push(r);
        }
        let jobs: Vec<Vec<FaceRow>> = by_file.into_values().collect();
        let jobs = std::sync::Arc::new(jobs);
        let next = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let start = Instant::now();
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let (jobs, next) = (jobs.clone(), next.clone());
                std::thread::spawn(move || {
                    crate::cloud::fail_fast_on_this_thread();
                    let mut out: Vec<(String, Option<String>, u128)> = Vec::new(); // kind, label, µs per face
                    let mut lines: Vec<String> = Vec::new();
                    let mut skipped: BTreeMap<String, usize> = BTreeMap::new();
                    loop {
                        let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let Some(faces) = jobs.get(i) else { break };
                        let t = Instant::now();
                        match profiles_now(faces) {
                            Ok(profiles) => {
                                let us = t.elapsed().as_micros() / profiles.len().max(1) as u128;
                                for (id, p) in &profiles {
                                    let family = faces.iter().find(|r| r.id == *id).map_or("", |r| r.family.as_str());
                                    lines.push(format!("{id}\t{family}\t{}\t{:?}\t{:?}\t{:?}\t{}", p.kind.as_str(), p.label, p.family_text, p.full_text, p.flags));
                                }
                                out.extend(profiles.into_iter().map(|(_, p)| (p.kind.as_str().to_string(), p.label, us)));
                            }
                            Err(e) => {
                                let why = match e {
                                    Unreadable::Broken(_) => "broken".to_string(),
                                    other => format!("{other:?}").to_lowercase(),
                                };
                                *skipped.entry(why).or_default() += faces.len();
                            }
                        }
                    }
                    (out, skipped, lines)
                })
            })
            .collect();
        let mut kinds: BTreeMap<String, usize> = BTreeMap::new();
        let mut labels: BTreeMap<String, usize> = BTreeMap::new();
        let mut skipped: BTreeMap<String, usize> = BTreeMap::new();
        let mut times = Vec::new();
        let mut dump: Vec<String> = Vec::new();
        for t in threads {
            let (out, skip, lines) = t.join().expect("no panics in the whole-library pass");
            dump.extend(lines);
            for (kind, label, us) in out {
                *kinds.entry(kind).or_default() += 1;
                if let Some(l) = label {
                    *labels.entry(l).or_default() += 1;
                }
                times.push(us);
            }
            for (k, n) in skip {
                *skipped.entry(k).or_default() += n;
            }
        }
        let wall = start.elapsed();
        times.sort();
        let pct = |p: f64| times.get(((times.len().max(1) - 1) as f64 * p) as usize).copied().unwrap_or(0);
        println!("files: {}  faces profiled: {}  wall: {wall:.2?} on 8 threads", jobs.len(), times.len());
        println!("per face: median {} µs, p99 {} µs, max {} µs", pct(0.5), pct(0.99), times.last().copied().unwrap_or(0));
        println!("kinds: {kinds:?}");
        println!("labels (top 20): {:?}", {
            let mut v: Vec<_> = labels.into_iter().collect();
            v.sort_by(|a, b| b.1.cmp(&a.1));
            v.truncate(20);
            v
        });
        println!("skipped faces: {skipped:?}");
        // FONTFACE_PREVIEW_DUMP=<file>: one line per face (id, family, kind, label, texts, flags),
        // sorted by id, for comparing two versions of the rules.
        if let Ok(file) = std::env::var("FONTFACE_PREVIEW_DUMP") {
            dump.sort_by_key(|l| l.split('\t').next().and_then(|id| id.parse::<i64>().ok()).unwrap_or(0));
            std::fs::write(&file, dump.join("\n") + "\n").unwrap();
            println!("wrote {} faces to {file}", dump.len());
        }
        assert!(!times.is_empty());
    }
}
