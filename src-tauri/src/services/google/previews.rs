//! Online previews: the Google Fonts page shows every family in its own font, even the ones that
//! aren't downloaded.
//!
//! - **What's asked for.** Google's documented CSS2 `text=` option: a tiny font file holding only
//!   the characters asked for. For a row, that's the family name, in its own letters and in
//!   capitals and lowercase (so a capitals-only font can still show its name). Icon families ask
//!   for five icons by their code points (`ICON_PREVIEW`). A family that can't draw its name
//!   (Lycian, Khmer, Karla Tamil Upright answer with only a space) asks for a short sample of its
//!   script instead, picked by Fontsource's `defSubset`; a family without Latin goes straight to
//!   it. While preview text is typed, rows use a fixed "alphabet" file instead (printable ASCII
//!   and Latin-1), so typed text never leaves the Mac.
//! - **How.** Rust asks `fonts.googleapis.com/css2` with Fontface's own User-Agent, reads the one
//!   `fonts.gstatic.com` URL from the answer and throws the CSS away, then downloads that file
//!   (at most `MAX_FILE_BYTES`; Noto Color Emoji is far larger) and checks it's a font. It's
//!   profiled like a library font (`preview::profile_safely`), so a row gets the same
//!   `PreviewInfo`. The web view never talks to Google: it loads the saved file through
//!   `ff://localhost/google/<id>/<token>/<file kind>` (protocol.rs, `serve`), which only serves
//!   files already saved here.
//! - **Kept** in the app's cache folder (`~/Library/Caches/design.snds.fontface/google-previews/`
//!   on macOS), never in the Services folder (that one is scanned and turned on):
//!   `<id>/<token>/<file kind>.ttf`, plus `<file kind>.json` with its profile and the text it
//!   holds. The token is the catalog's `lastModified`: when it changes, the old files go, and
//!   families that leave the catalog go too. Writes are atomic (a temporary file, then a
//!   rename). The cache holds about `MAX_CACHE_BYTES`; past that, the files used longest ago go.
//!   Each entry notes the `preview::PREVIEW_REV` it was profiled with: after a change to how
//!   profiles are worked out, a saved file is profiled again (from the file, no network), so
//!   Google rows and library rows of the same font always agree.
//! - **Failures** are remembered next to the files (`<file kind>.fail`) and tried again after a
//!   week: Google not knowing the family, a file too large, a file that isn't a usable font, or
//!   one that can't draw anything (that one also after a `PREVIEW_REV` change). Network trouble
//!   (no connection, a timeout, Google's servers failing) isn't the family's fault, and one
//!   failure alone is often a hiccup: after `OFFLINE_AFTER` in a row, previews pause ("offline"),
//!   for 30 seconds at first, then twice as long each time it goes on, up to 15 minutes. A
//!   download that gets through (or Google's final answer about a family) ends the pauses.
//! - **Privacy.** On by default (Settings › Google Fonts previews). Google sees the computer's IP
//!   address and which families are viewed. Typed text is never sent. Turned off, nothing at all
//!   is sent and saved files aren't used either (they stay until the cache is cleared).
//! - **Never touched elsewhere.** `is_preview_cache_path` keeps the scanner, the library,
//!   activation, tags and `ff://` by library id away from these files, even if the user adds
//!   their Library folder.

use std::{
    collections::{HashMap, HashSet},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use super::{icons, saved_catalog_stamp, saved_families, CatalogFamily};
use crate::{
    error::{AppError, AppResult},
    preview::{self, profile, PreviewInfo},
    services::{fetch_preview, PreviewFetchError},
};

/// The cache folder's name, inside the app's cache folder.
pub const DIR_NAME: &str = "google-previews";
/// How the cache folder's path ends on every system, in lowercase: the app's identifier
/// (tauri.conf.json, which names its cache folder), then `DIR_NAME`.
const MARKER: &str = "/design.snds.fontface/google-previews";

const CSS_URL: &str = "https://fonts.googleapis.com/css2";
/// Where CSS answers must come from.
const CSS_ORIGIN: &str = "https://fonts.googleapis.com/";
/// Where font files must come from: any other URL in Google's answer is refused.
const FONT_ORIGIN: &str = "https://fonts.gstatic.com/";
const MAX_CSS_BYTES: u64 = 64 * 1024;
/// The largest preview file kept. Name files are a few KB; the alphabet tens of KB.
pub const MAX_FILE_BYTES: u64 = 512 * 1024;
/// About how much the cache keeps before the files used longest ago go.
pub const MAX_CACHE_BYTES: u64 = 64 * 1024 * 1024;
/// A remembered failure is tried again after this long.
const RETRY_FAILED_SECS: u64 = 7 * 24 * 60 * 60;
/// Network trouble this many requests in a row pauses previews. One failure alone is often a
/// hiccup (a dropped connection, a slow answer), and the next request works.
const OFFLINE_AFTER: u32 = 3;
/// The first pause after network trouble. Each pause in a row after it is twice as long.
const FIRST_PAUSE_SECS: u64 = 30;
/// The longest pause (like the catalog's).
const OFFLINE_SECS: u64 = 15 * 60;
/// A saved file used again is marked as used (its modified time) at most this often.
const TOUCH_EVERY_SECS: u64 = 60 * 60;
/// Temporary files and half-written entries older than this are leftovers of a crash.
const LEFTOVER_SECS: u64 = 60 * 60;
/// What icon families preview with: home, search, settings, favorite and star, by code point.
/// The same as `ICON_PREVIEW` in src/components/GoogleFontsPanel.tsx.
pub const ICON_PREVIEW: &str = "\u{E88A} \u{E8B6} \u{E8B8} \u{E87D} \u{E838}";
/// How many characters a script sample asks for.
const SCRIPT_SAMPLE: usize = 24;

/// The four files a family can have.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FileKind {
    /// The family name (capitals and lowercase too).
    Name,
    /// Five icons, for icon families.
    Icons,
    /// A short sample of the family's script, when it can't draw its name.
    Script,
    /// Printable ASCII and Latin-1, for typed preview text.
    Alphabet,
}

