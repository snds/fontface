//! The listen-and-log test's pure parts: reading a request, its line in the log, the log's size
//! limit, who asked, and copying CoreText's values into JSON. The listener itself needs another
//! app to ask for a font, so it's tried by hand (docs/AUTO-ACTIVATION-TEST.md).

use std::collections::HashSet;
use std::ffi::OsStr;

use core_foundation::{
    array::CFArray,
    base::{CFType, TCFType},
    boolean::CFBoolean,
    data::CFData,
    dictionary::CFDictionary,
    number::CFNumber,
    string::CFString,
};
use serde_json::{json, Value};

use super::{
    append_line, asked, asker_from_executable, iso_ms, library_answer, listen, name_line, request_line, requested_fonts, setting_name, Asker, Bundle,
    Queued, RequestedFont, DISPLAY_KEY, FAMILY_KEY, POSTSCRIPT_KEY, STYLE_KEY,
};
use crate::{
    font_names::{FoundFace, How, LineMatch, NameIndex, NameLine},
    tags::{LibraryIndex, LibraryRow},
};

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("fontface-font-requests-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn only_a_clear_yes_starts_the_test() {
    for yes in ["1", "true", "YES", " 1 "] {
        assert!(asked(Some(OsStr::new(yes))), "{yes:?}");
    }
    for no in ["", "0", "false", "no", "2"] {
        assert!(!asked(Some(OsStr::new(no))), "{no:?}");
    }
    assert!(!asked(None));
}

#[test]
fn the_name_keys_are_coretexts_own() {
    let name = |key: core_foundation::string::CFStringRef| unsafe { CFString::wrap_under_get_rule(key) }.to_string();
    unsafe {
        assert_eq!(name(core_text::font_descriptor::kCTFontNameAttribute), POSTSCRIPT_KEY);
        assert_eq!(name(core_text::font_descriptor::kCTFontFamilyNameAttribute), FAMILY_KEY);
        assert_eq!(name(core_text::font_descriptor::kCTFontStyleNameAttribute), STYLE_KEY);
        assert_eq!(name(core_text::font_descriptor::kCTFontDisplayNameAttribute), DISPLAY_KEY);
    }
}

#[test]
fn a_request_names_its_fonts_at_any_depth_each_once() {
    let request = json!({
        "NSFontNameAttribute": "Inter-Bold",
        "NSFontFamilyAttribute": "Inter",
        "NSFontFaceAttribute": "Bold",
        "other": [
            { "NSFontVisibleNameAttribute": "Lora Italic" },
            { "NSFontNameAttribute": "Inter-Bold", "NSFontFamilyAttribute": "Inter", "NSFontFaceAttribute": "Bold" },
            { "NSFontNameAttribute": "  " },
            { "size": 12 }
        ]
    });
    assert_eq!(
        requested_fonts(&request),
        vec![
            RequestedFont { postscript_name: Some("Inter-Bold".into()), family: Some("Inter".into()), style: Some("Bold".into()), display_name: None },
            RequestedFont { display_name: Some("Lora Italic".into()), ..Default::default() },
        ]
    );
    // A bare name is a PostScript name.
    assert_eq!(requested_fonts(&json!("Helvetica-Light")), vec![RequestedFont { postscript_name: Some("Helvetica-Light".into()), ..Default::default() }]);
    assert!(requested_fonts(&json!({ "size": 12 })).is_empty());
    assert!(requested_fonts(&Value::Null).is_empty());
}

#[test]
fn the_matcher_gets_the_postscript_name_family_and_style_or_else_the_shown_name() {
    let full = RequestedFont { postscript_name: Some("Inter-Bold".into()), family: Some("Inter".into()), style: Some("Bold".into()), display_name: Some("Inter Bold".into()) };
    assert_eq!(
        name_line(&full),
        NameLine::Font { postscript_name: Some("Inter-Bold".into()), family: Some("Inter".into()), style: Some("Bold".into()) }
    );
    let shown = RequestedFont { display_name: Some("Lora Italic".into()), ..Default::default() };
    assert_eq!(name_line(&shown), NameLine::Text("Lora Italic".into()));
}

