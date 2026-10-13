//! Google Fonts, without an API key.
//!
//! - **Catalog:** Fontsource's public API (`api.fontsource.org/v1/fonts?type=google`), which mirrors
//!   Google Fonts' family list with category, weights, styles, variable flag, license and last
//!   change date. Cached for a day; after a failed refresh the saved copy is used and the network
//!   isn't retried for a while.
//! - **Files:** Google's official `google/fonts` repository. Each family's `METADATA.pb` lists its
//!   complete desktop font files (not web subsets), downloaded from raw.githubusercontent.com
//!   together with the family's license file, which is required. Icon fonts (Material Icons and
//!   Material Symbols) aren't in google/fonts: they come from google/material-design-icons, by
//!   a small table (see `icons`), with that repository's license (Apache 2.0).
//! - **Installed state:** each family folder holds a hidden `.fontface.json` with the catalog id,
//!   where the files came from, the `lastModified` it was installed at (for update detection),
//!   and each font file's ETag and size (so an update downloads only files that changed).
//! - **Updates:** a family has one when Fontsource's `lastModified` is newer than the one it was
//!   installed at. Icon families are the exception: their files come from another repository on
//!   its own schedule, so each catalog refresh asks whether the files themselves changed (see
//!   `check_icon_files`).
//!
//! Installs happen in two steps. `prepare` downloads and checks everything into a hidden
//! temporary folder; `commit` swaps it into place, keeping the old copy until the new one is in
//! place and restoring it if anything fails. An update in which no font file changed upstream
//! skips the swap: `refresh` only rewrites the license and install details, so the fonts stay on.
//! Every font here is open-licensed (OFL, Apache 2.0 or the Ubuntu Font Licence), which allows
//! downloading and installing them.

pub mod icons;

use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use super::{fetch, fetch_bytes, service_dir, Deadline, Fetch, Fetched};
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
/// One change to the latest-ETag file at a time (see `record_latest`).
static LATEST_WRITE: Mutex<()> = Mutex::new(());
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
    /// `google/fonts:<license dir>/<folder>`, or `google/material-design-icons`.
    source: String,
    /// Per font file: the ETag and size it was downloaded with. Missing in older installs.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    upstream: BTreeMap<String, Upstream>,
}

/// What the server said about a downloaded file, so a later update can ask "has it changed?".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Upstream {
    etag: String,
    bytes: u64,
}

