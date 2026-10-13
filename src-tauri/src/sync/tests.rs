//! Sync: the merge rules on their own, the file formats, and two (or three) devices sharing a
//! temporary folder, each with its own library database.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

use rusqlite::{params, Connection};
use serde_json::json;

use super::{
    engine::{self, Applied, Engine, Exception, ExceptionFor},
    hlc::{Clock, Hlc},
    merge::{Merged, Source},
    ops::{self, Op, OpKind, ReadError},
    transport::{FolderTransport, Transport},
};
use crate::{db, tags};

// ------------------------------------------------------------------------------ helpers

const A: &str = "aaaaaaaaaaaaaaaa";
const B: &str = "bbbbbbbbbbbbbbbb";
const C: &str = "cccccccccccccccc";

fn h(wall: u64, counter: u32, device: &str) -> Hlc {
    Hlc { wall, counter, device: device.into() }
}

fn tag_op(hlc: Hlc, id: &str, fields: &[(&str, serde_json::Value)]) -> Op {
    Op { hlc, kind: OpKind::Tag { id: id.into(), set: fields.iter().map(|(k, v)| (k.to_string(), v.clone())).collect() } }
}

fn add(hlc: Hlc, tag: &str, key: &str) -> Op {
    Op { hlc, kind: OpKind::Add { tag: tag.into(), key: key.into() } }
}

fn remove(hlc: Hlc, tag: &str, key: &str, dots: &[Hlc]) -> Op {
    Op { hlc, kind: OpKind::Remove { tag: tag.into(), key: key.into(), dots: dots.to_vec() } }
}

fn face(hlc: Hlc, key: &str, fields: &[(&str, serde_json::Value)]) -> Op {
    Op { hlc, kind: OpKind::Face { key: key.into(), set: fields.iter().map(|(k, v)| (k.to_string(), v.clone())).collect() } }
}

fn merged(ops: &[Op]) -> Merged {
    let mut m = Merged::default();
    for op in ops {
        m.apply(op);
    }
    m
}

fn names(m: &Merged) -> Vec<String> {
    m.tag_view().tags.into_iter().map(|t| t.name).collect()
}

const OKUDA: &str = "ps:Okuda|static|r";
const INTER: &str = "ps:Inter|var|r";

// ------------------------------------------------------------------------- merge rules

#[test]
fn concurrent_add_and_remove_keeps_the_add() {
    let base = vec![tag_op(h(1, 0, A), "t1", &[("name", json!("Sci-Fi")), ("color", json!("blue"))]), add(h(2, 0, A), "t1", OKUDA)];
    // B saw A's add and removes it; at the same time C adds the same font (B never saw C's add).
    let b_remove = remove(h(5, 0, B), "t1", OKUDA, &[h(2, 0, A)]);
    let c_add = add(h(4, 0, C), "t1", OKUDA);
    for order in [[b_remove.clone(), c_add.clone()], [c_add.clone(), b_remove.clone()]] {
        let mut ops = base.clone();
        ops.extend(order);
        let view = merged(&ops).tag_view();
        assert!(view.tags[0].keys.contains(OKUDA), "adding wins over a remove that didn't see it");
    }
    // A remove that saw every add takes the font off.
    let mut ops = base.clone();
    ops.push(remove(h(5, 0, B), "t1", OKUDA, &[h(2, 0, A)]));
    assert!(merged(&ops).tag_view().tags[0].keys.is_empty());
}

#[test]
fn rename_and_delete_at_the_same_time_deletes() {
    let create = tag_op(h(1, 0, A), "t1", &[("name", json!("Sci-Fi")), ("color", json!("blue"))]);
    let rename = tag_op(h(9, 0, A), "t1", &[("name", json!("Science Fiction"))]);
    let delete = Op { hlc: h(5, 0, B), kind: OpKind::TagDel { id: "t1".into() } };
    for ops in [vec![create.clone(), rename.clone(), delete.clone()], vec![delete.clone(), rename.clone(), create.clone()]] {
        assert!(names(&merged(&ops)).is_empty(), "a delete is final, even against a later rename");
    }
}

#[test]
fn deleting_a_tag_hides_the_tags_inside_it() {
    let ops = vec![
        tag_op(h(1, 0, A), "p", &[("name", json!("Sci-Fi"))]),
        tag_op(h(2, 0, B), "c", &[("name", json!("Star Trek")), ("parent", json!("p"))]),
        Op { hlc: h(3, 0, A), kind: OpKind::TagDel { id: "p".into() } },
    ];
    assert!(names(&merged(&ops)).is_empty());
}

