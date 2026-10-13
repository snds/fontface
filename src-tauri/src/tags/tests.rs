//! Tag storage, imports and exports, against a temporary library with hand-made font rows.
//! The Typeface fixtures are small synthetic files shaped like real backups (formats 2–4).

use std::path::PathBuf;

use rusqlite::{params, Connection};

use super::{
    export, face_key,
    import::{self, Source, SourceFont, SourceTag},
    is_loose, key_postscript_name, loose_key, organize, typeface, LibraryIndex,
};
use crate::db;

struct Library {
    dir: PathBuf,
    conn: Connection,
    user_folder: i64,
    system_folder: i64,
}

impl Library {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("fontface-tags-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = db::open(&dir.join("library.sqlite3")).unwrap();
        super::ensure_schema(&conn).unwrap();
        crate::activation::ensure_schema(&conn).unwrap();
        conn.execute("INSERT INTO folders (path, added_at, kind) VALUES ('/fonts', 0, 'user')", []).unwrap();
        let user_folder = conn.last_insert_rowid();
        conn.execute("INSERT INTO folders (path, added_at, kind) VALUES ('/Library/Fonts', 0, 'system')", []).unwrap();
        let system_folder = conn.last_insert_rowid();
        Library { dir, conn, user_folder, system_folder }
    }

    /// Adds a font row. Returns its face key.
    fn font(&self, folder: i64, path: &str, ps: Option<&str>, family: &str, style: &str, variable: bool, italic: bool) -> String {
        self.conn
            .execute(
                "INSERT INTO fonts (folder_id, path, face_index, file_size, mtime, family, subfamily, postscript_name,
                    weight, width, italic, monospace, variable, glyph_count, format)
                 VALUES (?1, ?2, 0, 1, 1, ?3, ?4, ?5, 400, 5, ?6, 0, ?7, 10, 'OpenType')",
                params![folder, path, family, style, ps, italic, variable],
            )
            .unwrap();
        face_key(ps, variable, italic, path, 0)
    }

    fn user(&self, path: &str, ps: &str, family: &str) -> String {
        self.font(self.user_folder, path, Some(ps), family, "Regular", false, false)
    }

    fn keys_of(&self, tag: &str) -> Vec<String> {
        let mut stmt = self
            .conn
            .prepare("SELECT face_key FROM tag_fonts JOIN tags ON tags.id = tag_id WHERE tags.name = ?1 ORDER BY face_key")
            .unwrap();
        stmt.query_map([tag], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
    }

    fn tag_names(&self) -> Vec<String> {
        super::list_tags(&self.conn).unwrap().into_iter().map(|t| t.name).collect()
    }
}

impl Drop for Library {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn tag(name: &str, fonts: &[&str]) -> SourceTag {
    SourceTag {
        name: name.into(),
        color: None,
        fonts: fonts.iter().map(|f| SourceFont::PostScript(f.to_string())).collect(),
        suggested: true,
        note: None,
    }
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

// ------------------------------------------------------------------------------ keys + schema

#[test]
fn face_keys_match_the_ui() {
    // Same strings as faceKey in src/library.ts.
    assert_eq!(face_key(Some("Inter-Bold"), false, false, "/a.otf", 0), "ps:Inter-Bold|static|r");
    assert_eq!(face_key(Some("Inter-Italic"), true, true, "/a.otf", 0), "ps:Inter-Italic|var|i");
    assert_eq!(face_key(None, false, false, "/x/a.ttc", 2), "file:/x/a.ttc#2");
    assert_eq!(face_key(Some(""), false, false, "/x/a.ttf", 0), "file:/x/a.ttf#0", "an empty name is no name");

    assert_eq!(key_postscript_name("ps:Inter-Bold|static|r"), Some("Inter-Bold"));
    assert_eq!(key_postscript_name("ps:Odd|Name|var|i"), Some("Odd|Name"));
    assert_eq!(key_postscript_name("ps:Inter-Bold"), Some("Inter-Bold"));
    assert_eq!(key_postscript_name("file:/a#0"), None);
    assert!(is_loose("ps:Inter-Bold"));
    assert!(is_loose("ps:Odd|Name"));
    assert!(!is_loose("ps:Inter-Bold|static|r"));
    assert!(!is_loose("file:/a#0"));
}

#[test]
fn schema_is_idempotent_and_leaves_the_version_alone() {
    let lib = Library::new("schema");
    let version = |c: &Connection| c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap();
    let before = version(&lib.conn);
    super::ensure_schema(&lib.conn).unwrap();
    super::ensure_schema(&lib.conn).unwrap();
    assert_eq!(version(&lib.conn), before);
    super::ensure_column(&lib.conn, "tags", "note", "note TEXT").unwrap();
    super::ensure_column(&lib.conn, "tags", "note", "note TEXT").unwrap();
    let columns: i64 =
        lib.conn.query_row("SELECT COUNT(*) FROM pragma_table_info('tags') WHERE name = 'note'", [], |r| r.get(0)).unwrap();
    assert_eq!(columns, 1);
}

// ----------------------------------------------------------------------------------- storage

#[test]
fn creating_nested_tags_creates_their_parents() {
    let mut lib = Library::new("create");
    let tag = super::create_tag(&mut lib.conn, "  Sci-Fi /  Star  Trek / TNG ", Some("blue")).unwrap();
    assert_eq!(tag.name, "Sci-Fi/Star Trek/TNG");
    assert_eq!(lib.tag_names(), names(&["Sci-Fi", "Sci-Fi/Star Trek", "Sci-Fi/Star Trek/TNG"]));
    // Parents share the color; a new child of an existing parent takes the parent's.
    assert!(super::list_tags(&lib.conn).unwrap().iter().all(|t| t.color == "blue"));
    let child = super::create_tag(&mut lib.conn, "sci-fi/Aliens", None).unwrap();
    assert_eq!(child.name, "Sci-Fi/Aliens", "joins the existing parent's spelling");
    assert_eq!(child.color, "blue");
    // Names are unique ignoring letter case.
    assert!(super::create_tag(&mut lib.conn, "SCI-FI", None).is_err());
    assert!(super::create_tag(&mut lib.conn, " / ", None).is_err());
    assert!(super::create_tag(&mut lib.conn, "Bad", Some("chartreuse")).is_err());
}

#[test]
fn new_top_level_tags_spread_over_the_palette() {
    let mut lib = Library::new("colors");
    let a = super::create_tag(&mut lib.conn, "A", None).unwrap();
    let b = super::create_tag(&mut lib.conn, "B", None).unwrap();
    assert_ne!(a.color, b.color);
    assert_ne!(a.color, "gray", "gray is kept for the macOS font folders");
}

#[test]
fn renaming_moves_nested_tags_and_refuses_clashes() {
    let mut lib = Library::new("rename");
    let st = super::create_tag(&mut lib.conn, "Sci-Fi/Star Trek", Some("red")).unwrap();
    super::create_tag(&mut lib.conn, "Sci-Fi/Star Trek/TNG", None).unwrap();
    super::create_tag(&mut lib.conn, "Favorites", None).unwrap();

    let moved = super::rename_tag(&mut lib.conn, st.id, "TV/Trek").unwrap();
    assert_eq!(moved.name, "TV/Trek");
    assert_eq!(lib.tag_names(), names(&["Favorites", "Sci-Fi", "TV", "TV/Trek", "TV/Trek/TNG"]));

    assert!(super::rename_tag(&mut lib.conn, st.id, "Favorites").is_err(), "name taken");
    assert!(super::rename_tag(&mut lib.conn, st.id, "TV/Trek/TNG/Deep").is_err(), "inside itself");
    // Only the letter case changes: allowed, and children follow.
    super::rename_tag(&mut lib.conn, st.id, "TV/TREK").unwrap();
    assert_eq!(lib.tag_names(), names(&["Favorites", "Sci-Fi", "TV", "TV/TREK", "TV/TREK/TNG"]));
}

#[test]
fn deleting_a_tag_deletes_its_children_and_their_fonts() {
    let mut lib = Library::new("delete");
    let key = lib.user("/fonts/a.otf", "A-Regular", "A");
    let parent = super::create_tag(&mut lib.conn, "Style", None).unwrap();
    let child = super::create_tag(&mut lib.conn, "Style/Sans", None).unwrap();
    let other = super::create_tag(&mut lib.conn, "Styles", None).unwrap();
    super::assign(&mut lib.conn, &[child.id, other.id], &[key.clone()], true).unwrap();
    let deleted = super::delete_tag(&mut lib.conn, parent.id).unwrap();
    assert_eq!(deleted.len(), 2);
    assert_eq!(lib.tag_names(), names(&["Styles"]), "a tag that only starts the same way stays");
    let rows: i64 = lib.conn.query_row("SELECT COUNT(*) FROM tag_fonts", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 1, "the deleted tags' fonts went with them");
}

#[test]
fn tags_follow_the_font_not_the_row() {
    let mut lib = Library::new("identity");
    let key = lib.user("/fonts/Inter.otf", "Inter-Regular", "Inter");
    let copy = lib.user("/fonts/copies/Inter.ttf", "Inter-Regular", "Inter");
    assert_eq!(key, copy, "copies share one key");
    let t = super::create_tag(&mut lib.conn, "Body", None).unwrap();
    super::assign(&mut lib.conn, &[t.id], &[key.clone()], true).unwrap();
    super::assign(&mut lib.conn, &[t.id], &[key.clone()], true).unwrap();
    assert_eq!(lib.keys_of("Body"), vec![key.clone()], "assigning twice stores it once");

    // A rescan (or a re-download) replaces the rows; the tag still applies.
    lib.conn.execute("DELETE FROM fonts", []).unwrap();
    lib.user("/fonts/new place/Inter.otf", "Inter-Regular", "Inter");
    let index = LibraryIndex::load(&lib.conn).unwrap();
    let org = organize(&lib.conn).unwrap();
    let face = &index.faces[0];
    assert_eq!(org.assignments.get(&face.key), Some(&vec![t.id]));

    // Fonts without a PostScript name are tagged by file.
    let file = lib.font(lib.user_folder, "/fonts/noname.ttf", None, "No Name", "Regular", false, false);
    assert_eq!(file, "file:/fonts/noname.ttf#0");
    super::assign(&mut lib.conn, &[t.id], &[file.clone()], true).unwrap();
    assert!(lib.keys_of("Body").contains(&file));
    assert!(super::assign(&mut lib.conn, &[t.id], &["bogus".into()], true).is_err());
}

#[test]
fn removing_a_tag_also_removes_one_kept_from_an_import() {
    let mut lib = Library::new("loose");
    let key = lib.user("/fonts/a.otf", "A-Regular", "A");
    let t = super::create_tag(&mut lib.conn, "Kept", None).unwrap();
    super::assign(&mut lib.conn, &[t.id], &[loose_key("A-Regular")], true).unwrap();
    super::assign(&mut lib.conn, &[t.id], &[key], false).unwrap();
    assert!(lib.keys_of("Kept").is_empty());
}

#[test]
fn location_colors_are_set_and_cleared() {
    let lib = Library::new("locations");
    super::set_location_color(&lib.conn, "/fonts/sub", Some("green")).unwrap();
    super::set_location_color(&lib.conn, "/fonts/sub", Some("teal")).unwrap();
    super::set_location_color(&lib.conn, super::FONT_BOOK_LOCATION, Some("gray")).unwrap();
    let colors = super::location_colors(&lib.conn).unwrap();
    assert_eq!(colors.get("/fonts/sub").map(String::as_str), Some("teal"));
    assert_eq!(colors.len(), 2);
    super::set_location_color(&lib.conn, "/fonts/sub", None).unwrap();
    assert_eq!(super::location_colors(&lib.conn).unwrap().len(), 1);
    assert!(super::set_location_color(&lib.conn, "nowhere", Some("red")).is_err());
    assert!(super::set_location_color(&lib.conn, "/fonts", Some("neon")).is_err());
}

// ---------------------------------------------------------------------------------- Typeface

/// Shaped like a real format 4 backup: nested names, empty parents, Typeface's own lists,
/// variable-instance names and a list of watched folders.
const TYPEFACE_V4: &str = r#"{
  "version": 4,
  "date": 1778460977.676847,
  "locations": ["/Users/someone/Fonts", "/Users/someone/Library/CloudStorage/Drive/Fonts"],
  "families": [],
  "mainFonts": [],
  "tags": [
    { "tag": { "name": "Fixed Width" }, "fonts": ["Mono-Regular", "Mono-Bold"] },
    { "tag": { "name": "Sci-Fi" }, "fonts": [] },
    { "tag": { "name": "Sci-Fi/Star Trek/TNG" }, "fonts": ["Okuda"] },
    { "tag": { "name": "Style/Sans" }, "fonts": ["Inter-Regular_Bold", "Inter-Regular_Black", "Missing-Font"] },
    { "tag": { "name": "style/sans" }, "fonts": ["Mono-Regular"] },
    { "tag": { "name": "typeface/active" }, "fonts": ["Okuda"] },
    { "tag": { "name": "quick-collection" }, "fonts": [] }
  ]
}"#;

/// Format 2 had no `mainFonts`; format 3 no `locations`.
const TYPEFACE_V2: &str = r#"{ "version": 2, "date": 1679679082.25, "families": [],
  "tags": [ { "tag": { "name": "Fun" }, "fonts": ["Okuda", 42, ""] } ] }"#;

