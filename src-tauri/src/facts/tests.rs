//! The font page's facts: OpenType features and their names, named styles, embedding, names,
//! languages, the cache, the safety rules and "last turned on". Fonts are built byte by byte
//! (test_fonts.rs), so nothing here needs fixture files.

use std::path::{Path, PathBuf};

use super::{embedding, facts_for, layout, read_facts_with, Embedding, FontFacts};
use crate::{
    preview::{FaceRow, Unreadable},
    tags::named_styles,
    test_fonts::{
        fvar_table, layout_table, ligature_lookup, name_table, set_params, single_lookup, variant_params, Cmap, FeatureSpec, FontBuilder,
        Shape,
    },
};

fn no_languages(_: &[u8], _: u32) -> Option<Vec<String>> {
    None
}

fn facts(font: &[u8]) -> FontFacts {
    read_facts_with(font, 0, no_languages).expect("a readable font")
}

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fontface-facts-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A font with a, g, f, i and alternates for a and g (ss01), an fi ligature (liga), kerning
/// (kern, positioning only), a named stylistic set and a character variant.
fn featured_font() -> FontBuilder {
    let mut b = FontBuilder::new().named("Featured").name(256, "Single-storey a").name(257, "Open g").name(300, "Round dots");
    let a = b.char('a' as u32, None);
    let g = b.char('g' as u32, None);
    let f = b.char('f' as u32, None);
    let i = b.char('i' as u32, None);
    let a2 = b.glyph(Shape::bar(300, 500), Some("a.ss01"));
    let g2 = b.glyph(Shape::bar(310, 500), Some("g.ss01"));
    let fi = b.glyph(Shape::bar(500, 700), Some("f_i"));
    let gsub = layout_table(
        &[(*b"latn", vec![*b"TRK ", *b"ROM "]), (*b"cyrl", vec![*b"SRB "]), (*b"DFLT", vec![])],
        &[
            FeatureSpec::new(b"liga", &[1]),
            FeatureSpec::new(b"ss01", &[0]).with_params(set_params(256)),
            FeatureSpec::new(b"ss02", &[0]).with_params(set_params(999)),
            FeatureSpec::new(b"ss03", &[0]).with_params(set_params(2)),
            FeatureSpec::new(b"cv01", &[0]).with_params(variant_params(257, &['g', 'a'])),
            FeatureSpec::new(b"size", &[]),
            FeatureSpec::new(&[0x01, b'b', b'a', b'd'], &[0]),
            // The same feature again for another script: listed once.
            FeatureSpec::new(b"liga", &[1]),
        ],
        &[single_lookup(&[(a, a2), (g, g2)]), ligature_lookup(&[(&[f, i], fi)])],
    );
    let gpos = layout_table(
        &[(*b"latn", vec![*b"NLD "]), (*b"grek", vec![])],
        &[FeatureSpec::new(b"kern", &[]), FeatureSpec::new(b"liga", &[]), FeatureSpec::new(b"ss04", &[]).with_params(set_params(300))],
        &[],
    );
    b.raw_table(b"GSUB", gsub).raw_table(b"GPOS", gpos)
}

#[test]
fn features_are_the_ones_the_tables_list_each_once_with_where_they_are() {
    let f = facts(&featured_font().build());
    let tags: Vec<&str> = f.features.iter().map(|f| f.tag.as_str()).collect();
    assert_eq!(tags, ["cv01", "kern", "liga", "ss01", "ss02", "ss03", "ss04"], "sorted; `size` and a damaged tag are left out");
    let get = |tag: &str| f.features.iter().find(|x| x.tag == tag).unwrap();
    assert!(get("liga").gsub && get("liga").gpos, "a tag in both tables says so");
    assert!(!get("kern").gsub && get("kern").gpos);
    assert!(get("ss01").gsub && !get("ss01").gpos);
}

#[test]
fn stylistic_sets_and_character_variants_use_the_fonts_own_names() {
    let f = facts(&featured_font().build());
    let name = |tag: &str| f.features.iter().find(|x| x.tag == tag).unwrap().name.clone();
    assert_eq!(name("ss01").as_deref(), Some("Single-storey a"));
    assert_eq!(name("ss02"), None, "a name id the font doesn't have");
    assert_eq!(name("ss03"), None, "ids under 256 are the font's own names, never a feature's");
    assert_eq!(name("ss04").as_deref(), Some("Round dots"), "named from the positioning table too");
    assert_eq!(name("cv01").as_deref(), Some("Open g"));
    assert_eq!(name("liga"), None, "other features have no names of their own");
}

