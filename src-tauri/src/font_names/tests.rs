//! The name matcher, against hand-made libraries (no files, no network), and once against a
//! temporary database to check the library query.

use rusqlite::params;

use super::{name_key, style_words, How, LineMatch, NameIndex, NameLine, MAX_LINE, NEAR_MISSES};
use crate::tags::{LibraryIndex, LibraryRow};

/// A Creative Cloud font store path: never matched.
const ADOBE: &str = "/Users/me/Library/Application Support/Adobe/CoreSync/plugins/livetype/.r/.12345.otf";

/// One copy of a style, as the library lists it.
#[derive(Clone)]
struct Font {
    row: LibraryRow,
}

fn font(path: &str, ps: &str, family: &str, style: &str) -> Font {
    Font {
        row: LibraryRow {
            id: 0,
            path: path.into(),
            face_index: 0,
            postscript_name: (!ps.is_empty()).then(|| ps.to_string()),
            family: family.into(),
            style: style.into(),
            full_name: None,
            legacy_family: None,
            legacy_style: None,
            variable: false,
            italic: style.contains("Italic") || style.contains("Oblique"),
            installed: false,
        },
    }
}

impl Font {
    fn full(mut self, full: &str) -> Self {
        self.row.full_name = Some(full.into());
        self
    }
    fn legacy(mut self, family: &str, style: &str) -> Self {
        self.row.legacy_family = Some(family.into());
        self.row.legacy_style = Some(style.into());
        self
    }
    fn variable(mut self) -> Self {
        self.row.variable = true;
        self
    }
    fn italic(mut self, italic: bool) -> Self {
        self.row.italic = italic;
        self
    }
    fn installed(mut self) -> Self {
        self.row.installed = true;
        self
    }
}

/// The library of these fonts, with ids 1, 2, 3… in order.
fn index(fonts: &[Font]) -> NameIndex {
    let mut lib = LibraryIndex::default();
    for (i, f) in fonts.iter().enumerate() {
        let mut row = f.row.clone();
        row.id = i as i64 + 1;
        lib.add(row);
    }
    NameIndex::new(lib)
}

/// A small library: Inter (static and display), Lora, Helvetica Neue, Roboto Flex (variable).
fn library() -> NameIndex {
    index(&[
        font("/f/Inter-Regular.otf", "Inter-Regular", "Inter", "Regular").full("Inter Regular"),
        font("/f/Inter-Bold.otf", "Inter-Bold", "Inter", "Bold").full("Inter Bold"),
        font("/f/Inter-BoldItalic.otf", "Inter-BoldItalic", "Inter", "Bold Italic").full("Inter Bold Italic"),
        font("/f/Inter-SemiBold.otf", "Inter-SemiBold", "Inter", "SemiBold").legacy("Inter SemiBold", "Regular"),
        font("/f/InterDisplay-Bold.otf", "InterDisplay-Bold", "Inter Display", "Bold"),
        font("/f/Lora-Regular.ttf", "Lora-Regular", "Lora", "Regular"),
        font("/f/Lora-Italic.ttf", "Lora-Italic", "Lora", "Italic"),
        font("/f/HelveticaNeue.ttc", "HelveticaNeue-Bd", "Helvetica Neue", "Bold").full("Helvetica Neue Bold"),
        font("/f/HelveticaNeue-BdOb.ttc", "HelveticaNeue-BdOb", "Helvetica Neue", "Bold Oblique"),
        font("/f/RobotoFlex.ttf", "RobotoFlex-Regular", "Roboto Flex", "Regular").variable(),
    ])
}

fn one(index: &NameIndex, line: &str) -> LineMatch {
    index.match_lines(&[NameLine::Text(line.into())], |_| false).remove(0)
}

