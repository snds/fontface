//! Cloud font services.
//!
//! Two kinds of integration, both license-safe (see docs/INTEGRATIONS.md):
//! - **Download services** (Google Fonts): open-licensed fonts are downloaded into a folder
//!   Fontface manages (`<app data>/Services/<Service>/`). That folder is a library folder of kind
//!   `service`, scanned and activated like any other, so downloaded fonts appear everywhere.
//! - **Managed by another app** (Adobe Fonts): read-only. Fontface lists what that app has
//!   already turned on, through the OS font APIs, and never opens, copies or (de)activates its files.
//! - **Online previews** (Google Fonts): tiny files that let the Google Fonts page show families
//!   that aren't downloaded in their own font. Kept in the app's cache folder, never scanned or
//!   turned on (see google/previews.rs, and `fetch_preview` here).

pub mod adobe;
pub mod google;
pub mod purchase_watch;
pub mod purchases;

use std::{
    path::{Path, PathBuf},
    sync::{Condvar, Mutex},
    time::Duration,
};

use rusqlite::Connection;

use crate::{
    db,
    error::{AppError, AppResult},
};

/// (service id, folder name) for every service with a folder Fontface manages.
pub const DOWNLOAD_SERVICES: &[(&str, &str)] = &[("google", "Google Fonts"), ("purchases", "Purchases")];

pub fn services_root(data_dir: &Path) -> PathBuf {
    data_dir.join("Services")
}

pub fn service_dir(data_dir: &Path, id: &str) -> Option<PathBuf> {
    DOWNLOAD_SERVICES.iter().find(|(s, _)| *s == id).map(|(_, name)| services_root(data_dir).join(name))
}

/// Which download service a managed folder belongs to, if any.
pub fn service_for_path(data_dir: &Path, path: &Path) -> Option<&'static str> {
    let root = std::fs::canonicalize(services_root(data_dir)).ok()?;
    DOWNLOAD_SERVICES.iter().find(|(_, name)| path == root.join(name)).map(|(id, _)| *id)
}

/// Creates each service's managed folder and makes sure it's in the library as kind `service`.
pub fn ensure_service_folders(conn: &mut Connection, data_dir: &Path) -> AppResult<()> {
    sweep_leftovers(data_dir);
    purchases::sweep_leftovers(data_dir);
    purchases::ensure_schema(conn)?;
    for (_, name) in DOWNLOAD_SERVICES {
        let dir = services_root(data_dir).join(name);
        std::fs::create_dir_all(&dir)?;
        let canonical = std::fs::canonicalize(&dir)?;
        let path = canonical.to_string_lossy().into_owned();
        let updated = conn.execute("UPDATE folders SET kind = 'service' WHERE path = ?1", [&path])?;
        if updated == 0 {
            match db::insert_folder(conn, &canonical, "service") {
                Ok(_) | Err(AppError::Invalid(_)) => {}
                Err(e) => return Err(e),
            }
        }
    }
    Ok(())
}

const USER_AGENT: &str = concat!("Fontface/", env!("CARGO_PKG_VERSION"), " (personal desktop font manager)");

/// How long a whole request may take, including reading the body.
#[derive(Clone, Copy)]
pub enum Deadline {
    /// Catalogs, manifests, license files.
    Small,
    /// Font files (some CJK families are tens of MB).
    Large,
    /// Google Fonts previews: a tiny file each, asked for while the user scrolls, so a slow
    /// answer is given up on quickly (see `fetch_preview`).
    Preview,
}

impl Deadline {
    fn duration(self) -> Duration {
        match self {
            Deadline::Small => Duration::from_secs(60),
            Deadline::Large => Duration::from_secs(10 * 60),
            Deadline::Preview => Duration::from_secs(10),
        }
    }

    /// How long connecting may take.
    fn connect(self) -> Duration {
        match self {
            Deadline::Preview => Duration::from_secs(5),
            _ => Duration::from_secs(15),
        }
    }