impl FileKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FileKind::Name => "name",
            FileKind::Icons => "icons",
            FileKind::Script => "script",
            FileKind::Alphabet => "alphabet",
        }
    }

    pub fn parse(s: &str) -> Option<FileKind> {
        [FileKind::Name, FileKind::Icons, FileKind::Script, FileKind::Alphabet].into_iter().find(|k| k.as_str() == s)
    }
}

/// What the page asks for (`google_preview`'s `kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ask {
    /// What a row shows with no preview text typed: Rust picks the name, icons or a script sample.
    Row,
    /// The alphabet file, for typed preview text.
    Alphabet,
}

impl Ask {
    pub fn parse(s: &str) -> Option<Ask> {
        match s {
            "row" => Some(Ask::Row),
            "alphabet" => Some(Ask::Alphabet),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PreviewState {
    /// The file is saved: `path`, `text`, `sample` and `profile` say how to draw it.
    Ready,
    /// Previews are turned off in Settings. Nothing was sent.
    Off,
    /// The network failed a moment ago; previews wait a while before trying again.
    Offline,
    /// Google has no preview for this family, or it can't draw anything.
    Unavailable,
    /// The family's preview file is too large to download for a row (Noto Color Emoji).
    TooLarge,
}

/// The answer to `google_preview`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GooglePreview {
    pub state: PreviewState,
    /// For `convertFileSrc(path, "ff")`: `google/<id>/<token>/<file kind>`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// What the row draws from the file: the family name (or the form of it the font can draw),
    /// the icons, or the script sample. For the alphabet file: the characters it holds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// `text` is a sample, not the family name, so the View options' case isn't applied (like
    /// the library's sample kinds).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<PreviewInfo>,
}

impl GooglePreview {
    fn not(state: PreviewState) -> GooglePreview {
        GooglePreview { state, path: None, text: None, sample: None, profile: None }
    }
}

/// What's saved with each file (`<file kind>.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    /// The characters the file was asked for.
    held: String,
    /// What a row draws from it (`GooglePreview::text`).
    text: String,
    sample: bool,
    profile: PreviewInfo,
    /// The `preview::PREVIEW_REV` the profile was worked out with (0: saved before this was
    /// noted). Any other: the file is profiled again before it's used.
    #[serde(default)]
    rev: i64,
}

/// Why a file wasn't made, remembered for `RETRY_FAILED_SECS` (`<file kind>.fail`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Why {
    /// Google answered with an error for the family (it doesn't know that name or style).
    NotFound,
    TooLarge,
    /// Not a usable font.
    Broken,
    /// A font, but nothing in it draws (the characters asked for aren't in it).
    CantDraw,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Failed {
    /// Seconds since the epoch.
    at: u64,
    why: Why,
    /// The characters asked for: a different request is tried at once.
    held: String,
    /// The `preview::PREVIEW_REV` then. A file that couldn't draw anything is tried again once
    /// profiles are worked out differently: it may draw now.
    #[serde(default)]
    rev: i64,
}

impl Failed {
    /// Still to be believed: the same request, under a week old, and for "can't draw", judged by
    /// the profiles of this build.
    fn holds(&self, held: &str) -> bool {
        self.held == held && now().saturating_sub(self.at) < RETRY_FAILED_SECS && (self.why != Why::CantDraw || self.rev == preview::PREVIEW_REV)
    }
}

/// Network trouble, for when previews leave the network alone (`Previews::network_trouble`).
#[derive(Debug, Default)]
struct Backoff {
    /// Requests in a row that failed because of the network.
    in_row: u32,
    /// Pauses in a row: each one after the first is twice as long.
    pauses: u32,
    /// Until when (seconds since the epoch) previews leave the network alone.
    until: u64,
}

/// What getting one file came to.
enum Got {
    Ready(Entry),
    /// A font that draws none of the characters asked for: the next file in the plan is tried.
    CantDraw,
    Not(PreviewState),
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Cache folders this run uses, so `is_preview_cache_path` knows them wherever they are.
static ROOTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// True for any path inside the preview cache: by its place in the app's cache folder
/// (`…/design.snds.fontface/google-previews/…`, any system, any case), or inside a cache folder
/// this run uses. These files are never scanned, turned on, tagged or served by library id.
pub fn is_preview_cache_path(path: &Path) -> bool {
    // Checked for every entry of every scan, so without building strings it doesn't need.
    let s = path.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
    if s.match_indices(MARKER).any(|(at, _)| matches!(s.as_bytes().get(at + MARKER.len()), None | Some(b'/'))) {
        return true;
    }
    ROOTS.lock().unwrap_or_else(|p| p.into_inner()).iter().any(|root| path.starts_with(root))
}

/// A catalog id as Fontsource writes them: lowercase letters, digits and `-`.
pub fn valid_id(id: &str) -> bool {
    (1..=80).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn valid_token(token: &str) -> bool {
    (1..=40).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// The folder name for a family's files: its catalog `lastModified`, letters, digits and `-` only.
pub fn token(last_modified: &str) -> String {
    let t: String = last_modified.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(40).collect();
    if t.is_empty() { "0".into() } else { t }
}

/// Percent-encodes everything but letters, digits and `-_.~`, as UTF-8.
fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for b in text.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Undoes `%XX` escapes (`convertFileSrc` encodes the whole path, slashes too). None if an
/// escape is broken or the result isn't UTF-8.
pub fn decode_path(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

// ---------------------------------------------------------------------------------- requests

/// The weight to ask for: none (the default, 400) when the family has a 400 or lists no
/// weights. Otherwise the one CSS would pick for 400: 400–500 first, then lighter, then heavier.
/// Buda has only 300 and Coda Caption only 800, and Google refuses those families without it.
fn nearest_weight(weights: &[u16]) -> Option<u16> {
    if weights.is_empty() || weights.contains(&400) {
        return None;
    }
    weights
        .iter()
        .filter(|w| (400..=500).contains(*w))
        .min()
        .or_else(|| weights.iter().filter(|w| **w < 400).max())
        .or_else(|| weights.iter().min())
        .copied()
}

/// The `family=` value: the name with `+` for spaces, plus the style when the family has no
/// regular one: the nearest weight, italic for italic-only families (Molle), or both.
fn family_param(f: &CatalogFamily) -> String {
    let name = f.family.split(' ').map(encode).collect::<Vec<_>>().join("+");
    let upright = f.styles.is_empty() || f.styles.iter().any(|s| s == "normal");
    match (upright, nearest_weight(&f.weights)) {
        (true, None) => name,
        (true, Some(w)) => format!("{name}:wght@{w}"),
        (false, None) => format!("{name}:ital@1"),
        (false, Some(w)) => format!("{name}:ital,wght@1,{w}"),
    }
}

/// The CSS2 request for a file holding `held`.
fn css_url(f: &CatalogFamily, held: &str) -> String {
    format!("{CSS_URL}?family={}&text={}", family_param(f), encode(held))
}

/// The family name as written, then in capitals, then in lowercase, each character once.
fn name_text(family: &str) -> String {
    let mut seen = HashSet::new();
    [family.to_string(), family.to_uppercase(), family.to_lowercase()]
        .concat()
        .chars()
        .filter(|c| seen.insert(*c))
        .collect()
}

/// Printable ASCII (U+0020–U+007E) and Latin-1 (U+00A0–U+00FF): what typed text can preview.
pub fn alphabet_text() -> String {
    (0x20u32..=0x7E).chain(0xA0..=0xFF).filter_map(char::from_u32).collect()
}

/// Subsets that are Latin letters, never a script sample.
fn latin_subset(s: &str) -> bool {
    matches!(s, "latin" | "latin-ext" | "vietnamese")
}

/// Hand-picked samples for subsets whose blocks are too big (or too mixed) to sample by rule.
fn curated_sample(subset: &str) -> Option<&'static str> {
    Some(match subset {
        "japanese" => "あいうえおかきくけこアイウエオカキクケコ日本語",
        "korean" => "가나다라마바사아자차카타파하한글",
        "chinese-simplified" => "中文字体汉字永东国人大天地上下",
        "chinese-traditional" | "chinese-hongkong" => "中文字體漢字永東國人大天地上下",
        "emoji" => "😀😍🎉👍🌍🍕🚀⭐",
        "symbols" => "☀☁☂★☎☺♠♣♥♦♪⚑⚓✈✉✓",
        "symbols2" => "←↑→↓⇄⌘⌛⏰■▲●◆☯♻⚡⬢",
        "math" => "∀∂∃∅∇∈∏∑√∞∫≈≠≤≥⊂⊕",
        "music" => "𝄞𝄢𝄪𝄫𝄬𝄭♩♪♫♬♭♮♯",
        _ => return None,
    })
}

/// The Unicode block a Fontsource subset names: by name ("old-turkic" is Old Turkic, "phags-pa"
/// is Phags-pa), or by a few that read differently.
fn subset_block(subset: &str) -> Option<(u32, u32)> {
    let name = match subset {
        "greek" => "Greek and Coptic",
        "greek-ext" => "Greek Extended",
        "cyrillic-ext" => "Cyrillic",
        "canadian-aboriginal" => "Unified Canadian Aboriginal Syllabics",
        "yi" => "Yi Syllables",
        "braille" => "Braille Patterns",
        "signwriting" => "Sutton SignWriting",
        "znamenny" => "Znamenny Musical Notation",
        "kana-extended" => "Kana Extended-A",
        "linear-b" => "Linear B Syllabary",
        "cypriot" => "Cypriot Syllabary",
        "meroitic" => "Meroitic Cursive",
        other => other,
    };
    let simple = |s: &str| s.to_ascii_lowercase().replace(['-', '_'], " ");
    let wanted = simple(name);
    profile::blocks().iter().find(|(_, _, n)| simple(n) == wanted).map(|(a, b, _)| (*a, *b))
}

/// A short sample of a subset's script: a hand-picked one, or up to `SCRIPT_SAMPLE` letters (or
/// numerals) of its Unicode block, the first ones, or spread evenly across a big block. None
/// for Latin subsets and subsets this build doesn't know.
pub fn script_text(subset: &str) -> Option<String> {
    if latin_subset(subset) || subset.is_empty() {
        return None;
    }
    if let Some(text) = curated_sample(subset) {
        return Some(text.to_string());
    }
    let (first, last) = subset_block(subset)?;
    let usable: Vec<char> = (first..=last).filter(|cp| !profile::skipped(*cp)).filter_map(char::from_u32).collect();
    let letters: Vec<char> = usable.iter().copied().filter(|c| c.is_alphabetic() || c.is_numeric()).collect();
    let pool = if letters.len() >= 5 { letters } else { usable };
    if pool.is_empty() {
        return None;
    }
    let chosen: Vec<char> = if pool.len() >= 300 {
        (0..SCRIPT_SAMPLE).map(|i| pool[i * (pool.len() - 1) / (SCRIPT_SAMPLE - 1)]).collect()
    } else {
        pool.into_iter().take(SCRIPT_SAMPLE).collect()
    };
    Some(chosen.into_iter().collect())
}

/// The subset a script sample comes from: Fontsource's `defSubset` when it's a script, else the
/// first script in `subsets` with a sample.
fn script_subset(f: &CatalogFamily) -> Option<&str> {
    let usable = |s: &str| !latin_subset(s) && script_text(s).is_some();
    if usable(&f.def_subset) {
        return Some(&f.def_subset);
    }
    f.subsets.iter().map(String::as_str).find(|s| usable(s))
}

/// The files to try for a request, in order, each with the characters it asks for.
fn plan(f: &CatalogFamily, ask: Ask) -> Vec<(FileKind, String)> {
    if icons::looks_like_icons(f) {
        // Icon families keep their icons, typed text or not: their letters are icon names.
        return vec![(FileKind::Icons, ICON_PREVIEW.to_string())];
    }
    if ask == Ask::Alphabet {
        return vec![(FileKind::Alphabet, alphabet_text())];
    }
    let script = script_subset(f).and_then(script_text).map(|t| (FileKind::Script, t));
    let no_latin = !f.subsets.is_empty() && !f.subsets.iter().any(|s| s == "latin");
    match script {
        Some(script) if no_latin => vec![script],
        Some(script) => vec![(FileKind::Name, name_text(&f.family)), script],
        None => vec![(FileKind::Name, name_text(&f.family))],
    }
}

/// The one font URL in Google's CSS answer. None if there's none, or if any font URL in it isn't
/// on fonts.gstatic.com (or isn't a plain URL): such an answer isn't used at all.
fn font_url(css: &str) -> Option<String> {
    let mut found: Option<String> = None;
    let mut rest = css;
    while let Some(start) = rest.find("url(") {
        let after = &rest[start + 4..];
        let end = after.find(')')?;
        let url = after[..end].trim().trim_matches(|c| c == '\'' || c == '"');
        let plain = url.len() <= 2048 && url.bytes().all(|b| b.is_ascii_graphic() && !matches!(b, b'\'' | b'"' | b'\\' | b'(' | b')'));
        if !plain || !url.starts_with(FONT_ORIGIN) {
            return None;
        }
        found.get_or_insert_with(|| url.to_string());
        rest = &after[end..];
    }
    found
}

/// Whether Google's answer is a stylesheet with no font in it: CSS (or nothing), not a web page,
/// and no `url(` anywhere.
fn fontless_css(css: &str) -> bool {
    let text = css.trim_start().to_ascii_lowercase();
    !text.contains("url(") && !text.starts_with('<') && !text.contains("<html") && !text.contains("<!doctype")
}

// ------------------------------------------------------------------------------------- cache

/// The saved catalog, by id, while its file is unchanged.
struct Index {
    stamp: (u64, SystemTime),
    families: Arc<HashMap<String, CatalogFamily>>,
}

/// Online previews: one per app (`AppState`), over its cache folder.
pub struct Previews {
    root: PathBuf,
    data_dir: PathBuf,
    /// About how many bytes the cache may hold.
    max_bytes: u64,
    /// Network trouble lately, and until when previews leave the network alone.
    backoff: Mutex<Backoff>,
    /// The cache's size in bytes, once measured.
    bytes: Mutex<Option<u64>>,
    /// Families being worked on: one request per family at a time, so two rows (or a row and its
    /// alphabet) never download the same file twice.
    busy: Mutex<HashSet<String>>,
    freed: Condvar,
    index: Mutex<Option<Index>>,
}

/// Holds a family for one request (see `Previews::busy`).
struct FamilyTurn<'a> {
    previews: &'a Previews,
    id: String,
}

impl Drop for FamilyTurn<'_> {
    fn drop(&mut self) {
        self.previews.busy.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.id);
        self.previews.freed.notify_all();
    }
}

/// Writes a file whole or not at all: a temporary file next to it, then a rename. Two writers
/// racing each leave a complete file; the last rename wins.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = path.parent().ok_or_else(|| std::io::Error::other("no parent folder"))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = dir.join(format!(".tmp-{name}-{nonce}-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let written = std::fs::File::create(&tmp)
        .and_then(|mut f| f.write_all(bytes).and_then(|_| f.sync_all()))
        .and_then(|_| std::fs::rename(&tmp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// Marks a saved file as just used (for eviction), at most once every `TOUCH_EVERY_SECS`.
fn touch(path: &Path) {
    let stale = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|m| SystemTime::now().duration_since(m).map_or(false, |age| age.as_secs() >= TOUCH_EVERY_SECS))
        .unwrap_or(false);
    if stale {
        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(path) {
            let _ = f.set_modified(SystemTime::now());
        }
    }
}

fn age_secs(meta: &std::fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|m| SystemTime::now().duration_since(m).ok()).map_or(0, |d| d.as_secs())
}

/// Every file under `dir`, with its size.
fn files_under(dir: &Path) -> Vec<(PathBuf, std::fs::Metadata)> {
    walkdir::WalkDir::new(dir)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| Some((e.path().to_path_buf(), e.metadata().ok()?)))
        .collect()
}

