//! Online previews, against `fake_net` (no network), plus one live test that's ignored by default.

use std::path::{Path, PathBuf};

use super::*;
use crate::{
    services::{
        fake_net::{self, Failure},
        google::{save_catalog_for_tests, CatalogFamily},
    },
    test_fonts::{FontBuilder, Shape},
};

/// A test's folders: a data folder with a saved catalog, and the cache. Removed afterwards.
struct Setup {
    dir: PathBuf,
    previews: Previews,
}

impl Drop for Setup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Setup {
    fn new(name: &str, families: Vec<CatalogFamily>) -> Setup {
        let dir = std::env::temp_dir().join(format!("fontface-previews-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        save_catalog_for_tests(&dir.join("data"), families);
        let previews = Previews::new(dir.join("cache").join(DIR_NAME), dir.join("data"));
        Setup { dir, previews }
    }

    fn data(&self) -> PathBuf {
        self.dir.join("data")
    }

    /// Saves a new catalog. Its size changes with the families, so the cache notices.
    fn catalog(&self, families: Vec<CatalogFamily>) {
        save_catalog_for_tests(&self.data(), families);
    }

    fn row(&self, id: &str) -> GooglePreview {
        self.previews.preview(id, Ask::Row, &on).unwrap()
    }

    fn alphabet(&self, id: &str) -> GooglePreview {
        self.previews.preview(id, Ask::Alphabet, &on).unwrap()
    }

    /// Every file in the cache, relative to it, sorted.
    fn files(&self) -> Vec<String> {
        let mut files: Vec<String> = files_under(self.previews.root())
            .into_iter()
            .map(|(p, _)| p.strip_prefix(self.previews.root()).unwrap().to_string_lossy().into_owned())
            .collect();
        files.sort();
        files
    }
}

fn on() -> bool {
    true
}

fn off() -> bool {
    false
}

fn family(id: &str, name: &str, subsets: &[&str]) -> CatalogFamily {
    CatalogFamily {
        id: id.into(),
        family: name.into(),
        category: "sans-serif".into(),
        variable: false,
        weights: vec![400],
        styles: vec!["normal".into()],
        subsets: subsets.iter().map(|s| s.to_string()).collect(),
        def_subset: subsets.first().map(|s| s.to_string()).unwrap_or_default(),
        license: "OFL-1.1".into(),
        last_modified: "2026-01-01".into(),
    }
}

fn inter() -> CatalogFamily {
    family("inter", "Inter", &["latin", "latin-ext"])
}

/// A font that draws `chars` (space draws nothing, as in real fonts).
fn font(name: &str, chars: &str) -> Vec<u8> {
    let mut b = FontBuilder::new().named(name);
    for c in chars.chars() {
        b.char(c as u32, (c == ' ').then_some(Shape::Empty));
    }
    b.build()
}

fn kit(name: &str) -> String {
    format!("https://fonts.gstatic.com/l/font?kit={name}&skey=abc&v=v1")
}

/// Google's CSS answer pointing at `url`, with the extra rules it sometimes adds.
fn css(url: &str) -> Vec<u8> {
    format!(
        "@font-face {{\n  font-family: 'X';\n  font-style: normal;\n  font-weight: 400;\n  src: url({url}) format('truetype');\n}}\n\
         .material-icons {{\n  font-family: 'X';\n}}\nbody {{\n  --google-font-color-x:none;\n}}\n"
    )
    .into_bytes()
}

/// The two answers for one file: the CSS for `held`, and the font it points to.
fn file(f: &CatalogFamily, held: &str, kit_name: &str, bytes: Vec<u8>) -> Vec<(String, Vec<u8>, Option<&'static str>)> {
    vec![(css_url(f, held), css(&kit(kit_name)), None), (kit(kit_name), bytes, None)]
}

fn urls() -> Vec<String> {
    fake_net::take_requests().into_iter().map(|(u, _)| u).collect()
}

// ------------------------------------------------------------------------------- the requests

#[test]
fn reads_the_one_gstatic_url_and_refuses_any_other() {
    let url = kit("abc");
    assert_eq!(font_url(&String::from_utf8(css(&url)).unwrap()), Some(url.clone()));
    assert_eq!(font_url(&format!("src: url('{url}') format('truetype');")), Some(url.clone()), "quotes are fine");
    assert_eq!(font_url(&format!("src: url(\"{url}\");")), Some(url.clone()));
    // Two font-faces (not what text= gives, but harmless): the first.
    assert_eq!(font_url(&format!("src: url({url});\nsrc: url({});", kit("other"))), Some(url.clone()));
    for bad in [
        "src: url(http://fonts.gstatic.com/l/font?kit=a);",
        "src: url(https://fonts.gstatic.com.evil.test/l/font?kit=a);",
        "src: url(https://evil.test/https://fonts.gstatic.com/a);",
        "src: url(//fonts.gstatic.com/l/font?kit=a);",
        "src: url(file:///etc/passwd);",
        "src: url(https://fonts.gstatic.com/a b);",
    ] {
        assert_eq!(font_url(bad), None, "{bad}");
    }
    // A good URL with a bad one beside it: the whole answer is refused.
    assert_eq!(font_url(&format!("src: url({url});\nsrc: url(https://evil.test/x.ttf);")), None);
    assert_eq!(font_url("<!DOCTYPE html><title>400: Font family not found</title>"), None);
    assert_eq!(font_url("src: url(https://fonts.gstatic.com/a"), None, "unclosed");
}

#[test]
fn builds_requests_for_names_styles_icons_and_scripts() {
    // The name in its own letters, capitals and lowercase, each once.
    assert_eq!(name_text("Inter"), "InterNTERi");
    assert_eq!(name_text("Noto Sans JP"), "Not SansJPOTAjp");
    assert_eq!(
        css_url(&inter(), &name_text("Inter")),
        "https://fonts.googleapis.com/css2?family=Inter&text=InterNTERi"
    );
    assert_eq!(
        css_url(&family("noto-sans-jp", "Noto Sans JP", &["latin"]), "No"),
        "https://fonts.googleapis.com/css2?family=Noto+Sans+JP&text=No"
    );
    // Spaces, '&', '+' and non-ASCII are encoded in the text.
    assert_eq!(encode("a b&c+é"), "a%20b%26c%2B%C3%A9");

    // No regular style: the nearest weight (as CSS would pick for 400), italic for italic-only.
    let styled = |weights: &[u16], styles: &[&str]| CatalogFamily {
        weights: weights.to_vec(),
        styles: styles.iter().map(|s| s.to_string()).collect(),
        ..family("x", "Buda", &["latin"])
    };
    assert_eq!(family_param(&styled(&[300], &["normal"])), "Buda:wght@300");
    assert_eq!(family_param(&styled(&[800], &["normal"])), "Buda:wght@800");
    assert_eq!(family_param(&styled(&[300, 500, 700], &["normal"])), "Buda:wght@500", "Sunflower: 500 before 300");
    assert_eq!(family_param(&styled(&[100, 200], &["normal"])), "Buda:wght@200");
    assert_eq!(family_param(&styled(&[600, 900], &["normal"])), "Buda:wght@600");
    assert_eq!(family_param(&styled(&[100, 400, 900], &["normal", "italic"])), "Buda");
    assert_eq!(family_param(&styled(&[], &[])), "Buda", "nothing listed: Google's default");
    assert_eq!(family_param(&styled(&[400], &["italic"])), "Buda:ital@1", "Molle");
    assert_eq!(family_param(&styled(&[300], &["italic"])), "Buda:ital,wght@1,300");

    // Icon families: five icons by their private-use code points, whatever is typed.
    let icons = CatalogFamily { category: "icons".into(), ..family("material-icons", "Material Icons", &["latin"]) };
    for ask in [Ask::Row, Ask::Alphabet] {
        assert_eq!(plan(&icons, ask), vec![(FileKind::Icons, ICON_PREVIEW.to_string())]);
    }
    assert_eq!(
        css_url(&icons, ICON_PREVIEW),
        "https://fonts.googleapis.com/css2?family=Material+Icons&text=%EE%A2%8A%20%EE%A2%B6%20%EE%A2%B8%20%EE%A1%BD%20%EE%A0%B8"
    );

    // Typed text: the alphabet, never the text itself.
    let alphabet = alphabet_text();
    assert_eq!(alphabet.chars().count(), 95 + 96);
    assert!(alphabet.starts_with(" !\"#") && alphabet.contains('~') && alphabet.contains('é') && alphabet.ends_with('ÿ'));
    assert!(!alphabet.contains('\u{7F}') && !alphabet.contains('\u{9F}'));
    assert_eq!(plan(&inter(), Ask::Alphabet), vec![(FileKind::Alphabet, alphabet)]);

    // Rows: the name, then a script sample if the family has a script; no Latin: the script only.
    assert_eq!(plan(&inter(), Ask::Row), vec![(FileKind::Name, name_text("Inter"))], "Latin only: the name, nothing to fall back to");
    let jp = family("noto-sans-jp", "Noto Sans JP", &["japanese", "latin"]);
    let jp_plan = plan(&jp, Ask::Row);
    assert_eq!(jp_plan.len(), 2);
    assert_eq!(jp_plan[0].0, FileKind::Name);
    assert_eq!(jp_plan[1], (FileKind::Script, "あいうえおかきくけこアイウエオカキクケコ日本語".to_string()));
    let khmer = family("khmer", "Khmer", &["khmer"]);
    let khmer_plan = plan(&khmer, Ask::Row);
    assert_eq!(khmer_plan.len(), 1);
    assert_eq!(khmer_plan[0].0, FileKind::Script);
    assert!(khmer_plan[0].1.starts_with("កខគឃង"), "{}", khmer_plan[0].1);
    assert_eq!(khmer_plan[0].1.chars().count(), SCRIPT_SAMPLE);
    // A catalog saved before defSubset was kept: the subsets decide.
    let older = CatalogFamily { def_subset: String::new(), ..family("noto-sans-lycian", "Noto Sans Lycian", &["lycian"]) };
    let lycian = plan(&older, Ask::Row);
    assert_eq!(lycian[0].0, FileKind::Script);
    assert!(lycian[0].1.chars().all(|c| (0x10280..=0x1029F).contains(&(c as u32))), "{}", lycian[0].1);
    assert!(css_url(&older, &lycian[0].1).contains("text=%F0%90%8A%80"), "astral characters are encoded as UTF-8");
}

/// Every subset Fontsource listed for Google Fonts (2026-10-18) has a script sample, except
/// Latin ones and scripts newer than this build's Unicode tables.
#[test]
fn every_listed_script_subset_has_a_sample() {
    const SUBSETS: &[&str] = &[
        "cyrillic", "cyrillic-ext", "greek", "math", "greek-ext", "symbols", "japanese", "devanagari", "hebrew", "arabic",
        "korean", "thai", "khmer", "telugu", "symbols2", "tamil", "chinese-traditional", "gujarati", "bengali", "kannada",
        "gurmukhi", "chinese-simplified", "malayalam", "sinhala", "emoji", "ethiopic", "canadian-aboriginal", "syriac",
        "oriya", "braille", "armenian", "cherokee", "lao", "adlam", "tifinagh", "lisu", "runic", "chinese-hongkong",
        "georgian", "nushu", "tibetan", "kayah-li", "myanmar", "gothic", "old-italic", "new-tai-lue", "old-permic",
        "lepcha", "limbu", "gunjala-gondi", "balinese", "glagolitic", "grantha", "khojki", "mayan-numerals", "nko",
        "phags-pa", "phoenician", "tai-viet", "vithkuqi", "yi", "kirat-rai", "music", "anatolian-hieroglyphs", "avestan",
        "bamum", "bassa-vah", "batak", "bhaiksuki", "brahmi", "buginese", "buhid", "carian", "caucasian-albanian",
        "chakma", "cham", "chorasmian", "coptic", "cuneiform", "cypriot", "cypro-minoan", "deseret", "duployan",
        "egyptian-hieroglyphs", "elbasan", "elymaic", "hanifi-rohingya", "hanunoo", "hatran", "imperial-aramaic",
        "indic-siyaq-numbers", "inscriptional-pahlavi", "inscriptional-parthian", "javanese", "kaithi", "kawi",
        "kharoshthi", "khudawadi", "linear-a", "linear-b", "lycian", "lydian", "mahajani", "mandaic", "manichaean",
        "marchen", "masaram-gondi", "medefaidrin", "meetei-mayek", "mende-kikakui", "meroitic", "meroitic-cursive",
        "meroitic-hieroglyphs", "miao", "modi", "mongolian", "mro", "multani", "nabataean", "nag-mundari", "nandinagari",
        "newa", "ogham", "ol-chiki", "old-hungarian", "old-north-arabian", "old-persian", "old-sogdian",
        "old-south-arabian", "old-turkic", "osage", "osmanya", "pahawh-hmong", "palmyrene", "pau-cin-hau",
        "psalter-pahlavi", "rejang", "samaritan", "saurashtra", "sharada", "shavian", "siddham", "signwriting", "sogdian",
        "sora-sompeng", "soyombo", "sundanese", "sunuwar", "syloti-nagri", "tagalog", "tagbanwa", "tai-le", "tai-tham",
        "takri", "tamil-supplement", "tangsa", "thaana", "tirhuta", "ugaritic", "vai", "wancho", "warang-citi",
        "zanabazar-square", "ahom", "dives-akuru", "dogra", "kana-extended", "khitan-small-script", "makasar",
        "nyiakeng-puachue-hmong", "old-uyghur", "ottoman-siyaq-numbers", "tangut", "todhri", "toto", "yezidi", "znamenny",
    ];
    // Unicode 17 (beria-erfe) is newer than the block tables.
    let mut missing: Vec<&str> = SUBSETS.iter().copied().filter(|s| script_text(s).is_none()).collect();
    missing.sort();
    assert!(missing.is_empty(), "no sample for {missing:?}");
    for latin in ["latin", "latin-ext", "vietnamese", ""] {
        assert!(script_text(latin).is_none(), "{latin}");
    }
    assert_eq!(script_text("beria-erfe"), None);
    for subset in SUBSETS {
        let text = script_text(subset).unwrap();
        let n = text.chars().count();
        assert!((5..=SCRIPT_SAMPLE).contains(&n), "{subset}: {n} characters");
        assert!(text.chars().all(|c| !profile::skipped(c as u32)), "{subset}: no marks or spaces");
    }
    // A big block is spread across, not just its start.
    let yi = script_text("yi").unwrap();
    assert!(yi.chars().last().unwrap() as u32 > 0xA400, "{yi}");
}

// ------------------------------------------------------------------------------------ previews

#[test]
fn a_row_downloads_its_name_once_and_keeps_it() {
    let s = Setup::new("name", vec![inter()]);
    let held = name_text("Inter");
    let _net = fake_net::serve(file(&inter(), &held, "inter", font("Inter", &held)));
    let answer = s.row("inter");
    assert_eq!(answer.state, PreviewState::Ready);
    assert_eq!(answer.path.as_deref(), Some("google/inter/2026-01-01/name"));
    assert_eq!(answer.text.as_deref(), Some("Inter"));
    assert_eq!(answer.sample, Some(false));
    let profile = answer.profile.clone().unwrap();
    assert_eq!(profile.kind, "name");
    assert!(profile.ascii_missing.is_empty(), "a name file's missing characters mean nothing");
    assert_eq!(urls(), vec![css_url(&inter(), &held), kit("inter")]);

    // Laid out as <id>/<token>/<kind>.ttf with its details, nothing else (no temporary files).
    assert_eq!(s.files(), vec!["inter/2026-01-01/name.json", "inter/2026-01-01/name.ttf"]);
    let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(s.previews.root().join("inter/2026-01-01/name.json")).unwrap()).unwrap();
    assert_eq!(saved["held"], held.as_str());
    assert_eq!(saved["text"], "Inter");
    assert_eq!(saved["profile"]["kind"], "name");
    assert!(saved.get("css").is_none() && !String::from_utf8_lossy(&std::fs::read(s.previews.root().join("inter/2026-01-01/name.json")).unwrap()).contains("gstatic"), "the CSS isn't kept");

    // Asked again: from the cache, no request.
    assert_eq!(s.row("inter"), answer);
    assert!(urls().is_empty());

    // The web view gets the saved bytes through ff://, by that path.
    let bytes = s.previews.serve("inter/2026-01-01/name").unwrap();
    assert_eq!(bytes, font("Inter", &held));
    assert!(urls().is_empty(), "serving never uses the network");
    // The JSON answer, as the UI reads it.
    let json = serde_json::to_value(&answer).unwrap();
    assert_eq!(json["state"], "ready");
    assert_eq!(json["path"], "google/inter/2026-01-01/name");
    assert_eq!(json["sample"], false);
    assert_eq!(json["profile"]["kind"], "name");
    assert_eq!(serde_json::to_value(GooglePreview::not(PreviewState::TooLarge)).unwrap(), serde_json::json!({ "state": "tooLarge" }));
}

#[test]
fn a_capitals_only_font_shows_its_name_in_capitals() {
    let s = Setup::new("caps", vec![inter()]);
    let held = name_text("Inter");
    let _net = fake_net::serve(file(&inter(), &held, "caps", font("Inter", "INTER")));
    let answer = s.row("inter");
    assert_eq!(answer.state, PreviewState::Ready);
    assert_eq!(answer.text.as_deref(), Some("INTER"));
    let profile = answer.profile.unwrap();
    assert_eq!(profile.kind, "case");
    // The lowercase it was asked for and lacks, so the UI never lowercases the name into
    // letters this file can't draw. Nothing it wasn't asked for.
    assert_eq!(profile.ascii_missing, "einrt");
    assert_eq!(answer.sample, Some(false), "like the library, a case change isn't a sample");
}

#[test]
fn a_name_that_cant_be_drawn_falls_back_to_a_script_sample() {
    // Lists Latin, but the font has none: Google answers with a space only.
    let f = family("noto-sans-khmer", "Noto Sans Khmer", &["khmer", "latin"]);
    let s = Setup::new("cant-draw", vec![f.clone()]);
    let held = name_text(&f.family);
    let script = script_text("khmer").unwrap();
    let mut routes = file(&f, &held, "space", font("Noto Sans Khmer", " "));
    routes.extend(file(&f, &script, "khmer", font("Noto Sans Khmer", &script)));
    let _net = fake_net::serve(routes);
    let answer = s.row("noto-sans-khmer");
    assert_eq!(answer.state, PreviewState::Ready);
    assert_eq!(answer.path.as_deref(), Some("google/noto-sans-khmer/2026-01-01/script"));
    assert_eq!(answer.sample, Some(true));
    let profile = answer.profile.clone().unwrap();
    assert_eq!(profile.kind, "script");
    assert_eq!(profile.label.as_deref(), Some("Khmer"));
    let text = answer.text.clone().unwrap();
    assert!(!text.is_empty() && text.chars().all(|c| script.contains(c)), "{text}");
    assert_eq!(urls(), vec![css_url(&f, &held), kit("space"), css_url(&f, &script), kit("khmer")]);
    // Remembered: the name isn't asked for again, the sample comes from the cache.
    assert_eq!(s.row("noto-sans-khmer"), answer);
    assert!(urls().is_empty());
    assert!(s.files().contains(&"noto-sans-khmer/2026-01-01/name.fail".to_string()), "{:?}", s.files());
}

#[test]
fn a_family_without_latin_goes_straight_to_its_script() {
    let f = family("noto-sans-lycian", "Noto Sans Lycian", &["lycian"]);
    let s = Setup::new("no-latin", vec![f.clone()]);
    let script = script_text("lycian").unwrap();
    let _net = fake_net::serve(file(&f, &script, "lycian", font("Noto Sans Lycian", &script)));
    let answer = s.row("noto-sans-lycian");
    assert_eq!(answer.state, PreviewState::Ready);
    assert_eq!(answer.profile.unwrap().label.as_deref(), Some("Lycian"));
    assert_eq!(urls(), vec![css_url(&f, &script), kit("lycian")], "the name is never asked for");
}

#[test]
fn nothing_drawable_at_all_is_unavailable_and_remembered() {
    let f = family("noto-sans-lycian", "Noto Sans Lycian", &["lycian"]);
    let s = Setup::new("nothing", vec![f.clone()]);
    let script = script_text("lycian").unwrap();
    let _net = fake_net::serve(file(&f, &script, "space", font("Noto Sans Lycian", " ")));
    assert_eq!(s.row("noto-sans-lycian").state, PreviewState::Unavailable);
    assert_eq!(urls().len(), 2);
    assert_eq!(s.row("noto-sans-lycian").state, PreviewState::Unavailable);
    assert!(urls().is_empty(), "remembered");
}

#[test]
fn icon_families_show_their_icons_typed_text_or_not() {
    let f = CatalogFamily { category: "icons".into(), ..family("material-icons", "Material Icons", &["latin"]) };
    let s = Setup::new("icons", vec![f.clone()]);
    let _net = fake_net::serve(file(&f, ICON_PREVIEW, "icons", font("Material Icons", ICON_PREVIEW)));
    let row = s.row("material-icons");
    assert_eq!(row.state, PreviewState::Ready);
    assert_eq!(row.path.as_deref(), Some("google/material-icons/2026-01-01/icons"));
    assert_eq!(row.text.as_deref(), Some(ICON_PREVIEW));
    assert_eq!(row.sample, Some(true));
    let profile = row.profile.clone().unwrap();
    assert_eq!(profile.kind, "symbols");
    assert_eq!(profile.family_text.as_deref(), Some(ICON_PREVIEW), "the profile describes the text drawn");
    // Typed text: the same icons file, no second download.
    assert_eq!(s.alphabet("material-icons"), row);
    assert_eq!(urls().len(), 2);
}

#[test]
fn typed_text_uses_the_alphabet_file() {
    let s = Setup::new("alphabet", vec![inter()]);
    let alphabet = alphabet_text();
    // The font lacks '@' and 'é'.
    let has: String = alphabet.chars().filter(|c| *c != '@' && *c != 'é').collect();
    let _net = fake_net::serve(file(&inter(), &alphabet, "alpha", font("Inter", &has)));
    let answer = s.alphabet("inter");
    assert_eq!(answer.state, PreviewState::Ready);
    assert_eq!(answer.path.as_deref(), Some("google/inter/2026-01-01/alphabet"));
    assert_eq!(answer.text.as_deref(), Some(alphabet.as_str()), "the characters the file holds");
    assert_eq!(answer.sample, Some(false));
    assert_eq!(answer.profile.unwrap().ascii_missing, "@");
    let asked = urls();
    assert_eq!(asked.len(), 2);
    assert!(asked[0].contains("&text=%20%21%22%23"), "{}", asked[0]);
}

#[test]
fn a_file_over_the_limit_is_too_large_and_remembered() {
    let f = family("noto-color-emoji", "Noto Color Emoji", &["emoji"]);
    let s = Setup::new("too-large", vec![f.clone()]);
    let script = script_text("emoji").unwrap();
    let _net = fake_net::serve(file(&f, &script, "emoji", vec![0; MAX_FILE_BYTES as usize + 1]));
    assert_eq!(s.row("noto-color-emoji").state, PreviewState::TooLarge);
    assert_eq!(urls().len(), 2);
    assert_eq!(s.row("noto-color-emoji").state, PreviewState::TooLarge);
    assert!(urls().is_empty(), "not downloaded again");
    assert_eq!(s.files(), vec!["noto-color-emoji/2026-01-01/script.fail"], "nothing kept but the note");
    // Exactly at the limit is fine (if it's a font).
    let mut at_limit = font("Inter", &name_text("Inter"));
    at_limit.resize(MAX_FILE_BYTES as usize, 0);
    let s2 = Setup::new("at-limit", vec![inter()]);
    let _net = fake_net::serve(file(&inter(), &name_text("Inter"), "inter", at_limit));
    assert_eq!(s2.row("inter").state, PreviewState::Ready);
}

#[test]
fn a_broken_file_or_a_refused_family_is_unavailable_and_retried_after_a_week() {
    let buda = CatalogFamily { weights: vec![300], ..family("buda", "Buda", &["latin"]) };
    let s = Setup::new("retry", vec![inter(), buda.clone()]);
    let held = name_text("Inter");
    let _net = fake_net::serve(file(&inter(), &held, "inter", b"not a font".to_vec()));
    assert_eq!(s.row("inter").state, PreviewState::Unavailable);
    assert_eq!(s.row("inter").state, PreviewState::Unavailable);
    assert_eq!(urls().len(), 2, "remembered after the first try");

    // Google refuses the family (HTTP 400): remembered too, not "offline".
    fake_net::fail(&css_url(&buda, &name_text("Buda")), Failure::Status(400));
    assert_eq!(s.row("buda").state, PreviewState::Unavailable);
    assert_eq!(s.row("buda").state, PreviewState::Unavailable);
    assert_eq!(urls(), vec![css_url(&buda, &name_text("Buda"))]);
    assert!(css_url(&buda, "x").contains("family=Buda:wght@300&"), "asked with its one weight");
    assert_eq!(s.row("inter").state, PreviewState::Unavailable, "one family's failure isn't another's");

    // A week later: tried again, and this time it works.
    let fail = s.previews.root().join("inter/2026-01-01/name.fail");
    let mut failed: serde_json::Value = serde_json::from_slice(&std::fs::read(&fail).unwrap()).unwrap();
    assert_eq!(failed["why"], "broken");
    failed["at"] = serde_json::json!(now() - RETRY_FAILED_SECS - 1);
    std::fs::write(&fail, serde_json::to_vec(&failed).unwrap()).unwrap();
    fake_net::set(&kit("inter"), font("Inter", &held), None);
    urls();
    assert_eq!(s.row("inter").state, PreviewState::Ready);
    assert_eq!(urls().len(), 2);
    assert!(!fail.exists(), "the note goes once it works");
}

#[test]
fn network_trouble_pauses_previews_without_blaming_the_family() {
    let (roboto, lora) = (family("roboto", "Roboto", &["latin"]), family("lora", "Lora", &["latin"]));
    let s = Setup::new("offline", vec![inter(), roboto.clone(), lora.clone()]);
    let held = name_text("Inter");
    let mut routes = file(&inter(), &held, "inter", font("Inter", &held));
    routes.extend(file(&roboto, &name_text("Roboto"), "roboto", font("Roboto", &name_text("Roboto"))));
    routes.extend(file(&lora, &name_text("Lora"), "lora", font("Lora", &name_text("Lora"))));
    let _net = fake_net::serve(routes);
    let end_pause = || s.previews.backoff.lock().unwrap().until = 0;
    let pause_left = || s.previews.backoff.lock().unwrap().until.saturating_sub(now());

    // One failure alone is often a hiccup: that row is "offline", the next family still tries,
    // and a family that downloads starts the count again.
    fake_net::fail(&css_url(&inter(), &held), Failure::Offline);
    assert_eq!(s.row("inter").state, PreviewState::Offline);
    assert_eq!(s.row("roboto").state, PreviewState::Ready);
    assert_eq!(urls().len(), 3);
    assert!(s.files().iter().all(|f| f.starts_with("roboto/")), "nothing remembered about Inter: {:?}", s.files());

    // Server trouble, rate limits and an answer that isn't Google's usual one (a Wi-Fi sign-in
    // page) count as the network's too, never the family's.
    fake_net::fail(&css_url(&inter(), &held), Failure::Status(503));
    assert_eq!(s.row("inter").state, PreviewState::Offline);
    fake_net::fail(&css_url(&inter(), &held), Failure::Status(429));
    assert_eq!(s.row("inter").state, PreviewState::Offline);
    assert!(!s.previews.paused(), "two in a row: no pause yet");
    fake_net::set(&css_url(&inter(), &held), b"<html>Sign in to the Wi-Fi</html>".to_vec(), None);
    assert_eq!(s.row("inter").state, PreviewState::Offline);
    assert!(s.files().iter().all(|f| f.starts_with("roboto/")), "{:?}", s.files());

    // Three in a row: previews pause, briefly at first. Nothing new is asked for meanwhile, and
    // saved previews still show.
    assert!(s.previews.paused());
    assert!((FIRST_PAUSE_SECS - 1..=FIRST_PAUSE_SECS).contains(&pause_left()), "{}", pause_left());
    urls();
    assert_eq!(s.row("lora").state, PreviewState::Offline);
    assert_eq!(s.row("roboto").state, PreviewState::Ready);
    assert!(urls().is_empty());
    // A request that was already running when the pause began, failing now, doesn't lengthen it.
    s.previews.network_trouble();
    assert!(pause_left() <= FIRST_PAUSE_SECS);

    // Still failing after each pause: the next one is twice as long, up to 15 minutes. The CSS
    // getting through isn't enough when the font download fails.
    fake_net::set(&css_url(&inter(), &held), css(&kit("inter")), None);
    fake_net::fail(&kit("inter"), Failure::Offline);
    for expected in [60, 120, 240, 480, OFFLINE_SECS, OFFLINE_SECS] {
        end_pause();
        assert_eq!(s.row("inter").state, PreviewState::Offline);
        assert!((expected - 1..=expected).contains(&pause_left()), "{expected}: {}", pause_left());
    }

    // Google answers again: the pauses end and the count starts over.
    end_pause();
    fake_net::set(&kit("inter"), font("Inter", &held), None);
    assert_eq!(s.row("inter").state, PreviewState::Ready);
    assert!(!s.previews.paused());
    fake_net::fail(&css_url(&lora, &name_text("Lora")), Failure::Offline);
    assert_eq!(s.row("lora").state, PreviewState::Offline);
    assert!(!s.previews.paused(), "one failure after things worked: no pause");
    // A final answer about a family (Google doesn't know it) shows the network works too.
    fake_net::fail(&css_url(&lora, &name_text("Lora")), Failure::Offline);
    s.previews.network_trouble();
    fake_net::fail(&css_url(&lora, &name_text("Lora")), Failure::Status(400));
    assert_eq!(s.row("lora").state, PreviewState::Unavailable);
    assert_eq!(s.previews.backoff.lock().unwrap().in_row, 0);
}

#[test]
fn turned_off_nothing_is_sent_and_nothing_saved_is_used() {
    let s = Setup::new("off", vec![inter()]);
    let held = name_text("Inter");
    let _net = fake_net::serve(file(&inter(), &held, "inter", font("Inter", &held)));
    for ask in [Ask::Row, Ask::Alphabet] {
        assert_eq!(s.previews.preview("inter", ask, &off).unwrap(), GooglePreview::not(PreviewState::Off));
    }
    assert!(fake_net::take_requests().is_empty(), "no request at all");
    // Saved earlier, then turned off: still "off".
    assert_eq!(s.row("inter").state, PreviewState::Ready);
    urls();
    assert_eq!(s.previews.preview("inter", Ask::Row, &off).unwrap().state, PreviewState::Off);
    assert!(fake_net::take_requests().is_empty());
    // Turned off between the two requests: the font isn't downloaded.
    let s2 = Setup::new("off-midway", vec![inter()]);
    let calls = std::cell::Cell::new(0);
    let first_only = || {
        calls.set(calls.get() + 1);
        calls.get() <= 2
    };
    assert_eq!(s2.previews.preview("inter", Ask::Row, &first_only).unwrap().state, PreviewState::Off);
    assert_eq!(urls(), vec![css_url(&inter(), &held)]);
}

#[test]
fn unknown_or_malformed_ids() {
    let s = Setup::new("ids", vec![inter()]);
    let _net = fake_net::serve(vec![]);
    assert_eq!(s.row("not-in-catalog").state, PreviewState::Unavailable);
    for bad in ["", "Inter", "../inter", "inter/x", "inter%2F", &"a".repeat(81)] {
        assert!(s.previews.preview(bad, Ask::Row, &on).is_err(), "{bad}");
    }
    assert!(urls().is_empty());
    // No saved catalog: nothing is fetched (not even the catalog).
    let empty = Previews::new(s.dir.join("cache2").join(DIR_NAME), s.dir.join("no-data"));
    assert_eq!(empty.preview("inter", Ask::Row, &on).unwrap().state, PreviewState::Unavailable);
    assert!(urls().is_empty());
}

// --------------------------------------------------------------------------------------- cache

#[test]
fn a_new_version_replaces_the_old_files_and_dropped_families_go() {
    let roboto = family("roboto", "Roboto", &["latin"]);
    let s = Setup::new("tokens", vec![inter(), roboto.clone()]);
    let (inter_held, roboto_held) = (name_text("Inter"), name_text("Roboto"));
    let mut routes = file(&inter(), &inter_held, "inter", font("Inter", &inter_held));
    routes.extend(file(&roboto, &roboto_held, "roboto", font("Roboto", &roboto_held)));
    let _net = fake_net::serve(routes);
    assert_eq!(s.row("inter").state, PreviewState::Ready);
    assert_eq!(s.row("roboto").state, PreviewState::Ready);
    assert!(s.previews.resolve("roboto/2026-01-01/name").is_some());

    // Inter changes (a new lastModified); Roboto leaves the catalog.
    let newer = CatalogFamily { last_modified: "2026-02-15".into(), ..inter() };
    s.catalog(vec![newer.clone()]);
    fake_net::set(&css_url(&newer, &inter_held), css(&kit("inter2")), None);
    fake_net::set(&kit("inter2"), font("Inter", &inter_held), None);
    let answer = s.row("inter");
    assert_eq!(answer.path.as_deref(), Some("google/inter/2026-02-15/name"));
    assert_eq!(s.files(), vec!["inter/2026-02-15/name.json", "inter/2026-02-15/name.ttf"]);
    assert!(s.previews.resolve("roboto/2026-01-01/name").is_none());
    assert!(s.previews.resolve("inter/2026-01-01/name").is_none());
}

#[test]
fn files_profiled_by_an_older_build_are_profiled_again_without_the_network() {
    let s = Setup::new("rev", vec![inter()]);
    let held = name_text("Inter");
    let _net = fake_net::serve(file(&inter(), &held, "inter", font("Inter", &held)));
    let answer = s.row("inter");
    assert_eq!(answer.state, PreviewState::Ready);
    let details = s.previews.root().join("inter/2026-01-01/name.json");
    let read = || serde_json::from_slice::<serde_json::Value>(&std::fs::read(&details).unwrap()).unwrap();
    assert_eq!(read()["rev"], preview::PREVIEW_REV);
    // Saved by an older build, whose profiles said something else: with an older rev, or with
    // none (saved before it was noted).
    for rev in [Some(preview::PREVIEW_REV - 1), None] {
        let mut saved = read();
        saved["text"] = "Stale".into();
        saved["sample"] = true.into();
        saved["profile"]["kind"] = "partial".into();
        match rev {
            Some(rev) => saved["rev"] = rev.into(),
            None => {
                saved.as_object_mut().unwrap().remove("rev");
            }
        }
        std::fs::write(&details, serde_json::to_vec(&saved).unwrap()).unwrap();
        s.previews.size(); // measured, as if the older build had saved it
        urls();
        assert_eq!(s.row("inter"), answer, "{rev:?}: today's profile of the saved file");
        assert!(urls().is_empty(), "{rev:?}: no network");
        let again = read();
        assert_eq!((again["rev"].as_i64(), again["text"].as_str()), (Some(preview::PREVIEW_REV), Some("Inter")), "{rev:?}: saved again");
    }
    // The cache's running count of its size kept up with the rewritten details.
    let on_disk: u64 = files_under(s.previews.root()).iter().map(|(_, m)| m.len()).sum();
    assert_eq!(*s.previews.bytes.lock().unwrap(), Some(on_disk));
}

#[test]
fn a_saved_name_that_profiles_now_say_cant_draw_gives_way_to_the_script() {
    // An older build saved a name file it thought drew; today's profiles say it draws nothing.
    let f = family("noto-sans-khmer", "Noto Sans Khmer", &["khmer", "latin"]);
    let s = Setup::new("rev-script", vec![f.clone()]);
    let (held, script) = (name_text(&f.family), script_text("khmer").unwrap());
    let _net = fake_net::serve(file(&f, &script, "khmer", font("Noto Sans Khmer", &script)));
    let dir = s.previews.root().join("noto-sans-khmer/2026-01-01");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("name.ttf"), font("Noto Sans Khmer", " ")).unwrap();
    // Its details, as that build saved them: the name, drawn.
    let mut old = entry_for(&f, FileKind::Name, &held, &font("Noto Sans Khmer", &held)).unwrap();
    old.rev = preview::PREVIEW_REV - 1;
    assert_eq!(old.text, "Noto Sans Khmer");
    std::fs::write(dir.join("name.json"), serde_json::to_vec(&old).unwrap()).unwrap();
    let answer = s.row("noto-sans-khmer");
    assert_eq!(answer.state, PreviewState::Ready);
    assert_eq!(answer.path.as_deref(), Some("google/noto-sans-khmer/2026-01-01/script"));
    assert_eq!(urls(), vec![css_url(&f, &script), kit("khmer")], "the name isn't downloaded again");
    assert_eq!(
        s.files(),
        vec!["noto-sans-khmer/2026-01-01/name.fail", "noto-sans-khmer/2026-01-01/script.json", "noto-sans-khmer/2026-01-01/script.ttf"]
    );
    let failed: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("name.fail")).unwrap()).unwrap();
    assert_eq!((failed["why"].as_str(), failed["rev"].as_i64()), (Some("cantDraw"), Some(preview::PREVIEW_REV)));
}