fn typeface_library(name: &str) -> Library {
    let lib = Library::new(name);
    lib.user("/fonts/Mono-Regular.otf", "Mono-Regular", "Mono");
    lib.user("/fonts/Mono-Bold.otf", "Mono-Bold", "Mono");
    lib.user("/fonts/Okuda.otf", "Okuda", "Okuda");
    // The static Inter-Regular, and the variable font with the same default name.
    lib.user("/fonts/Inter-Regular.otf", "Inter-Regular", "Inter");
    lib.font(lib.user_folder, "/fonts/Inter[wght].ttf", Some("Inter-Regular"), "Inter", "Regular", true, false);
    lib
}

#[test]
fn reads_typeface_backups() {
    let source = typeface::parse(TYPEFACE_V4.as_bytes()).unwrap();
    assert_eq!(source.tags.len(), 7);
    assert_eq!(source.date, Some(1778460977.676847));
    let active = source.tags.iter().find(|t| t.name == "typeface/active").unwrap();
    assert!(!active.suggested && active.note.is_some(), "Typeface's own lists aren't ticked");
    assert!(source.tags.iter().find(|t| t.name == "quick-collection").is_some_and(|t| !t.suggested));
    assert!(source.notes.iter().any(|n| n.contains("watching 2 folders")));

    let old = typeface::parse(TYPEFACE_V2.as_bytes()).unwrap();
    assert_eq!(old.tags[0].fonts, vec![SourceFont::PostScript("Okuda".into())], "non-names and blanks are skipped");

    assert!(typeface::parse(b"{\"nope\": true}").is_err());
    assert!(typeface::parse(b"not json").is_err());
}

#[test]
fn typeface_import_previews_then_applies_once() {
    let mut lib = typeface_library("typeface");
    let source = typeface::parse(TYPEFACE_V4.as_bytes()).unwrap();
    let preview = import::preview(&lib.conn, &source).unwrap();

    // "Style/Sans" and "style/sans" merge.
    assert_eq!(preview.tags.len(), 6);
    let sans = preview.tags.iter().find(|t| t.name == "Style/Sans").unwrap();
    assert_eq!(sans.merged, vec!["style/sans".to_string()]);
    assert_eq!(sans.fonts, 4);
    assert_eq!(sans.unmatched, 1, "Missing-Font isn't in the library");
    // Both Inter instances land on the variable font only; plus Mono-Regular.
    assert_eq!(sans.matched, 2);
    assert_eq!(preview.fonts, 6);
    assert_eq!(preview.unmatched_fonts, 1);
    // "Sci-Fi/Star Trek", "Style" and "typeface" aren't in the file; the preview says so.
    assert!(preview.notes.iter().any(|n| n.starts_with("3 parent tags not in this list")));

    let chosen: Vec<String> = preview.tags.iter().filter(|t| t.suggested).map(|t| t.name.clone()).collect();
    assert!(!chosen.contains(&"typeface/active".to_string()));
    let result = import::apply(&mut lib.conn, &source, &chosen, true).unwrap();
    assert_eq!(result.added, 2 + 1 + 2);
    assert_eq!(result.kept, 1, "Missing-Font is kept for later");

    assert_eq!(lib.keys_of("Style/Sans"), names(&["ps:Inter-Regular|var|r", "ps:Missing-Font", "ps:Mono-Regular|static|r"]));
    assert_eq!(lib.keys_of("Sci-Fi/Star Trek/TNG"), names(&["ps:Okuda|static|r"]));
    // "Sci-Fi/Star Trek" wasn't in the file but is created as a parent; nested tags share
    // their top level's color.
    let tags = super::list_tags(&lib.conn).unwrap();
    let color_of = |n: &str| tags.iter().find(|t| t.name == n).map(|t| t.color.clone()).unwrap();
    assert_eq!(color_of("Sci-Fi/Star Trek"), color_of("Sci-Fi"));
    assert_eq!(color_of("Sci-Fi/Star Trek/TNG"), color_of("Sci-Fi"));
    assert!(tags.iter().all(|t| t.name != "typeface/active"));

    // Running it again adds nothing.
    let again = import::preview(&lib.conn, &source).unwrap();
    assert!(again.tags.iter().filter(|t| t.suggested).all(|t| t.exists && t.new == 0));
    let result = import::apply(&mut lib.conn, &source, &chosen, true).unwrap();
    assert_eq!((result.added, result.kept, result.tags_created), (0, 0, 0));

    // Nor once a kept font arrives: it already has the tag through the kept key.
    lib.user("/fonts/Missing-Font.otf", "Missing-Font", "Missing");
    let again = import::preview(&lib.conn, &source).unwrap();
    assert!(again.tags.iter().filter(|t| t.suggested).all(|t| t.new == 0));
    let result = import::apply(&mut lib.conn, &source, &chosen, true).unwrap();
    assert_eq!((result.added, result.tags_updated), (0, 0));
    assert_eq!(lib.tag_names(), names(&["Fixed Width", "Sci-Fi", "Sci-Fi/Star Trek", "Sci-Fi/Star Trek/TNG", "Style", "Style/Sans"]));
}

