//! Listen and log: a test of auto-activation (macOS only, off unless asked for at launch).
//!
//! When an app needs a font that isn't on, macOS can ask a font manager for it. Before Fontface
//! answers such requests, this test finds out which apps ask, how often, and what a request
//! holds. Started with `FONTFACE_LISTEN_FONT_REQUESTS=1` in the environment, Fontface listens
//! (listen.rs) and writes one JSON line per request to `font-requests.jsonl` in its log folder
//! (~/Library/Logs/design.snds.fontface): when, which process and app asked, the names it asked
//! for, and whether the library has each one, found by the app's one name matcher (font_names).
//!
//! It never turns anything on. Every request is answered "no fonts", so the asking app behaves
//! exactly as if Fontface weren't there. It reads the library (through the app's own database
//! connection, briefly) and the asking app's Info.plist; it writes only its own log, which
//! starts again when it reaches MAX_LOG_BYTES (the one before is kept as font-requests.1.jsonl).
//!
//! docs/AUTO-ACTIVATION-TEST.md says how to run it and read the log.

mod listen;
#[cfg(test)]
mod tests;

use std::{
    collections::HashSet,
    ffi::OsStr,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering::Relaxed},
        mpsc::{sync_channel, Receiver, SyncSender, TrySendError},
        OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{
    font_names::{How, LineMatch, NameIndex, NameLine},
    AppState,
};

/// Set to 1 at launch to run the test.
pub const ENV_VAR: &str = "FONTFACE_LISTEN_FONT_REQUESTS";
/// The log, in Fontface's log folder.
pub const LOG_NAME: &str = "font-requests.jsonl";
/// The log before the current one.
pub const OLD_LOG_NAME: &str = "font-requests.1.jsonl";
/// The log starts again past this size, keeping the one before (so at most about twice this).
pub const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;
/// Requests waiting for the log's thread. Past this many, more are counted, not logged.
const QUEUE: usize = 1024;
/// The library is read again for requests after this long (it may have changed).
const INDEX_FOR: Duration = Duration::from_secs(10);
/// At most this many styles are named for one font asked for (the count says how many).
const STYLES_NAMED: usize = 8;

/// True when the variable asks for the test: "1", "true" or "yes".
pub fn asked(value: Option<&OsStr>) -> bool {
    value.and_then(OsStr::to_str).is_some_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
}

enum Message {
    /// Whether listening started, and if not, why.
    Started(Result<(), String>),
    Request(Queued),
}

/// A request as the callback queued it.
pub struct Queued {
    /// Unix milliseconds.
    pub at_ms: u64,
    pub pid: i32,
    pub request: Value,
}

static QUEUE_TX: OnceLock<SyncSender<Message>> = OnceLock::new();
/// Requests dropped because the queue was full, since the last one logged.
static DROPPED: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The callback's side: queue the request and return at once (it never waits).
fn queue_request(pid: i32, request: Value) {
    let Some(tx) = QUEUE_TX.get() else { return };
    if let Err(TrySendError::Full(_)) = tx.try_send(Message::Request(Queued { at_ms: now_ms(), pid, request })) {
        DROPPED.fetch_add(1, Relaxed);
    }
}

/// Starts the test if FONTFACE_LISTEN_FONT_REQUESTS asks for it; otherwise does nothing.
pub fn start_if_asked(app: &AppHandle) {
    if !asked(std::env::var_os(ENV_VAR).as_deref()) {
        return;
    }
    let dir = match app.path().app_log_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("fontface: can't log font requests, no log folder: {e}");
            return;
        }
    };
    let (tx, rx) = sync_channel(QUEUE);
    if QUEUE_TX.set(tx.clone()).is_err() {
        return; // already listening
    }
    let worker = Worker { app: app.clone(), log: dir.join(LOG_NAME), old: dir.join(OLD_LOG_NAME), index: None };
    eprintln!("fontface: logging font requests from other apps to {}", worker.log.display());
    if let Err(e) = std::thread::Builder::new().name("font-requests".into()).spawn(move || worker.run(rx)) {
        eprintln!("fontface: can't log font requests: {e}");
        return;
    }
    // CoreText delivers requests on the run loop the source is added to: the main one.
    let started = app.run_on_main_thread(move || {
        let _ = tx.try_send(Message::Started(listen::start(queue_request)));
    });
    if let Err(e) = started {
        if let Some(tx) = QUEUE_TX.get() {
            let _ = tx.try_send(Message::Started(Err(format!("couldn't reach the main thread: {e}"))));
        }
    }
}