    /// How many open connections to one host an agent keeps for its next requests. Previews run
    /// up to `MAX_PREVIEW_FETCHES` requests at once through one shared agent, so it keeps that
    /// many; with ureq's default of one, the others would close and the next requests would
    /// each start a new connection. Other agents serve one request (see `agent`).
    fn idle_per_host(self) -> usize {
        match self {
            Deadline::Preview => MAX_PREVIEW_FETCHES,
            _ => 1,
        }
    }
}

/// An HTTP(S) proxy from the environment, if one applies to `host`. SOCKS proxies are skipped
/// (this build can't use them), and NO_PROXY is respected.
fn proxy_for(host: &str) -> Option<ureq::Proxy> {
    let var = |names: &[&str]| names.iter().find_map(|n| std::env::var(n).ok().filter(|v| !v.trim().is_empty()));
    if let Some(no_proxy) = var(&["NO_PROXY", "no_proxy"]) {
        let host = host.to_ascii_lowercase();
        let excluded = no_proxy.split(',').map(|s| s.trim().trim_start_matches('.').to_ascii_lowercase()).any(|rule| {
            rule == "*" || (!rule.is_empty() && (host == rule || host.ends_with(&format!(".{rule}"))))
        });
        if excluded {
            return None;
        }
    }
    ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
        .iter()
        .filter_map(|n| std::env::var(n).ok())
        .filter(|v| !v.trim().is_empty() && !v.trim().to_ascii_lowercase().starts_with("socks"))
        .find_map(|v| ureq::Proxy::new(v.trim()).ok())
}

/// What went wrong with a request. A 404 is told apart because "not there" is often a normal answer.
pub enum Fetch {
    NotFound,
    Failed(AppError),
}

impl From<Fetch> for AppError {
    fn from(f: Fetch) -> Self {
        match f {
            Fetch::NotFound => AppError::NotFound("not found".into()),
            Fetch::Failed(e) => e,
        }
    }
}

/// The host a URL names, without its port.
fn host_name(url: &str) -> &str {
    url.split("://").nth(1).and_then(|r| r.split(['/', ':', '?']).next()).unwrap_or("")
}

fn agent(url: &str, deadline: Deadline) -> ureq::Agent {
    let host = host_name(url);
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(deadline.connect())
        .timeout(deadline.duration())
        .max_idle_connections_per_host(deadline.idle_per_host())
        .user_agent(USER_AGENT);
    if let Some(proxy) = proxy_for(host) {
        builder = builder.proxy(proxy);
    }
    builder.build()
}

/// What a download returned.
pub enum Fetched {
    /// The file, with the server's ETag (a tag naming this version of the file), if it sent one.
    Body { bytes: Vec<u8>, etag: Option<String> },
    /// The copy the caller already has, named by its ETag, is still current (HTTP 304).
    NotModified,
}

/// Downloads into memory, refusing anything larger than `max` bytes or slower than `deadline`.
pub fn fetch_bytes(url: &str, max: u64, deadline: Deadline) -> Result<Vec<u8>, Fetch> {
    match fetch(url, max, deadline, None)? {
        Fetched::Body { bytes, .. } => Ok(bytes),
        Fetched::NotModified => Err(not_modified_unasked(url)),
    }
}

/// Like `fetch_bytes`, and also returns the file's ETag. With `if_none_match` (the ETag of a
/// copy the caller has), the server may answer that the file hasn't changed instead of sending
/// it again.
pub fn fetch(url: &str, max: u64, deadline: Deadline, if_none_match: Option<&str>) -> Result<Fetched, Fetch> {
    #[cfg(test)]
    if let Some(answer) = fake_net::answer(url, if_none_match) {
        return match answer? {
            Fetched::Body { bytes, .. } if bytes.len() as u64 > max => Err(too_large(url)),
            fetched => Ok(fetched),
        };
    }
    fetch_from_network(url, max, deadline, if_none_match)
}

/// A failed request, in plain words. A 404 is told apart (see `Fetch`).
fn request_error(url: &str, e: ureq::Error) -> Fetch {
    match e {
        ureq::Error::Status(404, _) => Fetch::NotFound,
        ureq::Error::Status(429, _) => {
            Fetch::Failed(AppError::Other(format!("{} is limiting requests right now. Try again in a few minutes.", host_of(url))))
        }
        ureq::Error::Status(code, _) => Fetch::Failed(AppError::Other(format!("{} answered {code}", host_of(url)))),
        other => Fetch::Failed(AppError::Other(format!("Couldn't reach {}: {other}", host_of(url)))),
    }
}

