use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: i64,
    pub path: String,
    /// "system" for the macOS font folders (fonts there are always on), "user" for folders the user added.
    pub kind: String,
    /// Display name: a friendly name for system folders, the folder name otherwise.
    pub label: String,
    pub font_count: i64,
    pub missing: bool,
}

/// The lightweight row the library list needs. Everything else lives in `FontDetail`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontSummary {
    pub id: i64,
    pub folder_id: i64,
    pub path: String,
    pub face_index: u32,
    pub family: String,
    pub subfamily: String,
    pub full_name: Option<String>,
    pub postscript_name: Option<String>,
    pub weight: u16,
    pub width: u16,
    pub italic: bool,
    pub monospace: bool,
    pub variable: bool,
    pub format: String,
    /// What Fontface was asked to do (the user's intent), stored in the database.
    pub activated: bool,
    /// Lives in a macOS font folder, so the OS always loads it and it can't be switched off here.
    pub installed: bool,
    /// Modified time and size: identify this exact version of the file (preview cache key).
    pub mtime: i64,
    pub file_size: i64,
    /// What the OS reports right now. Can differ from `activated` if another app changed it.
    pub os_active: bool,
    /// What the preview draws (see preview/). None until the face has a current profile.
    pub preview: Option<crate::preview::PreviewInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontDetail {
    #[serde(flatten)]
    pub summary: FontSummary,
    pub version: Option<String>,
    pub designer: Option<String>,
    pub manufacturer: Option<String>,
    pub copyright: Option<String>,
    pub license: Option<String>,
    pub license_url: Option<String>,
    pub axes: Vec<Axis>,
    pub glyph_count: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Axis {
    pub tag: String,
    pub name: Option<String>,
    pub min: f32,
    pub default: f32,
    pub max: f32,
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub folder_id: i64,
    /// "discovering" while walking folders, then "reading" while parsing changed files.
    pub phase: &'static str,
    /// Font files found so far (discovering) or in total (reading).
    pub found: usize,
    /// Files finished, including ones skipped because they hadn't changed.
    pub done: usize,
    /// Files that have to be downloaded from cloud storage before they can be read.
    pub cloud: usize,
    pub current: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanFailure {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub folder_id: i64,
    pub files: usize,
    pub added: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub removed: usize,
    pub failed: Vec<ScanFailure>,
    /// Folders that couldn't be listed. When non-zero, nothing is removed from the library.
    pub walk_errors: usize,
    pub cancelled: bool,
}

/// Activation works per file: one file can hold several faces (.ttc), and the OS
/// turns them all on or off together. `ids` lists every face in that file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationOutcome {
    pub path: String,
    pub ids: Vec<i64>,
    pub active: bool,
    pub error: Option<String>,
}