impl Previews {
    /// Previews kept in `root` (the cache folder, which needn't exist yet), for the catalog
    /// saved in `data_dir`.
    pub fn new(root: PathBuf, data_dir: PathBuf) -> Previews {
        {
            let mut roots = ROOTS.lock().unwrap_or_else(|p| p.into_inner());
            let real = root.parent().and_then(|p| std::fs::canonicalize(p).ok()).zip(root.file_name()).map(|(p, n)| p.join(n));
            for r in [Some(root.clone()), real].into_iter().flatten() {
                if !roots.contains(&r) {
                    roots.push(r);
                }
            }
        }
        Previews {
            root,
            data_dir,
            max_bytes: MAX_CACHE_BYTES,
            backoff: Mutex::new(Backoff::default()),
            bytes: Mutex::new(None),
            busy: Mutex::new(HashSet::new()),
            freed: Condvar::new(),
            index: Mutex::new(None),
        }
    }

    #[cfg(test)]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The preview for one family. `enabled` says whether previews are on (Settings); it's asked
    /// again before each request, so turning them off stops at once. Off, nothing is sent and
    /// nothing saved is used. Uses the network (blocking): run it on a blocking thread.
    pub fn preview(&self, id: &str, ask: Ask, enabled: &dyn Fn() -> bool) -> AppResult<GooglePreview> {
        if !valid_id(id) {
            return Err(AppError::Invalid(format!("{id} isn't a Google Fonts family id")));
        }
        if !enabled() {
            return Ok(GooglePreview::not(PreviewState::Off));
        }
        let Some(family) = self.families().and_then(|f| f.get(id).cloned()) else {
            return Ok(GooglePreview::not(PreviewState::Unavailable));
        };
        let token = token(&family.last_modified);
        let _turn = self.family_turn(id);
        self.drop_other_tokens(id, &token);
        let plan = plan(&family, ask);
        let mut fallback = None;
        for (i, (kind, held)) in plan.iter().enumerate() {
            let more = i + 1 < plan.len();
            match self.get(&family, &token, *kind, held, enabled) {
                // The name drew only as a jumble of its letters (a partial set): the script
                // sample that follows is a better preview, if it works out.
                Got::Ready(entry) if more && *kind == FileKind::Name && entry.sample => {
                    fallback = Some(ready(id, &token, *kind, entry));
                }
                Got::Ready(entry) => return Ok(ready(id, &token, *kind, entry)),
                Got::CantDraw if more => {}
                Got::CantDraw => return Ok(fallback.unwrap_or(GooglePreview::not(PreviewState::Unavailable))),
                Got::Not(state) => return Ok(fallback.unwrap_or(GooglePreview::not(state))),
            }
        }
        Ok(fallback.unwrap_or(GooglePreview::not(PreviewState::Unavailable)))
    }