// ---------------------------------------------------------------------------- the log's thread

struct Worker {
    app: AppHandle,
    log: PathBuf,
    old: PathBuf,
    /// The library as last read, and when.
    index: Option<(Instant, NameIndex)>,
}

impl Worker {
    fn run(mut self, rx: Receiver<Message>) {
        for message in rx {
            // One odd request must not stop the log: a panic skips just that line.
            let line = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.line(message)));
            match line {
                Ok(Some(line)) => {
                    if let Err(e) = append_line(&self.log, &self.old, &line, MAX_LOG_BYTES) {
                        eprintln!("fontface: couldn't write the font request log: {e}");
                    }
                }
                Ok(None) => {}
                Err(_) => eprintln!("fontface: a font request couldn't be logged"),
            }
        }
    }

    fn line(&mut self, message: Message) -> Option<String> {
        match message {
            Message::Started(Ok(())) => {
                let line = json!({
                    "event": "listening",
                    "time": iso_ms(now_ms()),
                    "fontface": self.app.package_info().version.to_string(),
                    "macos": macos_version(),
                    "autoActivation": listen::auto_activation_setting(None).map(setting_name),
                    "answer": ANSWER,
                });
                Some(line.to_string())
            }
            Message::Started(Err(reason)) => {
                eprintln!("fontface: not listening for font requests: {reason}");
                // The same details as a listening line, so the log reads on its own.
                let line = json!({
                    "event": "not-listening",
                    "time": iso_ms(now_ms()),
                    "reason": reason,
                    "fontface": self.app.package_info().version.to_string(),
                    "macos": macos_version(),
                    "autoActivation": listen::auto_activation_setting(None).map(setting_name),
                });
                Some(line.to_string())
            }
            Message::Request(q) => {
                let asker = asker_of(q.pid);
                let setting = asker.app.as_ref().or(asker.process.as_ref()).and_then(|b| b.bundle_id.as_deref()).and_then(|id| listen::auto_activation_setting(Some(id)));
                let wanted = requested_fonts(&q.request);
                let (fonts, library_error) = match self.look_up(&wanted) {
                    Ok(answers) => (wanted.into_iter().zip(answers.into_iter().map(Some)).collect(), None),
                    Err(e) => (wanted.into_iter().map(|w| (w, None)).collect(), Some(e)),
                };
                let dropped = DROPPED.swap(0, Relaxed);
                Some(request_line(&q, &asker, setting.map(setting_name), fonts, library_error, dropped))
            }
        }
    }

    /// Whether the library has each font, by the shared matcher, with what's on now.
    fn look_up(&mut self, wanted: &[RequestedFont]) -> Result<Vec<LibraryAnswer>, String> {
        if wanted.is_empty() {
            return Ok(vec![]);
        }
        let state = self.app.try_state::<AppState>().ok_or("the library isn't open yet")?;
        let conn = state.conn().map_err(|e| e.to_string())?;
        if self.index.as_ref().is_none_or(|(at, _)| at.elapsed() > INDEX_FOR) {
            self.index = Some((Instant::now(), NameIndex::load(&conn).map_err(|e| e.to_string())?));
        }
        let on = activated_ids(&conn).map_err(|e| e.to_string())?;
        drop(conn);
        let (_, index) = self.index.as_ref().expect("just loaded");
        let lines: Vec<NameLine> = wanted.iter().map(name_line).collect();
        let matches = index.match_lines(&lines, is_online_only);
        Ok(matches.into_iter().map(|m| library_answer(m, &on)).collect())
    }
}

/// Every font row Fontface has on now. Reads only.
fn activated_ids(conn: &Connection) -> rusqlite::Result<HashSet<i64>> {
    let mut stmt = conn.prepare_cached("SELECT id FROM fonts WHERE activated = 1")?;
    let ids = stmt.query_map([], |r| r.get(0))?.collect();
    ids
}

/// True for an online-only cloud placeholder. Looks at the file's details only.
fn is_online_only(path: &str) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| crate::cloud::is_dataless(&m))
}