#[test]
fn samples_show_what_each_substitution_changes() {
    let f = facts(&featured_font().build());
    let sample = |tag: &str| f.features.iter().find(|x| x.tag == tag).unwrap().sample.clone();
    assert_eq!(sample("ss01").as_deref(), Some("a g"), "the characters its lookup covers");
    assert_eq!(sample("liga").as_deref(), Some("fi"), "the ligatures it forms");
    assert_eq!(sample("cv01").as_deref(), Some("a g"), "a character variant names its own characters");
    assert_eq!(sample("kern"), None, "positioning only: no sample from the font");
}

#[test]
fn scripts_and_their_languages_come_from_both_tables() {
    let f = facts(&featured_font().build());
    let scripts: Vec<(&str, Vec<&str>)> = f.scripts.iter().map(|s| (s.tag.as_str(), s.languages.iter().map(String::as_str).collect())).collect();
    assert_eq!(scripts, [("latn", vec!["TRK", "ROM", "NLD"]), ("cyrl", vec!["SRB"]), ("grek", vec![])], "DFLT isn't a script");
}

#[test]
fn a_font_without_layout_tables_has_no_features() {
    let f = facts(&FontBuilder::new().named("Plain").chars("abc").build());
    assert!(f.features.is_empty() && f.scripts.is_empty() && f.instances.is_empty());
    assert!(!f.apple_features);
    // Apple's own feature tables, and no OpenType ones: the page says so.
    let apple = facts(&FontBuilder::new().named("Apple").chars("abc").raw_table(b"morx", vec![0, 2, 0, 0, 0, 0, 0, 0]).build());
    assert!(apple.apple_features);
}

#[test]
fn damaged_layout_tables_give_nothing_rather_than_fail() {
    for bytes in [vec![], vec![0, 1], vec![0, 2, 0, 0, 0, 10, 0, 12, 0, 14], vec![0, 1, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]] {
        assert_eq!(layout::read_layout(&bytes).map(|l| l.features.len()).unwrap_or(0), 0);
        let f = facts(&FontBuilder::new().named("Broken").chars("ab").raw_table(b"GSUB", bytes.clone()).build());
        assert!(f.features.is_empty(), "{bytes:?}");
    }
}

#[test]
fn named_styles_come_with_their_axis_values() {
    let name = name_table(&[(256, "Weight".into()), (257, "Light".into()), (258, "Bold".into()), (259, "Var-Bold".into())]);
    let fvar = fvar_table(
        &[(*b"wght", 100.0, 400.0, 900.0, 0, 256), (*b"wdth", 75.0, 100.0, 100.0, 1, 256)],
        &[
            (257, vec![300.0, 100.0], None),
            (258, vec![700.0, 87.5], Some(259)),
            // The same style twice, and one whose name isn't in the table: left out.
            (258, vec![700.0, 87.5], Some(259)),
            (999, vec![500.0, 100.0], None),
        ],
    );
    let styles = named_styles::instances(&fvar, &name);
    assert_eq!(styles.len(), 2);
    assert_eq!(styles[0].name, "Light");
    assert_eq!(styles[0].values, vec![("wght".to_string(), 300.0), ("wdth".to_string(), 100.0)]);
    assert_eq!(styles[0].postscript_name, None);
    assert_eq!(styles[1].name, "Bold");
    assert_eq!(styles[1].values, vec![("wght".to_string(), 700.0), ("wdth".to_string(), 87.5)]);
    assert_eq!(styles[1].postscript_name.as_deref(), Some("Var-Bold"));
    // The PostScript names the tag import reads stay as they were.
    assert_eq!(named_styles::parse(&fvar, &name), vec!["Var-Bold".to_string()]);
    assert!(named_styles::instances(&fvar[..10], &name).is_empty(), "a cut-off table gives nothing");

    let font = FontBuilder::new()
        .named("Var")
        .name(256, "Weight")
        .name(257, "Light")
        .chars("ab")
        .raw_table(b"fvar", fvar_table(&[(*b"wght", 100.0, 400.0, 900.0, 0, 256)], &[(257, vec![300.0], None)]))
        .build();
    let f = facts(&font);
    assert_eq!(f.instances.len(), 1);
    let json = serde_json::to_value(&f.instances[0]).unwrap();
    assert_eq!(json, serde_json::json!({ "name": "Light", "values": [["wght", 300.0]] }), "the shape the UI reads");
}