fn fetch_from_network(url: &str, max: u64, deadline: Deadline, if_none_match: Option<&str>) -> Result<Fetched, Fetch> {
    use std::io::Read;
    let mut request = agent(url, deadline).get(url);
    if let Some(tag) = if_none_match {
        request = request.set("If-None-Match", tag);
    }
    let response = request.call().map_err(|e| request_error(url, e))?;
    if response.status() == 304 {
        return if if_none_match.is_some() { Ok(Fetched::NotModified) } else { Err(not_modified_unasked(url)) };
    }
    let etag = response.header("etag").and_then(usable_etag);
    let mut body = Vec::new();
    response
        .into_reader()
        .take(max + 1)
        .read_to_end(&mut body)
        .map_err(|e| Fetch::Failed(AppError::Other(format!("Download from {} failed: {e}", host_of(url)))))?;
    if body.len() as u64 > max {
        return Err(too_large(url));
    }
    Ok(Fetched::Body { bytes: body, etag })
}

/// Asks whether a file changed, without downloading it: a HEAD request carrying the ETag of the
/// copy the caller has. Returns the file's current ETag: that same one when the server answers
/// 304 (not modified), else the one the server sends (None if it sends none).
pub fn current_etag(url: &str, if_none_match: &str) -> Result<Option<String>, Fetch> {
    #[cfg(test)]
    if let Some(answer) = fake_net::answer_head(url, if_none_match) {
        return answer;
    }
    let response = agent(url, Deadline::Small)
        .head(url)
        .set("If-None-Match", if_none_match)
        .call()
        .map_err(|e| request_error(url, e))?;
    if response.status() == 304 {
        return Ok(Some(if_none_match.to_string()));
    }
    Ok(response.header("etag").and_then(usable_etag))
}

/// An ETag worth keeping: short, printable ASCII (so it can be sent back as a header as is).
fn usable_etag(tag: &str) -> Option<String> {
    let tag = tag.trim();
    (!tag.is_empty() && tag.len() <= 200 && tag.bytes().all(|b| (0x20..0x7F).contains(&b))).then(|| tag.to_string())
}

fn too_large(url: &str) -> Fetch {
    Fetch::Failed(AppError::Invalid(format!("A download from {} was larger than expected", host_of(url))))
}

fn not_modified_unasked(url: &str) -> Fetch {
    Fetch::Failed(AppError::Other(format!("{} answered 304 to a plain request", host_of(url))))
}

// ------------------------------------------------------------------------------ previews

/// At most this many preview requests run at once, whatever the UI asks for.
pub const MAX_PREVIEW_FETCHES: usize = 6;

/// Why a preview request failed (see `fetch_preview`).
#[derive(Debug, Clone, PartialEq)]
pub enum PreviewFetchError {
    /// The server answered with this HTTP status.
    Status(u16),
    /// The answer was larger than allowed.
    TooLarge,
    /// The answer came from somewhere else: a redirect left the expected host.
    Elsewhere,
    /// The network: no connection, a DNS failure, a timeout, a proxy that refused, or a download
    /// that broke off.
    Network(String),
}

/// The agent preview requests to one host share. One agent keeps its connections open (as many
/// as run at once, `Deadline::idle_per_host`), so the many small requests of a scroll don't
/// each start a new TLS handshake (`agent` builds a new one for every request, which is fine
/// for the occasional catalog or install). Each host gets its own, with the proxy that applies
/// to it (NO_PROXY may name one host and not the other).
fn preview_agent(url: &str) -> ureq::Agent {
    static AGENTS: Mutex<Vec<(String, ureq::Agent)>> = Mutex::new(Vec::new());
    let host = host_name(url).to_ascii_lowercase();
    let mut agents = AGENTS.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((_, agent)) = agents.iter().find(|(h, _)| *h == host) {
        return agent.clone();
    }
    let built = agent(url, Deadline::Preview);
    agents.push((host, built.clone()));
    built
}