/// Every request's answer, for the log.
const ANSWER: &str = "no fonts (listen and log only)";

// ------------------------------------------------------------------------------ what was asked

/// CoreText's names for a font descriptor's name attributes (kCTFontNameAttribute and its
/// neighbours, which tests check against CoreText's own constants).
pub const POSTSCRIPT_KEY: &str = "NSFontNameAttribute";
pub const FAMILY_KEY: &str = "NSFontFamilyAttribute";
pub const STYLE_KEY: &str = "NSFontFaceAttribute";
pub const DISPLAY_KEY: &str = "NSFontVisibleNameAttribute";

/// A font a request names: whichever of its names it gives.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestedFont {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub postscript_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

/// The fonts a request names: every dictionary in it (at any depth) with a name attribute. A
/// request that's only a string is a PostScript name.
pub fn requested_fonts(request: &Value) -> Vec<RequestedFont> {
    fn walk(v: &Value, out: &mut Vec<RequestedFont>) {
        match v {
            Value::Object(map) => {
                let name = |key: &str| map.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
                let font = RequestedFont { postscript_name: name(POSTSCRIPT_KEY), family: name(FAMILY_KEY), style: name(STYLE_KEY), display_name: name(DISPLAY_KEY) };
                if font != RequestedFont::default() && !out.contains(&font) {
                    out.push(font);
                }
                for (key, value) in map {
                    if ![POSTSCRIPT_KEY, FAMILY_KEY, STYLE_KEY, DISPLAY_KEY].contains(&key.as_str()) {
                        walk(value, out);
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|item| walk(item, out)),
            _ => {}
        }
    }
    if let Some(name) = request.as_str().map(str::trim).filter(|s| !s.is_empty()) {
        return vec![RequestedFont { postscript_name: Some(name.to_string()), ..Default::default() }];
    }
    let mut out = Vec::new();
    walk(request, &mut out);
    out
}

/// What the matcher is asked for one font: its PostScript name first, then family and style;
/// else the name it's shown by.
pub fn name_line(font: &RequestedFont) -> NameLine {
    if font.postscript_name.is_some() || font.family.is_some() {
        return NameLine::Font { postscript_name: font.postscript_name.clone(), family: font.family.clone(), style: font.style.clone() };
    }
    NameLine::Text(font.display_name.clone().unwrap_or_default())
}

/// Whether the library has a font asked for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAnswer {
    /// The library has a match.
    pub has_match: bool,
    /// The matcher's rule that found it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub how: Option<How>,
    /// How many styles match, how many of them are on now (in macOS Fonts, or turned on by
    /// Fontface), and how many are online-only.
    pub styles: usize,
    pub on: usize,
    pub online_only: usize,
    /// The first few, as "Family Style (PostScript name)".
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub names: Vec<String>,
    /// With no match: the library's closest names.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub near: Vec<String>,
}

pub fn library_answer(m: LineMatch, on: &HashSet<i64>) -> LibraryAnswer {
    let is_on = |f: &crate::font_names::FoundFace| f.installed || f.ids.iter().any(|id| on.contains(id));
    LibraryAnswer {
        has_match: !m.faces.is_empty(),
        how: m.how,
        styles: m.faces.len(),
        on: m.faces.iter().filter(|f| is_on(f)).count(),
        online_only: m.faces.iter().filter(|f| f.online_only).count(),
        names: m
            .faces
            .iter()
            .take(STYLES_NAMED)
            .map(|f| match &f.postscript_name {
                Some(ps) => format!("{} {} ({ps})", f.family, f.style),
                None => format!("{} {}", f.family, f.style),
            })
            .collect(),
        near: m.near,
    }
}

// ----------------------------------------------------------------------------- who asked

/// An app bundle, or a helper or extension bundle inside one.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    pub path: String,
}

/// The process that asked: its program, the app it belongs to, and its own bundle when that's a
/// helper inside the app (a browser's renderer, an app's extension).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asker {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<Bundle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process: Option<Bundle>,
}

/// The program a process runs, from its id. None when it's gone or not ours to look at.
fn executable_of(pid: i32) -> Option<String> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the buffer is as long as said.
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    String::from_utf8(buf).ok()
}

fn asker_of(pid: i32) -> Asker {
    executable_of(pid).map(|exe| asker_from_executable(Path::new(&exe))).unwrap_or_default()
}