#[test]
fn unmatched_fonts_are_only_kept_when_asked() {
    let mut lib = typeface_library("unmatched");
    let source = Source { tags: vec![tag("Later", &["Gone-Bold", "Afacad-Regular_SemiBold"])], ..Default::default() };
    import::apply(&mut lib.conn, &source, &names(&["Later"]), false).unwrap();
    assert!(lib.keys_of("Later").is_empty());
    let result = import::apply(&mut lib.conn, &source, &names(&["later"]), true).unwrap();
    assert_eq!(result.kept, 2, "counts fonts, not keys");
    // A named instance is also kept under its variable font (either slant), never a static one.
    assert_eq!(
        lib.keys_of("Later"),
        names(&["ps:Afacad-Regular_SemiBold", "ps:Afacad-Regular|var|i", "ps:Afacad-Regular|var|r", "ps:Gone-Bold"])
    );
    // When the font arrives, the loose key matches it.
    let key = lib.user("/fonts/Gone-Bold.otf", "Gone-Bold", "Gone");
    let index = LibraryIndex::load(&lib.conn).unwrap();
    assert_eq!(index.resolve("ps:Gone-Bold").first().map(|f| f.key.clone()), Some(key));
}

#[test]
fn instances_only_match_variable_fonts() {
    let mut lib = Library::new("instances");
    lib.user("/fonts/Static.otf", "Static-Regular", "Static");
    lib.user("/fonts/Foo.otf", "Foo", "Foo");
    let source = Source { tags: vec![tag("T", &["Static-Regular_Bold", "Foo_Bar"])], ..Default::default() };
    let preview = import::preview(&lib.conn, &source).unwrap();
    assert_eq!((preview.tags[0].matched, preview.tags[0].unmatched), (0, 2), "a static font isn't the instance");
    import::apply(&mut lib.conn, &source, &names(&["T"]), true).unwrap();
    // Kept for later instead, so the right fonts get it when they arrive.
    assert!(lib.keys_of("T").contains(&"ps:Foo_Bar".to_string()));
    assert!(lib.keys_of("T").contains(&"ps:Static-Regular|var|r".to_string()));
    assert!(!lib.keys_of("T").iter().any(|k| k == "ps:Foo" || k == "ps:Static-Regular|static|r"));
}

#[test]
fn a_fontface_key_falls_back_to_the_postscript_name() {
    let mut lib = Library::new("fallback");
    lib.font(lib.user_folder, "/fonts/Inter[wght].ttf", Some("Inter-Regular"), "Inter", "Regular", true, false);
    let source = Source {
        tags: vec![SourceTag {
            name: "Body".into(),
            color: None,
            fonts: vec![SourceFont::Key("ps:Inter-Regular|static|r".into())],
            suggested: true,
            note: None,
        }],
        ..Default::default()
    };
    import::apply(&mut lib.conn, &source, &names(&["Body"]), true).unwrap();
    assert_eq!(lib.keys_of("Body"), names(&["ps:Inter-Regular|var|r"]));
}

#[test]
fn bad_entries_in_a_tags_file_are_skipped_not_fatal() {
    let mut lib = typeface_library("bad-json");
    let long = "x".repeat(super::MAX_NAME + 1);
    let json = format!(
        r#"{{"format":"fontface-tags","version":1,"tags":[
            {{"name":"Good","color":"teal","fonts":[{{"key":"ps:Okuda|static|r"}}]}},
            {{"name":"{long}","color":"red","fonts":[]}}],
          "locationColors":{{"service:google":"blue","relative/path":"red","/fonts":"green","/elsewhere":"neon"}}}}"#
    );
    let source = export::parse_json(json.as_bytes()).unwrap();
    let preview = import::preview(&lib.conn, &source).unwrap();
    assert_eq!(preview.tags.len(), 1);
    assert!(preview.notes.iter().any(|n| n.contains("1 tag was left out")));
    let result = import::apply(&mut lib.conn, &source, &names(&["Good"]), true).unwrap();
    assert_eq!(result.location_colors, 1, "only the usable location color is set");
    assert_eq!(lib.keys_of("Good"), names(&["ps:Okuda|static|r"]));
}

#[test]
fn huge_font_names_are_dropped() {
    let backup = format!(r#"{{"version":3,"tags":[{{"tag":{{"name":"T"}},"fonts":["{}","Okuda"]}}]}}"#, "_".repeat(100_000));
    let source = typeface::parse(backup.as_bytes()).unwrap();
    assert_eq!(source.tags[0].fonts, vec![SourceFont::PostScript("Okuda".into())]);
    assert!(source.notes.iter().any(|n| n.contains("too long")));
}

#[test]
fn creating_and_importing_count_new_parents() {
    let mut lib = Library::new("parents");
    let sci = super::create_tag(&mut lib.conn, "Sci-Fi", Some("blue")).unwrap();
    let deep = super::create_tag(&mut lib.conn, "Sci-Fi/Star Trek/TNG", None).unwrap();
    assert_eq!(deep.color, sci.color, "takes the nearest existing parent's color");
    let source = Source { tags: vec![tag("P/Q/R", &[])], ..Default::default() };
    let result = import::apply(&mut lib.conn, &source, &names(&["P/Q/R"]), true).unwrap();
    assert_eq!(result.tags_created, 3);
}

#[test]
fn renames_respect_the_name_limit() {
    let mut lib = Library::new("rename-long");
    let parent = super::create_tag(&mut lib.conn, "A", None).unwrap();
    super::create_tag(&mut lib.conn, &format!("A/{}", "x".repeat(150)), None).unwrap();
    assert!(super::rename_tag(&mut lib.conn, parent.id, &"y".repeat(150)).is_err());
    assert_eq!(lib.tag_names().len(), 2, "nothing was renamed");
}

#[test]
fn export_files_are_written_whole() {
    let lib = Library::new("write");
    let target = lib.dir.join("out.json");
    export::write_file(&target, "first").unwrap();
    export::write_file(&target, "second").unwrap();
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "second");
    let leftovers = std::fs::read_dir(&lib.dir).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with("fontface-tmp")).count();
    assert_eq!(leftovers, 0);
    assert!(export::write_file(&lib.dir.join("missing-folder/out.json"), "x").is_err());
}

#[test]
fn imports_by_file_and_family() {
    let mut lib = typeface_library("files");
    let source = Source {
        tags: vec![SourceTag {
            name: "Picked".into(),
            color: Some("teal".into()),
            fonts: vec![SourceFont::File("/fonts/Okuda.otf".into()), SourceFont::Family("mono".into())],
            suggested: true,
            note: None,
        }],
        ..Default::default()
    };
    let preview = import::preview(&lib.conn, &source).unwrap();
    assert_eq!(preview.tags[0].color, "teal");
    assert_eq!(preview.tags[0].matched, 3);
    import::apply(&mut lib.conn, &source, &names(&["Picked"]), true).unwrap();
    assert_eq!(lib.keys_of("Picked").len(), 3);
}

// ------------------------------------------------------------------------------------ export