/// Preview requests running now.
static PREVIEW_FETCHES: Mutex<usize> = Mutex::new(0);
static PREVIEW_FETCH_DONE: Condvar = Condvar::new();

/// A turn to make a preview request: waits while `MAX_PREVIEW_FETCHES` are running, and gives
/// the turn back when dropped.
struct PreviewTurn;

impl PreviewTurn {
    fn take() -> PreviewTurn {
        let mut running = PREVIEW_FETCHES.lock().unwrap_or_else(|p| p.into_inner());
        while *running >= MAX_PREVIEW_FETCHES {
            running = PREVIEW_FETCH_DONE.wait(running).unwrap_or_else(|p| p.into_inner());
        }
        *running += 1;
        PreviewTurn
    }
}

impl Drop for PreviewTurn {
    fn drop(&mut self) {
        let mut running = PREVIEW_FETCHES.lock().unwrap_or_else(|p| p.into_inner());
        *running = running.saturating_sub(1);
        PREVIEW_FETCH_DONE.notify_one();
    }
}

/// Downloads a small file for a Google Fonts preview: through the shared agent for its host,
/// with the short `Deadline::Preview`, at most `MAX_PREVIEW_FETCHES` at once, refusing anything
/// over `max` bytes. The answer must come from a URL starting with `expected` (a redirect
/// elsewhere is refused). Blocks: never call it on the main thread or an async worker.
pub fn fetch_preview(url: &str, max: u64, expected: &str) -> Result<Vec<u8>, PreviewFetchError> {
    let _turn = PreviewTurn::take();
    #[cfg(test)]
    if let Some(answer) = fake_net::answer_preview(url) {
        return match answer? {
            bytes if bytes.len() as u64 > max => Err(PreviewFetchError::TooLarge),
            bytes => Ok(bytes),
        };
    }
    use std::io::Read;
    if !url.starts_with(expected) {
        return Err(PreviewFetchError::Elsewhere);
    }
    let response = match preview_agent(url).get(url).call() {
        Ok(r) => r,
        Err(ureq::Error::Status(code, _)) => return Err(PreviewFetchError::Status(code)),
        Err(e) => return Err(PreviewFetchError::Network(format!("Couldn't reach {}: {e}", host_of(url)))),
    };
    if !response.get_url().starts_with(expected) {
        return Err(PreviewFetchError::Elsewhere);
    }
    let mut body = Vec::new();
    response
        .into_reader()
        .take(max + 1)
        .read_to_end(&mut body)
        .map_err(|e| PreviewFetchError::Network(format!("Download from {} failed: {e}", host_of(url))))?;
    if body.len() as u64 > max {
        return Err(PreviewFetchError::TooLarge);
    }
    Ok(body)
}

/// Tests only: answers requests from a table instead of the network, so tests never go online.
#[cfg(test)]
pub mod fake_net {
    use std::{cell::RefCell, collections::HashMap};

    use super::{Fetch, Fetched, PreviewFetchError};
    use crate::error::AppError;

    /// How a URL fails instead of answering (see `fail`).
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub enum Failure {
        /// The server answers with this HTTP status.
        Status(u16),
        /// No answer at all: no connection, a DNS failure or a timeout.
        Offline,
    }

    thread_local! {
        /// URL → (body, ETag), while a test serves this thread.
        static ROUTES: RefCell<Option<HashMap<String, (Vec<u8>, Option<String>)>>> = const { RefCell::new(None) };
        /// URL → how it fails instead of answering (see `fail`).
        static FAILURES: RefCell<HashMap<String, Failure>> = RefCell::new(HashMap::new());
        /// Every request made: URL (after "HEAD " for a HEAD request) and the If-None-Match it
        /// carried.
        static LOG: RefCell<Vec<(String, Option<String>)>> = const { RefCell::new(Vec::new()) };
    }