/// What a line found: the rule, and each style as "Family Style".
fn found(index: &NameIndex, line: &str) -> (Option<How>, Vec<String>) {
    let m = one(index, line);
    (m.how, m.faces.iter().map(|f| format!("{} {}", f.family, f.style)).collect())
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn name_keys_ignore_case_spaces_and_punctuation() {
    assert_eq!(name_key("Inter-Bold"), "interbold");
    assert_eq!(name_key("inter bold"), "interbold");
    assert_eq!(name_key("INTER_BOLD"), "interbold");
    assert_eq!(name_key("Abaddon™ Std."), "abaddonstd");
    assert_eq!(name_key("Ünïcode Sans"), "ünïcodesans");
}

#[test]
fn style_words_read_short_forms_and_other_spellings() {
    assert_eq!(style_words("bolditalic"), Some(vec!["bold", "italic"]));
    assert_eq!(style_words("italicbold"), Some(vec!["bold", "italic"]));
    assert_eq!(style_words("boldit"), Some(vec!["bold", "italic"]));
    assert_eq!(style_words("boldoblique"), Some(vec!["bold", "italic"]));
    assert_eq!(style_words("regularitalic"), Some(vec!["italic"]));
    assert_eq!(style_words("roman"), Some(vec!["regular"]));
    assert_eq!(style_words("regular"), Some(vec!["regular"]));
    assert_eq!(style_words(""), Some(vec!["regular"]));
    assert_eq!(style_words("demibold"), Some(vec!["semibold"]));
    // The fewest words: SemiCondensed is one word, not Semi (SemiBold) and Condensed.
    assert_eq!(style_words("semicondensed"), Some(vec!["semicondensed"]));
    assert_eq!(style_words("semiboldcondensed"), Some(vec!["condensed", "semibold"]));
    assert_eq!(style_words("display"), None);
    assert_eq!(style_words("45light"), None);
}

#[test]
fn a_family_name_finds_every_style_in_it() {
    let lib = library();
    let (how, faces) = found(&lib, "Inter");
    assert_eq!(how, Some(How::Family));
    assert_eq!(faces, names(&["Inter Bold", "Inter Regular", "Inter SemiBold", "Inter Bold Italic"]));
    assert_eq!(found(&lib, "  lora ").1, names(&["Lora Regular", "Lora Italic"]));
    assert_eq!(found(&lib, "HELVETICA-NEUE").0, Some(How::Family));
}

#[test]
fn a_postscript_name_finds_its_style_as_written_or_written_another_way() {
    let lib = library();
    assert_eq!(found(&lib, "Inter-Bold"), (Some(How::PostScript), names(&["Inter Bold"])));
    assert_eq!(found(&lib, "inter bold"), (Some(How::PostScript), names(&["Inter Bold"])));
    assert_eq!(found(&lib, "INTER_BOLDITALIC"), (Some(How::PostScript), names(&["Inter Bold Italic"])));
    // A list of file names works too.
    assert_eq!(found(&lib, "Inter-Bold.otf"), (Some(How::PostScript), names(&["Inter Bold"])));
    assert_eq!(found(&lib, "HelveticaNeue-BdOb.OTF"), (Some(How::PostScript), names(&["Helvetica Neue Bold Oblique"])));
}

#[test]
fn a_full_name_finds_its_style() {
    let lib = library();
    assert_eq!(found(&lib, "Helvetica Neue Bold"), (Some(How::FullName), names(&["Helvetica Neue Bold"])));
}

#[test]
fn a_family_and_style_find_the_style_as_the_font_names_them_or_written_another_way() {
    let lib = index(&[
        font("/f/a.otf", "", "Acme Sans", "Semi Bold"),
        font("/f/b.otf", "AcmeSans-X1", "Acme Sans", "Bold Italic"),
        font("/f/c.otf", "AcmeSans-X2", "Acme Sans", "Roman"),
        font("/f/d.otf", "AcmeSans-X3", "Acme Sans", "Condensed Medium"),
    ]);
    // As the font names it, in any spacing.
    assert_eq!(found(&lib, "Acme Sans Semi Bold"), (Some(How::FamilyStyle), names(&["Acme Sans Semi Bold"])));
    assert_eq!(found(&lib, "AcmeSans-SemiBold"), (Some(How::FamilyStyle), names(&["Acme Sans Semi Bold"])));
    // Written another way: short forms, words in another order, Regular for Roman.
    assert_eq!(found(&lib, "Acme Sans Bold It").1, names(&["Acme Sans Bold Italic"]));
    assert_eq!(found(&lib, "Acme Sans Italic Bold").1, names(&["Acme Sans Bold Italic"]));
    assert_eq!(found(&lib, "Acme Sans Regular").1, names(&["Acme Sans Roman"]));
    assert_eq!(found(&lib, "Acme Sans Medium Cond").1, names(&["Acme Sans Condensed Medium"]));
    // Oblique is Italic.
    assert_eq!(found(&library(), "Helvetica Neue Bold Italic").1, names(&["Helvetica Neue Bold Oblique"]));
}

#[test]
fn the_longest_family_at_the_start_wins() {
    let lib = library();
    assert_eq!(found(&lib, "Inter Display Bold").1, names(&["Inter Display Bold"]));
    assert_eq!(found(&lib, "Inter Bold Italic").1, names(&["Inter Bold Italic"]));
}

#[test]
fn an_older_family_name_finds_that_weights_regular_style() {
    // Name IDs 1 and 2 name one weight as its own family ("Acme Sans Med", Regular and Italic),
    // which the newer names (16 and 17) don't spell the same way.
    let lib = index(&[
        font("/f/m.otf", "AcmeSans-Md", "Acme Sans", "Medium").legacy("Acme Sans Med", "Regular"),
        font("/f/mi.otf", "AcmeSans-MdIt", "Acme Sans", "Medium Italic").legacy("Acme Sans Med", "Italic"),
        font("/f/k.otf", "AcmeBook-It", "Acme", "Book Italic").legacy("Acme Book", "Italic"),
    ]);
    assert_eq!(found(&lib, "Acme Sans Med"), (Some(How::FamilyStyle), names(&["Acme Sans Medium"])));
    // Its italic, by the older family and style.
    assert_eq!(found(&lib, "Acme Sans Med Italic").1, names(&["Acme Sans Medium Italic"]));
    // No regular style under that name: every style that has it.
    assert_eq!(found(&lib, "Acme Book").1, names(&["Acme Book Italic"]));
}

#[test]
fn a_style_of_a_variable_family_finds_the_variable_font() {
    let lib = library();
    assert_eq!(found(&lib, "Roboto Flex Bold"), (Some(How::NamedStyle), names(&["Roboto Flex Regular"])));
    // Upright and italic variable fonts: the one with the slant asked for.
    let lib = index(&[
        font("/f/Fraunces.ttf", "Fraunces-Regular", "Fraunces", "Regular").variable(),
        font("/f/Fraunces-Italic.ttf", "Fraunces-Italic", "Fraunces", "Italic").variable().italic(true),
    ]);
    assert_eq!(found(&lib, "Fraunces Black Italic").1, names(&["Fraunces Italic"]));
    assert_eq!(found(&lib, "Fraunces SemiBold").1, names(&["Fraunces Regular"]));
    // A static style of that name comes first.
    let lib = index(&[
        font("/f/Fraunces.ttf", "Fraunces-Regular", "Fraunces", "Regular").variable(),
        font("/f/Fraunces-Black.otf", "Fraunces-Black", "Fraunces", "Black"),
    ]);
    assert_eq!(found(&lib, "Fraunces Blk"), (Some(How::FamilyStyle), names(&["Fraunces Black"])));
}

#[test]
fn a_line_that_matches_nothing_gets_the_closest_names() {
    let lib = library();
    let m = one(&lib, "Inter Bld");
    assert_eq!(m.how, None);
    assert!(m.faces.is_empty());
    assert_eq!(m.near.first().map(String::as_str), Some("Inter Bold"));
    assert!(m.near.len() <= NEAR_MISSES);
    // A misspelt family.
    assert_eq!(one(&lib, "Intr").near, names(&["Inter"]));
    assert_eq!(one(&lib, "Lorra Italic").near, names(&["Lora"]));
    // The start of a family's name.
    assert_eq!(one(&lib, "Helvet").near, names(&["Helvetica Neue"]));
    // Nothing close, or too short to tell.
    assert!(one(&lib, "Zapfino").near.is_empty());
    assert!(one(&lib, "Lx").near.is_empty());
}

#[test]
fn closest_names_are_worked_out_for_the_first_lines_only() {
    let lib = library();
    let lines: Vec<NameLine> = (0..301).map(|_| NameLine::Text("Intr".into())).chain([NameLine::Text("Inter".into())]).collect();
    let out = lib.match_lines(&lines, |_| false);
    assert_eq!(out.len(), 302, "an answer for every line, in order");
    assert!(!out[299].near.is_empty());
    assert!(out[300].near.is_empty(), "past the budget, a line goes without");
    assert_eq!(out[301].how, Some(How::Family), "matching still works past it");
}

#[test]
fn empty_and_very_long_lines_find_nothing() {
    let lib = library();
    for line in ["", "   ", "---", ".otf"] {
        let m = one(&lib, line);
        assert_eq!((m.how, m.faces.len(), m.near.len()), (None, 0, 0), "{line:?}");
    }
    let long = format!("Inter {}", "x".repeat(MAX_LINE));
    let m = one(&lib, &long);
    assert_eq!((m.how, m.near.len()), (None, 0));
}

#[test]
fn creative_cloud_files_are_never_matched() {
    let lib = index(&[
        font(ADOBE, "Minion-Regular", "Minion", "Regular"),
        font(ADOBE, "Acumin-Bold", "Acumin", "Bold"),
        font("/f/Acumin-Bold.otf", "Acumin-Bold", "Acumin", "Bold"),
    ]);
    for line in ["Minion-Regular", "Minion", "Minion Regular"] {
        let m = one(&lib, line);
        assert_eq!(m.how, None, "{line}");
        assert!(m.near.is_empty(), "{line}: not even as a closest name");
    }
    // Another copy is fine; only that copy is offered.
    let m = one(&lib, "Acumin-Bold");
    assert_eq!(m.how, Some(How::PostScript));
    assert_eq!(m.faces.len(), 1);
    assert_eq!(m.faces[0].ids, vec![3]);
}

#[test]
fn every_copy_of_a_style_is_offered_with_where_it_lives() {
    let lib = index(&[
        font("/a/Inter-Bold.otf", "Inter-Bold", "Inter", "Bold"),
        font("/b/Inter-Bold.otf", "Inter-Bold", "Inter", "Bold"),
        font("/Library/Fonts/Lora.ttf", "Lora-Regular", "Lora", "Regular").installed(),
        font("/drive/Lora.ttf", "Lora-Regular", "Lora", "Regular"),
        font("/drive/Mono.ttf", "Mono-Regular", "Mono", "Regular"),
    ]);
    let online = |path: &str| path.starts_with("/drive/");
    let out = lib.match_lines(&[NameLine::Text("Inter-Bold".into()), NameLine::Text("Lora".into()), NameLine::Text("Mono".into())], online);
    let inter = &out[0].faces[0];
    assert_eq!(inter.ids, vec![1, 2]);
    assert_eq!(inter.key, "ps:Inter-Bold|static|r");
    assert!(!inter.installed && !inter.online_only);
    // In a macOS font folder: always on, so it never needs a download.
    let lora = &out[1].faces[0];
    assert!(lora.installed && !lora.online_only);
    // Every copy online-only: turning it on downloads it first.
    let mono = &out[2].faces[0];
    assert!(mono.online_only && !mono.installed);
}

#[test]
fn fonts_named_in_parts_find_by_postscript_name_then_family_and_style() {
    let lib = library();
    let lines: Vec<NameLine> = serde_json::from_str(
        r#"[
            {"family": "Inter", "style": "Bold"},
            {"postscriptName": "Lora-Italic", "family": "Wrong", "style": "Wrong"},
            {"postscriptName": "Missing-Name", "family": "Lora", "style": "Regular"},
            {"family": "Roboto Flex"},
            {"style": "Bold"},
            {"postscriptName": "Intr-Bold"},
            "Inter-Regular"
        ]"#,
    )
    .unwrap();
    let out = lib.match_lines(&lines, |_| false);
    let styles = |m: &LineMatch| m.faces.iter().map(|f| format!("{} {}", f.family, f.style)).collect::<Vec<_>>();
    assert_eq!((out[0].how, styles(&out[0])), (Some(How::PostScript), names(&["Inter Bold"])), "Inter + Bold reads as Inter-Bold's key");
    assert_eq!((out[1].how, styles(&out[1])), (Some(How::PostScript), names(&["Lora Italic"])));
    assert_eq!(styles(&out[2]), names(&["Lora Regular"]), "a PostScript name not found falls back to the family and style");
    assert_eq!(out[3].how, Some(How::Family));
    assert_eq!((out[4].how, out[4].near.len()), (None, 0), "a style alone names nothing");
    assert_eq!(out[5].how, None);
    assert_eq!(out[5].near.first().map(String::as_str), Some("Inter"), "a PostScript name not found gets the closest names");
    assert_eq!(styles(&out[6]), names(&["Inter Regular"]));
}

