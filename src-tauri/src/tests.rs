//! Tests against fonts that ship with macOS, so they need no fixtures.

use std::path::Path;

use crate::{scanner, sfnt};

const HELVETICA_TTC: &str = "/System/Library/Fonts/Helvetica.ttc";
const SF_VARIABLE: &str = "/System/Library/Fonts/SFNS.ttf";
const ANDALE_MONO: &str = "/System/Library/Fonts/Supplemental/Andale Mono.ttf";

/// Copies a fixture as plain bytes. fs::copy keeps macOS's compression on system fonts, and
/// reading such a fresh copy can briefly fail with "Attribute not found", making tests flaky.
fn copy_plain(from: impl AsRef<Path>, to: impl AsRef<Path>) -> std::io::Result<()> {
    std::fs::write(to, std::fs::read(from)?)
}

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
    copy_plain(ANDALE_MONO, &copy).unwrap();

    let first = activation::activate_in(&copy, activation::Scope::Persistent);
    println!("activate: {first:?}");
    // The OS reports loaded fonts in its own path form; available_paths() must map it back
    // to the real on-disk path the scanner stores (here /tmp → /private/tmp).
    let key = std::fs::canonicalize(&copy).unwrap().to_string_lossy().into_owned();
    let seen_on = activation::available_paths().unwrap().contains(&key);
    println!("listed as loaded after activate ({key}): {seen_on}");
    let again = activation::activate_in(&copy, activation::Scope::Persistent);
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
            crate::tests::copy_plain(from, &dest).unwrap();
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
        crate::tests::copy_plain(ANDALE_MONO, &font).unwrap();
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
        crate::tests::copy_plain(ANDALE_MONO, dir.join("fonts/A.ttf")).unwrap();
        crate::tests::copy_plain(ANDALE_MONO, dir.join("fonts/B.ttf")).unwrap();
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
        crate::tests::copy_plain(ANDALE_MONO, dir.join("other/A.ttf")).unwrap();
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
        crate::tests::copy_plain(ANDALE_MONO, dir.join("b/Andale.ttf")).unwrap();
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
        crate::tests::copy_plain(ANDALE_MONO, dir.join("x/Andale.ttf")).unwrap();
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
        crate::tests::copy_plain(ANDALE_MONO, dir.join("elsewhere/A.ttf")).unwrap();
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
        crate::tests::copy_plain(ANDALE_MONO, &font).unwrap();
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
        crate::tests::copy_plain(ANDALE_MONO, dir.join("drive/Fonts/F.ttf")).unwrap();
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