    /// Waits until no other request works on this family, then holds it.
    fn family_turn(&self, id: &str) -> FamilyTurn<'_> {
        let mut busy = self.busy.lock().unwrap_or_else(|p| p.into_inner());
        while busy.contains(id) {
            busy = self.freed.wait(busy).unwrap_or_else(|p| p.into_inner());
        }
        busy.insert(id.to_string());
        FamilyTurn { previews: self, id: id.to_string() }
    }

    /// Holds a family if no request works on it now; None (without waiting) if one does.
    fn try_family_turn(&self, id: &str) -> Option<FamilyTurn<'_>> {
        let mut busy = self.busy.lock().unwrap_or_else(|p| p.into_inner());
        busy.insert(id.to_string()).then(|| FamilyTurn { previews: self, id: id.to_string() })
    }

    /// The saved catalog by id, read again whenever its file changes. Never uses the network.
    /// The first time a catalog is read, files of families and versions it no longer lists go.
    fn families(&self) -> Option<Arc<HashMap<String, CatalogFamily>>> {
        let stamp = saved_catalog_stamp(&self.data_dir)?;
        let (families, fresh) = {
            let mut index = self.index.lock().unwrap_or_else(|p| p.into_inner());
            match &*index {
                Some(i) if i.stamp == stamp => (i.families.clone(), false),
                _ => {
                    let (_, list) = saved_families(&self.data_dir)?;
                    let families: Arc<HashMap<String, CatalogFamily>> = Arc::new(list.into_iter().map(|f| (f.id.clone(), f)).collect());
                    *index = Some(Index { stamp, families: families.clone() });
                    (families, true)
                }
            }
        };
        if fresh && !families.is_empty() {
            self.sweep(&families);
        }
        Some(families)
    }

    /// Removes what the catalog no longer lists (families, and older versions of the rest),
    /// leftovers of interrupted writes and of an interrupted clear.
    fn sweep(&self, families: &HashMap<String, CatalogFamily>) {
        if let Some(parent) = self.root.parent() {
            for entry in std::fs::read_dir(parent).into_iter().flatten().flatten() {
                if entry.file_name().to_string_lossy().starts_with(&format!(".{DIR_NAME}-clearing-")) {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
        let Ok(entries) = std::fs::read_dir(&self.root) else { return };
        for entry in entries.flatten() {
            let id = entry.file_name().to_string_lossy().into_owned();
            match families.get(&id) {
                // A family being worked on is skipped: that request drops its older versions
                // itself, and the sweep never waits on the network (a font may be waiting on it).
                Some(f) => {
                    if let Some(_turn) = self.try_family_turn(&id) {
                        self.drop_other_tokens(&id, &token(&f.last_modified));
                        self.drop_leftovers(&entry.path().join(token(&f.last_modified)));
                    }
                }
                None if entry.path().is_dir() => {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
                None => {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        *self.bytes.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// Removes a family's files for every version but `token`'s.
    fn drop_other_tokens(&self, id: &str, token: &str) {
        for entry in std::fs::read_dir(self.root.join(id)).into_iter().flatten().flatten() {
            if entry.file_name() != token {
                let path = entry.path();
                let _ = if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
                *self.bytes.lock().unwrap_or_else(|p| p.into_inner()) = None;
            }
        }
    }

    /// In one family version's folder: temporary files, and halves of entries (a font without
    /// its details or the other way round), once they're old enough not to be mid-write.
    fn drop_leftovers(&self, dir: &Path) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(meta) = entry.metadata() else { continue };
            if age_secs(&meta) < LEFTOVER_SECS {
                continue;
            }
            let half = |ours: &str, other: &str| name.strip_suffix(ours).is_some_and(|stem| !dir.join(format!("{stem}{other}")).exists());
            if name.starts_with(".tmp-") || half(".ttf", ".json") || half(".json", ".ttf") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    fn dir(&self, id: &str, token: &str) -> PathBuf {
        self.root.join(id).join(token)
    }

    /// One file: saved already, a remembered failure, or downloaded now.
    fn get(&self, f: &CatalogFamily, token: &str, kind: FileKind, held: &str, enabled: &dyn Fn() -> bool) -> Got {
        let dir = self.dir(&f.id, token);
        let (font, details, fail) =
            (dir.join(format!("{}.ttf", kind.as_str())), dir.join(format!("{}.json", kind.as_str())), dir.join(format!("{}.fail", kind.as_str())));
        let remember = |why: Why| {
            let failed = Failed { at: now(), why, held: held.to_string(), rev: preview::PREVIEW_REV };
            let _ = std::fs::create_dir_all(&dir).and_then(|_| write_atomic(&fail, &serde_json::to_vec(&failed).unwrap_or_default()));
        };
        if let Some(entry) = read_json::<Entry>(&details).filter(|e| e.held == held) {
            if std::fs::metadata(&font).is_ok_and(|m| m.is_file() && m.len() <= MAX_FILE_BYTES) {
                if entry.rev == preview::PREVIEW_REV {
                    touch(&font);
                    return Got::Ready(entry);
                }
                if let Some(got) = self.profile_again(f, kind, held, &font, &details, &remember) {
                    return got;
                }
            }
        }
        if let Some(failed) = read_json::<Failed>(&fail).filter(|x| x.holds(held)) {
            return match failed.why {
                Why::CantDraw => Got::CantDraw,
                Why::TooLarge => Got::Not(PreviewState::TooLarge),
                Why::NotFound | Why::Broken => Got::Not(PreviewState::Unavailable),
            };
        }
        if self.paused() {
            return Got::Not(PreviewState::Offline);
        }
        if !enabled() {
            return Got::Not(PreviewState::Off);
        }
        // 1. Google's CSS, for the URL of the file. The CSS itself is thrown away.
        let css = match fetch_preview(&css_url(f, held), MAX_CSS_BYTES, CSS_ORIGIN) {
            Ok(css) => css,
            Err(e) => return self.failed(e, remember),
        };
        let css = String::from_utf8_lossy(&css);
        let Some(url) = font_url(&css) else {
            // A stylesheet with no font in it at all is Google's answer about this family, so it's
            // remembered like a "no" (and a family that always answers so can't keep pausing
            // every other row). Anything else (a Wi-Fi sign-in page, a font somewhere else) means
            // something between here and Google is off: network trouble.
            if fontless_css(&css) {
                self.network_fine();
                remember(Why::NotFound);
                return Got::Not(PreviewState::Unavailable);
            }
            self.network_trouble();
            return Got::Not(PreviewState::Offline);
        };
        if !enabled() {
            return Got::Not(PreviewState::Off);
        }
        // 2. The file.
        let bytes = match fetch_preview(&url, MAX_FILE_BYTES, FONT_ORIGIN) {
            Ok(bytes) => bytes,
            Err(e) => return self.failed(e, remember),
        };
        // Both hosts answered. (The CSS alone isn't enough: with fonts.gstatic.com out of reach,
        // every row would still ask fonts.googleapis.com again.)
        self.network_fine();
        // 3. What it draws, worked out like a library font's.
        let entry = match entry_for(f, kind, held, &bytes) {
            Ok(entry) => entry,
            Err(why) => {
                remember(why);
                return if why == Why::CantDraw { Got::CantDraw } else { Got::Not(PreviewState::Unavailable) };
            }
        };
        // 4. Saved: the font first, then its details, which make it count.
        let details_bytes = serde_json::to_vec(&entry).unwrap_or_default();
        let saved = std::fs::create_dir_all(&dir)
            .and_then(|_| write_atomic(&font, &bytes))
            .and_then(|_| write_atomic(&details, &details_bytes));
        if saved.is_err() {
            return Got::Not(PreviewState::Unavailable);
        }
        let _ = std::fs::remove_file(&fail);
        self.note_written(bytes.len() as u64 + details_bytes.len() as u64);
        Got::Ready(entry)
    }

    /// A saved file profiled with an older `PREVIEW_REV`: profiled again from the file, with no
    /// network, and its details saved again. None if the file isn't a usable font any more: it's
    /// removed, and asked for again like a file that was never saved.
    fn profile_again(&self, f: &CatalogFamily, kind: FileKind, held: &str, font: &Path, details: &Path, remember: &dyn Fn(Why)) -> Option<Got> {
        let old_size = std::fs::metadata(details).map_or(0, |m| m.len());
        let redone = std::fs::read(font).map_err(|_| Why::Broken).and_then(|bytes| entry_for(f, kind, held, &bytes));
        match redone {
            Ok(entry) => {
                let details_bytes = serde_json::to_vec(&entry).unwrap_or_default();
                // If this can't be saved, the answer is still right; the file is profiled again
                // next time.
                if write_atomic(details, &details_bytes).is_ok() {
                    let mut bytes = self.bytes.lock().unwrap_or_else(|p| p.into_inner());
                    *bytes = bytes.map(|b| (b + details_bytes.len() as u64).saturating_sub(old_size));
                }
                touch(font);
                Some(Got::Ready(entry))
            }
            Err(why) => {
                let _ = std::fs::remove_file(details);
                let _ = std::fs::remove_file(font);
                *self.bytes.lock().unwrap_or_else(|p| p.into_inner()) = None;
                // Profiles now say it draws nothing: on to the next file in the plan.
                (why == Why::CantDraw).then(|| {
                    remember(why);
                    Got::CantDraw
                })
            }
        }
    }

    /// A failed request: the family's fault (remembered for a week), or the network's (counted
    /// towards a pause, and nothing is remembered about the family).
    fn failed(&self, e: PreviewFetchError, remember: impl FnOnce(Why)) -> Got {
        match e {
            PreviewFetchError::TooLarge => {
                self.network_fine();
                remember(Why::TooLarge);
                Got::Not(PreviewState::TooLarge)
            }
            PreviewFetchError::Status(code) if (400..500).contains(&code) && code != 429 && code != 408 => {
                self.network_fine();
                remember(Why::NotFound);
                Got::Not(PreviewState::Unavailable)
            }
            PreviewFetchError::Status(_) | PreviewFetchError::Elsewhere | PreviewFetchError::Network(_) => {
                self.network_trouble();
                Got::Not(PreviewState::Offline)
            }
        }
    }

    /// Whether previews are leaving the network alone for now.
    fn paused(&self) -> bool {
        now() < self.backoff.lock().unwrap_or_else(|p| p.into_inner()).until
    }

    /// A request failed because of the network. After `OFFLINE_AFTER` in a row, previews pause:
    /// `FIRST_PAUSE_SECS`, then twice as long for each pause in a row, up to `OFFLINE_SECS`.
    /// Requests that were already running when a pause began don't make it longer.
    fn network_trouble(&self) {
        let mut b = self.backoff.lock().unwrap_or_else(|p| p.into_inner());
        let at = now();
        if at < b.until {
            return;
        }
        b.in_row = b.in_row.saturating_add(1);
        if b.in_row >= OFFLINE_AFTER {
            b.until = at + FIRST_PAUSE_SECS.saturating_mul(1 << b.pauses.min(16)).min(OFFLINE_SECS);
            b.pauses = b.pauses.saturating_add(1);
        }
    }

    /// Google answered for good (a file, or a final no for the family): the network works, so
    /// any pause ends and the count starts again.
    fn network_fine(&self) {
        *self.backoff.lock().unwrap_or_else(|p| p.into_inner()) = Backoff::default();
    }

    /// Counts a newly saved file; past the limit, the files used longest ago go until the cache
    /// is back under nine tenths of it.
    fn note_written(&self, added: u64) {
        let mut bytes = self.bytes.lock().unwrap_or_else(|p| p.into_inner());
        let total = match *bytes {
            Some(b) => b + added,
            None => files_under(&self.root).iter().map(|(_, m)| m.len()).sum(),
        };
        *bytes = Some(if total > self.max_bytes { self.evict(self.max_bytes / 10 * 9) } else { total });
    }

    /// Removes saved files, the ones used longest ago first, until the cache holds at most
    /// `target` bytes. A font and its details go together. Returns what's left.
    fn evict(&self, target: u64) -> u64 {
        let files = files_under(&self.root);
        let mut total: u64 = files.iter().map(|(_, m)| m.len()).sum();
        let mut fonts: Vec<(SystemTime, PathBuf, u64)> = files
            .iter()
            .filter(|(p, _)| p.extension().is_some_and(|e| e == "ttf"))
            .map(|(p, m)| {
                let details = p.with_extension("json");
                let size = m.len() + std::fs::metadata(&details).map_or(0, |d| d.len());
                (m.modified().unwrap_or(UNIX_EPOCH), p.clone(), size)
            })
            .collect();
        fonts.sort();
        for (_, font, size) in fonts {
            if total <= target {
                break;
            }
            let _ = std::fs::remove_file(font.with_extension("json"));
            let _ = std::fs::remove_file(&font);
            total = total.saturating_sub(size);
            // Its folders go too once empty (remove_dir refuses a folder with anything in it).
            if let Some(token_dir) = font.parent() {
                if std::fs::remove_dir(token_dir).is_ok() {
                    let _ = token_dir.parent().map(std::fs::remove_dir);
                }
            }
        }
        total
    }

    /// The cache's size in bytes, measured now.
    pub fn size(&self) -> u64 {
        let total = files_under(&self.root).iter().map(|(_, m)| m.len()).sum();
        *self.bytes.lock().unwrap_or_else(|p| p.into_inner()) = Some(total);
        total
    }

    /// Empties the cache, remembered failures included, and lets previews try the network again
    /// at once. The folder is moved aside first (one rename), so a file being saved meanwhile
    /// can't leave a half-cleared cache.
    pub fn clear(&self) -> AppResult<()> {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let aside = self.root.with_file_name(format!(".{DIR_NAME}-clearing-{nonce}"));
        match std::fs::rename(&self.root, &aside) {
            Ok(()) => std::fs::remove_dir_all(&aside)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => std::fs::remove_dir_all(&self.root)?,
        }
        *self.bytes.lock().unwrap_or_else(|p| p.into_inner()) = Some(0);
        self.network_fine();
        Ok(())
    }

    /// The file for `ff://localhost/google/<id>/<token>/<file kind>` (`rest` is what follows
    /// `google/`, already decoded): only a saved file of a family in the catalog, inside the
    /// cache folder. Never the network. None for anything else.
    pub fn resolve(&self, rest: &str) -> Option<PathBuf> {
        let mut parts = rest.split('/');
        let (id, token, kind) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() || !valid_id(id) || !valid_token(token) {
            return None;
        }
        let kind = FileKind::parse(kind)?;
        if !self.families()?.contains_key(id) {
            return None;
        }
        let path = self.dir(id, token).join(format!("{}.ttf", kind.as_str()));
        let meta = std::fs::symlink_metadata(&path).ok()?;
        (meta.is_file() && meta.len() <= MAX_FILE_BYTES).then_some(path)
    }

    /// The bytes `resolve` finds, marking the file as used.
    pub fn serve(&self, rest: &str) -> Option<Vec<u8>> {
        let path = self.resolve(rest)?;
        let bytes = std::fs::read(&path).ok()?;
        touch(&path);
        Some(bytes)
    }
}

/// What a downloaded (or saved) file holds for a row, worked out like a library font's
/// profile. `Why::Broken` if it isn't a usable font, `Why::CantDraw` if nothing in it draws.
fn entry_for(f: &CatalogFamily, kind: FileKind, held: &str, bytes: &[u8]) -> Result<Entry, Why> {
    let face = ttf_parser::Face::parse(bytes, 0).map_err(|_| Why::Broken)?;
    let names = profile::Names { family: &f.family, subfamily: "", full: &f.family, postscript: "", file_stem: "" };
    let p = preview::profile_safely(&face, &names);
    if p.kind == profile::Kind::None {
        return Err(Why::CantDraw);
    }
    let mut info = PreviewInfo::from_profile(&p);
    // The other files hold just a few characters on purpose, so only the alphabet's missing
    // characters mean what they do in the library. A name file keeps the ones it was asked
    // for and lacks (a capitals-only font's lowercase), so the View options' case isn't
    // applied to a name the font can't draw in it.
    match kind {
        FileKind::Alphabet => {}
        FileKind::Name => info.ascii_missing.retain(|c| held.contains(c)),
        FileKind::Icons | FileKind::Script => info.ascii_missing.clear(),
    }
    let (text, sample) = match kind {
        FileKind::Icons => {
            info.family_text = Some(ICON_PREVIEW.to_string());
            (ICON_PREVIEW.to_string(), true)
        }
        FileKind::Alphabet => (held.to_string(), false),
        FileKind::Name | FileKind::Script => (p.family_text.clone().unwrap_or_else(|| f.family.clone()), p.kind.is_sample()),
    };
    Ok(Entry { held: held.to_string(), text, sample, profile: info, rev: preview::PREVIEW_REV })
}

/// A small JSON file, if it's there and reads.
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    if std::fs::metadata(path).ok()?.len() > 64 * 1024 {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn ready(id: &str, token: &str, kind: FileKind, entry: Entry) -> GooglePreview {
    GooglePreview {
        state: PreviewState::Ready,
        path: Some(format!("google/{id}/{token}/{}", kind.as_str())),
        text: Some(entry.text),
        sample: Some(entry.sample),
        profile: Some(entry.profile),
    }
}

#[cfg(test)]
mod tests;
