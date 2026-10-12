//! Cloud font services.
//!
//! Two kinds of integration, both license-safe (see docs/INTEGRATIONS.md):
//! - **Download services** (Google Fonts): open-licensed fonts are downloaded into a folder
//!   Fontface manages (`<app data>/Services/<Service>/`). That folder is a library folder of kind
//!   `service`, scanned and activated like any other, so downloaded fonts appear everywhere.
//! - **Managed by another app** (Adobe Fonts): read-only. Fontface lists what that app has
//!   already turned on, through the OS font APIs, and never opens, copies or (de)activates its files.

pub mod adobe;
pub mod google;
pub mod purchase_watch;
pub mod purchases;

use std::{
    path::{Path, PathBuf},
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
}

impl Deadline {
    fn duration(self) -> Duration {
        match self {
            Deadline::Small => Duration::from_secs(60),
            Deadline::Large => Duration::from_secs(10 * 60),
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

fn agent(url: &str, deadline: Deadline) -> ureq::Agent {
    let host = url.split("://").nth(1).and_then(|r| r.split(['/', ':']).next()).unwrap_or("");
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout(deadline.duration())
        .user_agent(USER_AGENT);
    if let Some(proxy) = proxy_for(host) {
        builder = builder.proxy(proxy);
    }
    builder.build()
}

/// Downloads into memory, refusing anything larger than `max` bytes or slower than `deadline`.
pub fn fetch_bytes(url: &str, max: u64, deadline: Deadline) -> Result<Vec<u8>, Fetch> {
    use std::io::Read;
    let response = agent(url, deadline).get(url).call().map_err(|e| match e {
        ureq::Error::Status(404, _) => Fetch::NotFound,
        ureq::Error::Status(429, _) => {
            Fetch::Failed(AppError::Other(format!("{} is limiting requests right now. Try again in a few minutes.", host_of(url))))
        }
        ureq::Error::Status(code, _) => Fetch::Failed(AppError::Other(format!("{} answered {code}", host_of(url)))),
        other => Fetch::Failed(AppError::Other(format!("Couldn't reach {}: {other}", host_of(url)))),
    })?;
    let mut body = Vec::new();
    response
        .into_reader()
        .take(max + 1)
        .read_to_end(&mut body)
        .map_err(|e| Fetch::Failed(AppError::Other(format!("Download from {} failed: {e}", host_of(url)))))?;
    if body.len() as u64 > max {
        return Err(Fetch::Failed(AppError::Invalid(format!("A download from {} was larger than expected", host_of(url)))));
    }
    Ok(body)
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
            if n.starts_with(".download-") || n.starts_with(".old-") {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}
