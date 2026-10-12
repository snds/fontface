//! Google Fonts, without an API key.
//!
//! - **Catalog:** Fontsource's public API (`api.fontsource.org/v1/fonts?type=google`), which mirrors
//!   Google Fonts' family list with category, weights, styles, variable flag, license and last
//!   change date. Cached for a day; after a failed refresh the saved copy is used and the network
//!   isn't retried for a while.
//! - **Files:** Google's official `google/fonts` repository. Each family's `METADATA.pb` lists its
//!   complete desktop font files (not web subsets), downloaded from raw.githubusercontent.com
//!   together with the family's license file, which is required.
//! - **Installed state:** each family folder holds a hidden `.fontface.json` with the catalog id,
//!   the repository folder and the `lastModified` it was installed at (for update detection).
//!
//! Installs happen in two steps. `prepare` downloads and checks everything into a hidden
//! temporary folder; `commit` swaps it into place, keeping the old copy until the new one is in
//! place and restoring it if anything fails. Every font here is open-licensed (OFL, Apache 2.0 or
//! the Ubuntu Font Licence), which allows downloading and installing them.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use super::{fetch_bytes, service_dir, Deadline, Fetch};
use crate::{
    error::{AppError, AppResult},
    scanner,
};

const CATALOG_URL: &str = "https://api.fontsource.org/v1/fonts?type=google";
const REPO_RAW: &str = "https://raw.githubusercontent.com/google/fonts/main";
const CATALOG_MAX_AGE_SECS: u64 = 24 * 60 * 60;
/// After a failed refresh, don't try the network again (unless asked) for this long.
const RETRY_AFTER_FAILURE_SECS: u64 = 15 * 60;
const MAX_CATALOG_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FONT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SMALL_BYTES: u64 = 1024 * 1024;
const SIDECAR: &str = ".fontface.json";
const LICENSE_FILES: [&str; 3] = ["OFL.txt", "LICENSE.txt", "UFL.txt"];