#[test]
fn embedding_permissions_read_as_the_spec_says() {
    let e = |version, fs_type| embedding(version, fs_type);
    let kind = |version, fs_type| embedding(version, fs_type).kind;
    assert_eq!(kind(4, 0), "installable");
    assert_eq!(kind(4, 2), "restricted");
    assert_eq!(kind(4, 4), "previewPrint");
    assert_eq!(kind(4, 8), "editable");
    assert_eq!(kind(4, 6), "unclear", "from version 3, only one usage bit may be set");
    assert_eq!(kind(4, 1), "unclear", "bit 0 is reserved");
    // Up to version 2, several bits may be set and the most permissive counts.
    assert_eq!(kind(1, 0x6), "previewPrint");
    assert_eq!(kind(2, 0xE), "editable");
    assert_eq!(kind(0, 2), "restricted");
    assert_eq!(kind(1, 1), "unclear");
    assert_eq!(e(4, 0x0304), Embedding { kind: "previewPrint", no_subsetting: true, bitmap_only: true });
    assert_eq!(e(1, 0x0300), Embedding { kind: "installable", no_subsetting: false, bitmap_only: false }, "those flags came with version 2");

    let mut b = FontBuilder::new().named("Locked").chars("ab");
    b.fs_type = 0x0102;
    let f = facts(&b.build());
    assert_eq!(f.embedding, Some(Embedding { kind: "restricted", no_subsetting: true, bitmap_only: false }));
    let mut none = FontBuilder::new().named("NoOS2").chars("ab");
    none.os2 = None;
    assert_eq!(facts(&none.build()).embedding, None, "no OS/2 table: nothing to say");
}

#[test]
fn more_of_the_fonts_names() {
    let long = "x".repeat(super::MAX_TEXT + 10);
    let font = FontBuilder::new()
        .named("Named")
        .name(7, "Named is a trademark of Someone.")
        .name(10, &long)
        .name(11, "example.com")
        .name(12, "https://designer.example")
        .name(19, "  ")
        .chars("ab")
        .build();
    let f = facts(&font);
    assert_eq!(f.trademark.as_deref(), Some("Named is a trademark of Someone."));
    assert_eq!(f.description.as_ref().map(|d| d.chars().count()), Some(super::MAX_TEXT + 1), "long text is cut, with …");
    assert_eq!(f.vendor_url.as_deref(), Some("example.com"));
    assert_eq!(f.designer_url.as_deref(), Some("https://designer.example"));
    assert_eq!(f.sample_text, None, "blank names count as none");
}

#[test]
fn facts_serialize_in_the_shape_the_ui_expects() {
    let f = facts(&featured_font().build());
    let json = serde_json::to_value(&f).unwrap();
    for key in ["features", "scripts", "appleFeatures", "instances", "embedding", "trademark", "description", "vendorUrl", "designerUrl", "sampleText", "languages"] {
        assert!(json.get(key).is_some(), "{key}");
    }
    let ss01 = json["features"].as_array().unwrap().iter().find(|f| f["tag"] == "ss01").unwrap();
    assert_eq!(ss01, &serde_json::json!({ "tag": "ss01", "name": "Single-storey a", "sample": "a g", "gsub": true, "gpos": false }));
}

fn row(path: &Path, data: &[u8]) -> FaceRow {
    let meta = std::fs::metadata(path).unwrap();
    FaceRow {
        id: 1,
        path: path.to_string_lossy().into_owned(),
        face_index: 0,
        file_size: data.len() as i64,
        mtime: crate::scanner::mtime_secs(&meta),
        family: "Featured".into(),
        subfamily: "Regular".into(),
        full_name: None,
        postscript_name: None,
    }
}

