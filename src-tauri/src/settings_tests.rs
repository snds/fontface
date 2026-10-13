//! Settings, the launch restore plan, the login item, tag backups and the window's native side.
//! Everything here runs against temporary folders and pure functions; nothing touches the real
//! font registry, ~/Library/LaunchAgents or macOS's preferences.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use serde_json::json;

use crate::{
    activation::{launch_plan, temporary_after_swap, turn_on_plan, LaunchPlan, Scope, TurnOn},
    backups, db,
    settings::{self, ActivationMode, AppSettings, RestorePolicy, SidebarSections, Theme},
    tags,
    window::{self, DoubleClick},
};

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fontface-settings-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn error_text(r: crate::error::AppResult<AppSettings>) -> String {
    r.expect_err("should be refused").to_string()
}

// -------------------------------------------------------------------------------- settings

#[test]
fn defaults_match_the_spec() {
    let d = AppSettings::default();
    assert_eq!(d.theme, Theme::System);
    assert_eq!(d.preview_text, "");
    assert_eq!(d.preview_size, 32);
    assert!(d.restore_last_view);
    assert!(!d.launch_at_login);
    assert!(!d.keep_running_in_background);
    assert!(d.scan_at_launch);
    assert!(d.show_installed_in_all);
    assert_eq!(d.sidebar, SidebarSections { font_book: true, google: true, adobe: true, purchases: true, tags: true });
    assert_eq!(d.activation_mode, ActivationMode::Persistent);
    assert!(!d.clear_temporary_on_quit);
    assert_eq!(d.restore_on_launch, RestorePolicy::Always);
    assert!(d.tag_backups);
    assert_eq!(d.tag_backup_keep, 10);
}

#[test]
fn serializes_in_the_shape_the_ui_expects() {
    let v = serde_json::to_value(AppSettings::default()).unwrap();
    assert_eq!(
        v,
        json!({
            "theme": "system",
            "previewText": "",
            "previewSize": 32,
            "restoreLastView": true,
            "launchAtLogin": false,
            "keepRunningInBackground": false,
            "scanAtLaunch": true,
            "showInstalledInAll": true,
            "sidebar": { "fontBook": true, "google": true, "adobe": true, "purchases": true, "tags": true },
            "activationMode": "persistent",
            "clearTemporaryOnQuit": false,
            "restoreOnLaunch": "always",
            "tagBackups": true,
            "tagBackupKeep": 10
        })
    );
}