#[test]
fn latest_value_wins_and_a_wrong_clock_cant_win_forever() {
    // A's clock is an hour fast.
    let hour = 3_600_000;
    let mut a = Clock::default();
    let mut b = Clock::default();
    let a1 = a.tick(A, 10_000_000 + hour);
    // B writes a little later in real time, but its clock says earlier.
    let b_early = b.tick(B, 10_000_100);
    let mut m = merged(&[
        tag_op(h(1, 0, A), "t", &[("name", json!("Tag")), ("color", json!("red"))]),
        tag_op(a1.clone(), "t", &[("color", json!("blue"))]),
        tag_op(b_early, "t", &[("color", json!("green"))]),
    ]);
    assert_eq!(m.tag_view().tags[0].color, "blue", "before B has seen A's change, A's clock wins");
    // Once B has seen A's change, B's next change comes after it, whatever B's wall clock says.
    b.observe(&a1);
    let b_late = b.tick(B, 10_000_200);
    assert!(b_late > a1);
    m.apply(&tag_op(b_late, "t", &[("color", json!("green"))]));
    assert_eq!(m.tag_view().tags[0].color, "green");
}

#[test]
fn order_and_repeats_dont_matter() {
    let ops = vec![
        tag_op(h(1, 0, A), "p", &[("name", json!("Sci-Fi")), ("color", json!("blue"))]),
        tag_op(h(2, 0, A), "c", &[("name", json!("Star Trek")), ("parent", json!("p")), ("color", json!("blue"))]),
        add(h(3, 0, A), "c", OKUDA),
        add(h(3, 1, B), "c", INTER),
        remove(h(4, 0, B), "c", INTER, &[h(3, 1, B)]),
        tag_op(h(5, 0, B), "p", &[("name", json!("Genre"))]),
        face(h(6, 0, A), OKUDA, &[("on", json!(true))]),
        face(h(7, 0, B), OKUDA, &[("on", json!(false))]),
    ];
    let forward = merged(&ops);
    let mut reversed = ops.clone();
    reversed.reverse();
    assert_eq!(merged(&reversed), forward, "out of order: the remove arrives before its add, the child before its parent");
    let twice: Vec<Op> = ops.iter().chain(ops.iter()).cloned().collect();
    assert_eq!(merged(&twice), forward, "delivered twice");
    let view = forward.tag_view();
    assert_eq!(names(&forward), ["Genre", "Genre/Star Trek"]);
    assert_eq!(view.tags[1].keys, BTreeSet::from([OKUDA.to_string()]));
    assert!(!forward.effective(OKUDA, C, None).unwrap().on);
}

#[test]
fn a_child_waits_for_its_parent() {
    let child = tag_op(h(2, 0, A), "c", &[("name", json!("Star Trek")), ("parent", json!("p"))]);
    let mut m = merged(&[child]);
    assert!(names(&m).is_empty(), "a tag whose parent hasn't arrived yet isn't shown");
    m.apply(&tag_op(h(1, 0, A), "p", &[("name", json!("Sci-Fi"))]));
    assert_eq!(names(&m), ["Sci-Fi", "Sci-Fi/Star Trek"]);
}

#[test]
fn moves_that_make_a_loop_are_broken_the_same_way_everywhere() {
    let ops = vec![
        tag_op(h(1, 0, A), "x", &[("name", json!("X"))]),
        tag_op(h(1, 1, A), "y", &[("name", json!("Y"))]),
        // A moves X into Y; B moves Y into X at the same time.
        tag_op(h(5, 0, A), "x", &[("parent", json!("y"))]),
        tag_op(h(6, 0, B), "y", &[("parent", json!("x"))]),
    ];
    let mut reversed = ops.clone();
    reversed.reverse();
    // The later move (Y into X) is the one dropped.
    assert_eq!(names(&merged(&ops)), ["Y", "Y/X"]);
    assert_eq!(names(&merged(&reversed)), ["Y", "Y/X"]);
}

#[test]
fn tags_with_the_same_name_become_one() {
    let m = merged(&[
        tag_op(h(1, 0, A), "t-a", &[("name", json!("Sci-Fi")), ("color", json!("blue"))]),
        add(h(2, 0, A), "t-a", OKUDA),
        tag_op(h(3, 0, B), "t-b", &[("name", json!("sci-fi")), ("color", json!("green"))]),
        add(h(4, 0, B), "t-b", INTER),
    ]);
    let view = m.tag_view();
    assert_eq!(view.tags.len(), 1);
    assert_eq!(view.tags[0].name, "sci-fi", "the most recently written spelling");
    assert_eq!(view.tags[0].color, "green");
    assert_eq!(view.tags[0].sids, ["t-a", "t-b"]);
    assert_eq!(view.tags[0].keys.len(), 2);
}

