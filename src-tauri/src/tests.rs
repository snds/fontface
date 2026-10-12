//! Tests against fonts that ship with macOS, so they need no fixtures.

use std::path::Path;

use crate::{scanner, sfnt};

const HELVETICA_TTC: &str = "/System/Library/Fonts/Helvetica.ttc";
const SF_VARIABLE: &str = "/System/Library/Fonts/SFNS.ttf";
const ANDALE_MONO: &str = "/System/Library/Fonts/Supplemental/Andale Mono.ttf";

fn read(path: &str) -> Vec<u8> {
    std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

#[test]
fn parses_single_face_metadata() {
    let faces = scanner::parse_file(&read(ANDALE_MONO)).unwrap();
    assert_eq!(faces.len(), 1);
    let f = &faces[0];
    assert_eq!(f.family, "Andale Mono");
    assert!(f.monospace, "Andale Mono should be detected as monospaced");
    assert!(!f.variable);
    assert_eq!(f.format, "TrueType");
    assert!(f.glyph_count > 100);
}

#[test]
fn parses_every_face_in_a_collection() {
    let faces = scanner::parse_file(&read(HELVETICA_TTC)).unwrap();
    assert!(faces.len() >= 4, "Helvetica.ttc has several faces, got {}", faces.len());
    assert!(faces.iter().all(|f| f.family == "Helvetica"));
    assert!(faces.iter().any(|f| f.weight >= 700), "expected a bold face");
    assert!(faces.iter().any(|f| f.italic), "expected an oblique face");
    assert!(faces.iter().all(|f| f.format.ends_with("Collection")));
}

#[test]
fn reads_variable_axes() {
    let faces = scanner::parse_file(&read(SF_VARIABLE)).unwrap();
    let f = &faces[0];
    assert!(f.variable);
    let wght = f.axes.iter().find(|a| a.tag == "wght").expect("wght axis");
    assert!(wght.min < wght.default && wght.default < wght.max);
}

#[test]
fn rejects_non_fonts() {
    assert!(scanner::parse_file(b"definitely not a font").is_err());
}

#[test]
fn extracted_collection_faces_are_valid_standalone_fonts() {
    let data = read(HELVETICA_TTC);
    let originals = scanner::parse_file(&data).unwrap();
    for (i, original) in originals.iter().enumerate() {
        let single = sfnt::extract_face(&data, i as u32).expect("extract");
        assert!(!sfnt::is_collection(&single));
        let reparsed = scanner::parse_file(&single).unwrap();
        assert_eq!(reparsed.len(), 1);
        assert_eq!(reparsed[0].postscript_name, original.postscript_name, "face {i}");
        assert_eq!(reparsed[0].glyph_count, original.glyph_count, "face {i}");
    }
    assert!(sfnt::extract_face(&data, 999).is_none());
    assert!(sfnt::extract_face(&read(ANDALE_MONO), 0).is_none(), "plain fonts are not collections");
}

#[test]
fn recognises_font_extensions() {
    assert!(scanner::is_font_file(Path::new("a/B.TTF")));
    assert!(scanner::is_font_file(Path::new("x.otc")));
    assert!(!scanner::is_font_file(Path::new("x.woff2")));
    assert!(!scanner::is_font_file(Path::new("x")));
}

/// Registers a temporary copy of a font with CoreText, checks it, then unregisters it.
/// Touches the real per-user font registry, so it only runs on request:
///   cargo test activation_round_trip -- --ignored --nocapture
#[cfg(target_os = "macos")]
#[test]
#[ignore]
fn activation_round_trip() {
    use crate::activation;
    let dir = std::env::temp_dir().join(format!("fontface-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let copy = dir.join("Andale Mono Copy.ttf");
    std::fs::copy(ANDALE_MONO, &copy).unwrap();

    let first = activation::activate(&copy);
    println!("activate: {first:?}");
    // The OS reports loaded fonts in its own path form; available_paths() must map it back
    // to the real on-disk path the scanner stores (here /tmp → /private/tmp).
    let key = std::fs::canonicalize(&copy).unwrap().to_string_lossy().into_owned();
    let seen_on = activation::available_paths().unwrap().contains(&key);
    println!("listed as loaded after activate ({key}): {seen_on}");
    let again = activation::activate(&copy);
    println!("activate again (should be Ok, idempotent): {again:?}");
    let off = activation::deactivate(&copy);
    println!("deactivate: {off:?}");
    let seen_off = activation::available_paths().unwrap().contains(&key);
    println!("listed as loaded after deactivate: {seen_off}");
    let off_again = activation::deactivate(&copy);
    println!("deactivate again (should be Ok, idempotent): {off_again:?}");
    std::fs::remove_dir_all(&dir).ok();

    first.unwrap();
    again.unwrap();
    off.unwrap();
    off_again.unwrap();
    assert!(seen_on, "an activated font must show as loaded");
    assert!(!seen_off, "a deactivated font must not show as loaded");
}

mod library {
    use std::{
        path::{Path, PathBuf},
        sync::{atomic::AtomicBool, Arc},
    };

    use rusqlite::Connection;

    use crate::{db, scanner};

    use super::{ANDALE_MONO, HELVETICA_TTC};

    /// A scratch folder plus a fresh library database, removed when dropped.
    struct Sandbox {
        dir: PathBuf,
    }

    impl Sandbox {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("fontface-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("fonts")).unwrap();
            // Canonical, like folders added through the app.
            Self { dir: std::fs::canonicalize(dir).unwrap() }
        }
        fn fonts(&self) -> PathBuf {
            self.dir.join("fonts")
        }
        fn db(&self) -> PathBuf {
            self.dir.join("library.sqlite3")
        }
        fn conn(&self) -> Connection {
            db::open(&self.db()).unwrap()
        }
        fn copy(&self, from: &str, to: &str) -> PathBuf {
            let dest = self.fonts().join(to);
            std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
            std::fs::copy(from, &dest).unwrap();
            dest
        }
        fn add_folder(&self) -> i64 {
            db::insert_folder(&mut self.conn(), &self.fonts(), "user").unwrap()
        }
        fn scan(&self, folder: i64) -> crate::model::ScanReport {
            scanner::scan_folder(&self.db(), folder, &self.fonts(), &Arc::new(AtomicBool::new(false)), |_| {}).unwrap()
        }
        fn font_rows(&self) -> i64 {
            self.conn().query_row("SELECT COUNT(*) FROM fonts", [], |r| r.get(0)).unwrap()
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            // Undo any permission changes so cleanup can't fail.
            let _ = std::process::Command::new("chmod").args(["-R", "u+rwx"]).arg(&self.dir).status();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn scan_adds_skips_and_removes() {
        let sb = Sandbox::new("scan");
        let andale = sb.copy(ANDALE_MONO, "Andale.ttf");
        sb.copy(HELVETICA_TTC, "nested/deeper/Helvetica.ttc");
        std::fs::write(sb.fonts().join("broken.ttf"), b"not a font").unwrap();
        sb.copy(ANDALE_MONO, ".hidden/Ignored.ttf");
        sb.copy(ANDALE_MONO, "._AppleDouble.ttf");
        let folder = sb.add_folder();

        let first = sb.scan(folder);
        assert_eq!(first.files, 3, "hidden files and folders are skipped");
        assert_eq!(first.added, 2);
        assert_eq!(first.failed.len(), 1, "the broken file is reported, not fatal");
        assert_eq!(first.walk_errors, 0);
        let helvetica_faces = scanner::parse_file(&std::fs::read(HELVETICA_TTC).unwrap()).unwrap().len() as i64;
        assert_eq!(sb.font_rows(), 1 + helvetica_faces);

        let second = sb.scan(folder);
        assert_eq!(second.unchanged, 3, "unchanged files, including the remembered broken one, are not re-read");
        assert_eq!(second.added + second.updated, 0);
        assert!(second.failed.is_empty(), "a known-broken file isn't reported again until it changes");

        std::fs::remove_file(&andale).unwrap();
        let third = sb.scan(folder);
        assert_eq!(third.removed, 1);
        assert_eq!(sb.font_rows(), helvetica_faces);
    }

    #[test]
    fn unreadable_subfolder_never_removes_fonts() {
        let sb = Sandbox::new("walkerr");
        sb.copy(ANDALE_MONO, "a/Andale.ttf");
        sb.copy(HELVETICA_TTC, "locked/Helvetica.ttc");
        let folder = sb.add_folder();
        sb.scan(folder);
        let before = sb.font_rows();

        let locked = sb.fonts().join("locked");
        std::process::Command::new("chmod").arg("000").arg(&locked).status().unwrap();
        let report = sb.scan(folder);
        std::process::Command::new("chmod").arg("755").arg(&locked).status().unwrap();

        assert!(report.walk_errors >= 1, "the locked folder should count as a walk error");
        assert_eq!(report.removed, 0, "an incomplete walk must not delete anything");
        assert_eq!(sb.font_rows(), before);
    }

    #[test]
    fn missing_root_is_an_error_not_an_empty_scan() {
        let sb = Sandbox::new("missing");
        sb.copy(ANDALE_MONO, "Andale.ttf");
        let folder = sb.add_folder();
        sb.scan(folder);
        std::fs::rename(sb.fonts(), sb.dir.join("moved")).unwrap();
        let result = scanner::scan_folder(&sb.db(), folder, &sb.fonts(), &Arc::new(AtomicBool::new(false)), |_| {});
        assert!(result.is_err());
        assert_eq!(sb.font_rows(), 1, "fonts stay in the library while the folder is unreachable");
    }

    #[test]
    fn cancelled_scan_writes_and_removes_nothing() {
        let sb = Sandbox::new("cancel");
        sb.copy(ANDALE_MONO, "Andale.ttf");
        let folder = sb.add_folder();
        let report = scanner::scan_folder(&sb.db(), folder, &sb.fonts(), &Arc::new(AtomicBool::new(true)), |_| {}).unwrap();
        assert!(report.cancelled);
        assert_eq!(sb.font_rows(), 0);
    }

    #[test]
    fn progress_reports_discovery_then_reading() {
        let sb = Sandbox::new("progress");
        for i in 0..5 {
            sb.copy(ANDALE_MONO, &format!("f{i}.ttf"));
        }
        let folder = sb.add_folder();
        let mut phases = Vec::new();
        scanner::scan_folder(&sb.db(), folder, &sb.fonts(), &Arc::new(AtomicBool::new(false)), |p| phases.push(p.phase)).unwrap();
        assert_eq!(phases.first(), Some(&"discovering"), "the first event comes immediately, during discovery");
        assert!(phases.contains(&"reading"));
    }

    #[test]
    fn folders_never_overlap() {
        let sb = Sandbox::new("overlap");
        std::fs::create_dir_all(sb.fonts().join("child")).unwrap();
        let mut conn = sb.conn();
        let child = db::insert_folder(&mut conn, &sb.fonts().join("child"), "user").unwrap();
        conn.execute(
            "INSERT INTO fonts (folder_id, path, file_size, mtime, family, subfamily, weight, width, italic,
             monospace, variable, glyph_count, format, activated)
             VALUES (?1, 'x.ttf', 1, 1, 'X', 'Regular', 400, 5, 0, 0, 0, 1, 'TrueType', 1)",
            [child],
        )
        .unwrap();

        let parent = db::insert_folder(&mut conn, &sb.fonts(), "user").unwrap();
        let owner: i64 = conn.query_row("SELECT folder_id FROM fonts", [], |r| r.get(0)).unwrap();
        let active: bool = conn.query_row("SELECT activated FROM fonts", [], |r| r.get(0)).unwrap();
        assert_eq!(owner, parent, "a parent folder absorbs its child's fonts");
        assert!(active, "absorbed fonts keep their activation state");
        assert_eq!(db::list_folders(&conn).unwrap().len(), 1);

        assert!(db::insert_folder(&mut conn, &sb.fonts().join("child"), "user").is_err(), "nested folders are refused");
    }

    #[test]
    fn upgrades_a_v1_library_without_losing_fonts() {
        let sb = Sandbox::new("migrate");
        {
            let conn = Connection::open(sb.db()).unwrap();
            conn.execute_batch(db::SCHEMA_V1).unwrap();
            conn.execute_batch(
                "INSERT INTO folders (path, added_at) VALUES ('/tmp/somewhere', 0);
                 INSERT INTO fonts (folder_id, path, file_size, mtime, family, subfamily, weight, width, italic,
                    monospace, variable, glyph_count, format, activated)
                 VALUES (1, '/tmp/somewhere/a.ttf', 1, 1, 'A', 'Regular', 400, 5, 0, 0, 0, 1, 'TrueType', 1);",
            )
            .unwrap();
        }
        let conn = sb.conn();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 3);
        let kind: String = conn.query_row("SELECT kind FROM folders", [], |r| r.get(0)).unwrap();
        assert_eq!(kind, "user");
        let (count, active): (i64, bool) =
            conn.query_row("SELECT COUNT(*), MAX(activated) FROM fonts", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((count, active), (1, true), "fonts and their intent survive the table rebuild");
        let fk_on: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(fk_on, 1);

        // Ids are never reused after a delete.
        conn.execute("DELETE FROM folders", []).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM fonts", [], |r| r.get::<_, i64>(0)).unwrap(), 0, "cascade still works");
        conn.execute("INSERT INTO folders (path, added_at) VALUES ('/tmp/other', 0)", []).unwrap();
        assert_eq!(conn.last_insert_rowid(), 2);
    }

    #[test]
    fn user_folder_cannot_swallow_a_macos_folder() {
        let sb = Sandbox::new("swallow");
        std::fs::create_dir_all(sb.fonts().join("Library/Fonts")).unwrap();
        let mut conn = sb.conn();
        db::insert_folder(&mut conn, &sb.fonts().join("Library/Fonts"), "system").unwrap();
        let err = db::insert_folder(&mut conn, &sb.fonts(), "user").unwrap_err();
        assert!(err.to_string().contains("macOS font folder"), "{err}");
        assert_eq!(db::list_folders(&conn).unwrap().len(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn adds_macos_font_folders_once() {
        let sb = Sandbox::new("system");
        let mut conn = sb.conn();
        db::ensure_system_folders(&mut conn).unwrap();
        db::ensure_system_folders(&mut conn).unwrap();
        let mut folders = db::list_folders(&conn).unwrap();
        db::check_folders(&mut folders);
        assert!(folders.iter().all(|f| f.kind == "system"));
        assert!(folders.iter().any(|f| f.path == "/System/Library/Fonts" && f.label == "macOS System Fonts"));
        assert!(folders.len() <= 3, "running twice must not duplicate folders");
    }

    #[test]
    fn private_system_families_are_not_listed() {
        let sb = Sandbox::new("private");
        let sf = "/System/Library/Fonts/SFNS.ttf";
        if !Path::new(sf).exists() {
            return;
        }
        let family = scanner::parse_file(&std::fs::read(sf).unwrap()).unwrap()[0].family.clone();
        sb.copy(sf, "SFNS.ttf");
        let folder = sb.add_folder();
        sb.scan(folder);
        let expected = if family.starts_with('.') { 0 } else { 1 };
        assert_eq!(sb.font_rows(), expected, "family {family:?}");
    }
}

mod safety {
    use std::sync::{atomic::AtomicBool, Arc};

    use crate::{db, scanner};

    use super::ANDALE_MONO;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("fontface-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("fonts")).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    fn scan(dir: &std::path::Path, folder: i64) -> crate::model::ScanReport {
        scanner::scan_folder(&dir.join("db.sqlite3"), folder, &dir.join("fonts"), &Arc::new(AtomicBool::new(false)), |_| {})
            .unwrap()
    }

    /// Review finding: a changed file that can't be read must keep its rows and on/off intent.
    #[test]
    fn unreadable_changed_file_keeps_its_intent() {
        let dir = temp("keepintent");
        let font = dir.join("fonts/A.ttf");
        std::fs::copy(ANDALE_MONO, &font).unwrap();
        let mut conn = db::open(&dir.join("db.sqlite3")).unwrap();
        let folder = db::insert_folder(&mut conn, &dir.join("fonts"), "user").unwrap();
        scan(&dir, folder);
        conn.execute("UPDATE fonts SET activated = 1", []).unwrap();

        // Change it (new mtime) and make it unreadable.
        std::fs::write(&font, std::fs::read(ANDALE_MONO).unwrap()).unwrap();
        std::process::Command::new("touch").args(["-t", "203001010000"]).arg(&font).status().unwrap();
        std::process::Command::new("chmod").arg("000").arg(&font).status().unwrap();
        let report = scan(&dir, folder);
        std::process::Command::new("chmod").arg("644").arg(&font).status().unwrap();

        assert_eq!(report.failed.len(), 1);
        let (rows, active): (i64, bool) = conn
            .query_row("SELECT COUNT(*), COALESCE(MAX(activated), 0) FROM fonts", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((rows, active), (1, true), "row and intent survive a failed read");

        let again = scan(&dir, folder);
        assert_eq!(again.updated, 1, "retried once readable");
        let active: bool = conn.query_row("SELECT activated FROM fonts", [], |r| r.get(0)).unwrap();
        assert!(active);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Review finding: a dead symlink (even a hidden one) must not block cleanup forever.
    #[test]
    fn dead_symlinks_dont_block_cleanup() {
        let dir = temp("deadlink");
        std::fs::copy(ANDALE_MONO, dir.join("fonts/A.ttf")).unwrap();
        std::fs::copy(ANDALE_MONO, dir.join("fonts/B.ttf")).unwrap();
        let mut conn = db::open(&dir.join("db.sqlite3")).unwrap();
        let folder = db::insert_folder(&mut conn, &dir.join("fonts"), "user").unwrap();
        scan(&dir, folder);

        std::fs::remove_file(dir.join("fonts/B.ttf")).unwrap();
        std::os::unix::fs::symlink(dir.join("nowhere"), dir.join("fonts/.cache-link")).unwrap();
        std::os::unix::fs::symlink(dir.join("unplugged/Fonts"), dir.join("fonts/External")).unwrap();
        let report = scan(&dir, folder);
        assert_eq!(report.walk_errors, 0);
        assert_eq!(report.removed, 1, "B.ttf is cleaned up despite the dead links");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Review finding: a symlink into another library folder must not list its fonts twice.
    #[test]
    fn symlink_into_another_library_folder_is_not_listed_twice() {
        let dir = temp("crosslink");
        std::fs::create_dir_all(dir.join("other")).unwrap();
        std::fs::copy(ANDALE_MONO, dir.join("other/A.ttf")).unwrap();
        std::os::unix::fs::symlink(dir.join("other"), dir.join("fonts/Other")).unwrap();
        let mut conn = db::open(&dir.join("db.sqlite3")).unwrap();
        let other = db::insert_folder(&mut conn, &dir.join("other"), "user").unwrap();
        let folder = db::insert_folder(&mut conn, &dir.join("fonts"), "user").unwrap();
        scanner::scan_folder(&dir.join("db.sqlite3"), other, &dir.join("other"), &Arc::new(AtomicBool::new(false)), |_| {}).unwrap();
        let report = scan(&dir, folder);
        assert_eq!(report.files, 0);
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM fonts", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Migrates a copy of a real library: FONTFACE_DB_COPY=/path/to/copy.sqlite3 cargo test real_db -- --ignored --nocapture
#[test]
#[ignore]
fn real_db_migrates_without_loss() {
    let path = std::env::var("FONTFACE_DB_COPY").expect("set FONTFACE_DB_COPY to a COPY of library.sqlite3");
    let before = rusqlite::Connection::open(&path).unwrap();
    let count = |c: &rusqlite::Connection, sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
    let (folders, fonts, active) = (
        count(&before, "SELECT COUNT(*) FROM folders"),
        count(&before, "SELECT COUNT(*) FROM fonts"),
        count(&before, "SELECT COALESCE(SUM(activated), 0) FROM fonts"),
    );
    drop(before);
    let after = crate::db::open(std::path::Path::new(&path)).unwrap();
    println!("before: folders={folders} fonts={fonts} active={active}");
    println!(
        "after:  version={} folders={} fonts={} active={}",
        count(&after, "PRAGMA user_version"),
        count(&after, "SELECT COUNT(*) FROM folders"),
        count(&after, "SELECT COUNT(*) FROM fonts"),
        count(&after, "SELECT COALESCE(SUM(activated), 0) FROM fonts")
    );
    assert_eq!(count(&after, "SELECT COUNT(*) FROM folders"), folders);
    assert_eq!(count(&after, "SELECT COUNT(*) FROM fonts"), fonts);
    assert_eq!(count(&after, "SELECT COALESCE(SUM(activated), 0) FROM fonts"), active);
}

mod round_two {
    use std::sync::{atomic::AtomicBool, Arc};

    use rusqlite::Connection;

    use crate::{db, scanner};

    use super::ANDALE_MONO;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("fontface-r2-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    fn scan(db_path: &std::path::Path, folder: i64, root: &std::path::Path) -> crate::model::ScanReport {
        scanner::scan_folder(db_path, folder, root, &Arc::new(AtomicBool::new(false)), |_| {}).unwrap()
    }

    fn active(conn: &Connection) -> Vec<(i64, bool)> {
        conn.prepare("SELECT folder_id, activated FROM fonts ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    /// Folder A links to B; A lists B's font and the user turns it on. Adding B must hand the
    /// row over (keeping the choice), even if A is rescanned before B's first scan.
    #[test]
    fn adding_a_linked_folder_keeps_the_choice() {
        let dir = temp("handover");
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::create_dir_all(dir.join("b")).unwrap();
        std::fs::copy(ANDALE_MONO, dir.join("b/Andale.ttf")).unwrap();
        std::os::unix::fs::symlink(dir.join("b"), dir.join("a/B")).unwrap();
        let db_path = dir.join("db.sqlite3");
        let mut conn = db::open(&db_path).unwrap();
        let a = db::insert_folder(&mut conn, &dir.join("a"), "user").unwrap();
        scan(&db_path, a, &dir.join("a"));
        conn.execute("UPDATE fonts SET activated = 1", []).unwrap();

        let b = db::insert_folder(&mut conn, &dir.join("b"), "user").unwrap();
        assert_eq!(active(&conn), vec![(b, true)], "adding B claims the row at once");
        let report = scan(&db_path, a, &dir.join("a"));
        assert_eq!(report.removed, 0, "A's rescan must not drop or turn off B's font");
        scan(&db_path, b, &dir.join("b"));
        assert_eq!(active(&conn), vec![(b, true)]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two folders that both link to one outside folder: its fonts stay with the first one,
    /// instead of flipping (and being re-read) on every scan.
    #[test]
    fn shared_outside_folder_has_one_owner() {
        let dir = temp("shared");
        for d in ["a", "b", "x"] {
            std::fs::create_dir_all(dir.join(d)).unwrap();
        }
        std::fs::copy(ANDALE_MONO, dir.join("x/Andale.ttf")).unwrap();
        std::os::unix::fs::symlink(dir.join("x"), dir.join("a/X")).unwrap();
        std::os::unix::fs::symlink(dir.join("x"), dir.join("b/X")).unwrap();
        let db_path = dir.join("db.sqlite3");
        let mut conn = db::open(&db_path).unwrap();
        let a = db::insert_folder(&mut conn, &dir.join("a"), "user").unwrap();
        let b = db::insert_folder(&mut conn, &dir.join("b"), "user").unwrap();
        for _ in 0..2 {
            scan(&db_path, a, &dir.join("a"));
            let rb = scan(&db_path, b, &dir.join("b"));
            assert_eq!(rb.added + rb.updated + rb.removed, 0);
        }
        assert_eq!(active(&conn), vec![(a, false)]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Rows stored by older versions under the walked (symlinked) path move to the real path,
    /// keeping their id and on/off choice.
    #[test]
    fn old_symlink_paths_are_migrated_not_replaced() {
        let dir = temp("legacy");
        std::fs::create_dir_all(dir.join("fonts")).unwrap();
        std::fs::create_dir_all(dir.join("elsewhere")).unwrap();
        std::fs::copy(ANDALE_MONO, dir.join("elsewhere/A.ttf")).unwrap();
        std::os::unix::fs::symlink(dir.join("elsewhere"), dir.join("fonts/Linked")).unwrap();
        let db_path = dir.join("db.sqlite3");
        let mut conn = db::open(&db_path).unwrap();
        let f = db::insert_folder(&mut conn, &dir.join("fonts"), "user").unwrap();
        scan(&db_path, f, &dir.join("fonts"));
        // Rewrite the row as an old version would have stored it.
        let walked = dir.join("fonts/Linked/A.ttf").to_string_lossy().into_owned();
        conn.execute("UPDATE fonts SET path = ?1, activated = 1, mtime = 0", [&walked]).unwrap();
        let id_before: i64 = conn.query_row("SELECT id FROM fonts", [], |r| r.get(0)).unwrap();

        let report = scan(&db_path, f, &dir.join("fonts"));
        assert_eq!((report.removed, report.added), (0, 0));
        let (id, path, on): (i64, String, bool) =
            conn.query_row("SELECT id, path, activated FROM fonts", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!(id, id_before);
        assert!(path.ends_with("elsewhere/A.ttf"), "{path}");
        assert!(on);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A listed font that becomes unparseable is remembered: reported once, not every scan.
    #[test]
    fn corrupted_known_file_is_reported_once() {
        let dir = temp("corrupt");
        std::fs::create_dir_all(dir.join("fonts")).unwrap();
        let font = dir.join("fonts/A.ttf");
        std::fs::copy(ANDALE_MONO, &font).unwrap();
        let db_path = dir.join("db.sqlite3");
        let mut conn = db::open(&db_path).unwrap();
        let f = db::insert_folder(&mut conn, &dir.join("fonts"), "user").unwrap();
        scan(&db_path, f, &dir.join("fonts"));
        conn.execute("UPDATE fonts SET activated = 1", []).unwrap();
        std::fs::write(&font, b"truncated").unwrap();
        assert_eq!(scan(&db_path, f, &dir.join("fonts")).failed.len(), 1);
        assert_eq!(scan(&db_path, f, &dir.join("fonts")).failed.len(), 0, "not re-reported");
        let on: bool = conn.query_row("SELECT activated FROM fonts", [], |r| r.get(0)).unwrap();
        assert!(on, "the row and its choice are kept");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A row stored by an older version through a symlink whose drive is unplugged survives
    /// the scan (and keeps its choice) instead of being deleted.
    #[test]
    fn legacy_rows_behind_an_unplugged_link_are_kept() {
        let dir = temp("unplugged");
        std::fs::create_dir_all(dir.join("fonts")).unwrap();
        std::fs::create_dir_all(dir.join("drive/Fonts")).unwrap();
        std::fs::copy(ANDALE_MONO, dir.join("drive/Fonts/F.ttf")).unwrap();
        std::os::unix::fs::symlink(dir.join("drive/Fonts"), dir.join("fonts/Ext")).unwrap();
        let db_path = dir.join("db.sqlite3");
        let mut conn = db::open(&db_path).unwrap();
        let f = db::insert_folder(&mut conn, &dir.join("fonts"), "user").unwrap();
        scan(&db_path, f, &dir.join("fonts"));
        let walked = dir.join("fonts/Ext/F.ttf").to_string_lossy().into_owned();
        conn.execute("UPDATE fonts SET path = ?1, activated = 1", [&walked]).unwrap();

        std::fs::rename(dir.join("drive"), dir.join("drive-away")).unwrap();
        let report = scan(&db_path, f, &dir.join("fonts"));
        assert_eq!(report.removed, 0, "kept while the link's target is missing");
        std::fs::rename(dir.join("drive-away"), dir.join("drive")).unwrap();
        scan(&db_path, f, &dir.join("fonts"));
        let (rows, on): (i64, bool) =
            conn.query_row("SELECT COUNT(*), MAX(activated) FROM fonts", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((rows, on), (1, true));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

struct LiveInstall {
    dir: String,
    files: Vec<String>,
}

/// Live: fetches the Google Fonts catalog and installs one family into a temp data folder.
///   cargo test google_live -- --ignored --nocapture
#[test]
#[ignore]
fn google_live_install() {
    use crate::services::google;
    let data = std::env::temp_dir().join(format!("fontface-google-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).unwrap();
    let catalog = google::catalog(&data, false).expect("catalog");
    println!("catalog: {} families, stale={}", catalog.families.len(), catalog.stale);
    assert!(catalog.families.len() > 1000);
    for id in ["inter", "42dot-sans", "ubuntu"] {
        let family = catalog.families.iter().find(|e| e.family.id == id).expect("in catalog").family.clone();
        let result = match google::prepare(&data, &family).and_then(|p| {
            let files = p.files.clone();
            google::commit(p).map(|dir| (dir, files))
        }) {
            Ok((dir, files)) => LiveInstall { dir, files },
            Err(e) => {
                let listing = std::process::Command::new("find").arg(&data).output().unwrap();
                panic!("install {id}: {e:?}\n{}", String::from_utf8_lossy(&listing.stdout));
            }
        };
        println!("{id}: {} -> {:?}", result.dir, result.files);
        for f in &result.files {
            let bytes = std::fs::read(std::path::Path::new(&result.dir).join(f)).unwrap();
            assert!(!crate::scanner::parse_file(&bytes).unwrap().is_empty());
        }
    }
    let again = google::catalog(&data, false).unwrap();
    let inter = again.families.iter().find(|e| e.family.id == "inter").unwrap();
    assert!(inter.installed.is_some() && !inter.update_available);
    // Reinstalling (an update) swaps in place and leaves no temporary folders behind.
    let inter_family = inter.family.clone();
    let dir = google::commit(google::prepare(&data, &inter_family).unwrap()).unwrap();
    let leftovers: Vec<_> = std::fs::read_dir(std::path::Path::new(&dir).parent().unwrap())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    assert!(std::path::Path::new(&dir).join("OFL.txt").exists(), "license kept with the fonts");
    println!("adobe: {:?}", crate::services::adobe::status());
    let _ = std::fs::remove_dir_all(&data);
}

/// Creative Cloud's font store is never read, even through symlinks (Adobe's terms).
#[test]
fn adobe_font_store_is_never_scanned_or_switched() {
    use std::sync::{atomic::AtomicBool, Arc};
    let dir = std::env::temp_dir().join(format!("fontface-adobe-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let store = dir.join("Library/Application Support/Adobe/CoreSync/plugins/livetype");
    std::fs::create_dir_all(store.join("r")).unwrap();
    std::fs::copy(ANDALE_MONO, store.join("r/123.otf")).unwrap();
    std::fs::create_dir_all(dir.join("fonts")).unwrap();
    std::os::unix::fs::symlink(store.join("r/123.otf"), dir.join("fonts/Proxima.otf")).unwrap();
    std::os::unix::fs::symlink(dir.join("Library/Application Support/Adobe/CoreSync/plugins"), dir.join("fonts/CC")).unwrap();
    let db_path = dir.join("db.sqlite3");
    let mut conn = crate::db::open(&db_path).unwrap();
    let root = std::fs::canonicalize(dir.join("fonts")).unwrap();
    let folder = crate::db::insert_folder(&mut conn, &root, "user").unwrap();
    let report = crate::scanner::scan_folder(&db_path, folder, &root, &Arc::new(AtomicBool::new(false)), |_| {}).unwrap();
    assert_eq!(report.files, 0, "nothing in Adobe's store is read");
    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM fonts", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0);
    assert!(crate::activation::activate(&dir.join("fonts/Proxima.otf")).is_err(), "never registered");
    assert!(crate::activation::deactivate(&store.join("r/123.otf")).is_err(), "never unregistered");
    assert!(crate::db::insert_folder(&mut conn, &std::fs::canonicalize(&store).unwrap(), "user").is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

/// Startup removes any library rows for Creative Cloud's font files, Mac or Windows style.
#[test]
fn startup_purges_adobe_rows() {
    let dir = std::env::temp_dir().join(format!("fontface-purge-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("f")).unwrap();
    let mut conn = crate::db::open(&dir.join("db.sqlite3")).unwrap();
    let folder = crate::db::insert_folder(&mut conn, &std::fs::canonicalize(dir.join("f")).unwrap(), "user").unwrap();
    for path in [
        "/Users/x/Library/Application Support/Adobe/CoreSync/plugins/livetype/.r/.1.otf",
        r"\\?\C:\Users\x\AppData\Roaming\Adobe\CoreSync\plugins\livetype\r\2.otf",
        "/Users/x/Fonts/Keep.otf",
    ] {
        conn.execute(
            "INSERT INTO fonts (folder_id, path, file_size, mtime, family, subfamily, weight, width, italic,
             monospace, variable, glyph_count, format, activated) VALUES (?1, ?2, 1, 1, 'F', 'R', 400, 5, 0, 0, 0, 1, 'TrueType', 0)",
            rusqlite::params![folder, path],
        )
        .unwrap();
    }
    assert_eq!(crate::db::purge_adobe_rows(&mut conn).unwrap(), 2);
    let left: String = conn.query_row("SELECT path FROM fonts", [], |r| r.get(0)).unwrap();
    assert!(left.ends_with("Keep.otf"));
    let _ = std::fs::remove_dir_all(&dir);
}