#[test]
fn json_round_trip_and_missing_keys_take_defaults() {
    let mut custom = AppSettings::default();
    custom.theme = Theme::Dark;
    custom.preview_text = "Sphinx of black quartz".into();
    custom.sidebar.adobe = false;
    custom.restore_on_launch = RestorePolicy::Ask;
    let text = serde_json::to_string(&custom).unwrap();
    assert_eq!(serde_json::from_str::<AppSettings>(&text).unwrap(), custom);

    assert_eq!(serde_json::from_str::<AppSettings>("{}").unwrap(), AppSettings::default());
    let partial: AppSettings = serde_json::from_str(r#"{"previewSize": 64, "sidebar": {"tags": false}}"#).unwrap();
    assert_eq!(partial.preview_size, 64);
    assert!(!partial.sidebar.tags);
    assert!(partial.sidebar.font_book && partial.sidebar.google, "missing sidebar keys take defaults");
    assert_eq!(partial.theme, Theme::System);
}

#[test]
fn a_patch_changes_only_what_it_names() {
    let before = AppSettings::default();
    let after = settings::apply_patch(&before, &json!({ "theme": "dark", "previewSize": 48 })).unwrap();
    assert_eq!(after.theme, Theme::Dark);
    assert_eq!(after.preview_size, 48);
    assert_eq!(AppSettings { theme: Theme::System, preview_size: 32, ..after }, before);
}

#[test]
fn sidebar_merges_key_by_key() {
    let mut before = AppSettings::default();
    before.sidebar.google = false;
    let after = settings::apply_patch(&before, &json!({ "sidebar": { "adobe": false } })).unwrap();
    assert!(!after.sidebar.google, "keys the patch doesn't name keep their value");
    assert!(!after.sidebar.adobe);
    assert!(after.sidebar.font_book && after.sidebar.purchases && after.sidebar.tags);
}

#[test]
fn numbers_are_clamped_and_rounded() {
    let d = AppSettings::default();
    let low = settings::apply_patch(&d, &json!({ "previewSize": 2, "tagBackupKeep": 0 })).unwrap();
    assert_eq!((low.preview_size, low.tag_backup_keep), (10, 1));
    let high = settings::apply_patch(&d, &json!({ "previewSize": 4000, "tagBackupKeep": 99 })).unwrap();
    assert_eq!((high.preview_size, high.tag_backup_keep), (128, 50));
    let negative = settings::apply_patch(&d, &json!({ "previewSize": -20 })).unwrap();
    assert_eq!(negative.preview_size, 10);
    let fraction = settings::apply_patch(&d, &json!({ "previewSize": 31.6 })).unwrap();
    assert_eq!(fraction.preview_size, 32);
}

#[test]
fn unknown_keys_are_ignored() {
    let d = AppSettings::default();
    let after = settings::apply_patch(&d, &json!({ "fromTheFuture": 1, "sidebar": { "cloud": false }, "theme": "light" })).unwrap();
    assert_eq!(after, AppSettings { theme: Theme::Light, ..AppSettings::default() });
}

#[test]
fn bad_values_are_refused_in_plain_words_and_change_nothing() {
    let d = AppSettings::default();
    let msg = error_text(settings::apply_patch(&d, &json!({ "previewSize": 40, "theme": "blue" })));
    assert_eq!(msg, "Appearance must be “system”, “light” or “dark”");
    let msg = error_text(settings::apply_patch(&d, &json!({ "activationMode": "forever" })));
    assert_eq!(msg, "Turning fonts on must be “persistent” or “temporary”");
    let msg = error_text(settings::apply_patch(&d, &json!({ "restoreOnLaunch": 3 })));
    assert_eq!(msg, "Fonts that were on last time must be “always”, “ask” or “never”");
    let msg = error_text(settings::apply_patch(&d, &json!({ "launchAtLogin": "yes" })));
    assert_eq!(msg, "“Open at login” must be on or off");
    let msg = error_text(settings::apply_patch(&d, &json!({ "previewSize": "big" })));
    assert_eq!(msg, "Preview size must be a number");
    assert!(settings::apply_patch(&d, &json!({ "sidebar": true })).is_err());
    assert!(settings::apply_patch(&d, &json!({ "sidebar": { "tags": "no" } })).is_err());
    assert!(settings::apply_patch(&d, &json!({ "previewText": 12 })).is_err());
    assert!(settings::apply_patch(&d, &json!(["theme", "dark"])).is_err());
    assert!(settings::apply_patch(&d, &json!(null)).is_err());
}

#[test]
fn preview_text_has_a_length_limit() {
    let d = AppSettings::default();
    let ok = "é".repeat(settings::MAX_PREVIEW_TEXT);
    assert_eq!(settings::apply_patch(&d, &json!({ "previewText": ok })).unwrap().preview_text, ok);
    let long = "a".repeat(settings::MAX_PREVIEW_TEXT + 1);
    assert_eq!(
        error_text(settings::apply_patch(&d, &json!({ "previewText": long }))),
        "Preview text can be at most 500 characters"
    );
}

#[test]
fn every_setting_can_be_changed_by_a_patch() {
    // Guards against a field added to the struct but not to apply_key.
    let custom = AppSettings {
        theme: Theme::Light,
        preview_text: "Hamburgefonstiv".into(),
        preview_size: 77,
        restore_last_view: false,
        launch_at_login: true,
        keep_running_in_background: true,
        scan_at_launch: false,
        show_installed_in_all: false,
        sidebar: SidebarSections { font_book: false, google: false, adobe: false, purchases: false, tags: false },
        activation_mode: ActivationMode::Temporary,
        clear_temporary_on_quit: true,
        restore_on_launch: RestorePolicy::Never,
        tag_backups: false,
        tag_backup_keep: 3,
    };
    let patch = serde_json::to_value(&custom).unwrap();
    assert_eq!(settings::apply_patch(&AppSettings::default(), &patch).unwrap(), custom);
}

#[test]
fn storage_round_trip_skips_damaged_rows_and_keeps_unknown_ones() {
    let dir = temp("storage");
    let mut conn = db::open(&dir.join("library.sqlite3")).unwrap();
    settings::ensure_schema(&conn).unwrap();
    settings::ensure_schema(&conn).unwrap(); // idempotent
    assert_eq!(settings::load(&conn).unwrap(), AppSettings::default(), "an empty table gives the defaults");

    let mut custom = AppSettings::default();
    custom.preview_size = 72;
    custom.sidebar.purchases = false;
    custom.activation_mode = ActivationMode::Temporary;
    settings::save(&mut conn, &custom).unwrap();
    assert_eq!(settings::load(&conn).unwrap(), custom);

    // A row from a newer version, and a damaged one: the rest still loads.
    conn.execute("INSERT INTO app_settings (key, value) VALUES ('fromTheFuture', '\"x\"')", []).unwrap();
    conn.execute("UPDATE app_settings SET value = 'not json' WHERE key = 'theme'", []).unwrap();
    conn.execute("UPDATE app_settings SET value = '\"sideways\"' WHERE key = 'restoreOnLaunch'", []).unwrap();
    let loaded = settings::load(&conn).unwrap();
    assert_eq!(loaded.theme, Theme::System);
    assert_eq!(loaded.restore_on_launch, RestorePolicy::Always);
    assert_eq!(loaded.preview_size, 72);
    assert_eq!(loaded.activation_mode, ActivationMode::Temporary);

    settings::save(&mut conn, &AppSettings::default()).unwrap();
    let kept: i64 = conn.query_row("SELECT COUNT(*) FROM app_settings WHERE key = 'fromTheFuture'", [], |r| r.get(0)).unwrap();
    assert_eq!(kept, 1, "rows this version doesn't know are left alone");
    assert_eq!(settings::load(&conn).unwrap(), AppSettings::default());
    std::fs::remove_dir_all(&dir).ok();
}

// ----------------------------------------------------------------------- activation scopes

#[test]
fn turning_on_keeps_a_font_that_is_already_on_in_its_scope() {
    use ActivationMode::{Persistent, Temporary};
    // (mode, recorded on, temporary, loaded) → plan
    let cases = [
        (Persistent, false, false, false, TurnOn::Register(Scope::Persistent)),
        (Persistent, true, false, false, TurnOn::Register(Scope::Persistent)),
        (Persistent, true, false, true, TurnOn::Register(Scope::Persistent)), // idempotent, as before
        (Persistent, true, true, true, TurnOn::AlreadyOn),                     // on temporarily: stays temporary
        (Persistent, true, true, false, TurnOn::Register(Scope::Persistent)), // its login ended
        (Persistent, false, false, true, TurnOn::Register(Scope::Persistent)), // another app has it on
        (Temporary, false, false, false, TurnOn::Register(Scope::Session)),
        (Temporary, true, false, true, TurnOn::AlreadyOn), // on to stay: stays persistent
        (Temporary, true, false, false, TurnOn::Register(Scope::Session)),
        (Temporary, true, true, true, TurnOn::Register(Scope::Session)),
        (Temporary, false, false, true, TurnOn::Register(Scope::Session)), // another app has it on
    ];
    for (mode, recorded_on, temporary, loaded, want) in cases {
        assert_eq!(turn_on_plan(mode, recorded_on, temporary, loaded), want, "{mode:?} on={recorded_on} temp={temporary} loaded={loaded}");
    }
    assert_eq!(Scope::from(Persistent), Scope::Persistent);
    assert_eq!(Scope::from(Temporary), Scope::Session);
}

#[test]
fn an_update_brings_each_font_back_in_the_scope_it_had() {
    let on = |list: &[(&str, Scope)]| -> Vec<(String, Scope)> { list.iter().map(|(n, s)| (n.to_string(), *s)).collect() };
    let old = set(&["A-Regular.ttf", "A-Bold.ttf", "A-Italic.ttf"]);

    // Mixed: each keeps its own. A new file (statics rebuilt as a variable font) comes back to
    // stay, because something it may replace was kept on for good.
    let mixed = on(&[("A-Regular.ttf", Scope::Persistent), ("A-Bold.ttf", Scope::Session)]);
    let new = strings(&["A-Regular.ttf", "A-Bold.ttf", "A[wght].ttf"]);
    assert_eq!(temporary_after_swap(&mixed, &old, &new), strings(&["A-Bold.ttf"]));

    // Everything that was on was temporary: new files come back temporarily too. A file that's
    // gone from the new version is still listed, which is harmless.
    let all_temporary = on(&[("A-Regular.ttf", Scope::Session), ("A-Italic.ttf", Scope::Session)]);
    assert_eq!(
        temporary_after_swap(&all_temporary, &old, &new),
        strings(&["A-Italic.ttf", "A-Regular.ttf", "A[wght].ttf"])
    );

    // Everything was on to stay: nothing is temporary.
    let all_kept = on(&[("A-Regular.ttf", Scope::Persistent)]);
    assert!(temporary_after_swap(&all_kept, &old, &new).is_empty());

    // Nothing was on: nothing comes back, so nothing is temporary.
    assert!(temporary_after_swap(&[], &old, &new).is_empty());

    // One PostScript name in two files with different scopes (purchases): it's kept for good.
    let twice = on(&[("A-Regular", Scope::Session), ("A-Regular", Scope::Persistent), ("A-Bold", Scope::Session)]);
    assert_eq!(temporary_after_swap(&twice, &set(&["A-Regular", "A-Bold"]), &strings(&["A-Black"])), strings(&["A-Bold"]));
}

fn set(paths: &[&str]) -> HashSet<String> {
    paths.iter().map(|p| p.to_string()).collect()
}

fn strings(paths: &[&str]) -> Vec<String> {
    paths.iter().map(|p| p.to_string()).collect()
}

/// A library where /on/loaded is on, /on/a and /on/b were on but aren't loaded, /gone/c was on
/// but its drive isn't mounted, and nothing is temporary.
fn plan_for(policy: RestorePolicy) -> LaunchPlan {
    let recorded = set(&["/on/loaded", "/on/b", "/on/a", "/gone/c"]);
    let loaded = set(&["/on/loaded", "/other/app"]);
    launch_plan(&recorded, &HashSet::new(), &loaded, |p| !p.starts_with("/gone/"), policy)
}

#[test]
fn launch_always_turns_fonts_back_on_and_defers_missing_ones() {
    assert_eq!(
        plan_for(RestorePolicy::Always),
        LaunchPlan { reactivate: strings(&["/on/a", "/on/b"]), deferred: strings(&["/gone/c"]), ..Default::default() }
    );
}

#[test]
fn launch_ask_lists_existing_files_and_defers_missing_ones() {
    assert_eq!(
        plan_for(RestorePolicy::Ask),
        LaunchPlan { ask: strings(&["/on/a", "/on/b"]), deferred: strings(&["/gone/c"]), ..Default::default() }
    );
}

#[test]
fn launch_never_records_existing_files_as_off_and_keeps_missing_ones() {
    assert_eq!(
        plan_for(RestorePolicy::Never),
        LaunchPlan { record_off: strings(&["/on/a", "/on/b"]), deferred: strings(&["/gone/c"]), ..Default::default() }
    );
}

#[test]
fn launch_expires_temporary_fonts_whose_login_ended() {
    let recorded = set(&["/t/still-on", "/t/ended", "/t/ended-missing", "/p/off"]);
    let temporary = set(&["/t/still-on", "/t/ended", "/t/ended-missing", "/t/stray"]);
    let loaded = set(&["/t/still-on"]);
    for policy in [RestorePolicy::Always, RestorePolicy::Ask, RestorePolicy::Never] {
        let plan = launch_plan(&recorded, &temporary, &loaded, |p| !p.ends_with("missing"), policy);
        // Ended logins are never turned back on, asked about or deferred, whatever the policy;
        // a temporary row with no recorded intent is dropped too.
        assert_eq!(plan.expired, strings(&["/t/ended", "/t/ended-missing", "/t/stray"]), "{policy:?}");
        let rest: Vec<&String> = plan.reactivate.iter().chain(&plan.ask).chain(&plan.record_off).chain(&plan.deferred).collect();
        assert_eq!(rest, vec!["/p/off"], "{policy:?}: only the persistent font is left to the policy");
    }
}

#[test]
fn launch_does_nothing_when_everything_is_loaded() {
    let all = set(&["/a", "/b", "/t"]);
    let plan = launch_plan(&set(&["/a", "/b"]), &set(&["/t"]), &all, |_| true, RestorePolicy::Never);
    assert_eq!(plan, LaunchPlan::default());
}

// ------------------------------------------------------------------------------ login item

#[cfg(target_os = "macos")]
mod login {
    use super::temp;
    use crate::login_item;
    use std::path::Path;

    #[test]
    fn writes_reads_and_removes_the_launch_agent() {
        let dir = temp("agent").join("LaunchAgents"); // created on demand
        let exe = Path::new("/Applications/Fontface.app/Contents/MacOS/fontface");
        assert!(!login_item::is_enabled(&dir, exe));

        login_item::enable(&dir, exe).unwrap();
        let file = login_item::plist_path(&dir);
        assert_eq!(file.file_name().unwrap(), "design.snds.fontface.plist");
        let value = plist::Value::from_file(&file).unwrap();
        let dict = value.as_dictionary().unwrap();
        assert_eq!(dict.get("Label").and_then(plist::Value::as_string), Some("design.snds.fontface"));
        let args: Vec<&str> = dict["ProgramArguments"].as_array().unwrap().iter().filter_map(plist::Value::as_string).collect();
        assert_eq!(args, vec![exe.to_str().unwrap()]);
        assert_eq!(dict.get("RunAtLoad").and_then(plist::Value::as_boolean), Some(true));
        assert_eq!(dict.get("ProcessType").and_then(plist::Value::as_string), Some("Interactive"));

        assert!(login_item::is_enabled(&dir, exe));
        assert!(!login_item::is_enabled(&dir, Path::new("/Other/Fontface.app/Contents/MacOS/fontface")));

        login_item::disable(&dir).unwrap();
        assert!(!file.exists());
        assert!(!login_item::is_enabled(&dir, exe));
        login_item::disable(&dir).unwrap(); // already gone: fine
        std::fs::remove_dir_all(dir.parent().unwrap()).ok();
    }

    /// A fake app at `root/<place>/Fontface.app`, with its executable on disk.
    fn app(root: &Path, place: &str) -> std::path::PathBuf {
        let exe = root.join(place).join("Fontface.app/Contents/MacOS/fontface");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, "").unwrap();
        exe
    }

    #[test]
    fn refresh_follows_a_moved_app_but_never_turns_it_on() {
        let dir = temp("agent-refresh");
        let agents = dir.join("LaunchAgents");
        let old = app(&dir, "Applications");
        let new = app(&dir, "Moved");
        assert!(!login_item::refresh(&agents, &new).unwrap(), "no agent: the user turned it off");
        assert!(!login_item::plist_path(&agents).exists());

        login_item::enable(&agents, &old).unwrap();
        assert!(!login_item::refresh(&agents, &old).unwrap(), "same place: nothing to do");
        assert!(!login_item::refresh(&agents, &new).unwrap(), "the other copy is still there: it keeps the login item");
        assert_eq!(login_item::program(&agents).unwrap(), old);

        std::fs::remove_dir_all(old.ancestors().nth(3).unwrap()).unwrap(); // the app was moved
        assert!(login_item::refresh(&agents, &new).unwrap());
        assert_eq!(login_item::program(&agents).unwrap(), new);
        assert!(login_item::is_enabled(&agents, &new));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_copy_on_a_disk_image_or_translocated_never_takes_the_login_item() {
        let on_dmg = Path::new("/Volumes/Fontface/Fontface.app/Contents/MacOS/fontface");
        let translocated =
            Path::new("/private/var/folders/ab/cd/T/AppTranslocation/0A1B-2C3D/d/Fontface.app/Contents/MacOS/fontface");
        let read_only = |_: &Path| true;
        let writable = |_: &Path| false;
        assert!(login_item::temporary_location_with(on_dmg, read_only), "a disk image mounts read-only");
        assert!(
            !login_item::temporary_location_with(on_dmg, writable),
            "an app kept at the top of a writable drive is fine"
        );
        assert!(login_item::temporary_location(translocated));
        assert!(login_item::temporary_location_with(translocated, writable));
        assert!(!login_item::temporary_location(Path::new("/Applications/Fontface.app/Contents/MacOS/fontface")));
        assert!(
            !login_item::temporary_location_with(
                Path::new("/Volumes/Work/Applications/Fontface.app/Contents/MacOS/fontface"),
                read_only
            ),
            "an app installed in a folder on another drive is fine"
        );

        let dir = temp("agent-temporary");
        let gone = dir.join("Gone/Fontface.app/Contents/MacOS/fontface");
        let message = login_item::enable(&dir, translocated).expect_err("refused").to_string();
        assert_eq!(
            message,
            "Fontface can't open at login from here. Move it to your Applications folder, open it from there, and try again."
        );
        assert!(!login_item::plist_path(&dir).exists());

        // Even when the copy the login item starts is gone, a temporary copy doesn't take it.
        login_item::enable(&dir, &gone).unwrap();
        assert!(!login_item::refresh(&dir, translocated).unwrap());
        assert_eq!(login_item::program(&dir).unwrap(), gone);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn someone_elses_file_is_not_ours() {
        let dir = temp("agent-foreign");
        let mut dict = plist::Dictionary::new();
        dict.insert("Label".into(), plist::Value::String("com.example.other".into()));
        dict.insert("ProgramArguments".into(), plist::Value::Array(vec![plist::Value::String("/bin/sh".into())]));
        plist::Value::Dictionary(dict).to_file_xml(login_item::plist_path(&dir)).unwrap();
        assert!(login_item::program(&dir).is_none());
        assert!(!login_item::is_enabled(&dir, Path::new("/bin/sh")));
        std::fs::write(login_item::plist_path(&dir), "garbage").unwrap();
        assert!(login_item::program(&dir).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tells_an_app_bundle_from_a_development_build() {
        assert!(login_item::in_app_bundle(Path::new("/Applications/Fontface.app/Contents/MacOS/fontface")));
        assert!(!login_item::in_app_bundle(Path::new("/Users/me/fontface/src-tauri/target/debug/fontface")));
        assert!(!login_item::in_app_bundle(Path::new("/Applications/Fontface.app/Contents/Resources/x")));
    }
}

// --------------------------------------------------------------------------------- backups

const OCT_12_2026_143005: i64 = 1_791_815_405;
const DAY: i64 = 86_400;

#[test]
fn backup_names_sort_by_time_and_parse_back() {
    assert_eq!(backups::file_name(OCT_12_2026_143005), "Tags 2026-10-12 14-30-05.json");
    assert_eq!(backups::parse_name("Tags 2026-10-12 14-30-05.json"), Some(OCT_12_2026_143005));
    assert_eq!(backups::file_name(1_709_164_800), "Tags 2024-02-29 00-00-00.json");
    assert_eq!(backups::parse_name("Tags 1999-12-31 23-59-59.json"), Some(946_684_799));
    for t in [0, 951_782_400, 1_709_164_799, OCT_12_2026_143005 + 12_345] {
        assert_eq!(backups::parse_name(&backups::file_name(t)), Some(t));
    }
    let mut names: Vec<String> = [5 * DAY, 1, 40 * DAY, DAY + 7].iter().map(|t| backups::file_name(OCT_12_2026_143005 + t)).collect();
    let mut by_time = names.clone();
    names.sort();
    by_time.sort_by_key(|n| backups::parse_name(n));
    assert_eq!(names, by_time);
}

#[test]
fn only_exact_backup_names_count() {
    for name in [
        "Tags 2026-02-31 00-00-00.json",
        "Tags 2026-10-12 25-00-00.json",
        "Tags 2026-10-12 14-30-5.json",
        "Tags 2026-10-12 14:30:05.json",
        "Tags 2026-10-12 14-30-05.json.bak",
        "Tags 2026-10-12 14-30-05 copy.json",
        "tags 2026-10-12 14-30-05.json",
        "Tags +026-10-12 14-30-05.json",
        "Tags 2026-10-12 14-30-05.JSON",
        "notes.json",
        "",
    ] {
        assert_eq!(backups::parse_name(name), None, "{name}");
    }
}

fn touch_backup(dir: &Path, secs: i64) -> PathBuf {
    let path = dir.join(backups::file_name(secs));
    std::fs::write(&path, r#"{"format":"fontface-tags","version":1,"tags":[{"name":"A","color":"red","fonts":[]}]}"#).unwrap();
    path
}

#[test]
fn rotation_keeps_the_newest_and_never_touches_other_files() {
    let dir = temp("rotate");
    for i in 0..6 {
        touch_backup(&dir, OCT_12_2026_143005 + i * DAY);
    }
    let foreign = ["notes.txt", "Tags old.json", "Tags 2020-01-01 00-00-00.json.tmp", "Tags 2001-01-01 00-00-00.json.bak"];
    for name in foreign {
        std::fs::write(dir.join(name), "mine").unwrap();
    }
    // A folder with a backup's name is not a backup either.
    std::fs::create_dir(dir.join(backups::file_name(1))).unwrap();

    let now = OCT_12_2026_143005 + 5 * DAY;
    assert_eq!(backups::rotate(&dir, 3, now, None), 3);
    let left: Vec<i64> = backups::list(&dir).iter().map(|b| b.created_at / 1000).collect();
    assert_eq!(left, vec![OCT_12_2026_143005 + 5 * DAY, OCT_12_2026_143005 + 4 * DAY, OCT_12_2026_143005 + 3 * DAY]);
    for name in foreign {
        assert!(dir.join(name).exists(), "{name} must be left alone");
    }
    assert!(dir.join(backups::file_name(1)).is_dir());
    assert_eq!(backups::rotate(&dir, 3, now, None), 0);
    assert_eq!(backups::rotate(&dir, 0, now, None), 2, "at least one backup is always kept");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn rotation_never_deletes_the_new_backup_for_one_dated_in_the_future() {
    let dir = temp("rotate-future");
    let now = OCT_12_2026_143005;
    // Written while the clock was a year ahead, and while it was an hour ahead.
    let far = touch_backup(&dir, now + 365 * DAY);
    let near = touch_backup(&dir, now + 3600);
    let old = touch_backup(&dir, now - 2 * DAY);

    // Keep 2: the far-future one counts as the oldest, so it goes first.
    let written = touch_backup(&dir, now);
    assert_eq!(backups::rotate(&dir, 2, now, Some(&written)), 2);
    assert!(written.exists() && near.exists(), "the newest real backups stay");
    assert!(!far.exists() && !old.exists());

    // Keep 1: the one just written stays, even though the other is dated later.
    assert_eq!(backups::rotate(&dir, 1, now, Some(&written)), 1);
    assert!(written.exists() && !near.exists());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_launch_backup_survives_a_future_dated_one_with_keep_one() {
    let (dir, mut conn) = library("backup-future");
    tags::create_tag(&mut conn, "Serif", None).unwrap();
    let folder = dir.join("Backups");
    std::fs::create_dir_all(&folder).unwrap();
    let now = OCT_12_2026_143005;
    let future = touch_backup(&folder, now + 400 * DAY);
    let made = backups::at_launch(&conn, &folder, now, 1).unwrap().expect("a future-dated backup doesn't hold one back");
    assert!(Path::new(&made.path).exists(), "the backup it returns is there");
    assert!(!future.exists());
    assert_eq!(backups::list(&folder).len(), 1);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn backups_are_due_daily() {
    let dir = temp("due");
    let now = OCT_12_2026_143005;
    assert!(!backups::due(&dir, now, false), "no tags: nothing to back up");
    assert!(backups::due(&dir, now, true), "no backup yet");
    assert!(backups::due(&dir.join("missing"), now, true), "no folder yet");
    touch_backup(&dir, now - DAY + 60);
    assert!(!backups::due(&dir, now, true), "under a day old");
    assert!(backups::due(&dir, now + 60, true), "a day old");
    touch_backup(&dir, now + 30 * DAY);
    assert!(backups::due(&dir, now + 60, true), "a backup dated in the future doesn't hold new ones back");
    std::fs::remove_dir_all(&dir).ok();
}

fn library(name: &str) -> (PathBuf, rusqlite::Connection) {
    let dir = temp(name);
    let conn = db::open(&dir.join("library.sqlite3")).unwrap();
    tags::ensure_schema(&conn).unwrap();
    (dir, conn)
}

#[test]
fn launch_backup_skips_when_there_are_no_tags() {
    let (dir, conn) = library("backup-empty");
    let folder = dir.join("Backups");
    assert_eq!(backups::at_launch(&conn, &folder, OCT_12_2026_143005, 10).unwrap(), None);
    assert!(!folder.exists(), "nothing is written");
    let on_demand = backups::snapshot(&conn, OCT_12_2026_143005).expect_err("nothing to back up");
    assert_eq!(on_demand.to_string(), "There are no tags to back up yet");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn launch_backup_writes_a_tags_file_that_imports_back() {
    let (dir, mut conn) = library("backup-write");
    tags::create_tag(&mut conn, "Sci-Fi/Star Trek", None).unwrap();
    tags::create_tag(&mut conn, "Serif", Some("blue")).unwrap();
    let folder = dir.join("Backups");
    let now = OCT_12_2026_143005;

    let made = backups::at_launch(&conn, &folder, now, 2).unwrap().expect("first backup");
    assert_eq!(made.tags, 3, "Sci-Fi, Sci-Fi/Star Trek and Serif");
    assert_eq!(made.created_at, now * 1000);
    assert_eq!(made.path, folder.join("Tags 2026-10-12 14-30-05.json").to_string_lossy());
    let bytes = std::fs::read(&made.path).unwrap();
    assert_eq!(made.bytes, bytes.len() as u64);
    let source = tags::export::parse_json(&bytes).expect("the backup is a Fontface tags file");
    assert_eq!(source.tags.len(), 3);

    assert_eq!(backups::at_launch(&conn, &folder, now + 3600, 2).unwrap(), None, "one a day");
    assert!(backups::at_launch(&conn, &folder, now + DAY, 2).unwrap().is_some());
    assert!(backups::at_launch(&conn, &folder, now + 2 * DAY, 2).unwrap().is_some());
    let listed = backups::list(&folder);
    assert_eq!(listed.len(), 2, "the oldest beyond the number to keep is deleted");
    assert_eq!(listed[0].created_at, (now + 2 * DAY) * 1000, "newest first");
    assert!(listed.iter().all(|b| b.tags == 3));

    // On demand: even when one was written moments ago.
    let (contents, count) = backups::snapshot(&conn, now + 2 * DAY + 5).unwrap();
    let again = backups::write(&folder, now + 2 * DAY + 5, &contents, count, 2).unwrap();
    assert_eq!(backups::list(&folder)[0], again);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn listing_survives_unreadable_backups() {
    let dir = temp("backup-unreadable");
    std::fs::write(dir.join(backups::file_name(OCT_12_2026_143005)), "not json").unwrap();
    std::fs::write(dir.join(backups::file_name(OCT_12_2026_143005 - DAY)), r#"{"format":"other","tags":[1,2]}"#).unwrap();
    let listed = backups::list(&dir);
    assert_eq!(listed.len(), 2);
    assert!(listed.iter().all(|b| b.tags == 0));
    assert!(backups::list(&dir.join("missing")).is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

// ---------------------------------------------------------------------------------- window

#[test]
fn double_clicking_the_title_bar_follows_the_macos_setting() {
    // (AppleActionOnDoubleClick, AppleMiniaturizeOnDoubleClick) → what happens
    let cases = [
        (None, false, DoubleClick::Zoom), // never changed: macOS zooms
        (Some("Maximize"), false, DoubleClick::Zoom),
        (Some("Fill"), false, DoubleClick::Zoom),
        (Some("Minimize"), false, DoubleClick::Minimize),
        (Some("None"), false, DoubleClick::Nothing),
        (Some("none"), true, DoubleClick::Nothing), // the newer setting wins over the older one
        (None, true, DoubleClick::Minimize),         // older macOS: "minimize on double-click"
        (Some("SomethingNew"), false, DoubleClick::Zoom),
    ];
    for (action, miniaturize, want) in cases {
        assert_eq!(window::double_click_action(action, miniaturize), want, "{action:?} {miniaturize}");
    }
}

#[test]
fn the_window_background_matches_the_page_for_each_appearance() {
    assert_eq!(window::background(Theme::Light, true), [0xFF, 0xFF, 0xFF]);
    assert_eq!(window::background(Theme::Dark, false), [0x0A, 0x0A, 0x0A]);
    assert_eq!(window::background(Theme::System, true), window::DARK_BACKGROUND);
    assert_eq!(window::background(Theme::System, false), window::LIGHT_BACKGROUND);

    // The dark value is src/index.css's oklch(0.145 0 0): a grey, so linear sRGB is L³ on each
    // channel, then the sRGB transfer curve.
    let linear = 0.145f64.powi(3);
    let encoded = if linear <= 0.003_130_8 { 12.92 * linear } else { 1.055 * linear.powf(1.0 / 2.4) - 0.055 };
    assert_eq!((encoded * 255.0).round() as u8, window::DARK_BACKGROUND[0]);
    let css = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/index.css")).unwrap();
    assert!(css.contains("--background: oklch(1 0 0);"), "light background changed in index.css: update window.rs");
    assert!(css.contains("--background: oklch(0.145 0 0);"), "dark background changed in index.css: update window.rs");
}