    /// While the guard lives, this thread's requests are answered from `routes`. A URL that isn't
    /// listed answers 404. A request carrying the listed ETag answers 304 (not modified).
    pub fn serve(routes: Vec<(String, Vec<u8>, Option<&str>)>) -> Serving {
        let table = routes.into_iter().map(|(url, body, etag)| (url, (body, etag.map(str::to_string)))).collect();
        ROUTES.with(|r| *r.borrow_mut() = Some(table));
        FAILURES.with(|f| f.borrow_mut().clear());
        LOG.with(|l| l.borrow_mut().clear());
        Serving
    }

    /// From now on, `url` fails this way instead of answering (until `serve` starts again, or
    /// `set` gives it an answer).
    pub fn fail(url: &str, how: Failure) {
        FAILURES.with(|f| f.borrow_mut().insert(url.to_string(), how));
    }

    /// The listed failure for a URL, if it has one.
    fn failure(url: &str) -> Option<Failure> {
        FAILURES.with(|f| f.borrow().get(url).copied())
    }

    /// Adds or replaces one URL's answer (say, a newer file upstream).
    pub fn set(url: &str, body: Vec<u8>, etag: Option<&str>) {
        FAILURES.with(|f| f.borrow_mut().remove(url));
        ROUTES.with(|r| {
            if let Some(table) = r.borrow_mut().as_mut() {
                table.insert(url.to_string(), (body, etag.map(str::to_string)));
            }
        });
    }

    /// Takes one URL's answer away: it answers 404 from now on (say, a file moved upstream).
    pub fn remove(url: &str) {
        ROUTES.with(|r| {
            if let Some(table) = r.borrow_mut().as_mut() {
                table.remove(url);
            }
        });
    }

    /// The requests made since `serve` (or the last `take_requests`), oldest first.
    pub fn take_requests() -> Vec<(String, Option<String>)> {
        LOG.with(|l| std::mem::take(&mut *l.borrow_mut()))
    }

    pub struct Serving;

    impl Drop for Serving {
        fn drop(&mut self) {
            ROUTES.with(|r| *r.borrow_mut() = None);
            FAILURES.with(|f| f.borrow_mut().clear());
            LOG.with(|l| l.borrow_mut().clear());
        }
    }

    /// A HEAD request: the listed ETag (None if the route has none), or 404 if the URL isn't
    /// listed. Logged as "HEAD <url>".
    pub(super) fn answer_head(url: &str, if_none_match: &str) -> Option<Result<Option<String>, Fetch>> {
        ROUTES.with(|r| {
            let routes = r.borrow();
            let table = routes.as_ref()?;
            LOG.with(|l| l.borrow_mut().push((format!("HEAD {url}"), Some(if_none_match.to_string()))));
            Some(table.get(url).map(|(_, etag)| etag.clone()).ok_or(Fetch::NotFound))
        })
    }

    pub(super) fn answer(url: &str, if_none_match: Option<&str>) -> Option<Result<Fetched, Fetch>> {
        ROUTES.with(|r| {
            let routes = r.borrow();
            let table = routes.as_ref()?;
            LOG.with(|l| l.borrow_mut().push((url.to_string(), if_none_match.map(str::to_string))));
            Some(match (failure(url), table.get(url)) {
                (Some(Failure::Status(404)), _) => Err(Fetch::NotFound),
                (Some(how), _) => Err(Fetch::Failed(AppError::Other(format!("{how:?}")))),
                (None, None) => Err(Fetch::NotFound),
                (None, Some((_, Some(etag)))) if if_none_match == Some(etag.as_str()) => Ok(Fetched::NotModified),
                (None, Some((body, etag))) => Ok(Fetched::Body { bytes: body.clone(), etag: etag.clone() }),
            })
        })
    }

    /// A preview request (`fetch_preview`): the listed body, the listed failure, or 404 for a
    /// URL that isn't listed. Logged like any other request.
    pub(super) fn answer_preview(url: &str) -> Option<Result<Vec<u8>, PreviewFetchError>> {
        ROUTES.with(|r| {
            let routes = r.borrow();
            let table = routes.as_ref()?;
            LOG.with(|l| l.borrow_mut().push((url.to_string(), None)));
            Some(match (failure(url), table.get(url)) {
                (Some(Failure::Status(code)), _) => Err(PreviewFetchError::Status(code)),
                (Some(Failure::Offline), _) => Err(PreviewFetchError::Network("offline (test)".into())),
                (None, None) => Err(PreviewFetchError::Status(404)),
                (None, Some((body, _))) => Ok(body.clone()),
            })
        })
    }
}