/// The bundles a program sits in: the outermost .app is the app; the innermost bundle (.app,
/// .appex or .xpc) is the process's own, when it isn't the app itself.
pub fn asker_from_executable(exe: &Path) -> Asker {
    let bundles: Vec<&Path> = exe
        .ancestors()
        .skip(1)
        .filter(|p| p.extension().and_then(OsStr::to_str).is_some_and(|e| matches!(e, "app" | "appex" | "xpc")))
        .collect();
    let app = bundles.iter().rev().find(|p| p.extension() == Some(OsStr::new("app"))).copied();
    let own = bundles.first().copied().filter(|p| Some(*p) != app);
    Asker { executable: Some(exe.to_string_lossy().into_owned()), app: app.map(bundle_at), process: own.map(bundle_at) }
}

/// A bundle's name and id, from its Info.plist (read only); its folder name if that can't be read.
pub fn bundle_at(path: &Path) -> Bundle {
    let plist = plist::Value::from_file(path.join("Contents/Info.plist")).ok();
    let dict = plist.as_ref().and_then(plist::Value::as_dictionary);
    let field = |key: &str| dict.and_then(|d| d.get(key)).and_then(plist::Value::as_string).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let folder = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    Bundle {
        name: field("CFBundleDisplayName").or_else(|| field("CFBundleName")).unwrap_or(folder),
        bundle_id: field("CFBundleIdentifier"),
        path: path.to_string_lossy().into_owned(),
    }
}

/// macOS's version ("27.0.1"), from its own SystemVersion.plist.
fn macos_version() -> Option<String> {
    let v = plist::Value::from_file("/System/Library/CoreServices/SystemVersion.plist").ok()?;
    v.as_dictionary()?.get("ProductVersion")?.as_string().map(String::from)
}

/// An auto-activation setting's name (CTFontManagerAutoActivationSetting). "default" follows the
/// global setting.
pub fn setting_name(setting: u32) -> &'static str {
    match setting {
        0 => "default",
        1 => "disabled",
        2 => "enabled",
        3 => "prompt-user",
        _ => "unknown",
    }
}

// ------------------------------------------------------------------------------------ the log

/// Unix milliseconds → "2026-10-19T18:30:05.123Z".
pub fn iso_ms(ms: u64) -> String {
    let secs = crate::tags::export::iso8601((ms / 1000) as i64);
    format!("{}.{:03}Z", secs.trim_end_matches('Z'), ms % 1000)
}

/// One request's line: when, who asked, what for, what the library has, and the answer.
pub fn request_line(
    q: &Queued,
    asker: &Asker,
    setting: Option<&str>,
    fonts: Vec<(RequestedFont, Option<LibraryAnswer>)>,
    library_error: Option<String>,
    dropped: u64,
) -> String {
    let fonts: Vec<Value> = fonts
        .into_iter()
        .map(|(font, library)| {
            let mut v = serde_json::to_value(&font).unwrap_or(Value::Null);
            if let (Value::Object(map), Some(library)) = (&mut v, library) {
                map.insert("library".into(), serde_json::to_value(library).unwrap_or(Value::Null));
            }
            v
        })
        .collect();
    let mut line = json!({
        "event": "request",
        "time": iso_ms(q.at_ms),
        "pid": q.pid,
        "asker": asker,
        "autoActivation": setting,
        "fonts": fonts,
        "request": q.request,
        "answer": ANSWER,
    });
    if let Some(e) = library_error {
        line["libraryError"] = Value::String(e);
    }
    if dropped > 0 {
        line["dropped"] = Value::from(dropped);
    }
    line.to_string()
}

/// Adds a line to the log. Past `max` bytes, the log starts again and the one before becomes
/// `old` (replacing the older one).
pub fn append_line(log: &Path, old: &Path, line: &str, max: u64) -> std::io::Result<()> {
    if let Some(dir) = log.parent() {
        fs::create_dir_all(dir)?;
    }
    let size = fs::metadata(log).map(|m| m.len()).unwrap_or(0);
    if size > 0 && size + line.len() as u64 + 1 > max {
        fs::rename(log, old)?;
    }
    let mut file = fs::OpenOptions::new().create(true).append(true).open(log)?;
    file.write_all(format!("{line}\n").as_bytes())
}