fn row(id: i64, path: &str, ps: &str, family: &str, style: &str, installed: bool) -> LibraryRow {
    LibraryRow { id, path: path.into(), postscript_name: Some(ps.into()), family: family.into(), style: style.into(), installed, ..Default::default() }
}

#[test]
fn has_a_match_comes_from_the_shared_matcher_with_whats_on_now() {
    let mut lib = LibraryIndex::default();
    lib.add(row(1, "/f/Inter-Bold.otf", "Inter-Bold", "Inter", "Bold", false));
    lib.add(row(2, "/f/Inter-Regular.otf", "Inter-Regular", "Inter", "Regular", false));
    lib.add(row(3, "/Library/Fonts/Lora.ttf", "Lora-Regular", "Lora", "Regular", true));
    let index = NameIndex::new(lib);
    let wanted = [
        RequestedFont { postscript_name: Some("Inter-Bold".into()), ..Default::default() },
        RequestedFont { family: Some("Inter".into()), ..Default::default() },
        RequestedFont { display_name: Some("Lora".into()), ..Default::default() },
        RequestedFont { postscript_name: Some("Intr-Bold".into()), ..Default::default() },
    ];
    let lines: Vec<NameLine> = wanted.iter().map(name_line).collect();
    let on: HashSet<i64> = [2].into();
    let answers: Vec<_> = index.match_lines(&lines, |_| false).into_iter().map(|m| library_answer(m, &on)).collect();

    assert!(answers[0].has_match);
    assert_eq!(answers[0].how, Some(How::PostScript));
    assert_eq!((answers[0].styles, answers[0].on), (1, 0), "found, but off");
    assert_eq!(answers[0].names, vec!["Inter Bold (Inter-Bold)"]);
    assert_eq!((answers[1].how, answers[1].styles, answers[1].on), (Some(How::Family), 2, 1));
    assert_eq!(answers[2].on, 1, "a macOS Fonts style is always on");
    assert!(!answers[3].has_match);
    assert_eq!(answers[3].near, vec!["Inter"]);
}

#[test]
fn an_answer_counts_online_only_styles() {
    let face = |ps: &str, online_only: bool| FoundFace {
        key: format!("ps:{ps}|static|r"),
        family: "Mono".into(),
        style: ps.into(),
        postscript_name: None,
        ids: vec![9],
        variable: false,
        italic: false,
        installed: false,
        online_only,
    };
    let m = LineMatch { how: Some(How::Family), faces: vec![face("A", true), face("B", false)], near: vec![] };
    let a = library_answer(m, &HashSet::new());
    assert_eq!((a.styles, a.online_only, a.on), (2, 1, 0));
    assert_eq!(a.names, vec!["Mono A", "Mono B"]);
}

#[test]
fn times_are_utc_with_milliseconds() {
    assert_eq!(iso_ms(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_ms(1_792_434_605_123), "2026-10-19T18:30:05.123Z");
}

#[test]
fn settings_have_names() {
    assert_eq!(setting_name(0), "default");
    assert_eq!(setting_name(1), "disabled");
    assert_eq!(setting_name(2), "enabled");
    assert_eq!(setting_name(3), "prompt-user");
    assert_eq!(setting_name(9), "unknown");
}

#[test]
fn a_request_is_one_line_of_json_with_who_asked_what_was_found_and_the_answer() {
    let q = Queued { at_ms: 1_792_434_605_123, pid: 4242, request: json!({ "NSFontNameAttribute": "Inter-Bold\nnext line" }) };
    let asker = Asker {
        executable: Some("/Applications/Pages.app/Contents/MacOS/Pages".into()),
        app: Some(Bundle { name: "Pages".into(), bundle_id: Some("com.example.pages".into()), path: "/Applications/Pages.app".into() }),
        process: None,
    };
    let font = RequestedFont { postscript_name: Some("Inter-Bold\nnext line".into()), ..Default::default() };
    let line = request_line(&q, &asker, Some("default"), vec![(font.clone(), None)], Some("the library isn't open yet".into()), 3);
    assert!(!line.contains('\n'), "one line, whatever the request holds");
    let v: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["event"], "request");
    assert_eq!(v["time"], "2026-10-19T18:30:05.123Z");
    assert_eq!(v["pid"], 4242);
    assert_eq!(v["asker"]["app"]["bundleId"], "com.example.pages");
    assert_eq!(v["asker"]["executable"], "/Applications/Pages.app/Contents/MacOS/Pages");
    assert!(v["asker"].get("process").is_none());
    assert_eq!(v["autoActivation"], "default");
    assert_eq!(v["fonts"][0]["postscriptName"], "Inter-Bold\nnext line");
    assert!(v["fonts"][0].get("library").is_none());
    assert_eq!(v["libraryError"], "the library isn't open yet");
    assert_eq!(v["request"]["NSFontNameAttribute"], "Inter-Bold\nnext line");
    assert_eq!(v["answer"], "no fonts (listen and log only)");
    assert_eq!(v["dropped"], 3);

    // With the library's answer, and nothing dropped.
    let m = LineMatch { how: None, faces: vec![], near: vec!["Inter".into()] };
    let line = request_line(&q, &Asker::default(), None, vec![(font, Some(library_answer(m, &HashSet::new())))], None, 0);
    let v: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["fonts"][0]["library"]["hasMatch"], false);
    assert_eq!(v["fonts"][0]["library"]["near"][0], "Inter");
    assert!(v.get("dropped").is_none() && v.get("libraryError").is_none());
    assert_eq!(v["autoActivation"], Value::Null);
}