#[test]
fn facts_are_read_once_then_cached_until_the_file_changes() {
    let dir = temp("cache");
    let path = dir.join("Featured.ttf");
    let data = featured_font().build();
    std::fs::write(&path, &data).unwrap();
    let r = row(&path, &data);
    let mut reads = 0;
    let first = facts_for(&r, |d, i| {
        reads += 1;
        read_facts_with(d, i, no_languages)
    })
    .unwrap();
    assert_eq!(first.features.len(), 7);
    // Asked again: from memory, even with the file gone.
    std::fs::remove_file(&path).unwrap();
    let again = facts_for(&r, |_, _| panic!("shouldn't read the file again")).unwrap();
    assert_eq!(again, first);
    assert_eq!(reads, 1);
    // Another version of the file (another size) isn't the cached one; it's missing now.
    let other = FaceRow { file_size: r.file_size + 1, ..r.clone() };
    assert_eq!(facts_for(&other, |d, i| read_facts_with(d, i, no_languages)).unwrap_err(), Unreadable::Missing);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn files_that_must_not_be_read_never_are() {
    let dir = temp("never");
    // Creative Cloud's font store, by its path.
    let adobe = dir.join("CoreSync/plugins/livetype/r/.12345");
    std::fs::create_dir_all(adobe.parent().unwrap()).unwrap();
    let data = featured_font().build();
    std::fs::write(&adobe, &data).unwrap();
    let r = row(&adobe, &data);
    assert_eq!(facts_for(&r, |_, _| panic!("never read")).unwrap_err(), Unreadable::Adobe);
    // A file that changed since its scan isn't read either.
    let changed = dir.join("Changed.ttf");
    std::fs::write(&changed, &data).unwrap();
    let mut r = row(&changed, &data);
    r.mtime -= 100;
    assert_eq!(facts_for(&r, |_, _| panic!("never read")).unwrap_err(), Unreadable::Changed);
    // Not a font: broken, with the reason.
    let junk = dir.join("Junk.ttf");
    std::fs::write(&junk, b"not a font at all").unwrap();
    let r = row(&junk, b"not a font at all");
    assert!(matches!(facts_for(&r, |d, i| read_facts_with(d, i, no_languages)), Err(Unreadable::Broken(_))));
    std::fs::remove_dir_all(&dir).ok();
    // What the page says for an online-only file.
    assert_eq!(Unreadable::Cloud.kind(), "cloud");
    assert!(super::details_message(&Unreadable::Cloud).contains("online-only"));
}

#[test]
fn the_answer_says_why_a_file_was_not_read_and_still_has_last_turned_on() {
    let dir = temp("answer");
    let db = dir.join("library.sqlite3");
    let mut conn = crate::db::open(&db).unwrap();
    crate::activation::ensure_schema(&conn).unwrap();
    let folder = crate::db::insert_folder(&mut conn, &dir.join("fonts"), "user").unwrap();
    std::fs::create_dir_all(dir.join("fonts")).unwrap();
    let data = featured_font().build();
    let here = dir.join("fonts/Featured.ttf");
    std::fs::write(&here, &data).unwrap();
    let mtime = crate::scanner::mtime_secs(&std::fs::metadata(&here).unwrap());
    let gone = dir.join("fonts/Gone.ttf");
    for (path, ps) in [(&here, "Featured-Regular"), (&gone, "Gone-Regular")] {
        conn.execute(
            "INSERT INTO fonts (folder_id, path, file_size, mtime, family, subfamily, postscript_name, weight, width, italic,
             monospace, variable, glyph_count, format, activated)
             VALUES (?1, ?2, ?3, ?4, 'Featured', 'Regular', ?5, 400, 5, 0, 0, 0, 8, 'TrueType', 0)",
            rusqlite::params![folder, path.to_string_lossy(), data.len() as i64, mtime, ps],
        )
        .unwrap();
    }
    let id = |path: &Path| -> i64 { conn.query_row("SELECT id FROM fonts WHERE path = ?1", [path.to_string_lossy()], |r| r.get(0)).unwrap() };
    let (here_id, gone_id) = (id(&here), id(&gone));
    crate::activation::record_turned_on(&conn, &[gone.to_str().unwrap()], 1_700_000_000).unwrap();
    drop(conn);

    let state = crate::AppState::for_tests(&db, &dir).unwrap();
    let ok = super::answer(&state, here_id).unwrap();
    assert!(ok.facts.is_some() && ok.unread.is_none() && ok.message.is_none());
    assert_eq!(ok.last_turned_on, None, "never turned on by Fontface");
    let missing = super::answer(&state, gone_id).unwrap();
    assert!(missing.facts.is_none());
    assert_eq!(missing.unread, Some("missing"));
    assert!(missing.message.is_some());
    assert_eq!(missing.last_turned_on, Some(1_700_000_000), "from the library, even when the file can't be read");
    assert!(super::answer(&state, 9999).is_err(), "a font that isn't in the library");
    let json = serde_json::to_value(&missing).unwrap();
    assert_eq!(json["unread"], "missing");
    assert_eq!(json["lastTurnedOn"], 1_700_000_000);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn last_turned_on_is_kept_for_every_font_in_the_file_by_face_key() {
    let dir = temp("turned-on");
    let mut conn = crate::db::open(&dir.join("library.sqlite3")).unwrap();
    crate::activation::ensure_schema(&conn).unwrap();
    let folder = crate::db::insert_folder(&mut conn, &dir.join("a"), "user").unwrap();
    let other = crate::db::insert_folder(&mut conn, &dir.join("b"), "user").unwrap();
    // A collection with two fonts, and a copy of one of them elsewhere.
    let ttc = dir.join("a/Pair.ttc").to_string_lossy().into_owned();
    let copy = dir.join("b/Copy.ttf").to_string_lossy().into_owned();
    for (folder, path, index, ps, italic) in
        [(folder, &ttc, 0, Some("Pair-Regular"), false), (folder, &ttc, 1, Some("Pair-Italic"), true), (other, &copy, 0, Some("Pair-Regular"), false)]
    {
        conn.execute(
            "INSERT INTO fonts (folder_id, path, face_index, file_size, mtime, family, subfamily, postscript_name, weight, width,
             italic, monospace, variable, glyph_count, format, activated)
             VALUES (?1, ?2, ?3, 1, 1, 'Pair', 'Regular', ?4, 400, 5, ?5, 0, 0, 1, 'TrueType', 0)",
            rusqlite::params![folder, path, index, ps, italic],
        )
        .unwrap();
    }
    let ids: Vec<i64> = conn.prepare("SELECT id FROM fonts ORDER BY id").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
    assert_eq!(crate::activation::record_turned_on(&conn, &[&ttc], 100).unwrap(), 2, "both fonts in the file");
    let at = |id: i64| crate::activation::last_turned_on(&conn, id).unwrap();
    assert_eq!((at(ids[0]), at(ids[1])), (Some(100), Some(100)));
    assert_eq!(at(ids[2]), Some(100), "the same font in another file shares it (same face key)");
    crate::activation::record_turned_on(&conn, &[&copy], 250).unwrap();
    assert_eq!((at(ids[0]), at(ids[1]), at(ids[2])), (Some(250), Some(100), Some(250)), "the latest time wins");
    assert_eq!(at(424242), None, "a font that isn't in the library");
    std::fs::remove_dir_all(&dir).ok();
}