/// One catalog fetch at a time.
static CATALOG_FETCH: Mutex<()> = Mutex::new(());
/// When the last fetch failed (seconds since the epoch).
static LAST_FAILURE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogFamily {
    pub id: String,
    pub family: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub variable: bool,
    #[serde(default)]
    pub weights: Vec<u16>,
    #[serde(default)]
    pub styles: Vec<String>,
    #[serde(default)]
    pub subsets: Vec<String>,
    #[serde(default)]
    pub license: String,
    #[serde(default, rename = "lastModified")]
    pub last_modified: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sidecar {
    id: String,
    family: String,
    last_modified: String,
    source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub dir: String,
    pub last_modified: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    #[serde(flatten)]
    pub family: CatalogFamily,
    pub installed: Option<Installed>,
    pub update_available: bool,
    /// Why this family can't be downloaded from google/fonts, if it can't.
    pub unavailable: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub families: Vec<CatalogEntry>,
    /// Seconds since the epoch when the catalog was fetched.
    pub fetched_at: u64,
    /// The catalog couldn't be refreshed, so this is the last saved copy.
    pub stale: bool,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn cache_path(data_dir: &Path) -> PathBuf {
    super::services_root(data_dir).join(".cache").join("google-catalog.json")
}

#[derive(Serialize, Deserialize)]
struct CachedCatalog {
    fetched_at: u64,
    families: Vec<CatalogFamily>,
}

fn read_cache(data_dir: &Path) -> Option<CachedCatalog> {
    let path = cache_path(data_dir);
    if std::fs::metadata(&path).ok()?.len() > MAX_CATALOG_BYTES {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn fetch_catalog(data_dir: &Path) -> AppResult<CachedCatalog> {
    let bytes = fetch_bytes(CATALOG_URL, MAX_CATALOG_BYTES, Deadline::Small)?;
    let families: Vec<CatalogFamily> = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::Other(format!("The Google Fonts catalog couldn't be read: {e}")))?;
    let cached = CachedCatalog { fetched_at: now(), families };
    let path = cache_path(data_dir);
    std::fs::create_dir_all(path.parent().expect("cache file has a parent"))?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(&cached).unwrap_or_default())?;
    std::fs::rename(tmp, path)?;
    Ok(cached)
}

/// The google/fonts folder name for a catalog id: letters and digits only.
fn slug(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase()
}

/// Families Fontsource lists under Google Fonts that google/fonts doesn't hold.
fn unavailable_reason(f: &CatalogFamily) -> Option<String> {
    (f.category == "icons" || f.id.starts_with("material-icons") || f.id.starts_with("material-symbols"))
        .then(|| "Icon fonts are published separately, in google/material-design-icons.".to_string())
}

/// Installed families by catalog id, plus by repository folder (so a twin id still matches).
fn installed_index(data_dir: &Path) -> (HashMap<String, Installed>, HashMap<String, Installed>) {
    let (mut by_id, mut by_repo) = (HashMap::new(), HashMap::new());
    let Some(root) = service_dir(data_dir, "google") else { return (by_id, by_repo) };
    let Ok(entries) = std::fs::read_dir(root) else { return (by_id, by_repo) };
    for entry in entries.flatten() {
        // Hidden folders are downloads or backups in progress, not installed families.
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let dir = entry.path();
        let Ok(bytes) = std::fs::read(dir.join(SIDECAR)) else { continue };
        if let Ok(meta) = serde_json::from_slice::<Sidecar>(&bytes) {
            let item = Installed { dir: dir.to_string_lossy().into_owned(), last_modified: meta.last_modified };
            if let Some(repo) = meta.source.strip_prefix("google/fonts:").and_then(|s| s.rsplit('/').next()) {
                by_repo.insert(repo.to_string(), item.clone());
            }
            by_id.insert(meta.id, item);
        }
    }
    (by_id, by_repo)
}

/// The catalog with install state. Refreshed from the network at most once a day unless
/// `refresh` is set. If the network fails, the saved copy is used (marked stale), and automatic
/// refreshes pause for a while.
pub fn catalog(data_dir: &Path, refresh: bool) -> AppResult<Catalog> {
    let usable = |c: &CachedCatalog| {
        let fresh = now().saturating_sub(c.fetched_at) < CATALOG_MAX_AGE_SECS;
        let backing_off = now().saturating_sub(LAST_FAILURE.load(Ordering::Relaxed)) < RETRY_AFTER_FAILURE_SECS;
        (fresh || backing_off, !fresh)
    };
    let cached = read_cache(data_dir);
    // Fast path: a usable saved copy is returned without waiting on any fetch in progress.
    let (data, stale) = match cached {
        Some(c) if !refresh && usable(&c).0 => {
            let stale = usable(&c).1;
            (c, stale)
        }
        cached => {
            // An automatic refresh doesn't wait behind another fetch: it uses the saved copy.
            let _fetching = match (refresh, &cached) {
                (false, Some(_)) => match CATALOG_FETCH.try_lock() {
                    Ok(guard) => guard,
                    Err(_) => {
                        let c = cached.expect("matched Some");
                        return Ok(build(data_dir, c, true));
                    }
                },
                _ => CATALOG_FETCH.lock().unwrap_or_else(|p| p.into_inner()),
            };
            match fetch_catalog(data_dir) {
                Ok(c) => (c, false),
                Err(e) => {
                    LAST_FAILURE.store(now(), Ordering::Relaxed);
                    match cached {
                        Some(c) => (c, true),
                        None => return Err(e),
                    }
                }
            }
        }
    };
    Ok(build(data_dir, data, stale))
}

/// Combines a fetched catalog with install state.
fn build(data_dir: &Path, data: CachedCatalog, stale: bool) -> Catalog {
    // Fontsource lists a few families twice under ids that map to one repository folder
    // (e.g. "bj-cree" and "bjcree"). Keep the newest.
    let mut by_slug: HashMap<String, CatalogFamily> = HashMap::new();
    for f in data.families {
        let key = slug(&f.id);
        match by_slug.get(&key) {
            Some(existing) if existing.last_modified >= f.last_modified => {}
            _ => {
                by_slug.insert(key, f);
            }
        }
    }

    let (by_id, by_repo) = installed_index(data_dir);
    let mut families: Vec<CatalogEntry> = by_slug
        .into_iter()
        .map(|(key, family)| {
            let installed = by_id.get(&family.id).or_else(|| by_repo.get(&key)).cloned();
            let update_available = installed.as_ref().is_some_and(|i| i.last_modified < family.last_modified);
            let unavailable = unavailable_reason(&family);
            CatalogEntry { family, installed, update_available, unavailable }
        })
        .collect();
    families.sort_by(|a, b| a.family.family.to_lowercase().cmp(&b.family.family.to_lowercase()));
    Catalog { families, fetched_at: data.fetched_at, stale }
}

/// Looks a family up in the saved catalog without touching the network (unless there's no
/// saved catalog yet, or the id isn't in it).
pub fn find(data_dir: &Path, id: &str) -> AppResult<CatalogFamily> {
    let lookup = |c: Catalog| c.families.into_iter().find(|e| e.family.id == id);
    if let Some(entry) = lookup(catalog(data_dir, false)?) {
        return Ok(entry.family);
    }
    lookup(catalog(data_dir, true)?)
        .map(|e| e.family)
        .ok_or_else(|| AppError::NotFound(format!("{id} isn't in the Google Fonts catalog")))
}

/// Where a family lives in google/fonts: `<license dir>/<slug>`. The license from the catalog
/// picks the likely directory first; the others are tried after it.
fn repo_candidates(family: &CatalogFamily) -> Vec<String> {
    let slug = slug(&family.id);
    let license = family.license.to_ascii_lowercase();
    let mut dirs = vec!["ofl", "apache", "ufl"];
    let first = if license.starts_with("apache") { "apache" } else if license.starts_with("ufl") { "ufl" } else { "ofl" };
    dirs.retain(|d| *d != first);
    dirs.insert(0, first);
    dirs.into_iter().map(|d| format!("{d}/{slug}")).collect()
}

/// A font file name from METADATA.pb that's safe to write on every platform: a plain file name
/// in Google's character set, with a font extension. Anything else is refused.
fn safe_font_file_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-[],".contains(c))
        && scanner::is_font_file(Path::new(name))
        && Path::new(name).file_name() == Some(std::ffi::OsStr::new(name))
}

/// `filename: "Inter[opsz,wght].ttf"` lines from a METADATA.pb (protobuf text format).
fn metadata_filenames(text: &str) -> Vec<String> {
    let mut files: Vec<String> = text
        .lines()
        .filter_map(|line| line.trim().strip_prefix("filename:"))
        .filter_map(|rest| rest.trim().strip_prefix('"')?.strip_suffix('"').map(str::to_string))
        .filter(|name| safe_font_file_name(name))
        .collect();
    files.sort();
    files.dedup();
    files
}

fn safe_folder_name(family: &str) -> String {
    let cleaned: String = family
        .chars()
        .map(|c| if c == '/' || c == ':' || c == '\\' || c.is_control() { '-' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').to_string();
    if trimmed.is_empty() { "Untitled".into() } else { trimmed }
}

/// A family downloaded and checked, waiting in a hidden folder to be swapped into place.
pub struct Prepared {
    family: CatalogFamily,
    tmp: PathBuf,
    dest: PathBuf,
    pub files: Vec<String>,
    /// The family's folder, if an earlier copy is being replaced.
    pub replaces: Option<PathBuf>,
    /// Font file names in the copy being replaced.
    pub old_files: Vec<String>,
}

impl Drop for Prepared {
    fn drop(&mut self) {
        // Committed: tmp is empty (nothing to do). Abandoned or failed: clean it up.
        if !self.tmp.as_os_str().is_empty() {
            let _ = std::fs::remove_dir_all(&self.tmp);
        }
    }
}

/// Step 1: downloads every font file of a family, plus its license, into a hidden temporary
/// folder unique to this install, and checks each file is a real font. Nothing visible changes.
pub fn prepare(data_dir: &Path, family: &CatalogFamily) -> AppResult<Prepared> {
    if let Some(reason) = unavailable_reason(family) {
        return Err(AppError::Invalid(reason));
    }
    let root = service_dir(data_dir, "google").ok_or_else(|| AppError::Other("Google Fonts folder missing".into()))?;
    std::fs::create_dir_all(&root)?;

    // Find the family's folder. Only a 404 means "try the next one"; any other failure is reported.
    let mut found = None;
    for dir in repo_candidates(family) {
        match fetch_bytes(&format!("{REPO_RAW}/{dir}/METADATA.pb"), MAX_SMALL_BYTES, Deadline::Small) {
            Ok(text) => {
                let files = metadata_filenames(&String::from_utf8_lossy(&text));
                if !files.is_empty() {
                    found = Some((dir, files));
                    break;
                }
            }
            Err(Fetch::NotFound) => {}
            Err(Fetch::Failed(e)) => return Err(e),
        }
    }
    let (repo_dir, files) =
        found.ok_or_else(|| AppError::NotFound(format!("{} wasn't found in Google's font repository", family.family)))?;

    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = root.join(format!(".download-{}-{nonce}", slug(&family.id)));
    std::fs::create_dir_all(&tmp)?;
    let (by_id, by_repo) = installed_index(data_dir);
    let existing = by_id.get(&family.id).or_else(|| by_repo.get(&slug(&family.id))).map(|i| PathBuf::from(&i.dir));
    let old_files = existing
        .as_ref()
        .and_then(|d| std::fs::read_dir(d).ok())
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| scanner::is_font_file(Path::new(n)))
                .collect()
        })
        .unwrap_or_default();
    let prepared = Prepared {
        family: family.clone(),
        dest: existing.clone().unwrap_or_else(|| root.join(safe_folder_name(&family.family))),
        old_files,
        replaces: existing,
        tmp,
        files: files.clone(),
    };

    for name in &files {
        let url = format!("{REPO_RAW}/{repo_dir}/{}", urlencode_path(name));
        let bytes = fetch_bytes(&url, MAX_FONT_BYTES, Deadline::Large).map_err(|e| match e {
            Fetch::NotFound => AppError::NotFound(format!("{name} is listed for {} but missing from the repository", family.family)),
            Fetch::Failed(e) => e,
        })?;
        scanner::parse_file(&bytes).map_err(|e| AppError::Invalid(format!("{name} isn't a usable font: {e}")))?;
        std::fs::write(prepared.tmp.join(name), bytes).map_err(|e| AppError::Other(format!("Couldn't save {name}: {e}")))?;
    }

    // The license travels with the fonts. It's required: an install without it is refused.
    let mut license_saved = false;
    for license in LICENSE_FILES {
        match fetch_bytes(&format!("{REPO_RAW}/{repo_dir}/{license}"), MAX_SMALL_BYTES, Deadline::Small) {
            Ok(bytes) => {
                std::fs::write(prepared.tmp.join(license), bytes)
                    .map_err(|e| AppError::Other(format!("Couldn't save {license}: {e}")))?;
                license_saved = true;
                break;
            }
            Err(Fetch::NotFound) => {}
            Err(Fetch::Failed(e)) => return Err(e),
        }
    }
    if !license_saved {
        return Err(AppError::NotFound(format!("{}'s license file couldn't be found, so it wasn't installed", family.family)));
    }

    let sidecar = Sidecar {
        id: family.id.clone(),
        family: family.family.clone(),
        last_modified: family.last_modified.clone(),
        source: format!("google/fonts:{repo_dir}"),
    };
    std::fs::write(prepared.tmp.join(SIDECAR), serde_json::to_vec_pretty(&sidecar).unwrap_or_default())
        .map_err(|e| AppError::Other(format!("Couldn't save install details: {e}")))?;
    Ok(prepared)
}