#[test]
fn the_log_starts_again_past_its_size_and_keeps_the_one_before() {
    let dir = temp_dir("rotate");
    let (log, old) = (dir.join("Logs/font-requests.jsonl"), dir.join("Logs/font-requests.1.jsonl"));
    append_line(&log, &old, "one", 12).unwrap(); // 4 bytes
    append_line(&log, &old, "two", 12).unwrap(); // 8
    assert_eq!(std::fs::read_to_string(&log).unwrap(), "one\ntwo\n");
    assert!(!old.exists());
    append_line(&log, &old, "three", 12).unwrap(); // would be 14: starts again
    assert_eq!(std::fs::read_to_string(&log).unwrap(), "three\n");
    assert_eq!(std::fs::read_to_string(&old).unwrap(), "one\ntwo\n");
    append_line(&log, &old, "four", 12).unwrap();
    append_line(&log, &old, "five", 12).unwrap();
    assert_eq!(std::fs::read_to_string(&log).unwrap(), "five\n");
    assert_eq!(std::fs::read_to_string(&old).unwrap(), "three\nfour\n", "only the one before is kept");
    // A line longer than the limit still goes in, on its own.
    append_line(&log, &old, "a much longer line", 12).unwrap();
    assert_eq!(std::fs::read_to_string(&log).unwrap(), "a much longer line\n");
    let _ = std::fs::remove_dir_all(&dir);
}

fn write_bundle(dir: &std::path::Path, id: &str, name: Option<&str>) {
    std::fs::create_dir_all(dir.join("Contents/MacOS")).unwrap();
    let mut info = plist::Dictionary::new();
    info.insert("CFBundleIdentifier".into(), plist::Value::String(id.into()));
    if let Some(name) = name {
        info.insert("CFBundleName".into(), plist::Value::String(name.into()));
    }
    plist::Value::Dictionary(info).to_file_xml(dir.join("Contents/Info.plist")).unwrap();
}