#[cfg(target_os = "macos")]
#[test]
fn coretext_lists_the_languages_a_system_font_supports() {
    let path = "/System/Library/Fonts/Helvetica.ttc";
    let Ok(data) = std::fs::read(path) else { return };
    let languages = super::system_languages(&data, 1).expect("CoreText answers for Helvetica");
    assert!(languages.iter().any(|l| l == "en"), "{languages:?}");
    assert!(languages.iter().any(|l| l == "fr" || l.starts_with("fr")));
    assert!(languages.windows(2).all(|w| w[0] < w[1]), "sorted, each once");
    // A face with only a few symbols supports no language's alphabet.
    let mut b = FontBuilder::new().named("Dots");
    let dot = b.glyph(Shape::bar(100, 100), None);
    b.map(Cmap::Unicode, 0x2022, dot);
    let few = super::system_languages(&b.build(), 0).unwrap_or_default();
    assert!(!few.iter().any(|l| l == "en"), "{few:?}");
}

#[test]
fn samples_leave_out_marks_and_private_characters_and_put_letters_first() {
    let mut b = FontBuilder::new().named("Mixed");
    let one = b.char('1' as u32, None);
    let x = b.char('x' as u32, None);
    let mark = b.char(0x0301, None);
    let private = b.char(0xE001, None);
    let alt: Vec<u16> = (0..4).map(|_| b.glyph(Shape::bar(200, 400), None)).collect();
    let gsub = layout_table(
        &[(*b"latn", vec![])],
        &[FeatureSpec::new(b"salt", &[0])],
        &[single_lookup(&[(one, alt[0]), (x, alt[1]), (mark, alt[2]), (private, alt[3])])],
    );
    let f = facts(&b.raw_table(b"GSUB", gsub).build());
    assert_eq!(f.features[0].sample.as_deref(), Some("x 1"));
}