#[test]
fn bad_names_and_colors_from_elsewhere_are_handled() {
    let m = merged(&[
        tag_op(h(1, 0, A), "t1", &[("name", json!("a/b"))]),
        tag_op(h(1, 1, A), "t2", &[("name", json!("  "))]),
        tag_op(h(1, 2, A), "t3", &[("name", json!(" Fine  name ")), ("color", json!("ultraviolet"))]),
    ]);
    let view = m.tag_view();
    assert_eq!(view.unusable, 2);
    assert_eq!(view.tags[0].name, "Fine name");
    assert_eq!(view.tags[0].color, "gray");
}

#[test]
fn exceptions_this_device_then_its_group_then_the_shared_choice() {
    let mut m = merged(&[face(h(1, 0, A), OKUDA, &[("on", json!(true))])]);
    assert_eq!(m.effective(OKUDA, B, Some("Work")).map(|e| (e.on, e.source)), Some((true, Source::Shared)));
    m.apply(&face(h(2, 0, A), OKUDA, &[("xg:Work", json!("off"))]));
    assert_eq!(m.effective(OKUDA, B, Some("Work")).map(|e| (e.on, e.source)), Some((false, Source::Group)));
    assert_eq!(m.effective(OKUDA, B, Some("Home")).map(|e| e.on), Some(true));
    m.apply(&face(h(3, 0, B), OKUDA, &[(&format!("x:{B}"), json!("on"))]));
    assert_eq!(m.effective(OKUDA, B, Some("Work")).map(|e| (e.on, e.source)), Some((true, Source::Device)));
    // Back to "follow": the group's choice applies again, and the stamp moves on so it's re-applied.
    let before = m.effective(OKUDA, B, Some("Work")).unwrap().stamp;
    m.apply(&face(h(4, 0, B), OKUDA, &[(&format!("x:{B}"), json!(null))]));
    let after = m.effective(OKUDA, B, Some("Work")).unwrap();
    assert_eq!((after.on, after.source), (false, Source::Group));
    assert!(after.stamp > before);
    assert_eq!(m.effective(INTER, B, None), None, "nobody chose");
}

#[test]
fn a_snapshot_holds_the_same_state() {
    let ops = vec![
        tag_op(h(1, 0, A), "p", &[("name", json!("Sci-Fi")), ("color", json!("blue"))]),
        tag_op(h(2, 0, A), "p", &[("color", json!("red"))]),
        add(h(3, 0, A), "p", OKUDA),
        add(h(4, 0, B), "p", INTER),
        remove(h(5, 0, A), "p", INTER, &[h(4, 0, B)]),
        tag_op(h(6, 0, A), "gone", &[("name", json!("Gone"))]),
        Op { hlc: h(7, 0, A), kind: OpKind::TagDel { id: "gone".into() } },
        face(h(8, 0, A), OKUDA, &[("on", json!(true)), ("family", json!("Okuda"))]),
    ];
    let full = merged(&ops);
    let squeezed: Vec<Op> = full.ops_by(A).into_iter().chain(full.ops_by(B)).collect();
    assert!(squeezed.len() < ops.len() + 1);
    assert_eq!(merged(&squeezed).tag_view(), full.tag_view());
    assert_eq!(merged(&squeezed).effective(OKUDA, C, None), full.effective(OKUDA, C, None));
}

// ----------------------------------------------------------------------------- formats

#[test]
fn change_files_round_trip_and_refuse_what_they_cant_read() {
    let ops = vec![tag_op(h(1, 0, A), "t", &[("name", json!("Tag"))]), add(h(2, 0, A), "t", OKUDA)];
    let bytes = ops::write_changes(A, 3, &ops);
    let (header, read) = ops::read_changes(&bytes, A).unwrap();
    assert_eq!((header.seq, read), (3, ops.clone()));
    // Unfinished (a sync service still downloading it).
    assert!(matches!(ops::read_changes(&bytes[..bytes.len() - 5], A), Err(ReadError::Bad(_))));
    // Moved into another device's folder.
    assert!(matches!(ops::read_changes(&bytes, B), Err(ReadError::Bad(_))));
    // A newer format.
    let newer = String::from_utf8(bytes.clone()).unwrap().replacen("\"version\":1", "\"version\":2", 1);
    assert_eq!(ops::read_changes(newer.as_bytes(), A).unwrap_err(), ReadError::Newer(2));
    // A kind of change from a newer version is skipped, the rest is read.
    let extra = format!("{}{{\"hlc\":\"9.0.{A}\",\"op\":\"teleport\",\"to\":\"Mars\"}}\n", String::from_utf8(bytes).unwrap());
    assert_eq!(ops::read_changes(extra.as_bytes(), A).unwrap().1, ops);
}