#[test]
fn answers_go_to_the_ui_in_its_words() {
    let lib = library();
    let json = serde_json::to_value(lib.match_lines(&[NameLine::Text("Inter-Bold".into()), NameLine::Text("Intr".into())], |_| false)).unwrap();
    assert_eq!(json[0]["how"], "postScript");
    assert_eq!(json[0]["faces"][0]["key"], "ps:Inter-Bold|static|r");
    assert_eq!(json[0]["faces"][0]["postscriptName"], "Inter-Bold");
    assert_eq!(json[0]["faces"][0]["onlineOnly"], false);
    assert_eq!(json[1]["how"], serde_json::Value::Null);
    assert_eq!(json[1]["near"][0], "Inter");
}

#[test]
fn the_library_query_reads_every_name_a_copy_carries() {
    let dir = std::env::temp_dir().join(format!("fontface-font-names-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let conn = crate::db::open(&dir.join("library.sqlite3")).unwrap();
    conn.execute("INSERT INTO folders (path, added_at, kind) VALUES ('/fonts', 0, 'user')", []).unwrap();
    let user = conn.last_insert_rowid();
    conn.execute("INSERT INTO folders (path, added_at, kind) VALUES ('/Library/Fonts', 0, 'system')", []).unwrap();
    let system = conn.last_insert_rowid();
    let add = |folder: i64, path: &str, ps: &str, family: &str, style: &str, full: &str, legacy: Option<(&str, &str)>| {
        conn.execute(
            "INSERT INTO fonts (folder_id, path, face_index, file_size, mtime, family, subfamily, full_name, postscript_name,
                weight, width, italic, monospace, variable, glyph_count, format, legacy_family, legacy_style)
             VALUES (?1, ?2, 0, 1, 1, ?3, ?4, ?5, ?6, 400, 5, 0, 0, 0, 10, 'OpenType', ?7, ?8)",
            params![folder, path, family, style, full, ps, legacy.map(|l| l.0), legacy.map(|l| l.1)],
        )
        .unwrap();
        conn.last_insert_rowid()
    };
    let bd = add(user, "/fonts/HN-Bd.otf", "HelveticaNeue-Bd", "Helvetica Neue", "Bold", "Helvetica Neue Bold", None);
    let md = add(system, "/Library/Fonts/AS-Md.otf", "AcmeSans-Md", "Acme Sans", "Medium", "Acme Sans Medium", Some(("Acme Sans Med", "Regular")));
    let lib = NameIndex::load(&conn).unwrap();
    let out = lib.match_lines(&[NameLine::Text("Helvetica Neue Bold".into()), NameLine::Text("Acme Sans Med".into())], |_| false);
    assert_eq!(out[0].how, Some(How::FullName));
    assert_eq!(out[0].faces[0].ids, vec![bd]);
    assert_eq!(out[1].how, Some(How::FamilyStyle));
    assert_eq!(out[1].faces[0].ids, vec![md]);
    assert!(out[1].faces[0].installed);
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

/// What the Figma plugin copies (figma-plugin/fixtures/, checked against the plugin itself in
/// src/figmaPlugin.test.ts): "Family Style" lines, and the same fonts as JSON.
const FIGMA_LINES: &str = include_str!("../../../figma-plugin/fixtures/copy-all.txt");
const FIGMA_JSON: &str = include_str!("../../../figma-plugin/fixtures/copy-as-json.json");

#[test]
fn the_figma_plugins_list_finds_each_font_as_its_files_name_it() {
    // The fonts as their files name them: PostScript names, typographic names, variable fonts.
    let lib = index(&[
        font("/f/Fraunces[wght].ttf", "Fraunces-Regular", "Fraunces", "Regular").variable(),
        font("/f/Fraunces-Italic[wght].ttf", "Fraunces-Italic", "Fraunces", "Italic").variable().italic(true),
        font("/System/Library/Fonts/Helvetica.ttc", "Helvetica", "Helvetica", "Regular").installed(),
        font("/System/Library/Fonts/Helvetica.ttc", "Helvetica-BoldOblique", "Helvetica", "Bold Oblique").installed(),
        font("/f/IBMPlexSans-SemiBoldItalic.otf", "IBMPlexSans-SemiBoldItalic", "IBM Plex Sans", "SemiBold Italic"),
        font("/f/Inter-Regular.otf", "Inter-Regular", "Inter", "Regular"),
        font("/f/InterDisplay-Bold.otf", "InterDisplay-Bold", "Inter Display", "Bold"),
        font("/f/Lora-Italic[wght].ttf", "Lora-Italic", "Lora", "Italic").variable(),
        font("/f/NotoSansJP[wght].ttf", "NotoSansJP-Thin", "Noto Sans JP", "Thin").variable(),
        font("/f/UniversLTStd-Light.otf", "UniversLTStd-Light", "Univers LT Std", "45 Light"),
    ]);
    let expected = [
        Some("Fraunces Italic"),
        Some("Helvetica Bold Oblique"),
        Some("IBM Plex Sans SemiBold Italic"),
        Some("Inter Regular"),
        Some("Inter Display Bold"),
        Some("Lora Italic"),
        Some("Noto Sans JP Thin"),
        None, // Söhne Buch isn't in this library
        Some("Univers LT Std 45 Light"),
    ];
    let text: Vec<NameLine> = FIGMA_LINES.lines().map(|l| NameLine::Text(l.into())).collect();
    let json: serde_json::Value = serde_json::from_str(FIGMA_JSON).unwrap();
    let parts: Vec<NameLine> = serde_json::from_value(json["fonts"].clone()).unwrap();
    assert_eq!(text.len(), expected.len());
    assert_eq!(parts.len(), expected.len());
    for lines in [text, parts] {
        let out = lib.match_lines(&lines, |_| false);
        for ((line, m), want) in lines.iter().zip(&out).zip(expected) {
            let got: Vec<String> = m.faces.iter().map(|f| format!("{} {}", f.family, f.style)).collect();
            match want {
                Some(want) => assert_eq!(got, vec![want.to_string()], "{line:?}"),
                None => assert!(got.is_empty(), "{line:?}"),
            }
        }
        // The variable ones come from their variable fonts.
        assert_eq!(out[0].how, Some(How::NamedStyle));
        assert_eq!(out[6].how, Some(How::NamedStyle));
    }
}