#[test]
fn json_export_round_trips() {
    let mut lib = typeface_library("json");
    let pending = super::create_tag(&mut lib.conn, "Sci-Fi/Trek", Some("indigo")).unwrap();
    let okuda = face_key(Some("Okuda"), false, false, "", 0);
    let noname = lib.font(lib.user_folder, "/fonts/noname.ttf", None, "No Name", "Regular", false, false);
    super::assign(&mut lib.conn, &[pending.id], &[okuda.clone(), noname.clone(), loose_key("Not-Here")], true).unwrap();
    super::set_location_color(&lib.conn, "/fonts", Some("green")).unwrap();

    let tags = export::collect(&lib.conn, None).unwrap();
    let trek = tags.iter().find(|t| t.name == "Sci-Fi/Trek").unwrap();
    assert_eq!(trek.fonts.len(), 3);
    let ok = trek.fonts.iter().find(|f| f.key == okuda).unwrap();
    assert_eq!(ok.family.as_deref(), Some("Okuda"));
    assert_eq!(ok.files, vec!["/fonts/Okuda.otf".to_string()]);
    let missing = trek.fonts.iter().find(|f| f.key == "ps:Not-Here").unwrap();
    assert_eq!((missing.postscript_name.as_deref(), missing.files.len()), (Some("Not-Here"), 0));

    let json = export::to_json(&lib.conn, tags, 1_760_000_000).unwrap();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["format"], "fontface-tags");
    assert_eq!(value["version"], 1);
    assert_eq!(value["exportedAt"], "2025-10-09T08:53:20Z");

    // Into a fresh library holding the same fonts.
    let mut other = typeface_library("json-other");
    other.font(other.user_folder, "/fonts/noname.ttf", None, "No Name", "Regular", false, false);
    let source = export::parse_json(json.as_bytes()).unwrap();
    let all: Vec<String> = import::preview(&other.conn, &source).unwrap().tags.into_iter().map(|t| t.name).collect();
    let result = import::apply(&mut other.conn, &source, &all, true).unwrap();
    assert_eq!(result.location_colors, 1);
    assert_eq!(other.keys_of("Sci-Fi/Trek"), lib.keys_of("Sci-Fi/Trek"));
    let colors: Vec<(String, String)> = super::list_tags(&other.conn).unwrap().into_iter().map(|t| (t.name, t.color)).collect();
    assert!(colors.contains(&("Sci-Fi/Trek".into(), "indigo".into())));

    assert!(export::parse_json(br#"{"format":"something-else","version":1,"tags":[]}"#).is_err());
    assert!(export::parse_json(br#"{"format":"fontface-tags","version":99,"tags":[]}"#).is_err());
}

#[test]
fn restoring_a_backup_adds_or_replaces() {
    let mut lib = typeface_library("restore");
    let okuda = face_key(Some("Okuda"), false, false, "", 0);
    let mono = face_key(Some("Mono-Regular"), false, false, "", 0);
    // The backup: "Sci-Fi" (indigo) on Okuda and a font not in the library, and a location color.
    let scifi = super::create_tag(&mut lib.conn, "Sci-Fi", Some("indigo")).unwrap();
    super::assign(&mut lib.conn, &[scifi.id], &[okuda.clone(), loose_key("Not-Here")], true).unwrap();
    super::set_location_color(&lib.conn, "/fonts", Some("green")).unwrap();
    let json = export::to_json(&lib.conn, export::collect(&lib.conn, None).unwrap(), 1_760_000_000).unwrap();
    let backup = export::parse_json(json.as_bytes()).unwrap();

    // Since then: renamed and recolored, moved to another font, a new tag, another color.
    super::rename_tag(&mut lib.conn, scifi.id, "Space").unwrap();
    super::set_tag_color(&lib.conn, scifi.id, "red").unwrap();
    super::assign(&mut lib.conn, &[scifi.id], &[okuda.clone()], false).unwrap();
    super::assign(&mut lib.conn, &[scifi.id], &[mono.clone()], true).unwrap();
    super::create_tag(&mut lib.conn, "Made Later", None).unwrap();
    super::set_location_color(&lib.conn, "/fonts", Some("teal")).unwrap();
    let chosen = names(&["Sci-Fi"]);

    // Adding brings the old name back next to the new one and leaves the rest alone.
    let result = import::apply(&mut lib.conn, &backup, &chosen, true).unwrap();
    assert_eq!(result.tags_removed, 0);
    assert_eq!(lib.tag_names(), names(&["Made Later", "Sci-Fi", "Space"]));
    assert_eq!(super::location_colors(&lib.conn).unwrap().get("/fonts").map(String::as_str), Some("teal"));

    // Replacing puts the tags exactly as they were: names, colors, fonts, kept fonts, location colors.
    let result = import::replace(&mut lib.conn, &backup, &chosen, true).unwrap();
    assert_eq!(result.tags_removed, 3);
    assert_eq!(lib.tag_names(), names(&["Sci-Fi"]));
    let tags = super::list_tags(&lib.conn).unwrap();
    assert_eq!(tags[0].color, "indigo");
    assert_eq!(lib.keys_of("Sci-Fi"), vec![loose_key("Not-Here"), okuda]);
    assert!(lib.keys_of("Space").is_empty());
    let colors = super::location_colors(&lib.conn).unwrap();
    assert_eq!((colors.len(), colors.get("/fonts").map(String::as_str)), (1, Some("green")));

    // Ticking nothing that matches still clears everything; it's the caller's job to ask first.
    let none = import::replace(&mut lib.conn, &backup, &[], true).unwrap();
    assert_eq!(none.tags_removed, 1);
    assert!(lib.tag_names().is_empty());
}

#[test]
fn csv_quotes_and_defuses_formulas() {
    let tags = vec![export::ExportTag {
        name: "Display, \"big\"".into(),
        color: "red".into(),
        fonts: vec![export::ExportFont {
            key: "ps:X|static|r".into(),
            postscript_name: Some("X".into()),
            family: Some("=HYPERLINK(\"http://example.com\")".into()),
            style: Some("Regular".into()),
            variable: Some(false),
            italic: Some(true),
            files: vec!["/fonts/x.otf".into()],
        }],
    }];
    let csv = export::to_csv(&tags);
    let mut lines = csv.split("\r\n");
    assert!(export::to_csv(&[export::ExportTag { name: "a;=1".into(), color: "red".into(), fonts: tags[0].fonts.clone() }]).contains("\"a;=1\""), "semicolons are quoted");
    assert_eq!(lines.next(), Some("tag,color,postscript_name,family,style,variable,italic,file"));
    assert_eq!(
        lines.next(),
        Some(r#""Display, ""big""",red,X,"'=HYPERLINK(""http://example.com"")",Regular,no,yes,/fonts/x.otf"#)
    );
}

#[test]
fn typeface_export_reads_back() {
    let mut lib = typeface_library("tf-export");
    let t = super::create_tag(&mut lib.conn, "Fun", None).unwrap();
    let noname = lib.font(lib.user_folder, "/fonts/noname.ttf", None, "No Name", "Regular", false, false);
    super::assign(&mut lib.conn, &[t.id], &[face_key(Some("Okuda"), false, false, "", 0), noname], true).unwrap();
    let (file, skipped) = export::to_typeface(&export::collect(&lib.conn, None).unwrap(), 1_700_000_000);
    assert_eq!(skipped, 1, "Typeface needs a PostScript name");
    let back = typeface::parse(file.as_bytes()).unwrap();
    assert_eq!(back.tags.len(), 1);
    assert_eq!(back.tags[0].fonts, vec![SourceFont::PostScript("Okuda".into())]);
}

#[test]
fn finder_export_leaves_macos_font_folders_alone() {
    let mut lib = Library::new("finder-plan");
    let key = lib.user("/fonts/A.otf", "A-Regular", "A");
    lib.font(lib.system_folder, "/Library/Fonts/A.otf", Some("A-Regular"), "A", "Regular", false, false);
    let t = super::create_tag(&mut lib.conn, "Mine", None).unwrap();
    super::assign(&mut lib.conn, &[t.id], &[key], true).unwrap();
    let (plan, skipped) = export::finder_plan(&lib.conn, None).unwrap();
    assert_eq!(plan.keys().collect::<Vec<_>>(), vec!["/fonts/A.otf"]);
    assert_eq!(skipped, 1);
}

#[test]
fn exporting_one_tag_includes_its_children() {
    let mut lib = Library::new("scope");
    let parent = super::create_tag(&mut lib.conn, "Sci-Fi/Trek", None).unwrap();
    super::create_tag(&mut lib.conn, "Other", None).unwrap();
    let tags = export::collect(&lib.conn, Some(&[super::find_tag(&lib.conn, "Sci-Fi").unwrap().unwrap().id])).unwrap();
    assert_eq!(tags.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), vec!["Sci-Fi", "Sci-Fi/Trek"]);
    let only = export::collect(&lib.conn, Some(&[parent.id])).unwrap();
    assert_eq!(only.len(), 1);
}

#[test]
fn dates_are_iso_8601() {
    assert_eq!(export::iso8601(0), "1970-01-01T00:00:00Z");
    assert_eq!(export::iso8601(951_782_400), "2000-02-29T00:00:00Z");
    assert_eq!(export::iso8601(1_778_460_977), "2026-05-11T00:56:17Z");
}

// ------------------------------------------------------------------------------------- macOS

/// Finder tags on a temporary file: written, read back, and merged with ones already there.
#[cfg(target_os = "macos")]
#[test]
fn finder_tags_round_trip() {
    let dir = std::env::temp_dir().join(format!("fontface-finder-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("font.otf");
    std::fs::write(&file, b"not really a font").unwrap();
    let path = file.to_string_lossy().into_owned();
    assert!(super::macos::finder_tags(&path).unwrap().is_empty());
    super::macos::set_finder_tags(&path, &names(&["Sci-Fi/Star Trek", "Red"])).unwrap();
    assert_eq!(super::macos::finder_tags(&path).unwrap(), names(&["Sci-Fi/Star Trek", "Red"]));
    let source = super::macos::finder_source([path.clone()].iter());
    let red = source.tags.iter().find(|t| t.name == "Red").unwrap();
    assert_eq!(red.color.as_deref(), Some("red"));
    assert_eq!(red.fonts, vec![SourceFont::File(path)]);
    let _ = std::fs::remove_dir_all(dir);
}

/// Lists Font Book collections. Reads only.
///   cargo test font_book_collections -- --ignored --nocapture
#[cfg(target_os = "macos")]
#[test]
#[ignore]
fn font_book_collections() {
    let source = super::macos::font_book_source();
    for t in &source.tags {
        println!("{}: {} fonts", t.name, t.fonts.len());
    }
}

/// Previews a real Typeface backup against a copy of a real library. Reads only.
///   FONTFACE_TYPEFACE_BACKUP=… FONTFACE_LIBRARY_COPY=… cargo test real_typeface_backup -- --ignored --nocapture
#[test]
#[ignore]
fn real_typeface_backup() {
    let (Ok(backup), Ok(library)) = (std::env::var("FONTFACE_TYPEFACE_BACKUP"), std::env::var("FONTFACE_LIBRARY_COPY"))
    else {
        panic!("set FONTFACE_TYPEFACE_BACKUP and FONTFACE_LIBRARY_COPY");
    };
    // Work on a throwaway copy, so the library file itself is never written.
    let lib = Library::new("real");
    let copy = lib.dir.join("copy.sqlite3");
    std::fs::copy(&library, &copy).unwrap();
    let conn = db::open(&copy).unwrap();
    super::ensure_schema(&conn).unwrap();
    let source = typeface::parse(&std::fs::read(&backup).unwrap()).unwrap();
    let p = import::preview(&conn, &source).unwrap();
    println!("{}: {} tags, {} fonts named, {} matched, {} not in the library", p.label, p.tags.len(), p.fonts, p.matched_fonts, p.unmatched_fonts);
    for t in &p.tags {
        println!(
            "  {:<40} {:>5} fonts → {:>5} styles, {:>5} unmatched{}{}",
            t.name,
            t.fonts,
            t.matched,
            t.unmatched,
            if t.suggested { "" } else { "  (not ticked)" },
            if t.merged.is_empty() { String::new() } else { format!("  merged: {}", t.merged.join(", ")) }
        );
    }
    for n in &p.notes {
        println!("  note: {n}");
    }

    // With FONTFACE_DUMP_DIR set, also apply the ticked tags to the throwaway copy and write
    // JSON in the shapes the UI receives, for trying the interface with real data.
    if let Ok(dir) = std::env::var("FONTFACE_DUMP_DIR") {
        let dir = PathBuf::from(dir);
        let mut conn = conn;
        let write = |name: &str, value: &dyn erased::Json| std::fs::write(dir.join(name), value.json()).unwrap();
        let mut folders = db::list_folders(&conn).unwrap();
        db::check_folders(&mut folders);
        write("folders.json", &folders);
        write("fonts.json", &db::list_fonts(&conn).unwrap());
        write("preview.json", &p);
        let chosen: Vec<String> = p.tags.iter().filter(|t| t.suggested).map(|t| t.name.clone()).collect();
        let result = import::apply(&mut conn, &source, &chosen, true).unwrap();
        write("apply.json", &result);
        write("organize.json", &organize(&conn).unwrap());
        println!("  wrote JSON to {}", dir.display());
    }
}

/// Imports one or more Typeface backups into a library file, in place, the way the Import
/// dialog does: preview, then apply the tags it ticks, keeping tags for fonts not in the
/// library yet. Backups are applied in the order given, so tags merge into the first spelling.
///
/// Dry run (prints the previews; works on a snapshot, so the library isn't touched):
///   FONTFACE_TYPEFACE_BACKUPS='a.typeface-backup|b.typeface-backup' FONTFACE_LIBRARY=/path/library.sqlite3 \
///     cargo test import_typeface_backups -- --ignored --nocapture
/// Add FONTFACE_APPLY_TO=<the same path as FONTFACE_LIBRARY> to write. Fontface's own library
/// also needs FONTFACE_REAL_LIBRARY=yes, and Fontface must not be running.
#[test]
#[ignore]
fn import_typeface_backups() {
    let (Ok(backups), Ok(library)) = (std::env::var("FONTFACE_TYPEFACE_BACKUPS"), std::env::var("FONTFACE_LIBRARY")) else {
        panic!("set FONTFACE_TYPEFACE_BACKUPS (paths separated by |) and FONTFACE_LIBRARY");
    };
    let apply = std::env::var("FONTFACE_APPLY_TO").ok().as_deref() == Some(library.as_str());
    let real = library.contains("/design.snds.fontface/");
    if apply && real && std::env::var("FONTFACE_REAL_LIBRARY").ok().as_deref() != Some("yes") {
        panic!("{library} is Fontface's own library. Set FONTFACE_REAL_LIBRARY=yes (and quit Fontface) to change it.");
    }
    // A dry run works on a snapshot (VACUUM INTO also takes what's still in the WAL file), so
    // the library itself isn't opened for writing at all.
    let _scratch;
    let target = if apply {
        PathBuf::from(&library)
    } else {
        let lib = Library::new("dry-run");
        let snapshot = lib.dir.join("snapshot.sqlite3");
        let source = Connection::open_with_flags(&library, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        source.execute("VACUUM INTO ?1", [snapshot.to_string_lossy()]).unwrap();
        _scratch = lib;
        snapshot
    };
    let mut conn = db::open(&target).unwrap();
    super::ensure_schema(&conn).unwrap();
    let count = |conn: &Connection, sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
    for backup in backups.split('|').map(str::trim).filter(|b| !b.is_empty()) {
        let source = typeface::parse(&std::fs::read(backup).unwrap()).unwrap();
        let matcher = import::Matcher::load(&conn).unwrap().with_named_styles(&source);
        let p = import::preview_with(&conn, &matcher, &source).unwrap();
        println!("\n{backup}\n{}: {} tags, {} fonts named, {} matched ({} named styles of variable fonts, {} tidied names), {} not in the library",
            p.label, p.tags.len(), p.fonts, p.matched_fonts, p.named_style_matches, p.tidied_matches, p.unmatched_fonts);
        for t in &p.tags {
            println!("  {:<40} {:>5} fonts → {:>5} styles ({:>5} new), {:>5} not in the library{}",
                t.name, t.fonts, t.matched, t.new, t.unmatched, if t.suggested { "" } else { "  (not ticked)" });
        }
        for n in &p.notes {
            println!("  note: {n}");
        }
        // With FONTFACE_DUMP_MISSING=<folder>, also write the fonts not found, for a report.
        if let Ok(dir) = std::env::var("FONTFACE_DUMP_MISSING") {
            let name = std::path::Path::new(backup).file_stem().unwrap().to_string_lossy().to_string();
            let file = PathBuf::from(dir).join(format!("missing-{name}.json"));
            std::fs::write(&file, serde_json::to_string(&p.missing).unwrap()).unwrap();
            println!("  wrote {} missing fonts to {}", p.missing.len(), file.display());
        }
        if apply {
            let chosen: Vec<String> = p.tags.iter().filter(|t| t.suggested).map(|t| t.name.clone()).collect();
            let r = import::apply_with(&mut conn, &matcher, &source, &chosen, true).unwrap();
            println!("  applied {} tags: {} created, {} updated, {} tags added to {} styles, tags kept for {} fonts not in the library",
                chosen.len(), r.tags_created, r.tags_updated, r.added, r.styles, r.kept);
        }
    }
    let tags = count(&conn, "SELECT COUNT(*) FROM tags");
    let rows = count(&conn, "SELECT COUNT(*) FROM tag_fonts");
    // Assignments whose font is in the library, and the different styles they cover.
    let index = LibraryIndex::load(&conn).unwrap();
    let keys: Vec<String> = conn.prepare("SELECT face_key FROM tag_fonts").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
    let styles: std::collections::BTreeSet<&str> = keys.iter().flat_map(|k| index.resolve(k)).map(|f| f.key.as_str()).collect();
    let kept = keys.iter().filter(|k| index.resolve(k).is_empty()).count();
    println!("\n{}: {tags} tags, {rows} tag assignments, {} different styles tagged, {kept} assignments kept for fonts not in the library",
        if apply { "after" } else { "unchanged" }, styles.len());
}

/// Lets the dump above write any serializable value through one closure.
mod erased {
    pub trait Json {
        fn json(&self) -> String;
    }
    impl<T: serde::Serialize> Json for T {
        fn json(&self) -> String {
            serde_json::to_string(self).unwrap()
        }
    }
}

// ------------------------------------------------------- named styles, tidied names, missing

/// A font file with only the tables a test needs. With `face` = Some(i), a collection whose
/// face `i` holds the tables (the faces before it are empty).
fn sfnt(tables: &[(&[u8; 4], Vec<u8>)], face: Option<u32>) -> Vec<u8> {
    let faces = face.map_or(1, |i| i + 1) as usize;
    let header = if face.is_some() { 12 + 4 * faces } else { 0 };
    let dir_len = |n: usize| 12 + 16 * n;
    // Empty faces first (no tables), then the real one.
    let mut out = Vec::new();
    if face.is_some() {
        out.extend_from_slice(b"ttcf");
        out.extend_from_slice(&[0, 1, 0, 0]);
        out.extend_from_slice(&(faces as u32).to_be_bytes());
        for i in 0..faces {
            let at = header + dir_len(0) * i;
            out.extend_from_slice(&(at as u32).to_be_bytes());
        }
        for _ in 0..faces - 1 {
            out.extend_from_slice(&[0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        }
    }
    let start = out.len();
    out.extend_from_slice(&[0, 1, 0, 0]);
    out.extend_from_slice(&(tables.len() as u16).to_be_bytes());
    out.extend_from_slice(&[0; 6]);
    let mut at = start + dir_len(tables.len());
    let mut data = Vec::new();
    for (tag, bytes) in tables {
        out.extend_from_slice(*tag);
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&(at as u32).to_be_bytes());
        out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        data.extend_from_slice(bytes);
        at += bytes.len();
    }
    out.extend_from_slice(&data);
    out
}

/// A `name` table with Windows English records.
fn name_table(records: &[(u16, &str)]) -> Vec<u8> {
    let mut head = Vec::new();
    let mut strings = Vec::new();
    head.extend_from_slice(&0u16.to_be_bytes());
    head.extend_from_slice(&(records.len() as u16).to_be_bytes());
    head.extend_from_slice(&((6 + 12 * records.len()) as u16).to_be_bytes());
    for (id, text) in records {
        let utf16: Vec<u8> = text.encode_utf16().flat_map(u16::to_be_bytes).collect();
        for v in [3u16, 1, 0x0409, *id, utf16.len() as u16, strings.len() as u16] {
            head.extend_from_slice(&v.to_be_bytes());
        }
        strings.extend_from_slice(&utf16);
    }
    head.extend_from_slice(&strings);
    head
}

/// An `fvar` table with one axis. Each instance is (style name id, PostScript name id).
fn fvar_table(instances: &[(u16, Option<u16>)], with_ps_ids: bool) -> Vec<u8> {
    let size: u16 = if with_ps_ids { 10 } else { 8 };
    let mut t = Vec::new();
    for v in [1u16, 0, 16, 2, 1, 20, instances.len() as u16, size] {
        t.extend_from_slice(&v.to_be_bytes());
    }
    t.extend_from_slice(b"wght");
    for fixed in [100u32 << 16, 400 << 16, 900 << 16] {
        t.extend_from_slice(&fixed.to_be_bytes());
    }
    t.extend_from_slice(&[0, 0, 1, 0]);
    for (style, ps) in instances {
        t.extend_from_slice(&style.to_be_bytes());
        t.extend_from_slice(&[0, 0]);
        t.extend_from_slice(&(400u32 << 16).to_be_bytes());
        if with_ps_ids {
            t.extend_from_slice(&ps.unwrap_or(0xFFFF).to_be_bytes());
        }
    }
    t
}

fn variable_font(face: Option<u32>) -> Vec<u8> {
    let name = name_table(&[(6, "Var-Regular"), (256, "Condensed Thin"), (257, "Var-CondensedThin"), (258, "Bold"), (259, "Has Spaces")]);
    // Bold has no PostScript name of its own; "Has Spaces" isn't a valid one.
    let fvar = fvar_table(&[(256, Some(257)), (258, None), (258, Some(259))], true);
    sfnt(&[(b"fvar", fvar), (b"name", name)], face)
}

#[test]
fn named_styles_are_read_from_fvar() {
    use super::named_styles::parse;
    let name = name_table(&[(256, "Condensed Thin"), (257, "Var-CondensedThin"), (259, "Has Spaces")]);
    assert_eq!(parse(&fvar_table(&[(256, Some(257)), (258, None), (258, Some(259))], true), &name), vec!["Var-CondensedThin".to_string()]);
    assert!(parse(&fvar_table(&[(256, Some(257))], false), &name).is_empty(), "records without the field have no names");
    assert!(parse(&[0, 1], &name).is_empty(), "a cut-off table reads as nothing");
    assert!(parse(&fvar_table(&[(256, Some(999))], true), &name).is_empty(), "a name id that isn't in the table");
}

#[test]
fn named_styles_tag_their_variable_font() {
    let mut lib = Library::new("named-styles");
    let single = lib.dir.join("Var.ttf");
    std::fs::write(&single, variable_font(None)).unwrap();
    let key = lib.font(lib.user_folder, single.to_str().unwrap(), Some("Var-Regular"), "Var", "Regular", true, false);
    // A collection whose second face is the variable one.
    let ttc = lib.dir.join("Coll.ttc");
    std::fs::write(&ttc, variable_font(Some(1))).unwrap();
    lib.conn
        .execute(
            "INSERT INTO fonts (folder_id, path, face_index, file_size, mtime, family, subfamily, postscript_name,
                weight, width, italic, monospace, variable, glyph_count, format)
             VALUES (?1, ?2, 1, 1, 1, 'Coll', 'Regular', 'Coll-Regular', 400, 5, 0, 0, 1, 10, 'OpenType')",
            params![lib.user_folder, ttc.to_str().unwrap()],
        )
        .unwrap();
    let coll_key = face_key(Some("Coll-Regular"), true, false, "", 0);

    let source = Source { tags: vec![tag("Narrow", &["Var-CondensedThin", "Var-Bold", "Not-Here"])], ..Default::default() };
    let p = import::preview(&lib.conn, &source).unwrap();
    assert_eq!((p.matched_fonts, p.unmatched_fonts, p.named_style_matches), (1, 2, 1));
    assert_eq!(p.tags[0].matched, 2, "the single file and the collection both declare Var-CondensedThin");
    assert!(p.notes.iter().any(|n| n.contains("named style inside variable fonts") && n.contains("Var-CondensedThin")), "{:?}", p.notes);
    let missing: Vec<&str> = p.missing.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(missing, vec!["Not-Here", "Var-Bold"]);
    assert_eq!(p.missing[0].tags, vec!["Narrow".to_string()]);

    import::apply(&mut lib.conn, &source, &names(&["Narrow"]), false).unwrap();
    let mut want = vec![key, coll_key];
    want.sort();
    assert_eq!(lib.keys_of("Narrow"), want);
}

#[test]
fn named_styles_are_only_read_when_needed() {
    let lib = Library::new("named-lazy");
    // A variable font row whose file doesn't exist: matching by name must not need it.
    lib.font(lib.user_folder, "/nowhere/Var.ttf", Some("Var-Regular"), "Var", "Regular", true, false);
    let source = Source { tags: vec![tag("Plain", &["Var-Regular", "Var-Regular_Bold"])], ..Default::default() };
    let p = import::preview(&lib.conn, &source).unwrap();
    assert_eq!((p.matched_fonts, p.named_style_matches, p.missing.len()), (2, 0, 0));
}

#[test]
fn names_match_once_tidied_like_macos() {
    use super::import::tidy_postscript;
    assert_eq!(tidy_postscript("D3 Factorism Katakana"), "D3-Factorism-Katakana");
    assert_eq!(tidy_postscript("MDRS-FD01(c)Zhimetcardozo,2009"), "MDRS-FD01cZhimetcardozo,2009");
    assert_eq!(tidy_postscript("ltr-09:30/60"), "ltr-09:3060");
    assert_eq!(tidy_postscript("Okuda"), "Okuda");

    let mut lib = Library::new("tidied");
    let d3 = lib.user("/fonts/D3.ttf", "D3 Factorism Katakana", "D3 Factorism Katakana");
    lib.user("/fonts/Okuda.otf", "Okuda", "Okuda");
    let source = Source { tags: vec![tag("Sci-Fi", &["D3-Factorism-Katakana", "Okuda"])], ..Default::default() };
    let p = import::preview(&lib.conn, &source).unwrap();
    assert_eq!((p.matched_fonts, p.tidied_matches), (2, 1));
    assert!(p.notes.iter().any(|n| n.contains("D3-Factorism-Katakana")));
    import::apply(&mut lib.conn, &source, &names(&["Sci-Fi"]), false).unwrap();
    assert!(lib.keys_of("Sci-Fi").contains(&d3));
}

#[test]
fn reads_typeface_format_5_and_its_own_download_folder() {
    let v5 = r#"{ "version": 5, "date": 1790869265.07, "meta": { "digests": [2] }, "fontData": [],
      "families": [], "mainFonts": [],
      "locations": ["/Users/x/Library/Containers/com.criminalbird.typeface/Data/Library/Application Support/downloads/Google",
                    "/Users/x/Fonts"],
      "tags": [ { "tag": { "name": "Fun" }, "fonts": ["Okuda"] } ] }"#;
    let source = typeface::parse(v5.as_bytes()).unwrap();
    assert_eq!(source.label, "Typeface backup (format 5)");
    assert_eq!(source.tags.len(), 1);
    assert!(source.notes.iter().any(|n| n.contains("Typeface kept the Google Fonts")), "{:?}", source.notes);
    assert!(source.notes.iter().any(|n| n.contains("watching 1 folder, and 1 isn't on this Mac") && n.contains("…/x/Fonts")), "{:?}", source.notes);
}

// ------------------------------------------------------------------------------- relocating

#[test]
fn a_moved_folder_keeps_its_fonts_tags_and_colors() {
    let mut lib = Library::new("relocate");
    let old = lib.dir.join("Design/Fonts").to_string_lossy().into_owned();
    lib.conn.execute("INSERT INTO folders (path, added_at, kind) VALUES (?1, 0, 'user')", [&old]).unwrap();
    let folder = lib.conn.last_insert_rowid();
    let a = format!("{old}/A.otf");
    let b = format!("{old}/sub/B.otf");
    lib.font(folder, &a, Some("A-Regular"), "A", "Regular", false, false);
    let b_key = lib.font(folder, &b, None, "B", "Regular", false, false);
    lib.conn.execute("UPDATE fonts SET activated = 1 WHERE path = ?1", [&a]).unwrap();
    lib.conn
        .execute("INSERT INTO skipped_files (path, folder_id, file_size, mtime, reason) VALUES (?1, ?2, 1, 1, 'bad')", params![format!("{old}/bad.otf"), folder])
        .unwrap();
    let t = super::create_tag(&mut lib.conn, "Sci-Fi", None).unwrap();
    super::assign(&mut lib.conn, &[t.id], &[b_key.clone()], true).unwrap();
    super::set_location_color(&lib.conn, &old, Some("green")).unwrap();
    super::set_location_color(&lib.conn, &format!("{old}/sub"), Some("red")).unwrap();
    super::set_location_color(&lib.conn, "/fonts", Some("blue")).unwrap();

    // Nothing there yet: asks first, changes nothing.
    let empty = lib.dir.join("Empty");
    std::fs::create_dir_all(&empty).unwrap();
    let r = super::relocate::relocate(&mut lib.conn, folder, &empty, false).unwrap();
    assert_eq!((r.moved, r.found, r.checked), (false, 0, 2));
    assert_eq!(db::get_folder(&lib.conn, folder).unwrap().path, old);

    // The fonts moved to Archive/Fonts.
    let new_dir = lib.dir.join("Archive/Fonts");
    std::fs::create_dir_all(new_dir.join("sub")).unwrap();
    std::fs::write(new_dir.join("A.otf"), b"x").unwrap();
    std::fs::write(new_dir.join("sub/B.otf"), b"x").unwrap();
    let r = super::relocate::relocate(&mut lib.conn, folder, &new_dir, false).unwrap();
    let new = std::fs::canonicalize(&new_dir).unwrap().to_string_lossy().into_owned();
    assert!(r.moved);
    assert_eq!((r.found, r.checked), (2, 2));
    assert_eq!(db::get_folder(&lib.conn, folder).unwrap().path, new);
    let paths: Vec<String> =
        lib.conn.prepare("SELECT path FROM fonts WHERE folder_id = ?1 ORDER BY path").unwrap().query_map([folder], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
    assert_eq!(paths, vec![format!("{new}/A.otf"), format!("{new}/sub/B.otf")]);
    let skipped: String = lib.conn.query_row("SELECT path FROM skipped_files", [], |r| r.get(0)).unwrap();
    assert_eq!(skipped, format!("{new}/bad.otf"));
    assert_eq!(r.active, vec![format!("{new}/A.otf")]);
    assert_eq!(r.old_paths.len(), 2);
    // The tag kept by file follows the file.
    assert_eq!(lib.keys_of("Sci-Fi"), vec![face_key(None, false, false, &format!("{new}/sub/B.otf"), 0)]);
    let colors = super::location_colors(&lib.conn).unwrap();
    assert_eq!(colors.get(&new).map(String::as_str), Some("green"));
    assert_eq!(colors.get(&format!("{new}/sub")).map(String::as_str), Some("red"));
    assert_eq!(colors.get("/fonts").map(String::as_str), Some("blue"), "other folders are untouched");
    assert!(!colors.keys().any(|k| k.starts_with(&old)));

    // Folders never overlap, and macOS folders can't be moved.
    let inside = lib.dir.join("Archive/Fonts/sub");
    lib.conn.execute("INSERT INTO folders (path, added_at, kind) VALUES (?1, 0, 'user')", [lib.dir.join("Other").to_string_lossy()]).unwrap();
    let other = lib.conn.last_insert_rowid();
    std::fs::create_dir_all(lib.dir.join("Other")).unwrap();
    assert!(super::relocate::relocate(&mut lib.conn, other, &inside, true).is_err(), "inside another library folder");
    assert!(super::relocate::relocate(&mut lib.conn, lib.system_folder, &empty, true).is_err());
    // Forcing works when the files really aren't there yet (say, still syncing).
    let r = super::relocate::relocate(&mut lib.conn, folder, &empty, true).unwrap();
    assert!(r.moved && r.found == 0);
}

/// Adds a user folder at `relative` inside the library's temporary folder. Returns (id, path).
fn add_folder(lib: &Library, relative: &str) -> (i64, String) {
    let path = lib.dir.join(relative).to_string_lossy().into_owned();
    lib.conn.execute("INSERT INTO folders (path, added_at, kind) VALUES (?1, 0, 'user')", [&path]).unwrap();
    (lib.conn.last_insert_rowid(), path)
}

/// Makes a folder with empty files at these paths inside it. Returns its real path.
fn folder_with(lib: &Library, relative: &str, files: &[&str]) -> (PathBuf, String) {
    let dir = lib.dir.join(relative);
    std::fs::create_dir_all(&dir).unwrap();
    for f in files {
        let file = dir.join(f);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, b"x").unwrap();
    }
    let real = std::fs::canonicalize(&dir).unwrap().to_string_lossy().into_owned();
    (dir, real)
}

#[test]
fn a_moved_folder_keeps_fonts_on_for_this_login_temporary() {
    use crate::activation::{temporary_paths, wanted_scope, Scope};
    let mut lib = Library::new("relocate-temporary");
    let (folder, old) = add_folder(&lib, "Fonts/Design");
    for (file, on) in [("Temp.otf", true), ("Kept.otf", true), ("Off.otf", false), ("Twice.otf", true)] {
        let path = format!("{old}/{file}");
        lib.font(folder, &path, Some(file), "F", "Regular", false, false);
        lib.conn.execute("UPDATE fonts SET activated = ?1 WHERE path = ?2", params![on, path]).unwrap();
    }
    let (new_dir, new) = folder_with(&lib, "Fonts/Archive", &["Temp.otf", "Kept.otf", "Off.otf", "Twice.otf"]);
    // On for this login only: Temp, and Twice, which somehow also has a row at its new path already.
    // Another folder's temporary font is left alone.
    for path in [format!("{old}/Temp.otf"), format!("{old}/Twice.otf"), format!("{new}/Twice.otf"), "/fonts/Other.otf".into()] {
        lib.conn.execute("INSERT INTO temporary_activations (path) VALUES (?1)", [&path]).unwrap();
    }

    let r = super::relocate::relocate(&mut lib.conn, folder, &new_dir, false).unwrap();
    assert!(r.moved);
    let mut old_active = r.old_active.clone();
    old_active.sort_by(|x, y| x.0.cmp(&y.0));
    assert_eq!(
        old_active,
        vec![
            (format!("{old}/Kept.otf"), Scope::Persistent),
            (format!("{old}/Temp.otf"), Scope::Session),
            (format!("{old}/Twice.otf"), Scope::Session),
        ],
        "each old registration, in the scope to remove it from"
    );
    let mut active = r.active.clone();
    active.sort();
    assert_eq!(active, vec![format!("{new}/Kept.otf"), format!("{new}/Temp.otf"), format!("{new}/Twice.otf")]);
    let temporary = temporary_paths(&lib.conn).unwrap();
    let want: std::collections::HashSet<String> =
        [format!("{new}/Temp.otf"), format!("{new}/Twice.otf"), "/fonts/Other.otf".into()].into_iter().collect();
    assert_eq!(temporary, want, "temporary fonts follow the folder; nothing is left at the old path");

    // After the rescan, reconcile turns each back on in the scope it had.
    assert_eq!(wanted_scope(&lib.conn, &format!("{new}/Temp.otf")).unwrap(), Some(Scope::Session));
    assert_eq!(wanted_scope(&lib.conn, &format!("{new}/Kept.otf")).unwrap(), Some(Scope::Persistent));
    assert_eq!(wanted_scope(&lib.conn, &format!("{new}/Off.otf")).unwrap(), None, "turned off: not wanted");
    assert_eq!(wanted_scope(&lib.conn, &format!("{old}/Temp.otf")).unwrap(), None, "the old path isn't in the library");
    lib.font(lib.system_folder, "/Library/Fonts/Sys.otf", Some("Sys"), "S", "Regular", false, false);
    lib.conn.execute("UPDATE fonts SET activated = 1 WHERE path = '/Library/Fonts/Sys.otf'", []).unwrap();
    assert_eq!(wanted_scope(&lib.conn, "/Library/Fonts/Sys.otf").unwrap(), None, "macOS loads its own folders");
}

#[test]
fn folder_moves_chain_and_never_move_a_live_folder() {
    let mut lib = Library::new("relocate-chain");
    let (folder, a) = add_folder(&lib, "A");
    let (b_dir, b) = folder_with(&lib, "B", &[]);
    let (c_dir, c) = folder_with(&lib, "C", &[]);
    let moves = |conn: &Connection| super::relocate::Moves::load(conn).unwrap();
    assert!(moves(&lib.conn).is_empty());

    assert!(super::relocate::relocate(&mut lib.conn, folder, &b_dir, false).unwrap().moved);
    assert_eq!(moves(&lib.conn).current(&format!("{a}/sub/x.otf")), Some(format!("{b}/sub/x.otf")));
    assert_eq!(moves(&lib.conn).current(&a), Some(b.clone()), "the folder itself");
    assert_eq!(moves(&lib.conn).current(&format!("{a}-other/x.otf")), None, "a sibling with a longer name");
    assert_eq!(moves(&lib.conn).current(&format!("{b}/x.otf")), None, "already at the current place");

    // A → B, then B → C: both old places lead to C.
    assert!(super::relocate::relocate(&mut lib.conn, folder, &c_dir, false).unwrap().moved);
    assert_eq!(moves(&lib.conn).current(&format!("{a}/x.otf")), Some(format!("{c}/x.otf")));
    assert_eq!(moves(&lib.conn).current(&format!("{b}/x.otf")), Some(format!("{c}/x.otf")));

    // And back to B: B is live again, so only A and C lead there.
    assert!(super::relocate::relocate(&mut lib.conn, folder, &b_dir, false).unwrap().moved);
    assert_eq!(moves(&lib.conn).current(&format!("{a}/x.otf")), Some(format!("{b}/x.otf")));
    assert_eq!(moves(&lib.conn).current(&format!("{c}/x.otf")), Some(format!("{b}/x.otf")));
    assert_eq!(moves(&lib.conn).current(&format!("{b}/x.otf")), None);
    let rows: i64 = lib.conn.query_row("SELECT COUNT(*) FROM folder_moves", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 2, "no move from B to itself");

    // A folder added later at an old place is its own: paths there stay put.
    lib.conn.execute("INSERT INTO folders (path, added_at, kind) VALUES (?1, 0, 'user')", [&c]).unwrap();
    assert_eq!(moves(&lib.conn).current(&format!("{c}/x.otf")), None);
    assert_eq!(moves(&lib.conn).current(&format!("{a}/x.otf")), Some(format!("{b}/x.otf")));
}

#[test]
fn a_folder_moved_up_into_its_parent_still_follows_the_move() {
    let mut lib = Library::new("relocate-up");
    let (folder, inner) = add_folder(&lib, "P/inner");
    let (p_dir, p) = folder_with(&lib, "P", &[]);
    assert!(super::relocate::relocate(&mut lib.conn, folder, &p_dir, false).unwrap().moved);
    let moves = super::relocate::Moves::load(&lib.conn).unwrap();
    assert_eq!(moves.current(&format!("{inner}/x.otf")), Some(format!("{p}/x.otf")), "into the folder the move led to");
    assert_eq!(moves.current(&inner), Some(p.clone()));
    assert_eq!(moves.current(&format!("{p}/x.otf")), None, "already at the current place");
}

#[test]
fn a_backup_from_before_a_move_restores_onto_the_new_place() {
    let mut lib = Library::new("relocate-restore");
    let (folder, old) = add_folder(&lib, "Archive/Fonts");
    let big = lib.font(folder, &format!("{old}/Display/Big.otf"), Some("Big-Regular"), "Big", "Regular", false, false);
    let hand = lib.font(folder, &format!("{old}/Script/Hand.otf"), None, "Hand", "Regular", false, false);
    let display = super::create_tag(&mut lib.conn, "Display", None).unwrap();
    let script = super::create_tag(&mut lib.conn, "Script", None).unwrap();
    super::assign(&mut lib.conn, &[display.id], &[big.clone()], true).unwrap();
    super::assign(&mut lib.conn, &[script.id], &[hand], true).unwrap();
    super::set_location_color(&lib.conn, &old, Some("teal")).unwrap();
    super::set_location_color(&lib.conn, &format!("{old}/Script"), Some("pink")).unwrap();
    super::set_location_color(&lib.conn, "/fonts", Some("green")).unwrap();
    let json = export::to_json(&lib.conn, export::collect(&lib.conn, None).unwrap(), 1_760_000_000).unwrap();
    let backup = export::parse_json(json.as_bytes()).unwrap();

    // The folder moved, and Locate… found it.
    let (new_dir, new) = folder_with(&lib, "Fonts", &["Display/Big.otf", "Script/Hand.otf"]);
    assert!(super::relocate::relocate(&mut lib.conn, folder, &new_dir, false).unwrap().moved);
    let hand_now = face_key(None, false, false, &format!("{new}/Script/Hand.otf"), 0);
    super::set_location_color(&lib.conn, &new, Some("blue")).unwrap();

    // The preview matches the moved font, and so does the restore.
    let preview = import::preview(&lib.conn, &backup).unwrap();
    assert_eq!((preview.matched_fonts, preview.unmatched_fonts), (2, 0), "{:?}", preview.missing);
    let chosen = names(&["Display", "Script"]);
    let result = import::replace(&mut lib.conn, &backup, &chosen, false).unwrap();
    assert_eq!((result.styles, result.kept, result.location_colors), (2, 0, 3));
    assert_eq!(lib.keys_of("Script"), vec![hand_now.clone()]);
    assert_eq!(lib.keys_of("Display"), vec![big]);
    let colors = super::location_colors(&lib.conn).unwrap();
    let want: std::collections::BTreeMap<String, String> = [
        (new.clone(), "teal".to_string()),
        (format!("{new}/Script"), "pink".to_string()),
        ("/fonts".to_string(), "green".to_string()),
    ]
    .into_iter()
    .collect();
    assert_eq!(colors, want, "the backup's colors, at the folder's current place");

    // Adding works the same way, and a color the source already has at the current place wins
    // over one that moved there.
    lib.conn.execute("DELETE FROM location_colors", []).unwrap();
    let mut both = backup.clone();
    both.location_colors = vec![(old.clone(), "teal".into()), (new.clone(), "red".into())];
    let result = import::apply(&mut lib.conn, &both, &chosen, false).unwrap();
    assert_eq!(result.location_colors, 1);
    assert_eq!(super::location_colors(&lib.conn).unwrap().get(&new).map(String::as_str), Some("red"));
    assert_eq!(lib.keys_of("Script"), vec![hand_now]);
}