#[test]
fn only_sync_files_count() {
    assert_eq!(ops::change_seq("changes-000042.jsonl"), Some(42));
    assert_eq!(ops::change_seq("changes-000042 (conflicted copy 2026-10-12).jsonl"), None);
    assert_eq!(ops::change_seq("changes-000042 (Sean's MacBook Pro).jsonl"), None);
    assert_eq!(ops::change_seq(".changes-000042.jsonl.123.tmp"), None);
    assert_eq!(ops::change_seq("changes-.jsonl"), None);
}

// --------------------------------------------------------------------------- devices

/// One computer: its own library database and its own sync state, sharing `folder`.
struct Device {
    dir: PathBuf,
    folder: PathBuf,
    conn: Connection,
    engine: Engine,
    folder_id: i64,
}

impl Device {
    fn new(name: &str, folder: &Path, machine: &str) -> Device {
        let dir = std::env::temp_dir().join(format!("fontface-sync-{name}-{}-{}", std::process::id(), super::device::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = db::open(&dir.join("library.sqlite3")).unwrap();
        tags::ensure_schema(&conn).unwrap();
        crate::activation::ensure_schema(&conn).unwrap();
        super::ensure_schema(&conn).unwrap();
        conn.execute("INSERT INTO folders (path, added_at, kind) VALUES (?1, 0, 'user')", [dir.join("fonts").to_string_lossy()]).unwrap();
        let folder_id = conn.last_insert_rowid();
        let mut engine = Engine::load(&conn, machine, name).unwrap();
        engine.config.enabled = true;
        engine.config.folder = Some(folder.to_string_lossy().into_owned());
        engine.save_config(&conn).unwrap();
        Device { dir, folder: folder.to_path_buf(), conn, engine, folder_id }
    }

    fn transport(&self) -> FolderTransport {
        FolderTransport::new(&self.folder, self.engine.me())
    }

    /// Adds a font file with one face. Returns its face key.
    fn font(&self, ps: &str, family: &str) -> String {
        let path = self.dir.join("fonts").join(format!("{ps}.otf")).to_string_lossy().into_owned();
        self.conn
            .execute(
                "INSERT INTO fonts (folder_id, path, face_index, file_size, mtime, family, subfamily, postscript_name,
                    weight, width, italic, monospace, variable, glyph_count, format)
                 VALUES (?1, ?2, 0, 1, 1, ?3, 'Regular', ?4, 400, 5, 0, 0, 0, 10, 'OpenType')",
                params![self.folder_id, path, family, ps],
            )
            .unwrap();
        tags::face_key(Some(ps), false, false, &path, 0)
    }

    fn is_on(&self, key: &str) -> bool {
        let ps = tags::key_postscript_name(key).unwrap();
        self.conn.query_row("SELECT MAX(activated) FROM fonts WHERE postscript_name = ?1", [ps], |r| r.get(0)).unwrap()
    }

    /// What the user does with the switch: on/off here, then the hook `set_activation` calls.
    fn switch(&mut self, key: &str, on: bool) {
        let ps = tags::key_postscript_name(key).unwrap();
        self.conn.execute("UPDATE fonts SET activated = ?1 WHERE postscript_name = ?2", params![on, ps]).unwrap();
        self.engine.choose(&self.conn, &[key.to_string()], on).unwrap();
    }

    fn tag(&mut self, name: &str) -> i64 {
        tags::create_tag(&mut self.conn, name, Some("blue")).unwrap().id
    }

    fn tag_id(&self, name: &str) -> i64 {
        tags::find_tag(&self.conn, name).unwrap().unwrap().id
    }

    fn put(&mut self, tag: &str, key: &str, on: bool) {
        let id = self.tag_id(tag);
        tags::assign(&mut self.conn, &[id], &[key.to_string()], on).unwrap();
    }

    fn tags(&self) -> Vec<(String, String, Vec<String>)> {
        tags::list_tags(&self.conn)
            .unwrap()
            .into_iter()
            .map(|t| {
                let mut stmt = self.conn.prepare("SELECT face_key FROM tag_fonts WHERE tag_id = ?1 ORDER BY face_key").unwrap();
                let keys = stmt.query_map([t.id], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
                (t.name, t.color, keys)
            })
            .collect()
    }

    fn own_files(&self) -> Vec<String> {
        self.transport().list(self.engine.me()).unwrap()
    }

    /// One sync, as `run_cycle` does it, with the font switches done straight in the database.
    fn sync(&mut self) -> Applied {
        self.cycle(true)
    }

    fn cycle(&mut self, remote: bool) -> Applied {
        let progress: BTreeMap<String, u64> = self.engine.saved.peers.iter().map(|(d, p)| (d.clone(), p.seq)).collect();
        let incoming = remote.then(|| engine::read_folder(&self.transport(), &progress));
        let me = self.engine.me().to_string();
        let tx = self.conn.transaction().unwrap();
        if let Some(inc) = incoming {
            self.engine.check_own_device_file(&tx, inc.devices.get(&me)).unwrap();
            self.engine.merge(inc);
        }
        let faces = engine::load_faces(&tx).unwrap();
        let mismatched = self.engine.mismatched(&faces);
        self.engine.local_changes(&tx, &mismatched).unwrap();
        if remote && !self.engine.saved.seeded {
            self.engine.seed(&tx, &faces).unwrap();
        }
        let applied = self.engine.apply(&tx, &faces, &mismatched).unwrap();
        for (on, list) in [(false, &applied.turn_off), (true, &applied.turn_on)] {
            for (_, ids) in list {
                for id in ids {
                    tx.execute("UPDATE fonts SET activated = ?1 WHERE path = (SELECT path FROM fonts WHERE id = ?2)", params![on, id]).unwrap();
                }
            }
        }
        self.engine.mark_applied(applied.stamps.clone());
        self.engine.save_state(&tx).unwrap();
        tx.commit().unwrap();
        // Write, as `write_files` does.
        let t = self.transport();
        if let Some((seq, row, bytes)) = self.engine.next_file(&self.own_files()) {
            t.write_atomic(&ops::change_name(seq), &bytes).unwrap();
            self.engine.written(&self.conn, seq, row).unwrap();
        }
        let now = super::hlc::now_ms();
        if self.engine.device_file_due(now) {
            t.write_atomic(ops::DEVICE_NAME, &self.engine.device_file("test", now)).unwrap();
            self.engine.saved.device_written = now;
            self.engine.device_dirty = false;
        }
        if let Some((bytes, covered)) = self.engine.compaction(&self.own_files()) {
            t.write_atomic(ops::SNAPSHOT_NAME, &bytes).unwrap();
            for name in covered {
                t.remove(&name).unwrap();
            }
        }
        applied
    }
}

impl Drop for Device {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

struct Folder(PathBuf);

impl Folder {
    fn new(name: &str) -> Folder {
        let dir = std::env::temp_dir().join(format!("fontface-sync-folder-{name}-{}-{}", std::process::id(), super::device::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        Folder(dir)
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn two_devices_share_tags_renames_moves_and_deletes() {
    let folder = Folder::new("tags");
    let mut a = Device::new("A", &folder.0, "machine-a");
    let mut b = Device::new("B", &folder.0, "machine-b");
    let okuda_a = a.font("Okuda", "Okuda");
    let okuda_b = b.font("Okuda", "Okuda");
    assert_eq!(okuda_a.split('|').next(), okuda_b.split('|').next());
    a.tag("Sci-Fi/Star Trek");
    a.put("Sci-Fi/Star Trek", &okuda_a, true);
    a.sync();
    b.sync();
    assert_eq!(
        b.tags(),
        [("Sci-Fi".into(), "blue".into(), vec![]), ("Sci-Fi/Star Trek".into(), "blue".into(), vec![OKUDA.to_string()])]
    );

    // B renames the parent and recolors the child; A moves the child to the top level.
    let sci_fi = b.tag_id("Sci-Fi");
    tags::rename_tag(&mut b.conn, sci_fi, "Genre").unwrap();
    let trek = b.tag_id("Genre/Star Trek");
    tags::set_tag_color(&b.conn, trek, "red").unwrap();
    b.sync();
    a.sync();
    assert_eq!(
        a.tags(),
        [("Genre".into(), "blue".into(), vec![]), ("Genre/Star Trek".into(), "red".into(), vec![OKUDA.to_string()])]
    );
    let trek = a.tag_id("Genre/Star Trek");
    tags::rename_tag(&mut a.conn, trek, "Star Trek").unwrap();
    a.sync();
    b.sync();
    assert_eq!(b.tags().iter().map(|t| t.0.as_str()).collect::<Vec<_>>(), ["Genre", "Star Trek"]);

    // A takes the font off the tag; B deletes "Genre".
    a.put("Star Trek", &okuda_a, false);
    let genre = b.tag_id("Genre");
    tags::delete_tag(&mut b.conn, genre).unwrap();
    a.sync();
    b.sync();
    a.sync();
    assert_eq!(a.tags(), [("Star Trek".into(), "red".into(), vec![])]);
    assert_eq!(a.tags(), b.tags());
}

#[test]
fn tags_both_devices_had_before_joining_merge_by_name() {
    let folder = Folder::new("join");
    let mut a = Device::new("A", &folder.0, "machine-a");
    let mut b = Device::new("B", &folder.0, "machine-b");
    let okuda = a.font("Okuda", "Okuda");
    let inter_b = b.font("Inter", "Inter");
    a.tag("Sci-Fi");
    a.put("Sci-Fi", &okuda, true);
    b.tag("sci-fi");
    b.put("sci-fi", &inter_b, true);
    a.sync();
    b.sync();
    a.sync();
    assert_eq!(a.tags().len(), 1);
    assert_eq!(a.tags()[0].2.len(), 2, "one tag, with both devices' fonts");
    assert_eq!(a.tags()[0].2, b.tags()[0].2);
    // Deleting the merged tag on one side deletes it everywhere (both sync ids get a tombstone).
    let id = a.tags().first().map(|t| a.tag_id(&t.0)).unwrap();
    tags::delete_tag(&mut a.conn, id).unwrap();
    a.sync();
    b.sync();
    assert!(b.tags().is_empty());
}

#[test]
fn concurrent_renames_settle_on_the_same_name() {
    let folder = Folder::new("renames");
    let mut a = Device::new("A", &folder.0, "machine-a");
    let mut b = Device::new("B", &folder.0, "machine-b");
    a.tag("Draft");
    a.sync();
    b.sync();
    let (ia, ib) = (a.tag_id("Draft"), b.tag_id("Draft"));
    tags::rename_tag(&mut a.conn, ia, "From A").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    tags::rename_tag(&mut b.conn, ib, "From B").unwrap();
    a.sync();
    b.sync();
    a.sync();
    assert_eq!(a.tags(), b.tags());
    assert_eq!(a.tags()[0].0, "From B", "the later rename wins");
}

#[test]
fn on_off_follows_the_shared_choice_with_per_device_exceptions() {
    let folder = Folder::new("intent");
    let mut a = Device::new("A", &folder.0, "machine-a");
    let mut b = Device::new("B", &folder.0, "machine-b");
    let okuda = a.font("Okuda", "Okuda");
    b.font("Okuda", "Okuda");
    a.sync();
    b.sync();
    a.switch(&okuda, true);
    a.sync();
    let applied = b.sync();
    assert_eq!(applied.turn_on.len(), 1);
    assert!(b.is_on(&okuda), "turned on at B too");

    // B: "Never on here". A is unaffected.
    b.engine.set_exception(&b.conn, &[okuda.clone()], Exception::Off, ExceptionFor::ThisDevice).unwrap();
    b.cycle(false);
    assert!(!b.is_on(&okuda));
    b.sync();
    a.sync();
    assert!(a.is_on(&okuda));
    assert_eq!(b.engine.exceptions().get(&okuda), Some(&Exception::Off));

    // At B the switch now changes B's exception, not everyone's choice.
    b.switch(&okuda, true);
    b.sync();
    a.switch(&okuda, false);
    a.sync();
    b.sync();
    assert!(!a.is_on(&okuda));
    assert!(b.is_on(&okuda), "B's exception keeps it on there");
    assert_eq!(b.engine.exceptions().get(&okuda), Some(&Exception::On));

    // Back to "Follow sync": B takes the shared choice (off).
    b.engine.set_exception(&b.conn, &[okuda.clone()], Exception::Follow, ExceptionFor::ThisDevice).unwrap();
    b.cycle(false);
    assert!(!b.is_on(&okuda));
}

#[test]
fn a_font_this_device_lacks_keeps_its_choice_until_it_arrives() {
    let folder = Folder::new("missing");
    let mut a = Device::new("A", &folder.0, "machine-a");
    let mut b = Device::new("B", &folder.0, "machine-b");
    let okuda = a.font("Okuda", "Okuda");
    a.switch(&okuda, true);
    a.sync();
    b.sync();
    let missing = b.engine.missing(&engine::load_faces(&b.conn).unwrap());
    assert_eq!(missing, [(okuda.clone(), "Okuda".to_string(), "Regular".to_string())]);
    // The font turns up at B (a drive mounted, a download finished): it's turned on.
    b.font("Okuda", "Okuda");
    b.sync();
    assert!(b.is_on(&okuda));
    assert!(b.engine.missing(&engine::load_faces(&b.conn).unwrap()).is_empty());
}

#[test]
fn joining_shares_fonts_already_on_and_never_turns_any_off() {
    let folder = Folder::new("seed");
    let mut a = Device::new("A", &folder.0, "machine-a");
    let mut b = Device::new("B", &folder.0, "machine-b");
    let okuda = a.font("Okuda", "Okuda");
    let inter = a.font("Inter", "Inter");
    b.font("Okuda", "Okuda");
    b.font("Inter", "Inter");
    a.switch(&okuda, true);
    a.sync();
    b.conn.execute("UPDATE fonts SET activated = 1 WHERE postscript_name = 'Inter'", []).unwrap();
    b.sync();
    a.sync();
    assert!(a.is_on(&okuda) && a.is_on(&inter));
    assert!(b.is_on(&okuda) && b.is_on(&inter));
}

#[test]
fn applying_never_writes_changes_back() {
    let folder = Folder::new("echo");
    let mut a = Device::new("A", &folder.0, "machine-a");
    let mut b = Device::new("B", &folder.0, "machine-b");
    let okuda = a.font("Okuda", "Okuda");
    b.font("Okuda", "Okuda");
    a.tag("Sci-Fi/Star Trek");
    a.put("Sci-Fi/Star Trek", &okuda, true);
    a.switch(&okuda, true);
    a.sync();
    b.sync(); // B's own first sync writes its join (nothing to share here)
    let files_before = b.own_files();
    for _ in 0..3 {
        b.sync();
        a.sync();
    }
    assert_eq!(b.own_files(), files_before, "B applied A's changes and wrote none of its own");
    assert!(b.engine.outbox.is_empty());
    let local = b.engine.local_changes(&b.conn, &BTreeSet::new()).unwrap();
    assert_eq!(local, 0);
}

#[test]
fn a_partial_or_damaged_file_is_skipped_and_tried_again() {
    let folder = Folder::new("partial");
    let mut a = Device::new("A", &folder.0, "machine-a");
    let mut b = Device::new("B", &folder.0, "machine-b");
    a.tag("First");
    a.sync();
    a.tag("Second");
    a.sync();
    // The second change file is still downloading at B: only half of it is there.
    let dir = folder.0.join("Fontface Sync/v1/devices").join(a.engine.me());
    let second = dir.join(ops::change_name(2));
    let full = std::fs::read(&second).unwrap();
    std::fs::write(&second, &full[..full.len() / 2]).unwrap();
    // And a sync service left a conflicted copy and a stray file.
    std::fs::write(dir.join("changes-000002 (conflicted copy).jsonl"), b"garbage").unwrap();
    std::fs::write(dir.join("notes.txt"), b"hello").unwrap();
    b.sync();
    assert_eq!(b.tags().iter().map(|t| t.0.as_str()).collect::<Vec<_>>(), ["First"]);
    assert_eq!(b.engine.saved.peers[a.engine.me()].seq, 1, "not counted as read");
    assert!(b.engine.problems.contains_key(a.engine.me()));
    // The download finishes.
    std::fs::write(&second, &full).unwrap();
    b.sync();
    assert_eq!(b.tags().iter().map(|t| t.0.as_str()).collect::<Vec<_>>(), ["First", "Second"]);
    assert!(!b.engine.problems.contains_key(a.engine.me()));
    // A damaged state is rebuilt from the folder, without losing anything.
    b.conn.execute("UPDATE sync_meta SET value = 'not json' WHERE key = 'state'", []).unwrap();
    b.engine = Engine::load(&b.conn, "machine-b", "B").unwrap();
    b.sync();
    assert_eq!(b.tags().iter().map(|t| t.0.as_str()).collect::<Vec<_>>(), ["First", "Second"]);
}

#[test]
fn a_newer_format_is_refused_in_plain_words() {
    let folder = Folder::new("newer");
    let mut a = Device::new("A", &folder.0, "machine-a");
    let mut b = Device::new("B", &folder.0, "machine-b");
    a.tag("Mine");
    a.sync();
    let first = folder.0.join("Fontface Sync/v1/devices").join(a.engine.me()).join(ops::change_name(1));
    let text = std::fs::read_to_string(&first).unwrap().replacen("\"version\":1", "\"version\":7", 1);
    std::fs::write(&first, text).unwrap();
    std::fs::create_dir_all(folder.0.join("Fontface Sync/v2")).unwrap();
    b.sync();
    assert!(b.tags().is_empty());
    assert!(b.engine.problems[a.engine.me()].contains("newer version"));
    assert_eq!(b.engine.newer_formats, ["v2"]);
}

#[test]
fn copied_app_data_gets_a_new_device_id() {
    let folder = Folder::new("clone");
    let mut a = Device::new("A", &folder.0, "machine-a");
    a.tag("Mine");
    a.sync();
    let old_id = a.engine.me().to_string();
    // Migration Assistant copied A's library to a new Mac.
    let copy = a.dir.with_extension("copy");
    std::fs::create_dir_all(&copy).unwrap();
    a.conn.execute("VACUUM INTO ?1", [copy.join("library.sqlite3").to_string_lossy()]).unwrap();
    let conn = db::open(&copy.join("library.sqlite3")).unwrap();
    let engine = Engine::load(&conn, "machine-new", "New Mac").unwrap();
    assert_ne!(engine.me(), old_id);
    assert!(engine.cloned);
    assert_eq!(engine.config.name, "New Mac");
    let _ = std::fs::remove_dir_all(&copy);

    // Same id, and the machine check couldn't catch it (say the hardware id couldn't be read
    // when the copy was made): the device file in the folder gives it away.
    let mut twin = Device::new("Twin", &folder.0, "machine-twin");
    twin.engine.config.device_id = old_id.clone();
    twin.engine.saved = Default::default();
    twin.sync();
    assert_ne!(twin.engine.me(), old_id, "the folder's device file was written by another computer");
    assert!(twin.engine.cloned);
    assert_eq!(twin.tags().iter().map(|t| t.0.as_str()).collect::<Vec<_>>(), ["Mine"]);
    // A's folder was never written by the twin.
    let a_dir = folder.0.join("Fontface Sync/v1/devices").join(&old_id);
    let a_device = ops::read_device(&std::fs::read(a_dir.join(ops::DEVICE_NAME)).unwrap()).unwrap();
    assert_eq!(a_device.machine, "machine-a");
}

#[test]
fn compaction_keeps_everything_for_a_device_that_joins_later() {
    let folder = Folder::new("compact");
    let mut a = Device::new("A", &folder.0, "machine-a");
    let okuda = a.font("Okuda", "Okuda");
    for i in 0..30 {
        a.tag(&format!("Tag {i:02}"));
        if i == 10 {
            a.put("Tag 10", &okuda, true);
        }
        if i == 20 {
            let id = a.tag_id("Tag 05");
            tags::delete_tag(&mut a.conn, id).unwrap();
        }
        a.sync();
    }
    let files = a.own_files();
    assert!(files.contains(&ops::SNAPSHOT_NAME.to_string()));
    assert!(files.iter().filter(|f| ops::change_seq(f).is_some()).count() < 24, "older change files were squeezed");
    let mut b = Device::new("B", &folder.0, "machine-b");
    b.sync();
    assert_eq!(b.tags().len(), 29);
    assert_eq!(b.tags(), a.tags());
}

#[test]
fn a_different_font_with_the_same_name_isnt_merged() {
    let folder = Folder::new("prints");
    let mut a = Device::new("A", &folder.0, "machine-a");
    let mut b = Device::new("B", &folder.0, "machine-b");
    let key = a.font("Nova-Regular", "Nova Sans");
    b.font("Nova-Regular", "Nova Serif");
    // A's copy is a purchase with a known fingerprint, B's file has a different one.
    a.conn
        .execute(
            "INSERT INTO sync_outbox (line) VALUES (?1)",
            [serde_json::to_string(&face(
                Hlc { wall: super::hlc::now_ms(), counter: 0, device: a.engine.me().into() },
                &key,
                &[("on", json!(true)), ("family", json!("Nova Sans")), ("prints", json!(["0000000000000001-10"]))],
            ))
            .unwrap()],
        )
        .unwrap();
    a.engine = Engine::load(&a.conn, "machine-a", "A").unwrap();
    a.sync();
    let b_file = b.conn.query_row("SELECT path FROM fonts", [], |r| r.get::<_, String>(0)).unwrap();
    std::fs::create_dir_all(Path::new(&b_file).parent().unwrap()).unwrap();
    std::fs::write(&b_file, b"a different font").unwrap();
    b.sync();
    assert!(!b.is_on(&key), "not turned on: it's another font that shares the name");
    // Same family, other fingerprint: another version of the same font, so it's matched.
    b.conn.execute("UPDATE fonts SET family = 'Nova Sans'", []).unwrap();
    b.sync();
    assert!(b.is_on(&key));
}