fn host_of(url: &str) -> &str {
    url.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or(url)
}

/// Removes leftovers of interrupted downloads and updates. Runs at startup, before any install.
pub fn sweep_leftovers(data_dir: &Path) {
    for (_, name) in DOWNLOAD_SERVICES {
        let Ok(entries) = std::fs::read_dir(services_root(data_dir).join(name)) else { continue };
        for entry in entries.flatten() {
            let n = entry.file_name().to_string_lossy().into_owned();
            // Also Google Fonts families removed last time, held for Undo (google::hold_removed)
            // and not deleted at quit.
            if n.starts_with(".download-") || n.starts_with(".old-") || n.starts_with(".removed-") {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_etags_are_kept() {
        assert_eq!(usable_etag(" \"abc\" ").as_deref(), Some("\"abc\""));
        assert_eq!(usable_etag("W/\"abc\"").as_deref(), Some("W/\"abc\""));
        assert!(usable_etag("").is_none());
        assert!(usable_etag("\"a\r\nX-Evil: 1\"").is_none());
        assert!(usable_etag(&"a".repeat(201)).is_none());
    }

    /// Building an agent sends nothing. Its pool settings show only in ureq's debug text
    /// (ureq 2.12: `max_idle_per_host: N`).
    #[test]
    fn the_preview_agent_keeps_a_connection_for_each_request_running_at_once() {
        let kept = |a: &ureq::Agent| {
            let text = format!("{a:?}");
            let at = text.find("max_idle_per_host: ").expect("ureq's debug text names the pool size") + "max_idle_per_host: ".len();
            text[at..].split(|c: char| !c.is_ascii_digit()).next().unwrap().parse::<usize>().unwrap()
        };
        for url in ["https://fonts.googleapis.com/css2?family=Inter", "https://fonts.gstatic.com/l/font?kit=a"] {
            let shared = preview_agent(url);
            assert_eq!(kept(&shared), MAX_PREVIEW_FETCHES, "{url}");
            assert_eq!(kept(&preview_agent(url)), MAX_PREVIEW_FETCHES, "the same agent again");
        }
        assert_eq!(kept(&agent("https://example.test/catalog.json", Deadline::Small)), 1, "a one-request agent keeps ureq's default");
    }

    #[test]
    fn fake_answers_respect_the_size_limit_and_etags() {
        let _net = fake_net::serve(vec![("https://example.test/f".into(), vec![0; 10], Some("\"t\""))]);
        assert!(matches!(fetch("https://example.test/f", 9, Deadline::Small, None), Err(Fetch::Failed(AppError::Invalid(_)))));
        assert!(matches!(fetch("https://example.test/f", 10, Deadline::Small, Some("\"t\"")), Ok(Fetched::NotModified)));
        assert!(matches!(
            fetch("https://example.test/f", 10, Deadline::Small, Some("\"old\"")),
            Ok(Fetched::Body { etag: Some(t), .. }) if t == "\"t\""
        ));
        assert!(matches!(fetch_bytes("https://example.test/missing", 10, Deadline::Small), Err(Fetch::NotFound)));
        assert_eq!(fake_net::take_requests().len(), 4);
        // A HEAD request reports the current ETag and downloads nothing.
        assert!(matches!(current_etag("https://example.test/f", "\"t\""), Ok(Some(t)) if t == "\"t\""));
        assert!(matches!(current_etag("https://example.test/f", "\"old\""), Ok(Some(t)) if t == "\"t\""));
        assert!(matches!(current_etag("https://example.test/missing", "\"t\""), Err(Fetch::NotFound)));
        assert_eq!(
            fake_net::take_requests()[0],
            ("HEAD https://example.test/f".to_string(), Some("\"t\"".to_string()))
        );
    }
}