fn read_sidecar(dir: &Path) -> Option<Sidecar> {
    let path = dir.join(SIDECAR);
    if std::fs::metadata(&path).ok()?.len() > MAX_SMALL_BYTES {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub dir: String,
    pub last_modified: String,
    /// Per font file, the ETag it was downloaded with (from `.fontface.json`).
    #[serde(skip)]
    upstream: BTreeMap<String, Upstream>,
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

fn latest_path(data_dir: &Path) -> PathBuf {
    super::services_root(data_dir).join(".cache").join("google-latest-etags.json")
}

/// The newest ETag the server gave for each icon font file, by URL: from the check on each
/// catalog refresh (`check_icon_files`) and from downloads (`prepare`). Compared with the ETag an
/// install recorded, it says whether that file changed upstream since.
fn read_latest(data_dir: &Path) -> BTreeMap<String, String> {
    let path = latest_path(data_dir);
    if std::fs::metadata(&path).map_or(true, |m| m.len() > MAX_SMALL_BYTES) {
        return BTreeMap::new();
    }
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Saves what the server just said about files: `Some(tag)` is a file's current ETag; `None`
/// means it isn't known (the server sent none, or the file is gone), so the entry goes. Best
/// effort: if it can't be saved, the catalog's date decides about updates instead.
fn record_latest(data_dir: &Path, answers: Vec<(String, Option<String>)>) {
    if answers.is_empty() {
        return;
    }
    let _guard = LATEST_WRITE.lock().unwrap_or_else(|p| p.into_inner());
    let mut latest = read_latest(data_dir);
    for (url, tag) in answers {
        match tag {
            Some(tag) => latest.insert(url, tag),
            None => latest.remove(&url),
        };
    }
    let path = latest_path(data_dir);
    let tmp = path.with_extension("tmp");
    let saved = std::fs::create_dir_all(path.parent().expect("cache file has a parent"))
        .and_then(|_| std::fs::write(&tmp, serde_json::to_vec(&latest).unwrap_or_default()))
        .and_then(|_| std::fs::rename(&tmp, &path));
    if saved.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Asks whether each installed icon family's font files changed upstream, and records the
/// answers (`record_latest`). Icon fonts come from google/material-design-icons, not from the
/// repository Fontsource's `lastModified` follows: Material Symbols is pushed there weekly, often
/// a day or more after Fontsource's date moves, and Material Icons' files no longer change though
/// its date still does. So the files decide. Each file is asked about with a HEAD request
/// carrying the ETag it was downloaded with; nothing is downloaded, and the answer is usually a
/// small "not modified". At most one request per icon family (8). Stops at the first failure.
fn check_icon_files(data_dir: &Path) {
    let (by_id, _) = installed_index(data_dir);
    let mut answers = Vec::new();
    'families: for icon in icons::FAMILIES {
        let Some(installed) = by_id.get(icon.id) else { continue };
        for (name, url) in icons::source(icon).fonts {
            let Some(recorded) = installed.upstream.get(&name) else { continue };
            match super::current_etag(&url, &recorded.etag) {
                Ok(tag) => answers.push((url, tag)),
                Err(Fetch::NotFound) => answers.push((url, None)),
                Err(Fetch::Failed(_)) => break 'families,
            }
        }
    }
    record_latest(data_dir, answers);
}

/// Whether an installed icon family's files changed upstream: the ETag each was downloaded with,
/// against the newest one the server gave (`read_latest`). None when that isn't known for every
/// file (no ETag recorded, or not asked yet); the catalog's date decides then.
fn icon_changed(icon: &icons::IconFamily, recorded: &BTreeMap<String, Upstream>, latest: &BTreeMap<String, String>) -> Option<bool> {
    let mut known = true;
    for (name, url) in icons::source(icon).fonts {
        match (recorded.get(&name), latest.get(&url)) {
            (Some(mine), Some(now)) if mine.etag != *now => return Some(true),
            (Some(_), Some(_)) => {}
            _ => known = false,
        }
    }
    known.then_some(false)
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

/// Families the catalog lists that Fontface can't download, and why: an icon font that isn't
/// in the icon table (say, one Google adds later), or the left-out static Material Symbols.
fn unavailable_reason(f: &CatalogFamily) -> Option<String> {
    if icons::lookup(&f.id).is_some() {
        None
    } else if icons::hidden(&f.id) {
        Some("This is the same as Material Symbols Outlined. Get that one instead.".to_string())
    } else if icons::looks_like_icons(f) {
        Some("Fontface doesn't know where Google publishes this icon font yet.".to_string())
    } else {
        None
    }
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
        if let Some(meta) = read_sidecar(&dir) {
            let item =
                Installed { dir: dir.to_string_lossy().into_owned(), last_modified: meta.last_modified, upstream: meta.upstream };
            if let Some(repo) = meta.source.strip_prefix("google/fonts:").and_then(|s| s.rsplit('/').next()) {
                by_repo.insert(repo.to_string(), item.clone());
            }
            by_id.insert(meta.id, item);
        }
    }
    (by_id, by_repo)
}

/// The catalog with install state. Refreshed from the network at most once a day unless
/// `refresh` is set; each refresh also asks whether installed icon families' files changed
/// (`check_icon_files`). If the network fails, the saved copy is used (marked stale), and
/// automatic refreshes pause for a while.
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
                Ok(c) => {
                    check_icon_files(data_dir);
                    (c, false)
                }
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
        // The static Material Symbols is a second copy of Outlined (see `icons`).
        if icons::hidden(&f.id) {
            continue;
        }
        // Icon families show their real license (Fontsource says OFL) and sit under Icons.
        let f = icons::corrected(f);
        let key = slug(&f.id);
        match by_slug.get(&key) {
            Some(existing) if existing.last_modified >= f.last_modified => {}
            _ => {
                by_slug.insert(key, f);
            }
        }
    }

    let (by_id, by_repo) = installed_index(data_dir);
    let latest = read_latest(data_dir);
    let mut families: Vec<CatalogEntry> = by_slug
        .into_iter()
        .map(|(key, family)| {
            let installed = by_id.get(&family.id).or_else(|| by_repo.get(&key)).cloned();
            // Icon families: whether their files changed, when that's known (see `check_icon_files`).
            let update_available = installed.as_ref().is_some_and(|i| {
                icons::lookup(&family.id)
                    .and_then(|icon| icon_changed(icon, &i.upstream, &latest))
                    .unwrap_or(i.last_modified < family.last_modified)
            });
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

/// Where a family's files come from.
struct Source {
    /// Recorded as the install's source: `google/fonts:<license dir>/<folder>`, or
    /// `google/material-design-icons`.
    label: String,
    /// Each font file: the name it's saved under, and its URL.
    fonts: Vec<(String, String)>,
    /// License files to try, in order: the name it's saved under, and its URL. The first one
    /// found is saved.
    licenses: Vec<(String, String)>,
}

/// Finds a family's files: icon fonts from the icon table, others from their google/fonts
/// folder (found through its METADATA.pb).
fn locate(family: &CatalogFamily) -> AppResult<Source> {
    if let Some(icon) = icons::lookup(&family.id) {
        return Ok(icons::source(icon));
    }
    // Only a 404 means "try the next folder"; any other failure is reported.
    for dir in repo_candidates(family) {
        match fetch_bytes(&format!("{REPO_RAW}/{dir}/METADATA.pb"), MAX_SMALL_BYTES, Deadline::Small) {
            Ok(text) => {
                let files = metadata_filenames(&String::from_utf8_lossy(&text));
                if !files.is_empty() {
                    return Ok(Source {
                        fonts: files
                            .into_iter()
                            .map(|name| {
                                let url = format!("{REPO_RAW}/{dir}/{}", urlencode_path(&name));
                                (name, url)
                            })
                            .collect(),
                        licenses: LICENSE_FILES.iter().map(|l| (l.to_string(), format!("{REPO_RAW}/{dir}/{l}"))).collect(),
                        label: format!("google/fonts:{dir}"),
                    });
                }
            }
            Err(Fetch::NotFound) => {}
            Err(Fetch::Failed(e)) => return Err(e),
        }
    }
    Err(AppError::NotFound(format!("{} wasn't found in Google's font repository", family.family)))
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
    /// Font files that hadn't changed upstream, so the copy being replaced was reused.
    pub reused: Vec<String>,
}

impl Prepared {
    /// An update in which nothing changed upstream: every font file was reused from the copy
    /// being replaced, and that copy has no other font files. `refresh` then keeps it in place.
    pub fn unchanged(&self) -> bool {
        self.replaces.is_some()
            && !self.files.is_empty()
            && self.files.iter().all(|f| self.reused.contains(f))
            && self.old_files.iter().all(|f| self.files.contains(f))
    }
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
/// An update asks the server for each file only if it changed since the copy being replaced
/// was downloaded; an unchanged file is copied from that copy instead.
pub fn prepare(data_dir: &Path, family: &CatalogFamily) -> AppResult<Prepared> {
    if let Some(reason) = unavailable_reason(family) {
        return Err(AppError::Invalid(reason));
    }
    let root = service_dir(data_dir, "google").ok_or_else(|| AppError::Other("Google Fonts folder missing".into()))?;
    std::fs::create_dir_all(&root)?;
    let source = locate(family)?;

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
    // What the copy being replaced recorded about its downloads.
    let recorded = existing.as_deref().and_then(read_sidecar).map(|s| s.upstream).unwrap_or_default();
    let mut prepared = Prepared {
        family: family.clone(),
        dest: existing.clone().unwrap_or_else(|| root.join(safe_folder_name(&family.family))),
        old_files,
        replaces: existing,
        tmp,
        files: source.fonts.iter().map(|(name, _)| name.clone()).collect(),
        reused: Vec::new(),
    };

    let mut upstream = BTreeMap::new();
    for (name, url) in &source.fonts {
        let old = prepared.replaces.as_ref().map(|d| d.join(name)).zip(recorded.get(name));
        let got = download_font(family, name, url, old)?;
        scanner::parse_file(&got.bytes).map_err(|e| AppError::Invalid(format!("{name} isn't a usable font: {e}")))?;
        std::fs::write(prepared.tmp.join(name), &got.bytes).map_err(|e| AppError::Other(format!("Couldn't save {name}: {e}")))?;
        if got.reused {
            prepared.reused.push(name.clone());
        }
        if let Some(tag) = got.upstream {
            upstream.insert(name.clone(), tag);
        }
    }
    // What the server just said about each icon file also answers "has it changed?" for the
    // catalog (see `check_icon_files`), even if this install goes no further.
    if icons::lookup(&family.id).is_some() {
        record_latest(data_dir, source.fonts.iter().map(|(name, url)| (url.clone(), upstream.get(name).map(|u| u.etag.clone()))).collect());
    }

    // The license travels with the fonts. It's required: an install without it is refused.
    let mut license_saved = false;
    for (saved_as, url) in &source.licenses {
        match fetch_bytes(url, MAX_SMALL_BYTES, Deadline::Small) {
            Ok(bytes) if !bytes.is_empty() => {
                std::fs::write(prepared.tmp.join(saved_as), bytes)
                    .map_err(|e| AppError::Other(format!("Couldn't save {saved_as}: {e}")))?;
                license_saved = true;
                break;
            }
            Ok(_) | Err(Fetch::NotFound) => {}
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
        source: source.label,
        upstream,
    };
    std::fs::write(prepared.tmp.join(SIDECAR), serde_json::to_vec_pretty(&sidecar).unwrap_or_default())
        .map_err(|e| AppError::Other(format!("Couldn't save install details: {e}")))?;
    Ok(prepared)
}

/// One font file, downloaded or reused.
struct Got {
    bytes: Vec<u8>,
    /// The ETag and size to record, if the server gave an ETag.
    upstream: Option<Upstream>,
    /// The file hadn't changed, so the copy being replaced was used.
    reused: bool,
}

/// Downloads one font file. `old` is the file in the copy being replaced, with the ETag and size
/// it was downloaded with. If it's still that size there, the request asks for the file only if
/// it changed; when it hasn't, the local copy is used, provided it still reads as a font.
/// Otherwise (or if the local copy can't be used) the file is downloaded in full.
fn download_font(family: &CatalogFamily, name: &str, url: &str, old: Option<(PathBuf, &Upstream)>) -> AppResult<Got> {
    let failed = |e: Fetch| match e {
        Fetch::NotFound => AppError::NotFound(format!("{name} is listed for {} but missing from the repository", family.family)),
        Fetch::Failed(e) => e,
    };
    let downloaded = |bytes: Vec<u8>, etag: Option<String>| {
        let upstream = etag.map(|etag| Upstream { etag, bytes: bytes.len() as u64 });
        Got { bytes, upstream, reused: false }
    };
    let old = old.filter(|(path, rec)| std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() == rec.bytes));
    if let Some((path, rec)) = old {
        match fetch(url, MAX_FONT_BYTES, Deadline::Large, Some(&rec.etag)).map_err(failed)? {
            Fetched::Body { bytes, etag } => return Ok(downloaded(bytes, etag)),
            Fetched::NotModified => {
                if let Ok(bytes) = std::fs::read(&path) {
                    if bytes.len() as u64 == rec.bytes && scanner::parse_file(&bytes).is_ok() {
                        return Ok(Got { bytes, upstream: Some(rec.clone()), reused: true });
                    }
                }
                // The local copy can't be read, or changed since it was downloaded: fetch it in full.
            }
        }
    }
    match fetch(url, MAX_FONT_BYTES, Deadline::Large, None).map_err(failed)? {
        Fetched::Body { bytes, etag } => Ok(downloaded(bytes, etag)),
        Fetched::NotModified => Err(AppError::Other(format!("Couldn't download {name}"))),
    }
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

/// Step 2 for an update in which nothing changed upstream (`Prepared::unchanged`): the family's
/// folder stays where it is, so its fonts stay on and apps using them aren't disturbed. Only its
/// license and install details (with the catalog's new date) are replaced. The details go last:
/// if this stops partway, the old ones remain and the update is offered again. Returns the
/// family's folder (real path), like `commit`.
pub fn refresh(prepared: Prepared) -> AppResult<String> {
    let dest = match &prepared.replaces {
        Some(dir) if prepared.unchanged() => dir.clone(),
        _ => return Err(AppError::Other(format!("{} changed, so it has to be swapped in", prepared.family.family))),
    };
    let put = |name: &str| {
        std::fs::rename(prepared.tmp.join(name), dest.join(name)).map_err(|e| AppError::Other(format!("Couldn't update {name}: {e}")))
    };
    let (new, gone): (Vec<&str>, Vec<&str>) = LICENSE_FILES.into_iter().partition(|l| prepared.tmp.join(l).is_file());
    for license in new {
        put(license)?;
    }
    // A license now saved under another name (say OFL.txt became LICENSE.txt): the old one goes.
    for license in gone {
        let _ = std::fs::remove_file(dest.join(license));
    }
    put(SIDECAR)?;
    // The reused font files left in the temporary folder go with it (Drop).
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
    fn known_icon_fonts_are_downloadable_and_unknown_ones_say_why() {
        assert!(unavailable_reason(&fam("material-symbols-rounded", "OFL-1.1")).is_none());
        assert!(unavailable_reason(&fam("material-icons", "OFL-1.1")).is_none());
        assert!(unavailable_reason(&fam("inter", "OFL-1.1")).is_none());
        let mut future = fam("noto-icons", "OFL-1.1");
        future.category = "icons".into();
        for f in [future, fam("material-symbols-extra", "OFL-1.1")] {
            let why = unavailable_reason(&f).expect("an icon font Fontface doesn't know");
            assert!(!why.contains("published separately"), "{why}");
        }
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

    // ------------------------------------------------------------------ icon fonts

    use crate::services::fake_net;

    /// Every id Fontsource lists under Google Fonts for Google's icon fonts (2026-10-13).
    const FONTSOURCE_ICON_IDS: [&str; 9] = [
        "material-icons",
        "material-icons-outlined",
        "material-icons-round",
        "material-icons-sharp",
        "material-icons-two-tone",
        "material-symbols",
        "material-symbols-outlined",
        "material-symbols-rounded",
        "material-symbols-sharp",
    ];

    /// A family as Fontsource lists it: icon families labelled OFL-1.1.
    fn listed(id: &str, category: &str, last_modified: &str) -> CatalogFamily {
        let family = icons::lookup(id).map_or(id, |i| i.family).to_string();
        CatalogFamily { family, category: category.into(), last_modified: last_modified.into(), ..fam(id, "OFL-1.1") }
    }

    /// A fresh data folder for one test.
    fn data_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fontface-google-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn font(family: &str, letters: &str) -> Vec<u8> {
        crate::test_fonts::FontBuilder::new().named(family).chars(letters).build()
    }

    fn icon_url(dir: &str, name: &str) -> String {
        format!("{}/{dir}/{}", icons::REPO_RAW, urlencode_path(name))
    }

    fn license_url() -> String {
        format!("{}/LICENSE", icons::REPO_RAW)
    }

    const APACHE: &[u8] = b"Apache License\nVersion 2.0, January 2004\n";

    fn sidecar_in(dir: &str) -> Sidecar {
        read_sidecar(Path::new(dir)).expect("install details")
    }

    /// Hidden folders left in the Google Fonts folder (downloads or backups).
    fn leftovers(data: &Path) -> Vec<String> {
        std::fs::read_dir(service_dir(data, "google").unwrap())
            .map(|entries| {
                entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with('.')).collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn icon_table_covers_every_listed_icon_family_with_safe_names() {
        let mut ids: Vec<&str> = icons::FAMILIES.iter().map(|f| f.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), icons::FAMILIES.len(), "ids are unique");
        for id in FONTSOURCE_ICON_IDS {
            assert!(icons::lookup(id).is_some() != icons::hidden(id), "{id}: in the table or hidden, not both");
        }
        for icon in icons::FAMILIES {
            assert!(!icon.files.is_empty());
            let source = icons::source(icon);
            assert_eq!(source.label, "google/material-design-icons");
            assert_eq!(source.licenses, vec![("LICENSE.txt".to_string(), license_url())]);
            for ((dir, name), (saved, url)) in icon.files.iter().zip(&source.fonts) {
                assert!(safe_font_file_name(name), "{name}");
                assert_eq!(saved, name);
                assert!(url.starts_with("https://raw.githubusercontent.com/google/material-design-icons/master/"), "{url}");
                assert!(url.ends_with(&format!("/{dir}/{}", urlencode_path(name))), "{url}");
                assert!(!url.contains('[') && !url.contains(','), "brackets and commas are encoded: {url}");
            }
        }
        let rounded = icons::source(icons::lookup("material-symbols-rounded").unwrap());
        assert_eq!(rounded.fonts[0].0, "MaterialSymbolsRounded[FILL,GRAD,opsz,wght].ttf");
        assert_eq!(
            rounded.fonts[0].1,
            "https://raw.githubusercontent.com/google/material-design-icons/master/variablefont/MaterialSymbolsRounded%5BFILL%2CGRAD%2Copsz%2Cwght%5D.ttf"
        );
        let icons_ttf = icons::source(icons::lookup("material-icons").unwrap());
        assert_eq!(
            icons_ttf.fonts,
            vec![(
                "MaterialIcons-Regular.ttf".to_string(),
                "https://raw.githubusercontent.com/google/material-design-icons/master/font/MaterialIcons-Regular.ttf".to_string()
            )]
        );
    }

    #[test]
    fn catalog_shows_icon_families_as_apache_licensed_icons() {
        let data = data_dir("catalog-icons");
        let families = vec![
            listed("material-icons", "icons", "2025-09-17"),
            listed("material-symbols-rounded", "icons", "2026-10-08"),
            listed("material-symbols", "monospace", "2026-10-08"),
            listed("noto-icons", "icons", "2026-01-01"),
            listed("inter", "sans-serif", "2026-01-01"),
        ];
        let catalog = build(&data, CachedCatalog { fetched_at: now(), families }, false);
        let get = |id: &str| catalog.families.iter().find(|e| e.family.id == id);
        for id in ["material-icons", "material-symbols-rounded"] {
            let e = get(id).unwrap();
            assert_eq!((e.family.license.as_str(), e.family.category.as_str()), ("Apache-2.0", "icons"), "{id}");
            assert!(e.unavailable.is_none(), "{id} can be downloaded");
        }
        // Not in the table: Fontsource's label stays, and the row says it can't be downloaded.
        let unknown = get("noto-icons").unwrap();
        assert_eq!(unknown.family.license, "OFL-1.1");
        assert!(unknown.unavailable.is_some());
        // Text fonts are untouched.
        let inter = get("inter").unwrap();
        assert_eq!((inter.family.license.as_str(), inter.family.category.as_str()), ("OFL-1.1", "sans-serif"));
        assert!(get("material-symbols").is_none(), "the static Material Symbols is left out");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn static_material_symbols_is_left_out_and_never_downloaded() {
        assert!(icons::hidden("material-symbols"));
        assert!(icons::lookup("material-symbols").is_none());
        assert!(icons::lookup("material-symbols-outlined").is_some(), "Outlined (the same icons) is offered");
        let data = data_dir("static-symbols");
        let _net = fake_net::serve(vec![]);
        let err = prepare(&data, &listed("material-symbols", "monospace", "2026-10-08")).err().expect("refused");
        assert!(matches!(&err, AppError::Invalid(why) if why.contains("Material Symbols Outlined")), "{err:?}");
        assert!(fake_net::take_requests().is_empty(), "nothing is downloaded");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn icon_family_installs_updates_and_skips_unchanged_files() {
        let data = data_dir("icons-install");
        let name = "MaterialIcons-Regular.ttf";
        let url = icon_url("font", name);
        let v1 = font("Material Icons", "abc");
        let _net = fake_net::serve(vec![(url.clone(), v1.clone(), Some("\"v1\"")), (license_url(), APACHE.to_vec(), None)]);
        let family = icons::corrected(listed("material-icons", "icons", "2025-09-17"));

        // First download: the font and the license, saved as LICENSE.txt, with its ETag.
        let prepared = prepare(&data, &family).unwrap();
        assert_eq!(prepared.files, vec![name]);
        assert!(prepared.replaces.is_none() && prepared.reused.is_empty() && !prepared.unchanged());
        let dir = commit(prepared).unwrap();
        assert!(dir.ends_with("/Material Icons"), "{dir}");
        assert_eq!(std::fs::read(Path::new(&dir).join(name)).unwrap(), v1);
        assert_eq!(std::fs::read(Path::new(&dir).join("LICENSE.txt")).unwrap(), APACHE);
        assert_eq!(fake_net::take_requests(), vec![(url.clone(), None), (license_url(), None)]);
        let saved = sidecar_in(&dir);
        assert_eq!((saved.id.as_str(), saved.source.as_str(), saved.last_modified.as_str()), ("material-icons", "google/material-design-icons", "2025-09-17"));
        assert_eq!(saved.upstream[name], Upstream { etag: "\"v1\"".into(), bytes: v1.len() as u64 });

        // The catalog sees it as installed. The download told it the file's current ETag, so the
        // file decides about updates: Fontsource's date moving on offers nothing.
        let listing = |last_modified: &str| {
            let families = vec![listed("material-icons", "icons", last_modified)];
            build(&data, CachedCatalog { fetched_at: now(), families }, false).families.remove(0)
        };
        let entry = listing("2025-09-17");
        assert!(entry.installed.is_some() && !entry.update_available);
        assert!(!listing("2026-01-01").update_available, "the file hasn't changed");
        // Without that answer (say the cache was cleared), the date decides, as for text families.
        std::fs::remove_file(latest_path(&data)).unwrap();
        assert!(listing("2026-01-01").update_available);

        // Update, file unchanged upstream: asked with its ETag, answered "not modified", reused.
        // Nothing changed, so the folder stays in place (its fonts stay on); only the license and
        // install details are rewritten, with the new date.
        std::fs::write(Path::new(&dir).join("kept.txt"), b"").unwrap();
        let newer = icons::corrected(listed("material-icons", "icons", "2026-01-01"));
        let prepared = prepare(&data, &newer).unwrap();
        assert_eq!(prepared.reused, vec![name]);
        assert!(prepared.unchanged());
        assert_eq!(prepared.replaces.as_ref().map(|d| std::fs::canonicalize(d).unwrap()), Some(PathBuf::from(&dir)));
        assert_eq!(fake_net::take_requests()[0], (url.clone(), Some("\"v1\"".to_string())));
        assert_eq!(refresh(prepared).unwrap(), dir);
        assert!(Path::new(&dir).join("kept.txt").exists(), "left in place, not swapped");
        assert_eq!(std::fs::read(Path::new(&dir).join(name)).unwrap(), v1);
        assert_eq!(std::fs::read(Path::new(&dir).join("LICENSE.txt")).unwrap(), APACHE);
        assert_eq!(sidecar_in(&dir).last_modified, "2026-01-01");
        assert_eq!(sidecar_in(&dir).upstream[name].etag, "\"v1\"");
        assert!(!listing("2026-01-01").update_available);
        assert!(leftovers(&data).is_empty(), "{:?}", leftovers(&data));

        // Another font file in the copy being replaced: the swap would remove it, so that's a change.
        std::fs::write(Path::new(&dir).join("Extra.ttf"), font("Extra", "x")).unwrap();
        let prepared = prepare(&data, &newer).unwrap();
        assert_eq!(prepared.reused, vec![name]);
        assert!(!prepared.unchanged());
        let dir = commit(prepared).unwrap();
        assert!(!Path::new(&dir).join("Extra.ttf").exists() && !Path::new(&dir).join("kept.txt").exists());

        // Update, file changed upstream: the new file is downloaded and its ETag recorded.
        let v2 = font("Material Icons", "abcdef");
        fake_net::set(&url, v2.clone(), Some("\"v2\""));
        let prepared = prepare(&data, &newer).unwrap();
        assert!(prepared.reused.is_empty() && !prepared.unchanged());
        let dir = commit(prepared).unwrap();
        assert_eq!(std::fs::read(Path::new(&dir).join(name)).unwrap(), v2);
        assert_eq!(sidecar_in(&dir).upstream[name].etag, "\"v2\"");

        // The local copy changed size since: no "has it changed?" question; downloaded in full.
        std::fs::write(Path::new(&dir).join(name), b"damaged").unwrap();
        fake_net::take_requests();
        let prepared = prepare(&data, &newer).unwrap();
        assert!(prepared.reused.is_empty());
        assert_eq!(fake_net::take_requests()[0], (url.clone(), None));
        let dir = commit(prepared).unwrap();
        assert_eq!(std::fs::read(Path::new(&dir).join(name)).unwrap(), v2);

        // Same size but no longer a font (say it was overwritten): not reused either.
        std::fs::write(Path::new(&dir).join(name), vec![0u8; v2.len()]).unwrap();
        let prepared = prepare(&data, &newer).unwrap();
        assert!(prepared.reused.is_empty());
        let dir = commit(prepared).unwrap();
        assert_eq!(std::fs::read(Path::new(&dir).join(name)).unwrap(), v2);
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn variable_icon_family_keeps_brackets_and_commas_in_its_file_name() {
        let data = data_dir("icons-variable");
        let name = "MaterialSymbolsRounded[FILL,GRAD,opsz,wght].ttf";
        let _net = fake_net::serve(vec![
            (icon_url("variablefont", name), font("Material Symbols Rounded", "ab"), None),
            (license_url(), APACHE.to_vec(), None),
        ]);
        let family = icons::corrected(listed("material-symbols-rounded", "icons", "2026-10-08"));
        let dir = commit(prepare(&data, &family).unwrap()).unwrap();
        assert!(dir.ends_with("/Material Symbols Rounded"), "{dir}");
        let bytes = std::fs::read(Path::new(&dir).join(name)).unwrap();
        assert_eq!(scanner::parse_file(&bytes).unwrap()[0].family, "Material Symbols Rounded");
        assert!(Path::new(&dir).join("LICENSE.txt").exists());
        // No ETag from the server: nothing recorded, so the next update downloads in full.
        assert!(sidecar_in(&dir).upstream.is_empty());
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn icon_family_without_its_license_or_with_a_broken_file_is_refused() {
        let data = data_dir("icons-refused");
        let name = "MaterialIconsSharp-Regular.otf";
        let family = icons::corrected(listed("material-icons-sharp", "icons", "2025-06-17"));
        {
            let _net = fake_net::serve(vec![(icon_url("font", name), font("Material Icons Sharp", "ab"), None)]);
            let err = prepare(&data, &family).err().expect("no license, no install");
            assert!(matches!(&err, AppError::NotFound(why) if why.contains("license")), "{err:?}");
        }
        {
            let _net = fake_net::serve(vec![(icon_url("font", name), b"not a font".to_vec(), None), (license_url(), APACHE.to_vec(), None)]);
            let err = prepare(&data, &family).err().expect("not a font");
            assert!(matches!(&err, AppError::Invalid(why) if why.contains(name)), "{err:?}");
        }
        {
            let _net = fake_net::serve(vec![(license_url(), APACHE.to_vec(), None)]);
            let err = prepare(&data, &family).err().expect("missing upstream");
            assert!(matches!(&err, AppError::NotFound(why) if why.contains(name)), "{err:?}");
        }
        assert!(installed_dir(&data, "material-icons-sharp").is_none());
        assert!(leftovers(&data).is_empty(), "{:?}", leftovers(&data));
        let visible: Vec<_> = std::fs::read_dir(service_dir(&data, "google").unwrap()).unwrap().flatten().collect();
        assert!(visible.is_empty(), "nothing installed: {visible:?}");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn text_family_still_installs_from_google_fonts() {
        let data = data_dir("text-install");
        let name = "Inter[opsz,wght].ttf";
        let metadata = "name: \"Inter\"\nfonts {\n  filename: \"Inter[opsz,wght].ttf\"\n}\n";
        let _net = fake_net::serve(vec![
            (format!("{REPO_RAW}/ofl/inter/METADATA.pb"), metadata.as_bytes().to_vec(), None),
            (format!("{REPO_RAW}/ofl/inter/{}", urlencode_path(name)), font("Inter", "Inter"), Some("\"i1\"")),
            (format!("{REPO_RAW}/ofl/inter/OFL.txt"), b"SIL Open Font License".to_vec(), None),
        ]);
        let family = CatalogFamily { last_modified: "2026-01-01".into(), ..fam("inter", "OFL-1.1") };
        let dir = commit(prepare(&data, &family).unwrap()).unwrap();
        assert!(Path::new(&dir).join(name).exists() && Path::new(&dir).join("OFL.txt").exists());
        let saved = sidecar_in(&dir);
        assert_eq!(saved.source, "google/fonts:ofl/inter");
        assert_eq!(saved.upstream[name].etag, "\"i1\"");
        // An update asks for the font only if it changed, like icon families.
        fake_net::take_requests();
        let prepared = prepare(&data, &family).unwrap();
        assert_eq!(prepared.reused, vec![name]);
        drop(prepared);
        assert!(leftovers(&data).is_empty(), "an abandoned download is cleaned up");
        // Text families aren't asked about between updates: their date decides.
        assert!(read_latest(&data).is_empty());

        // Fontsource's date moved on but the font didn't: an update that changes nothing keeps
        // the folder (and its fonts) in place and records the new date, so it isn't offered again.
        // A license saved under another name before goes.
        std::fs::write(Path::new(&dir).join("UFL.txt"), b"old license").unwrap();
        let newer = CatalogFamily { last_modified: "2026-02-01".into(), ..family.clone() };
        let prepared = prepare(&data, &newer).unwrap();
        assert!(prepared.unchanged());
        assert_eq!(refresh(prepared).unwrap(), dir);
        assert_eq!(sidecar_in(&dir).last_modified, "2026-02-01");
        assert!(Path::new(&dir).join("OFL.txt").exists() && !Path::new(&dir).join("UFL.txt").exists());
        let listing = |f: &CatalogFamily| build(&data, CachedCatalog { fetched_at: now(), families: vec![f.clone()] }, false).families.remove(0);
        assert!(!listing(&newer).update_available);
        assert!(listing(&CatalogFamily { last_modified: "2026-03-01".into(), ..family.clone() }).update_available);
        assert!(leftovers(&data).is_empty(), "{:?}", leftovers(&data));
        let _ = std::fs::remove_dir_all(&data);
    }

    /// Material Symbols is pushed to google/material-design-icons weekly, often a day or more after
    /// Fontsource's date for it moves. An update made in that gap keeps last week's file but takes
    /// the new date, so the date alone would then say "up to date" until it moved again. The file
    /// decides instead: each catalog refresh asks about it with a HEAD request.
    #[test]
    fn icon_updates_follow_the_files_not_fontsources_date() {
        let data = data_dir("icons-update-check");
        let name = "MaterialSymbolsRounded[FILL,GRAD,opsz,wght].ttf";
        let url = icon_url("variablefont", name);
        let v1 = font("Material Symbols Rounded", "ab");
        let _net = fake_net::serve(vec![(url.clone(), v1.clone(), Some("\"w1\"")), (license_url(), APACHE.to_vec(), None)]);
        let at = |date: &str| icons::corrected(listed("material-symbols-rounded", "icons", date));
        let listing = |date: &str| build(&data, CachedCatalog { fetched_at: now(), families: vec![at(date)] }, false).families.remove(0);
        let dir = commit(prepare(&data, &at("2026-10-01")).unwrap()).unwrap();
        assert!(!listing("2026-10-01").update_available);

        // Fontsource's date moves to 10-08 before Google pushes the new file: nothing is offered.
        fake_net::take_requests();
        check_icon_files(&data);
        assert_eq!(fake_net::take_requests(), vec![(format!("HEAD {url}"), Some("\"w1\"".to_string()))], "asked, nothing downloaded");
        assert!(!listing("2026-10-08").update_available, "the file hasn't changed yet");

        // Updated in that gap anyway (say, before any check had run): nothing changed, so it
        // takes the new date and keeps last week's file.
        let prepared = prepare(&data, &at("2026-10-08")).unwrap();
        assert!(prepared.unchanged());
        refresh(prepared).unwrap();
        assert_eq!(sidecar_in(&dir).last_modified, "2026-10-08");

        // Google pushes the new file. The next catalog refresh asks about it and offers the
        // update, though Fontsource's date hasn't moved again.
        let v2 = font("Material Symbols Rounded", "abc");
        fake_net::set(&url, v2.clone(), Some("\"w2\""));
        fake_net::set(CATALOG_URL, serde_json::to_vec(&vec![listed("material-symbols-rounded", "icons", "2026-10-08")]).unwrap(), None);
        let catalog = catalog(&data, true).unwrap();
        let entry = catalog.families.iter().find(|e| e.family.id == "material-symbols-rounded").unwrap();
        assert!(entry.installed.is_some() && entry.update_available, "the file changed");
        assert!(fake_net::take_requests().contains(&(format!("HEAD {url}"), Some("\"w1\"".to_string()))));

        // Updating downloads it, and then it's up to date.
        let prepared = prepare(&data, &at("2026-10-08")).unwrap();
        assert!(!prepared.unchanged());
        let dir = commit(prepared).unwrap();
        assert_eq!(std::fs::read(Path::new(&dir).join(name)).unwrap(), v2);
        assert!(!listing("2026-10-08").update_available);
        check_icon_files(&data);
        assert!(!listing("2026-10-08").update_available);

        // The server stops sending an ETag, or the file is gone (it moved): not known any more,
        // so the date decides.
        for gone in [false, true] {
            commit(prepare(&data, &at("2026-10-08")).unwrap()).unwrap();
            if gone {
                fake_net::remove(&url);
            } else {
                fake_net::set(&url, v2.clone(), None);
            }
            check_icon_files(&data);
            assert!(!read_latest(&data).contains_key(&url), "gone: {gone}");
            assert!(!listing("2026-10-08").update_available);
            assert!(listing("2026-10-15").update_available);
            fake_net::set(&url, v2.clone(), Some("\"w2\""));
        }
        assert!(leftovers(&data).is_empty(), "{:?}", leftovers(&data));
        let _ = std::fs::remove_dir_all(&data);
    }

    /// Live: installs Material Icons, then asks about its file the way each catalog refresh does.
    ///   cargo test icon_update_check_live -- --ignored --nocapture
    #[test]
    #[ignore]
    fn icon_update_check_live() {
        let data = data_dir("icons-check-live");
        let name = "MaterialIcons-Regular.ttf";
        let url = icon_url("font", name);
        let dir = commit(prepare(&data, &icons::corrected(listed("material-icons", "icons", "live"))).unwrap()).unwrap();
        let etag = sidecar_in(&dir).upstream[name].etag.clone();
        println!("{url}: {etag}");
        assert_eq!(read_latest(&data).get(&url), Some(&etag), "the download recorded it");
        std::fs::remove_file(latest_path(&data)).unwrap();
        check_icon_files(&data);
        assert_eq!(read_latest(&data).get(&url), Some(&etag), "asked: not modified");
        // Asked with an old ETag, the server gives the current one, and nothing is downloaded.
        assert!(matches!(super::super::current_etag(&url, "\"stale\""), Ok(Some(t)) if t == etag));
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn only_installed_icon_families_with_recorded_etags_are_asked_about() {
        let data = data_dir("icons-check-scope");
        let rounded = "MaterialSymbolsRounded[FILL,GRAD,opsz,wght].ttf";
        let _net = fake_net::serve(vec![
            // No ETag from the server: nothing to ask with later.
            (icon_url("variablefont", rounded), font("Material Symbols Rounded", "ab"), None),
            (license_url(), APACHE.to_vec(), None),
        ]);
        commit(prepare(&data, &icons::corrected(listed("material-symbols-rounded", "icons", "2026-10-08"))).unwrap()).unwrap();
        fake_net::take_requests();
        check_icon_files(&data);
        assert!(fake_net::take_requests().is_empty(), "no recorded ETag, and nothing else installed");
        let _ = std::fs::remove_dir_all(&data);
    }
}