#[test]
fn the_asker_is_the_outer_app_and_its_helper_when_a_helper_asked() {
    let dir = temp_dir("asker");
    let app = dir.join("Design Tool.app");
    let helper = app.join("Contents/Frameworks/Design Tool Helper (Renderer).app");
    write_bundle(&app, "com.example.design", Some("Design Tool"));
    write_bundle(&helper, "com.example.design.helper.renderer", None);

    let main = asker_from_executable(&app.join("Contents/MacOS/Design Tool"));
    assert_eq!(main.app.as_ref().map(|b| (b.name.as_str(), b.bundle_id.as_deref())), Some(("Design Tool", Some("com.example.design"))));
    assert!(main.process.is_none(), "the app itself asked");

    let renderer = asker_from_executable(&helper.join("Contents/MacOS/Design Tool Helper (Renderer)"));
    assert_eq!(renderer.app.as_ref().and_then(|b| b.bundle_id.as_deref()), Some("com.example.design"));
    let own = renderer.process.unwrap();
    // No name in its Info.plist: its folder's.
    assert_eq!((own.name.as_str(), own.bundle_id.as_deref()), ("Design Tool Helper (Renderer)", Some("com.example.design.helper.renderer")));

    // A program outside any bundle; and an XPC service outside any app.
    let tool = asker_from_executable(std::path::Path::new("/usr/bin/some-tool"));
    assert!(tool.app.is_none() && tool.process.is_none());
    assert_eq!(tool.executable.as_deref(), Some("/usr/bin/some-tool"));
    let xpc = asker_from_executable(&dir.join("Service.xpc/Contents/MacOS/Service"));
    assert!(xpc.app.is_none());
    assert_eq!(xpc.process.map(|b| b.name), Some("Service".into()));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_real_app_on_this_mac_names_itself() {
    // TextEdit is part of macOS; read only.
    let textedit = std::path::Path::new("/System/Applications/TextEdit.app");
    if !textedit.exists() {
        return;
    }
    let asker = asker_from_executable(&textedit.join("Contents/MacOS/TextEdit"));
    assert_eq!(asker.app.and_then(|b| b.bundle_id), Some("com.apple.TextEdit".into()));
}

#[test]
fn coretext_values_become_json() {
    let font_dict = CFDictionary::from_CFType_pairs(&[
        (CFString::new("NSFontNameAttribute").as_CFType(), CFString::new("Inter-Bold").as_CFType()),
        (CFString::new("NSFontSizeAttribute").as_CFType(), CFNumber::from(12.5f64).as_CFType()),
    ]);
    let list = CFArray::from_CFTypes(&[CFNumber::from(3i32).as_CFType(), CFBoolean::true_value().as_CFType(), CFData::from_buffer(&[1, 2, 3]).as_CFType()]);
    let request: CFDictionary<CFType, CFType> = CFDictionary::from_CFType_pairs(&[
        (CFString::new("font").as_CFType(), font_dict.as_CFType()),
        (CFString::new("list").as_CFType(), list.as_CFType()),
        (CFString::new("long").as_CFType(), CFString::new(&"x".repeat(1500)).as_CFType()),
    ]);
    let v = unsafe { listen::to_json(request.as_CFTypeRef(), 0) };
    assert_eq!(v["font"]["NSFontNameAttribute"], "Inter-Bold");
    assert_eq!(v["font"]["NSFontSizeAttribute"], 12.5);
    assert_eq!(v["list"], json!([3, true, "<3 bytes>"]));
    let long = v["long"].as_str().unwrap();
    assert_eq!(long.chars().count(), 1001, "cut to 1,000 characters and an ellipsis");
    assert_eq!(requested_fonts(&v), vec![RequestedFont { postscript_name: Some("Inter-Bold".into()), ..Default::default() }]);
    assert_eq!(unsafe { listen::to_json(std::ptr::null(), 0) }, Value::Null);
}

#[test]
fn a_font_descriptor_becomes_its_attributes() {
    let descriptor = core_text::font_descriptor::new_from_postscript_name(&CFString::new("Helvetica"));
    let v = unsafe { listen::to_json(descriptor.as_CFTypeRef(), 0) };
    assert_eq!(v[POSTSCRIPT_KEY], "Helvetica");
}

#[test]
fn reading_auto_activation_settings_works_on_this_mac() {
    // Read only. Present on every macOS Fontface supports; the test only checks it answers.
    let global = listen::auto_activation_setting(None);
    assert!(global.is_some_and(|s| s <= 3), "{global:?}");
    assert!(listen::auto_activation_setting(Some("com.example.not-an-app")).is_some());
}

#[test]
fn this_macos_still_has_the_listener_call() {
    // Only looks the name up: nothing listens. If Apple removes the call, the test can't run.
    assert!(listen::symbol(c"CTFontManagerCreateFontRequestRunLoopSource").is_some());
    assert!(listen::symbol(c"kCTFontManagerBundleIdentifier").is_some());
    assert!(listen::symbol(c"NoSuchFunctionInCoreText").is_none());
}
