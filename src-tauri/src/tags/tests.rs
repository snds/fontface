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