#[test]
fn cant_draw_is_tried_again_after_a_profile_change_and_other_failures_wait() {
    let s = Setup::new("rev-fail", vec![inter()]);
    let held = name_text("Inter");
    let _net = fake_net::serve(file(&inter(), &held, "inter", font("Inter", &held)));
    let fail = s.previews.root().join("inter/2026-01-01/name.fail");
    std::fs::create_dir_all(fail.parent().unwrap()).unwrap();
    let note = |why: &str, rev: Option<i64>| {
        let mut v = serde_json::json!({ "at": now(), "why": why, "held": held });
        if let Some(rev) = rev {
            v["rev"] = rev.into();
        }
        std::fs::write(&fail, serde_json::to_vec(&v).unwrap()).unwrap();
    };
    // Judged by today's profiles: still believed.
    note("cantDraw", Some(preview::PREVIEW_REV));
    assert_eq!(s.row("inter").state, PreviewState::Unavailable);
    assert!(urls().is_empty());
    // Not the family's own fault in any other way (a broken file, Google not knowing it): those
    // wait their week, whatever profiles say.
    for why in ["broken", "notFound"] {
        note(why, Some(preview::PREVIEW_REV - 1));
        assert_eq!(s.row("inter").state, PreviewState::Unavailable, "{why}");
        assert!(urls().is_empty(), "{why}");
    }
    // Judged by older profiles (or before that was noted): tried again, and today it draws.
    for rev in [Some(preview::PREVIEW_REV - 1), None] {
        let _ = std::fs::remove_dir_all(s.previews.root());
        std::fs::create_dir_all(fail.parent().unwrap()).unwrap();
        note("cantDraw", rev);
        assert_eq!(s.row("inter").state, PreviewState::Ready, "{rev:?}");
        assert_eq!(urls().len(), 2, "{rev:?}");
        assert!(!fail.exists());
    }
}