/// Live: downloads Google's Material Icons from google/material-design-icons into a temp data
/// folder (no catalog call), with its license. Checks the font parses under its own family name,
/// that its library preview draws icons (the scanner works previews out the same way), and that
/// it has the icons the Google Fonts page previews icon families with. Then reinstalls it: the
/// file hasn't changed upstream, so the downloaded copy is reused.
///   cargo test google_icons_live -- --ignored --nocapture
/// With FONTFACE_LIVE_ALL_ICONS=1 it does every family in the icon table (about 40 MB).
#[test]
#[ignore]
fn google_icons_live_install() {
    use crate::{
        preview::profile::Kind,
        services::google::{self, icons},
    };
    let data = std::env::temp_dir().join(format!("fontface-google-icons-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).unwrap();
    let all = std::env::var_os("FONTFACE_LIVE_ALL_ICONS").is_some();
    for icon in icons::FAMILIES.iter().filter(|i| all || i.id == "material-icons") {
        let family = google::CatalogFamily {
            id: icon.id.into(),
            family: icon.family.into(),
            category: icons::CATEGORY.into(),
            variable: false,
            weights: vec![],
            styles: vec![],
            subsets: vec![],
            license: icons::LICENSE_ID.into(),
            last_modified: "live".into(),
        };
        let prepared = google::prepare(&data, &family).unwrap_or_else(|e| panic!("{}: {e:?}", icon.id));
        let files = prepared.files.clone();
        let dir = google::commit(prepared).unwrap();
        let license = std::fs::read_to_string(Path::new(&dir).join("LICENSE.txt")).unwrap();
        assert!(license.contains("Apache License") && license.contains("Version 2.0"), "{}", &license[..license.len().min(200)]);
        for f in &files {
            let bytes = std::fs::read(Path::new(&dir).join(f)).unwrap();
            let stem = Path::new(f).file_stem().unwrap().to_string_lossy();
            let faces = scanner::parse_file_with_previews(&bytes, &stem).unwrap();
            for face in &faces {
                let preview = face.preview.as_ref().expect("a preview profile");
                println!(
                    "{}: {f} ({} KB) family={:?} style={:?} variable={} preview={:?} sample={:?}",
                    icon.id,
                    bytes.len() / 1024,
                    face.family,
                    face.subfamily,
                    face.variable,
                    preview.kind,
                    preview.family_text.as_deref().map(|t| t.chars().take(8).collect::<String>()),
                );
                assert_eq!(face.family, icon.family);
                if icon.id.starts_with("material-icons") {
                    // Its letters draw nothing alone (they only build ligatures), so the
                    // library preview shows a sample of its icons.
                    assert_eq!(preview.kind, Kind::Symbols, "{f}");
                } else {
                    // Material Symbols also has a plain alphabet, so it can draw its own name.
                    assert!(matches!(preview.kind, Kind::Name | Kind::Symbols), "{f}: {:?}", preview.kind);
                }
            }
            // ICON_PREVIEW in GoogleFontsPanel.tsx: home, search, settings, favorite, star.
            let face = ttf_parser::Face::parse(&bytes, 0).unwrap();
            for cp in [0xE88A, 0xE8B6, 0xE8B8, 0xE87D, 0xE838] {
                let glyph = char::from_u32(cp).and_then(|c| face.glyph_index(c));
                assert!(glyph.and_then(|g| face.glyph_bounding_box(g)).is_some(), "{f}: U+{cp:04X} draws an icon");
            }
        }
        let again = google::prepare(&data, &family).unwrap();
        assert_eq!(again.reused, files, "{}: unchanged upstream, so reused", icon.id);
        google::commit(again).unwrap();
    }
    let root = std::fs::read_dir(data.join("Services/Google Fonts")).unwrap();
    let leftovers: Vec<_> = root.flatten().filter(|e| e.file_name().to_string_lossy().starts_with('.')).collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
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
    crate::tests::copy_plain(ANDALE_MONO, store.join("r/123.otf")).unwrap();
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
    assert!(crate::activation::activate_in(&dir.join("fonts/Proxima.otf"), crate::activation::Scope::Persistent).is_err(), "never registered");
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

mod purchases_flow {
    use std::io::Write;

    use crate::{activation::Scope, db, services::purchases};

    use super::{ANDALE_MONO, HELVETICA_TTC};

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("fontface-buy-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Downloads")).unwrap();
        std::fs::create_dir_all(dir.join("data")).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    /// A store-like zip: fonts in a subfolder, a license, macOS clutter, a webfont and a path
    /// that tries to escape.
    fn make_zip(path: &std::path::Path) {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        for (name, bytes) in [
            ("Andale/Desktop/AndaleMono-Regular.ttf", std::fs::read(ANDALE_MONO).unwrap()),
            ("Andale/Desktop/Helvetica.ttc", std::fs::read(HELVETICA_TTC).unwrap()),
            ("Andale/License/EULA Desktop.txt", b"license text".to_vec()),
            ("Andale/Web/andale.woff2", b"web".to_vec()),
            ("__MACOSX/Andale/._AndaleMono-Regular.ttf", b"junk".to_vec()),
            ("../../escape.ttf", std::fs::read(ANDALE_MONO).unwrap()),
        ] {
            zip.start_file(name, opts).unwrap();
            zip.write_all(&bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    #[cfg(target_os = "macos")]
    fn set_origin(path: &std::path::Path, urls: &[&str]) {
        let value = plist::Value::Array(urls.iter().map(|u| plist::Value::String(u.to_string())).collect());
        let mut bytes = Vec::new();
        value.to_writer_binary(&mut bytes).unwrap();
        xattr::set(path, "com.apple.metadata:kMDItemWhereFroms", &bytes).unwrap();
    }

    #[test]
    fn finds_identifies_and_imports_a_store_zip() {
        let dir = temp("zip");
        let download = dir.join("Downloads/andale-mono.zip");
        make_zip(&download);
        #[cfg(target_os = "macos")]
        set_origin(&download, &["https://cdn.myfonts.net/s/aw/original/123/andale.zip", "https://www.myfonts.com/account/orders"]);

        let data = dir.join("data");
        let mut conn = db::open(&data.join("db.sqlite3")).unwrap();
        crate::services::ensure_service_folders(&mut conn, &data).unwrap();
        purchases::add_watch_folder(&conn, &purchases::validate_watch_folder(&dir.join("Downloads")).unwrap()).unwrap();

        let new = purchases::check_folders(&conn, &data).unwrap();
        assert_eq!(new.len(), 1);
        let find = purchases::finds(&conn).unwrap().remove(0);
        assert_eq!(find.contents.fonts.len(), 2, "two desktop fonts; webfont, clutter and the escaping entry skipped: {:?}", find.contents.fonts);
        assert!(find.contents.families.contains(&"Andale Mono".to_string()));
        assert_eq!(find.contents.licenses, vec!["Andale/License/EULA Desktop.txt"]);
        #[cfg(target_os = "macos")]
        assert_eq!(find.store.as_deref(), Some("myfonts"), "store read from the download's origin");
        assert!(purchases::check_folders(&conn, &data).unwrap().is_empty(), "unchanged downloads aren't re-reported");

        let source = purchases::find_source(&conn, &data, find.id).unwrap();
        let store = source.store.clone().unwrap_or_else(|| purchases::OTHER.into());
        let result = purchases::import(&data, &source.path, &store, source.origin_url, source.referrer).unwrap();
        purchases::mark_imported(&conn, find.id, &store, &result.dir).unwrap();
        let mut files = result.files.clone();
        files.sort();
        assert_eq!(files, vec!["AndaleMono-Regular.ttf", "Helvetica.ttc"]);
        let imported_dir = std::path::Path::new(&result.dir);
        assert!(imported_dir.join("EULA Desktop.txt").exists(), "license travels with the fonts");
        assert!(download.exists(), "the original download is left alone");
        assert!(!dir.join("escape.ttf").exists() && !data.join("escape.ttf").exists());
        assert!(purchases::is_import_dir(&data, imported_dir));
        let listed = purchases::imported(&data);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].font_files, 2);
        #[cfg(target_os = "macos")]
        assert_eq!(listed[0].store_name, "MyFonts");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn imports_a_plain_font_file_with_a_chosen_store() {
        let dir = temp("file");
        let file = dir.join("Downloads/Andale Mono.ttf");
        crate::tests::copy_plain(ANDALE_MONO, &file).unwrap();
        let data = dir.join("data");
        let mut conn = db::open(&data.join("db.sqlite3")).unwrap();
        crate::services::ensure_service_folders(&mut conn, &data).unwrap();
        let first = purchases::import(&data, &file, "fontspring", None, None).unwrap();
        let second = purchases::import(&data, &file, "fontspring", None, None).unwrap();
        assert_ne!(first.dir, second.dir, "a second import doesn't overwrite the first");
        assert!(first.dir.contains("/Purchases/Fontspring/"));
        let empty = dir.join("Downloads/notes.zip");
        let mut z = zip::ZipWriter::new(std::fs::File::create(&empty).unwrap());
        z.start_file("readme.txt", zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(b"hi").unwrap();
        z.finish().unwrap();
        assert!(purchases::import(&data, &empty, "other", None, None).is_err(), "no fonts, no import");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn setup(name: &str) -> (std::path::PathBuf, std::path::PathBuf, rusqlite::Connection) {
        let dir = temp(name);
        let data = dir.join("data");
        let mut conn = db::open(&data.join("db.sqlite3")).unwrap();
        crate::services::ensure_service_folders(&mut conn, &data).unwrap();
        purchases::add_watch_folder(&conn, &purchases::validate_watch_folder(&dir.join("Downloads")).unwrap()).unwrap();
        (dir, data, conn)
    }

    /// Safari and Archive Utility unzip downloads into a folder: that's one download, and its
    /// license comes along. Web/app files are left out, and OTF wins over TTF of the same font.
    #[test]
    fn an_unzipped_folder_is_one_download_with_its_license() {
        let (dir, data, conn) = setup("folder");
        let family = dir.join("Downloads/Andale Family");
        for (rel, src) in [
            ("OTF/AndaleMono.otf", ANDALE_MONO),
            ("TTF/AndaleMono.ttf", ANDALE_MONO),
            ("Webfonts/AndaleMono-web.ttf", ANDALE_MONO),
            ("Collection/Helvetica.ttc", HELVETICA_TTC),
        ] {
            std::fs::create_dir_all(family.join(rel).parent().unwrap()).unwrap();
            crate::tests::copy_plain(src, family.join(rel)).unwrap();
        }
        std::fs::write(family.join("Licensing.pdf"), b"license").unwrap();
        std::fs::write(family.join("Broken.otf"), b"not a font").unwrap();

        let new = purchases::check_folders(&conn, &data).unwrap();
        assert_eq!(new.len(), 1, "one download, not one per file");
        let find = purchases::finds(&conn).unwrap().remove(0);
        assert!(find.is_folder);
        assert_eq!(find.contents.licenses, vec!["Licensing.pdf"]);
        // The two Andale files are byte-identical TrueType copies (not an OTF/TTF pair), so both stay.
        assert_eq!(find.contents.fonts.len(), 3, "{:?}", find.contents.fonts);
        assert_eq!(find.contents.skipped_fonts, vec!["Webfonts/AndaleMono-web.ttf"], "the web copy is left out");
        assert_eq!(find.contents.unreadable, vec!["Broken.otf"], "a bad file is shown, not silently dropped");

        let source = purchases::find_source(&conn, &data, find.id).unwrap();
        let result = purchases::import(&data, &source.path, "other", None, None).unwrap();
        assert!(std::path::Path::new(&result.dir).join("Licensing.pdf").exists());
        assert_eq!(result.files.len(), 3);

        // Finder writing .DS_Store doesn't make the (now dismissed) download new again.
        purchases::dismiss(&conn, find.id).unwrap();
        std::fs::write(family.join(".DS_Store"), b"finder").unwrap();
        std::fs::write(family.join("OTF/.DS_Store"), b"finder").unwrap();
        assert!(purchases::check_folders(&conn, &data).unwrap().is_empty());
        // A zip next to its own unzipped folder counts once.
        crate::tests::copy_plain(ANDALE_MONO, dir.join("Downloads/Andale Family.zip")).ok();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A recorded download that's renamed or moved keeps its state instead of being offered again.
    #[test]
    fn a_moved_download_is_not_offered_again() {
        let (dir, data, conn) = setup("moved");
        crate::tests::copy_plain(ANDALE_MONO, dir.join("Downloads/Andale.ttf")).unwrap();
        let first = purchases::check_folders(&conn, &data).unwrap();
        purchases::dismiss(&conn, first[0]).unwrap();
        std::fs::rename(dir.join("Downloads/Andale.ttf"), dir.join("Downloads/Andale renamed.ttf")).unwrap();
        assert!(purchases::check_folders(&conn, &data).unwrap().is_empty(), "not new again");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Symlinks (e.g. one restored from a hostile zip pointing at a system file) are never followed.
    #[test]
    fn symlinked_downloads_are_ignored() {
        let (dir, data, conn) = setup("symlink");
        std::os::unix::fs::symlink(ANDALE_MONO, dir.join("Downloads/Linked.ttf")).unwrap();
        std::os::unix::fs::symlink("/dev/zero", dir.join("Downloads/Zero.otf")).unwrap();
        assert!(purchases::check_folders(&conn, &data).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Live FSEvents: a font dropped into a watched folder is recorded within a few seconds.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn watcher_notices_new_downloads() {
        let dir = temp("watch");
        let data = dir.join("data");
        let db_path = data.join("db.sqlite3");
        let mut conn = db::open(&db_path).unwrap();
        crate::services::ensure_service_folders(&mut conn, &data).unwrap();
        let folder = purchases::validate_watch_folder(&dir.join("Downloads")).unwrap();
        purchases::add_watch_folder(&conn, &folder).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |r| {
            let _ = tx.send(r);
        })
        .unwrap();
        use notify::Watcher;
        watcher.watch(std::path::Path::new(&folder), notify::RecursiveMode::Recursive).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        crate::tests::copy_plain(ANDALE_MONO, dir.join("Downloads/New.ttf")).unwrap();
        let got = rx.recv_timeout(std::time::Duration::from_secs(10)).expect("an event");
        println!("event: {got:?}");
        assert!(purchases::record(&conn, &data, &dir.join("Downloads/New.ttf")).unwrap().is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Live FSEvents: a whole unzipped folder moved into a watched folder (as Archive Utility
    /// does) maps to one download, with its license.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn watcher_sees_a_moved_in_folder_as_one_download() {
        let (dir, data, conn) = setup("watch-folder");
        let staging = dir.join("staging/Andale Family");
        std::fs::create_dir_all(staging.join("OTF")).unwrap();
        crate::tests::copy_plain(ANDALE_MONO, staging.join("OTF/AndaleMono.ttf")).unwrap();
        std::fs::write(staging.join("EULA.txt"), b"license").unwrap();
        let root = std::path::PathBuf::from(purchases::watch_folders(&conn).unwrap().remove(0));
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |r: notify::Result<notify::Event>| {
            if let Ok(e) = r {
                let _ = tx.send(e.paths);
            }
        })
        .unwrap();
        use notify::Watcher;
        watcher.watch(&root, notify::RecursiveMode::Recursive).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        std::fs::rename(&staging, root.join("Andale Family")).unwrap();
        let paths = rx.recv_timeout(std::time::Duration::from_secs(10)).expect("an event");
        let units: std::collections::HashSet<_> =
            paths.iter().filter_map(|p| purchases::unit_for(&[root.clone()], p)).collect();
        println!("event paths {paths:?} -> units {units:?}");
        assert_eq!(units.len(), 1);
        let unit = units.into_iter().next().unwrap();
        let id = purchases::record(&conn, &data, &unit).unwrap().expect("recorded as new");
        let find = purchases::finds(&conn).unwrap().into_iter().find(|f| f.id == id).unwrap();
        assert!(find.is_folder);
        assert_eq!(find.contents.licenses, vec!["EULA.txt"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------------ replace, trials, transfers

    const ARIAL: &str = "/System/Library/Fonts/Supplemental/Arial.ttf";
    const ARIAL_BOLD: &str = "/System/Library/Fonts/Supplemental/Arial Bold.ttf";
    const COURIER: &str = "/System/Library/Fonts/Supplemental/Courier New.ttf";
    const GEORGIA: &str = "/System/Library/Fonts/Supplemental/Georgia.ttf";

    /// A "newer version" of a font: the same faces, different bytes (padding after the tables).
    fn newer(src: &str) -> Vec<u8> {
        let mut bytes = std::fs::read(src).unwrap();
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        bytes
    }

    fn postscript(path: &str) -> String {
        crate::scanner::parse_file(&std::fs::read(path).unwrap()).unwrap().remove(0).postscript_name.unwrap()
    }

    fn set_store(conn: &rusqlite::Connection, id: i64, store: &str) {
        conn.execute("UPDATE purchase_finds SET store = ?2 WHERE id = ?1", rusqlite::params![id, store]).unwrap();
    }

    fn status_of(conn: &rusqlite::Connection, id: i64) -> String {
        conn.query_row("SELECT status FROM purchase_finds WHERE id = ?1", [id], |r| r.get(0)).unwrap()
    }

    /// Hidden leftovers (half-made imports, set-aside old copies) in a store's folder.
    fn leftovers(store_dir: &std::path::Path) -> Vec<String> {
        std::fs::read_dir(store_dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(".import-") || n.starts_with(".replaced-"))
            .collect()
    }

    fn write_download(folder: &std::path::Path, files: &[(&str, Vec<u8>)]) {
        std::fs::create_dir_all(folder).unwrap();
        for (name, bytes) in files {
            std::fs::write(folder.join(name), bytes).unwrap();
        }
    }

    /// Imports a watched download the way the app does, and returns (find id, purchase folder).
    fn import_find(conn: &rusqlite::Connection, data: &std::path::Path, store: &str) -> (i64, String) {
        let ids = purchases::check_folders(conn, data).unwrap();
        assert_eq!(ids.len(), 1, "one new download");
        let source = purchases::find_source(conn, data, ids[0]).unwrap();
        let result = purchases::import(data, &source.path, store, None, None).unwrap();
        purchases::mark_imported(conn, ids[0], store, &result.dir).unwrap();
        (ids[0], result.dir)
    }

    /// A newer download of an imported purchase (same store, its families, one of its faces) is
    /// offered as a Replace. Replacing swaps the files, keeps faces the download doesn't have and
    /// the old license, and reports which faces were on so the same ones are turned back on.
    #[test]
    fn replace_swaps_in_a_newer_version_and_keeps_what_was_on() {
        let (dir, data, conn) = setup("replace");
        write_download(
            &dir.join("Downloads/Arial v1"),
            &[
                ("Arial.ttf", std::fs::read(ARIAL).unwrap()),
                ("Arial Bold.ttf", std::fs::read(ARIAL_BOLD).unwrap()),
                ("EULA.txt", b"license v1".to_vec()),
            ],
        );
        let (_, old_dir) = import_find(&conn, &data, "myfonts");

        // Version 2 updates the regular style only, with a new license.
        write_download(&dir.join("Downloads/Arial v2"), &[("Arial.ttf", newer(ARIAL)), ("EULA.txt", b"license v2".to_vec())]);
        let ids = purchases::check_folders(&conn, &data).unwrap();
        assert_eq!(ids.len(), 1, "different files: offered, not taken for the old download");
        set_store(&conn, ids[0], "myfonts");
        let mut finds = purchases::finds(&conn).unwrap();
        purchases::link_replacements(&mut finds, &data);
        let v2 = finds.iter().find(|f| f.id == ids[0]).unwrap();
        assert_eq!(v2.replaces.as_deref(), Some(old_dir.as_str()), "offered as a Replace, not a second import");
        assert!(finds.iter().filter(|f| f.id != ids[0]).all(|f| f.replaces.is_none()));

        // Only the regular was on, for this login only. The fake turns nothing off in the OS; it
        // reports what it would.
        let turned_off_in = std::cell::RefCell::new(None);
        let source = purchases::find_source(&conn, &data, ids[0]).unwrap();
        let result = purchases::replace(
            &data,
            std::path::Path::new(&old_dir),
            &source.path,
            source.store.as_deref(),
            None,
            None,
            |d| {
                *turned_off_in.borrow_mut() = Some(d.to_path_buf());
                Ok(vec![(format!("{old_dir}/Arial.ttf"), Scope::Session)])
            },
            |_| panic!("nothing to turn back on after a successful swap"),
        )
        .unwrap();
        purchases::mark_imported(&conn, ids[0], &result.store, &result.dir).unwrap();

        assert_eq!(turned_off_in.borrow().as_deref(), Some(std::path::Path::new(&old_dir)), "old fonts turned off first");
        assert_eq!(result.dir, old_dir, "same folder, so the library keeps its place");
        assert_eq!(result.files, vec!["Arial Bold.ttf", "Arial.ttf"]);
        assert_eq!(result.was_active_faces, vec![postscript(ARIAL)], "the UI turns exactly these back on");
        assert_eq!(result.temporary_faces, vec![postscript(ARIAL)], "and for this login only, as before");
        assert!(result.old_faces.contains(&postscript(ARIAL_BOLD)));
        let folder = std::path::Path::new(&old_dir);
        assert_eq!(std::fs::read(folder.join("Arial.ttf")).unwrap(), newer(ARIAL), "the new version is in place");
        assert_eq!(std::fs::read(folder.join("Arial Bold.ttf")).unwrap(), std::fs::read(ARIAL_BOLD).unwrap(), "untouched style kept");
        let listed = purchases::imported(&data);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].font_files, 2);
        assert_eq!(listed[0].license_files.len(), 2, "the old license stays with the new one: {:?}", listed[0].license_files);
        assert!(leftovers(folder.parent().unwrap()).is_empty());
        assert!(purchases::check_folders(&conn, &data).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// If the swap fails after the old fonts were turned off, they're turned back on and the old
    /// copy is untouched. A replace interrupted by a crash is undone at the next launch.
    #[test]
    fn a_failed_replace_puts_the_old_version_back() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, data, conn) = setup("replace-fail");
        write_download(&dir.join("Downloads/Arial v1"), &[("Arial.ttf", std::fs::read(ARIAL).unwrap())]);
        let (_, old_dir) = import_find(&conn, &data, "myfonts");
        let folder = std::path::PathBuf::from(&old_dir);
        write_download(&dir.join("Downloads/Arial v2"), &[("Arial.ttf", newer(ARIAL))]);

        let on = vec![(format!("{old_dir}/Arial.ttf"), Scope::Persistent)];
        let restored = std::cell::RefCell::new(Vec::new());
        let result = purchases::replace(
            &data,
            &folder,
            &dir.join("Downloads/Arial v2"),
            Some("myfonts"),
            None,
            None,
            |d| {
                // Something goes wrong between turning the fonts off and swapping the files.
                std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o000)).unwrap();
                Ok(on.clone())
            },
            |paths| restored.borrow_mut().extend_from_slice(paths),
        );
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(result.is_err());
        assert_eq!(*restored.borrow(), on, "the fonts that were turned off are turned back on");
        assert_eq!(std::fs::read(folder.join("Arial.ttf")).unwrap(), std::fs::read(ARIAL).unwrap(), "old version untouched");
        assert!(leftovers(folder.parent().unwrap()).is_empty(), "the copied new files are cleaned up");

        // A download from another store, or of another family, is refused before anything changes.
        let refuse = |store: &str, source: &std::path::Path| {
            purchases::replace(&data, &folder, source, Some(store), None, None, |_| panic!("not turned off"), |_| {})
        };
        assert!(refuse("fontspring", &dir.join("Downloads/Arial v2")).is_err());
        write_download(&dir.join("Downloads/Courier"), &[("Courier New.ttf", std::fs::read(COURIER).unwrap())]);
        assert!(refuse("myfonts", &dir.join("Downloads/Courier")).is_err());

        // Crash after the old copy was set aside but before the new one landed: it goes back.
        let aside = folder.with_file_name(format!(".replaced-{}", folder.file_name().unwrap().to_string_lossy()));
        std::fs::rename(&folder, &aside).unwrap();
        purchases::sweep_leftovers(&data);
        assert!(folder.join("Arial.ttf").exists() && !aside.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A purchase that may be a trial gets a reminder 30 days after import. "I bought it" clears
    /// the flag, and a later Replace from the same store doesn't bring it back.
    #[test]
    fn trial_reminder_after_30_days_until_the_user_says_they_bought_it() {
        let (dir, data, _conn) = setup("trial");
        let file = dir.join("Downloads/Arial.ttf");
        crate::tests::copy_plain(ARIAL, &file).unwrap();
        let result = purchases::import(&data, &file, "fontstore", None, None).unwrap();
        let item = || purchases::imported(&data).into_iter().find(|i| i.dir == result.dir).unwrap();
        assert!(item().may_be_trial, "Fontstore downloads may be trials");
        assert!(!item().trial_reminder, "no reminder right after import");

        let day = 24 * 60 * 60;
        assert!(!purchases::trial_reminder_due(1_000_000, true, 1_000_000 + 29 * day));
        assert!(purchases::trial_reminder_due(1_000_000, true, 1_000_000 + 30 * day));
        assert!(!purchases::trial_reminder_due(1_000_000, false, 1_000_000 + 90 * day));

        // Imported 31 days ago.
        let sidecar = std::path::Path::new(&result.dir).join(".fontface-purchase.json");
        let mut meta: serde_json::Value = serde_json::from_slice(&std::fs::read(&sidecar).unwrap()).unwrap();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        meta["importedAt"] = serde_json::json!(now - 31 * day);
        std::fs::write(&sidecar, serde_json::to_vec(&meta).unwrap()).unwrap();
        assert!(item().trial_reminder, "reminder shows after 30 days");

        purchases::confirm_license(&data, std::path::Path::new(&result.dir)).unwrap();
        assert!(!item().may_be_trial && !item().trial_reminder, "I bought it clears the flag and the reminder");

        crate::tests::copy_plain(ARIAL, dir.join("Downloads/Arial old.ttf")).unwrap();
        std::fs::write(dir.join("Downloads/Arial new.ttf"), newer(ARIAL)).unwrap();
        purchases::replace(
            &data,
            std::path::Path::new(&result.dir),
            &dir.join("Downloads/Arial new.ttf"),
            Some("fontstore"),
            None,
            None,
            |_| Ok(Vec::new()),
            |_| {},
        )
        .unwrap();
        assert!(!item().may_be_trial, "a newer version of a bought font isn't a trial again");
        assert!(purchases::confirm_license(&data, &dir.join("Downloads")).is_err(), "only Fontface's own folders");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// "License transferred" turns the fonts off and removes the import, like "subscription
    /// ended" does for one item, and the download isn't offered again, even after it moves.
    /// If the files can't be deleted, the fonts are turned back on.
    #[test]
    fn a_transferred_license_turns_fonts_off_and_removes_the_import() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, data, conn) = setup("transfer");
        crate::tests::copy_plain(ARIAL, dir.join("Downloads/Arial.ttf")).unwrap();
        let (id, import_dir) = import_find(&conn, &data, "myfonts");
        let folder = std::path::PathBuf::from(&import_dir);

        // Deleting fails: the fonts come back on and the purchase stays.
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o555)).unwrap();
        let restored = std::cell::RefCell::new(Vec::new());
        let on = vec![(format!("{import_dir}/Arial.ttf"), Scope::Session)];
        let failed = purchases::remove_import(&data, &folder, |_| Ok(on.clone()), |p| restored.borrow_mut().extend_from_slice(p));
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(failed.is_err());
        assert_eq!(*restored.borrow(), on);
        assert!(purchases::is_import_dir(&data, &folder));

        let turned_off_in = std::cell::RefCell::new(None);
        purchases::remove_import(
            &data,
            &folder,
            |d| {
                *turned_off_in.borrow_mut() = Some(d.to_path_buf());
                Ok(on.clone())
            },
            |_| panic!("removed fine: nothing to turn back on"),
        )
        .unwrap();
        purchases::forget_removed(&conn, &import_dir, "transferred").unwrap();
        assert_eq!(turned_off_in.borrow().as_deref(), Some(folder.as_path()), "fonts turned off before deleting");
        assert!(!folder.exists() && purchases::imported(&data).is_empty(), "the import is gone");
        assert_eq!(status_of(&conn, id), "transferred");
        assert!(purchases::finds(&conn).unwrap().is_empty(), "not listed anywhere");

        // The original download, tidied into a subfolder, isn't offered again.
        std::fs::create_dir_all(dir.join("Downloads/Old fonts")).unwrap();
        std::fs::rename(dir.join("Downloads/Arial.ttf"), dir.join("Downloads/Old fonts/Arial.ttf")).unwrap();
        assert!(purchases::check_folders(&conn, &data).unwrap().is_empty());
        assert!(purchases::remove_import(&data, &dir.join("Downloads"), |_| panic!(), |_| {}).is_err(), "only Fontface's folders");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An imported download moved into a subfolder of a watched folder (a new top-level item) is
    /// matched by its files' contents and isn't offered again. A dismissed download that's still
    /// in place doesn't hide a fresh copy of it.
    #[test]
    fn an_imported_folder_moved_into_a_subfolder_is_not_offered_again() {
        let (dir, data, conn) = setup("moved-in");
        write_download(
            &dir.join("Downloads/Andale Family"),
            &[("AndaleMono.ttf", std::fs::read(ANDALE_MONO).unwrap()), ("EULA.txt", b"license".to_vec())],
        );
        let (_, import_dir) = import_find(&conn, &data, "myfonts");
        std::fs::create_dir_all(dir.join("Downloads/Fonts")).unwrap();
        std::fs::rename(dir.join("Downloads/Andale Family"), dir.join("Downloads/Fonts/Andale Family")).unwrap();
        assert!(purchases::check_folders(&conn, &data).unwrap().is_empty(), "same fonts: not offered again");
        let row: (String, Option<String>) = conn
            .query_row("SELECT status, imported_dir FROM purchase_finds WHERE path LIKE '%/Downloads/Fonts'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(row, ("imported".to_string(), Some(import_dir)), "linked to the purchase that holds them");

        // A dismissed download still in place: a second copy of it is a deliberate download.
        crate::tests::copy_plain(GEORGIA, dir.join("Downloads/Georgia.ttf")).unwrap();
        let georgia = purchases::check_folders(&conn, &data).unwrap();
        purchases::dismiss(&conn, georgia[0]).unwrap();
        crate::tests::copy_plain(GEORGIA, dir.join("Downloads/Georgia copy.ttf")).unwrap();
        assert_eq!(purchases::check_folders(&conn, &data).unwrap().len(), 1, "offered again");
        // Once the dismissed one is moved away into the subfolder, that subfolder isn't offered.
        std::fs::rename(dir.join("Downloads/Georgia.ttf"), dir.join("Downloads/Fonts/Georgia.ttf")).unwrap();
        assert!(purchases::check_folders(&conn, &data).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Font files of one family downloaded one at a time go into one folder, not one each. A file
    /// with a face that folder already has, or a possible trial, gets its own folder.
    #[test]
    fn loose_files_of_one_family_are_grouped_on_import() {
        let (dir, data, conn) = setup("group");
        crate::tests::copy_plain(ARIAL, dir.join("Downloads/Arial.ttf")).unwrap();
        let (_, arial) = import_find(&conn, &data, "github");

        // A second style arrives: a plain "Add to library", not a Replace.
        crate::tests::copy_plain(ARIAL_BOLD, dir.join("Downloads/Arial Bold.ttf")).unwrap();
        let ids = purchases::check_folders(&conn, &data).unwrap();
        set_store(&conn, ids[0], "github");
        let mut finds = purchases::finds(&conn).unwrap();
        purchases::link_replacements(&mut finds, &data);
        assert!(finds.iter().all(|f| f.replaces.is_none()), "a new style isn't a new version");
        let bold = purchases::import(&data, &dir.join("Downloads/Arial Bold.ttf"), "github", None, None).unwrap();
        assert_eq!(bold.dir, arial, "joins the family's folder");
        assert_eq!(bold.files, vec!["Arial Bold.ttf"], "only the new file is reported, so only it is turned on");
        let listed = purchases::imported(&data);
        assert_eq!((listed.len(), listed[0].font_files), (1, 2));

        // Another family, a face the folder already has, a possible trial, another store: apart.
        let courier = purchases::import(&data, std::path::Path::new(COURIER), "github", None, None).unwrap();
        let again = purchases::import(&data, std::path::Path::new(ARIAL), "github", None, None).unwrap();
        crate::tests::copy_plain(ARIAL_BOLD, dir.join("Downloads/Arial Bold Trial.ttf")).unwrap();
        let trial = purchases::import(&data, &dir.join("Downloads/Arial Bold Trial.ttf"), "github", None, None).unwrap();
        let elsewhere = purchases::import(&data, std::path::Path::new(ARIAL_BOLD), "fontspring", None, None).unwrap();
        for other in [&courier.dir, &again.dir, &trial.dir, &elsewhere.dir] {
            assert_ne!(other, &arial);
        }
        assert_eq!(purchases::imported(&data).len(), 5);
        assert!(leftovers(std::path::Path::new(&arial).parent().unwrap()).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// When the watcher stops (its channel closes) mid-batch, the batch is still checked.
    #[test]
    fn the_watcher_worker_checks_its_last_batch_before_stopping() {
        let (dir, data, _conn) = setup("flush");
        let file = dir.join("Downloads/Arial.ttf");
        crate::tests::copy_plain(ARIAL, &file).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(crate::services::purchase_watch::Msg::Item(file)).unwrap();
        drop(tx); // the watcher was dropped right after the event
        let announced = std::cell::RefCell::new(Vec::new());
        crate::services::purchase_watch::worker(&data.join("db.sqlite3"), &data, rx, |ids| {
            announced.borrow_mut().extend_from_slice(ids)
        });
        assert_eq!(announced.borrow().len(), 1, "the pending download was recorded and announced");
        let conn = db::open(&data.join("db.sqlite3")).unwrap();
        assert_eq!(purchases::finds(&conn).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two folder checks never run at once: one asked for while another runs waits for it and
    /// gets its result.
    #[test]
    fn only_one_folder_check_runs_at_a_time() {
        let key = format!("single-flight-test-{}", std::process::id());
        let runs = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (started_tx, started) = std::sync::mpsc::channel();
        let leader = {
            let (key, runs) = (key.clone(), runs.clone());
            std::thread::spawn(move || {
                purchases::single_flight(&key, || {
                    runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    started_tx.send(()).unwrap();
                    std::thread::sleep(std::time::Duration::from_millis(400));
                    Ok(vec![7, 8])
                })
            })
        };
        started.recv().unwrap();
        let shared = purchases::single_flight(&key, || {
            runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(vec![99])
        });
        assert_eq!(shared.unwrap(), vec![7, 8], "the second caller got the running check's result");
        assert_eq!(leader.join().unwrap().unwrap(), vec![7, 8]);
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 1, "only one check ran");
        assert_eq!(purchases::single_flight(&key, || Ok(vec![99])).unwrap(), vec![99], "a later check runs anew");
        let failed = purchases::single_flight(&key, || Err(crate::error::AppError::Other("disk gone".into())));
        assert!(failed.is_err());
    }
}

#[test]
fn watched_folders_cannot_nest() {
    use crate::services::purchases::check_not_nested;
    let existing = vec!["/Users/x/Downloads".to_string()];
    assert!(check_not_nested(&existing, "/Users/x/Downloads/Fonts").is_err());
    assert!(check_not_nested(&existing, "/Users/x").is_err());
    assert!(check_not_nested(&existing, "/Users/x/Desktop").is_ok());
    assert!(check_not_nested(&existing, "/Users/x/Downloads").is_ok(), "re-adding the same folder is harmless");
}