/// Step 2: swaps the prepared family into place. The old copy is moved aside first and only
/// deleted once the new one is in place; if the swap fails, the old copy is put back.
/// Returns the family's folder (real path, matching how the scanner stores font paths).
pub fn commit(mut prepared: Prepared) -> AppResult<String> {
    let dest = prepared.dest.clone();
    let backup = dest.with_file_name(format!(".old-{}", slug(&prepared.family.id)));
    let had_old = dest.exists();
    if had_old {
        let _ = std::fs::remove_dir_all(&backup);
        std::fs::rename(&dest, &backup).map_err(|e| AppError::Other(format!("Couldn't set the old copy aside: {e}")))?;
    }
    if let Err(e) = std::fs::rename(&prepared.tmp, &dest) {
        if had_old {
            let _ = std::fs::rename(&backup, &dest);
        }
        return Err(AppError::Other(format!("Couldn't move {} into place: {e}", prepared.family.family)));
    }
    prepared.tmp = PathBuf::new(); // committed: nothing for Drop to clean up
    if had_old {
        let _ = std::fs::remove_dir_all(&backup);
    }
    let real = std::fs::canonicalize(&dest).unwrap_or(dest);
    Ok(real.to_string_lossy().into_owned())
}

/// The installed folder of a family, if it's installed.
pub fn installed_dir(data_dir: &Path, id: &str) -> Option<PathBuf> {
    let (mut by_id, mut by_repo) = installed_index(data_dir);
    by_id.remove(id).or_else(|| by_repo.remove(&slug(id))).map(|i| PathBuf::from(i.dir))
}