#[test]
fn tokens_are_safe_folder_names() {
    assert_eq!(token("2026-01-01"), "2026-01-01");
    assert_eq!(token("2026/01/01 ../x"), "20260101x");
    assert_eq!(token(""), "0");
    assert_eq!(token(&"9".repeat(60)).len(), 40);
    assert!(valid_token(&token("../../etc")));
}

#[test]
fn writes_are_whole_or_not_at_all() {
    let dir = std::env::temp_dir().join(format!("fontface-previews-atomic-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("name.ttf");
    write_atomic(&path, b"first").unwrap();
    write_atomic(&path, b"second").unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"second");
    // Racing writers: each leaves a whole file, and no temporary file is left behind.
    let writers: Vec<_> = (0..8u8)
        .map(|i| {
            let path = path.clone();
            std::thread::spawn(move || {
                for _ in 0..20 {
                    write_atomic(&path, &vec![i; 4096]).unwrap();
                }
            })
        })
        .collect();
    for w in writers {
        w.join().unwrap();
    }
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(bytes.len(), 4096);
    assert!(bytes.iter().all(|b| *b == bytes[0]), "one writer's file, whole");
    let left: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name()).collect();
    assert_eq!(left, vec![std::ffi::OsString::from("name.ttf")]);
    // A folder that isn't there: an error, and nothing left over.
    assert!(write_atomic(&dir.join("missing/name.ttf"), b"x").is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn leftovers_of_a_crash_are_swept() {
    let s = Setup::new("leftovers", vec![inter()]);
    let held = name_text("Inter");
    let _net = fake_net::serve(file(&inter(), &held, "inter", font("Inter", &held)));
    assert_eq!(s.row("inter").state, PreviewState::Ready);
    let dir = s.previews.root().join("inter/2026-01-01");
    let old = SystemTime::now() - std::time::Duration::from_secs(LEFTOVER_SECS + 60);
    for name in [".tmp-name.ttf-1-2-3", "script.ttf", "alphabet.json"] {
        std::fs::write(dir.join(name), b"x").unwrap();
        std::fs::File::options().write(true).open(dir.join(name)).unwrap().set_modified(old).unwrap();
    }
    std::fs::write(dir.join(".tmp-new"), b"x").unwrap(); // mid-write: kept
    let clearing = s.previews.root().with_file_name(format!(".{DIR_NAME}-clearing-1"));
    std::fs::create_dir_all(clearing.join("x")).unwrap();
    // A catalog change makes the cache sweep.
    s.catalog(vec![inter(), family("roboto", "Roboto", &["latin"])]);
    assert_eq!(s.row("inter").state, PreviewState::Ready);
    assert_eq!(s.files(), vec!["inter/2026-01-01/.tmp-new", "inter/2026-01-01/name.json", "inter/2026-01-01/name.ttf"]);
    assert!(!clearing.exists());
}

#[test]
fn past_the_limit_the_files_used_longest_ago_go() {
    let families: Vec<CatalogFamily> =
        (0..6).map(|i| family(&format!("fam-{i}"), &format!("Fam {}", ["A", "B", "C", "D", "E", "F"][i]), &["latin"])).collect();
    let mut s = Setup::new("lru", families.clone());
    let mut routes = Vec::new();
    for (i, f) in families.iter().enumerate() {
        let held = name_text(&f.family);
        let mut bytes = font(&f.family, &held);
        bytes.resize(20_000, 0); // padding after the tables: still a font
        routes.extend(file(f, &held, &format!("k{i}"), bytes));
    }
    let _net = fake_net::serve(routes);
    s.previews.max_bytes = 70_000; // room for three
    let age = |id: &str, secs: u64| {
        let path = s.previews.root().join(format!("{id}/2026-01-01/name.ttf"));
        std::fs::File::options().write(true).open(path).unwrap().set_modified(SystemTime::now() - std::time::Duration::from_secs(secs)).unwrap();
    };
    for (i, id) in ["fam-0", "fam-1", "fam-2"].iter().enumerate() {
        assert_eq!(s.row(id).state, PreviewState::Ready);
        age(id, 10_000 - i as u64 * 1000);
    }
    // fam-0 is used again (marked as used: it was last used over an hour ago).
    assert_eq!(s.row("fam-0").state, PreviewState::Ready);
    // Two more: over the limit, so the oldest go, fam-1 first, then fam-2. fam-0 stays.
    assert_eq!(s.row("fam-3").state, PreviewState::Ready);
    assert_eq!(s.row("fam-4").state, PreviewState::Ready);
    let kept: Vec<String> = s.files().into_iter().filter(|f| f.ends_with(".ttf")).collect();
    assert_eq!(kept, vec!["fam-0/2026-01-01/name.ttf", "fam-3/2026-01-01/name.ttf", "fam-4/2026-01-01/name.ttf"]);
    assert!(!s.previews.root().join("fam-1").exists(), "an emptied family's folder goes too");
    assert!(s.previews.size() <= 70_000);
    // An evicted family downloads again when it's needed.
    urls();
    assert_eq!(s.row("fam-1").state, PreviewState::Ready);
    assert_eq!(urls().len(), 2);
}

#[test]
fn the_cache_reports_its_size_and_clears() {
    let s = Setup::new("clear", vec![inter()]);
    let held = name_text("Inter");
    let _net = fake_net::serve(file(&inter(), &held, "inter", font("Inter", &held)));
    assert_eq!(s.previews.size(), 0, "nothing yet (the folder isn't even there)");
    assert_eq!(s.row("inter").state, PreviewState::Ready);
    let size = s.previews.size();
    let on_disk: u64 = files_under(s.previews.root()).iter().map(|(_, m)| m.len()).sum();
    assert!(size > 0 && size == on_disk);
    s.previews.backoff.lock().unwrap().until = now() + OFFLINE_SECS;
    s.previews.clear().unwrap();
    assert_eq!(s.previews.size(), 0);
    assert!(!s.previews.root().exists());
    assert!(std::fs::read_dir(s.previews.root().parent().unwrap()).unwrap().next().is_none(), "nothing set aside is left");
    // Cleared while offline: previews may try again at once.
    urls();
    assert_eq!(s.row("inter").state, PreviewState::Ready);
    assert_eq!(urls().len(), 2);
    s.previews.clear().unwrap();
    s.previews.clear().unwrap(); // nothing there: fine
}

// --------------------------------------------------------------------------------- ff:// paths

#[test]
fn ff_paths_serve_only_saved_files_of_catalog_families() {
    let s = Setup::new("paths", vec![inter()]);
    let held = name_text("Inter");
    let _net = fake_net::serve(file(&inter(), &held, "inter", font("Inter", &held)));
    assert_eq!(s.row("inter").state, PreviewState::Ready);
    urls();
    // convertFileSrc encodes the slashes.
    assert_eq!(decode_path("google%2Finter%2F2026-01-01%2Fname").as_deref(), Some("google/inter/2026-01-01/name"));
    assert_eq!(decode_path("12").as_deref(), Some("12"));
    assert_eq!(decode_path("%zz"), None);
    assert_eq!(decode_path("%2"), None);
    assert_eq!(decode_path("%FF"), None, "not UTF-8");
    assert!(s.previews.resolve("inter/2026-01-01/name").is_some());
    // Something outside the cache to aim at.
    std::fs::write(s.dir.join("secret.ttf"), font("Secret", "abc")).unwrap();
    std::fs::create_dir_all(s.previews.root().join("roboto/2026-01-01")).unwrap();
    std::fs::copy(s.previews.root().join("inter/2026-01-01/name.ttf"), s.previews.root().join("roboto/2026-01-01/name.ttf")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(s.dir.join("secret.ttf"), s.previews.root().join("inter/2026-01-01/script.ttf")).unwrap();
    for bad in [
        "../secret",
        "inter/../../secret",
        "inter/2026-01-01/../../../secret",
        "inter/2026-01-01/name.ttf",
        "inter/2026-01-01/name/",
        "inter/2026-01-01/name/x",
        "inter/2026-01-01/evil",
        "inter/2026-01-01/NAME",
        "inter/2026-01-01/script", // a symlink, not a saved file
        "inter/2026-01-01/alphabet", // not saved
        "inter/2026-01-02/name",
        "inter/..%2F/name",
        "inter/2026.01.01/name",
        "inter//name",
        "Inter/2026-01-01/name",
        "roboto/2026-01-01/name", // a file is there, but Roboto isn't in the catalog
        "/inter/2026-01-01/name",
        "inter/2026-01-01",
        "",
    ] {
        assert!(s.previews.resolve(bad).is_none(), "{bad}");
        assert!(s.previews.serve(bad).is_none(), "{bad}");
    }
    assert!(urls().is_empty(), "never the network");
}

#[test]
fn the_cache_is_off_limits_to_the_rest_of_the_app() {
    // The rule knows the folder by the app's identifier, which names its cache folder.
    let conf: serde_json::Value = serde_json::from_str(include_str!("../../../../tauri.conf.json")).unwrap();
    assert_eq!(MARKER, format!("/{}/{DIR_NAME}", conf["identifier"].as_str().unwrap()));
    for path in [
        "/Users/x/Library/Caches/design.snds.fontface/google-previews/inter/2026-01-01/name.ttf",
        "/Users/x/Library/Caches/design.snds.fontface/google-previews",
        "/Users/x/Library/Caches/Design.SNDS.Fontface/Google-Previews/inter",
        r"C:\Users\x\AppData\Local\design.snds.fontface\google-previews\inter\1\name.ttf",
        "/home/x/.cache/design.snds.fontface/google-previews/a/b/name.ttf",
    ] {
        assert!(is_preview_cache_path(Path::new(path)), "{path}");
        assert!(crate::preview::never_read(path), "{path}");
    }
    for path in [
        "/Users/x/Library/Caches/design.snds.fontface",
        "/Users/x/Library/Caches/design.snds.fontface/google-previews-old/a.ttf",
        "/Users/x/Fonts/google-previews/a.ttf",
        "/Users/x/Library/Application Support/design.snds.fontface/Services/Google Fonts/Inter/Inter.ttf",
    ] {
        assert!(!is_preview_cache_path(Path::new(path)), "{path}");
    }
    // A cache folder somewhere else (tests, another identifier) is known by where this run keeps it.
    let s = Setup::new("guard", vec![inter()]);
    assert!(is_preview_cache_path(&s.previews.root().join("inter/2026-01-01/name.ttf")));
    assert!(!is_preview_cache_path(&s.data()));
}

// --------------------------------------------------------------------------------------- live

/// Live: a few real families from Google, into a temporary cache. Sends a handful of requests
/// to fonts.googleapis.com and fonts.gstatic.com.
///   cargo test google_previews_live -- --ignored --nocapture
#[test]
#[ignore]
fn google_previews_live() {
    let styled = |id: &str, name: &str, subsets: &[&str], weights: &[u16], styles: &[&str], category: &str| CatalogFamily {
        weights: weights.to_vec(),
        styles: styles.iter().map(|s| s.to_string()).collect(),
        category: category.into(),
        ..family(id, name, subsets)
    };
    let families = vec![
        styled("inter", "Inter", &["cyrillic", "greek", "latin", "latin-ext", "vietnamese"], &[100, 400, 900], &["normal", "italic"], "sans-serif"),
        styled("buda", "Buda", &["latin"], &[300], &["normal"], "display"),
        styled("molle", "Molle", &["latin", "latin-ext"], &[400], &["italic"], "handwriting"),
        styled("material-icons", "Material Icons", &["latin"], &[400], &["normal"], "icons"),
        styled("noto-sans-lycian", "Noto Sans Lycian", &["lycian"], &[400], &["normal"], "sans-serif"),
        CatalogFamily {
            def_subset: "japanese".into(),
            ..styled("noto-sans-jp", "Noto Sans JP", &["cyrillic", "japanese", "latin", "latin-ext", "vietnamese"], &[100, 400, 900], &["normal"], "sans-serif")
        },
        styled("noto-color-emoji", "Noto Color Emoji", &["emoji"], &[400], &["normal"], "sans-serif"),
        styled("karla-tamil-upright", "Karla Tamil Upright", &["tamil"], &[400, 700], &["normal"], "sans-serif"),
        styled("khmer", "Khmer", &["khmer"], &[400], &["normal"], "sans-serif"),
        styled("sunflower", "Sunflower", &["korean", "latin"], &[300, 500, 700], &["normal"], "sans-serif"),
    ];
    let s = Setup::new("live", families);
    let report = |id: &str, a: &GooglePreview| {
        let p = a.profile.as_ref();
        let bytes = a.path.as_deref().and_then(|path| s.previews.resolve(&path["google/".len()..])).and_then(|f| std::fs::metadata(f).ok()).map(|m| m.len());
        println!(
            "{id}: {:?} {:?} {bytes:?} bytes text={:?} sample={:?} kind={:?} label={:?}",
            a.state,
            a.path,
            a.text,
            a.sample,
            p.map(|p| &p.kind),
            p.and_then(|p| p.label.as_ref())
        );
    };
    for id in ["inter", "buda", "molle", "sunflower"] {
        let a = s.row(id);
        report(id, &a);
        assert_eq!(a.state, PreviewState::Ready, "{id}");
        assert_eq!(a.profile.as_ref().unwrap().kind, "name", "{id}");
        assert!(s.previews.serve(&a.path.unwrap()["google/".len()..]).is_some());
    }
    let icons = s.row("material-icons");
    report("material-icons", &icons);
    assert_eq!((icons.state, icons.sample), (PreviewState::Ready, Some(true)));
    let lycian = s.row("noto-sans-lycian");
    report("noto-sans-lycian", &lycian);
    assert_eq!(lycian.state, PreviewState::Ready);
    assert_eq!(lycian.profile.as_ref().unwrap().label.as_deref(), Some("Lycian"));
    // Their names come back as a space only: a sample of their script instead.
    for (id, label) in [("karla-tamil-upright", "Tamil"), ("khmer", "Khmer")] {
        let a = s.row(id);
        report(id, &a);
        assert_eq!((a.state, a.sample), (PreviewState::Ready, Some(true)), "{id}");
        assert!(a.path.as_deref().is_some_and(|p| p.ends_with("/script")), "{id}");
        assert_eq!(a.profile.as_ref().unwrap().label.as_deref(), Some(label), "{id}");
    }
    let jp = s.row("noto-sans-jp");
    report("noto-sans-jp", &jp);
    assert_eq!(jp.state, PreviewState::Ready);
    let emoji = s.row("noto-color-emoji");
    report("noto-color-emoji", &emoji);
    assert!(matches!(emoji.state, PreviewState::TooLarge | PreviewState::Ready | PreviewState::Unavailable), "{emoji:?}");
    let alphabet = s.alphabet("inter");
    report("inter (alphabet)", &alphabet);
    assert_eq!(alphabet.state, PreviewState::Ready);
    assert!(alphabet.profile.unwrap().ascii_missing.is_empty(), "Inter has all of ASCII");
    println!("cache: {} bytes", s.previews.size());
    assert!(s.previews.size() < 2 * 1024 * 1024);
}