/// Percent-encodes the characters Google's file names use that aren't safe in a URL path.
fn urlencode_path(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for b in name.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fam(id: &str, license: &str) -> CatalogFamily {
        CatalogFamily {
            id: id.into(),
            family: id.into(),
            category: String::new(),
            variable: false,
            weights: vec![],
            styles: vec![],
            subsets: vec![],
            license: license.into(),
            last_modified: String::new(),
        }
    }

    #[test]
    fn reads_only_safe_filenames_from_metadata() {
        let text = "fonts {\n  filename: \"Inter[opsz,wght].ttf\"\n}\nfonts {\n  filename: \"Inter-Italic[opsz,wght].ttf\"\n}\n\
                    fonts {\n  filename: \"../evil.ttf\"\n}\nfonts {\n  filename: \"\\\\Users\\\\Public\\\\x.ttf\"\n}\n\
                    fonts {\n  filename: \"C:x.ttf\"\n}\nfonts {\n  filename: \"run.bat\"\n}\nfonts {\n  filename: \".fontface.json\"\n}\n";
        assert_eq!(metadata_filenames(text), vec!["Inter-Italic[opsz,wght].ttf", "Inter[opsz,wght].ttf"]);
    }

    #[test]
    fn repo_paths_follow_license() {
        assert_eq!(repo_candidates(&fam("42dot-sans", "OFL-1.1"))[0], "ofl/42dotsans");
        assert_eq!(repo_candidates(&fam("roboto-flex", "Apache-2.0"))[0], "apache/robotoflex");
        assert_eq!(repo_candidates(&fam("ubuntu", "UFL-1.0"))[0], "ufl/ubuntu");
        assert_eq!(repo_candidates(&fam("x", "OFL-1.1")).len(), 3);
    }

    #[test]
    fn icon_fonts_are_marked_unavailable() {
        assert!(unavailable_reason(&fam("material-symbols-rounded", "Apache-2.0")).is_some());
        assert!(unavailable_reason(&fam("inter", "OFL-1.1")).is_none());
    }

    #[test]
    fn encodes_brackets_and_commas() {
        assert_eq!(urlencode_path("Inter[opsz,wght].ttf"), "Inter%5Bopsz%2Cwght%5D.ttf");
    }

    #[test]
    fn folder_names_are_safe() {
        assert_eq!(safe_folder_name("A/B: C"), "A-B- C");
        assert_eq!(safe_folder_name(".hidden"), "hidden");
    }
}
