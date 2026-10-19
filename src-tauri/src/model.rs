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
    /// Fontface turned this file on for this login only (it's in `temporary_activations`; see
    /// `db::mark_temporary`). Left out of the JSON when false.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub temporary: bool,
    /// The font's version (name ID 5), designer (9) and foundry (8), for the Table's columns.
    /// Left out of the list when the font doesn't say.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub designer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manufacturer: Option<String>,
    pub glyph_count: u16,
    /// A variable font's weights: its `wght` axis, lowest and highest, rounded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight_range: Option<[u16; 2]>,
    /// When the font came into the library, in Unix seconds (see `db::backfill_added_at`).
    /// Left out until it's known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added_at: Option<i64>,
    /// The font names its own grouping family (name ID 16, other than its name ID 1): family
    /// grouping by name leaves it alone. None until its names have been read (see
    /// `families::backfill_names`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_typo_family: Option<bool>,
    /// Its name ID 1, when that differs from `family` (which prefers name ID 16).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_family: Option<String>,
    /// What the preview draws (see preview/). None until the face has a current profile.
    pub preview: Option<crate::preview::PreviewInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontDetail {
    #[serde(flatten)]
    pub summary: FontSummary,
    pub copyright: Option<String>,
    pub license: Option<String>,
    pub license_url: Option<String>,
    pub axes: Vec<Axis>,
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
    /// What the OS has now (after `verify_with_os`).
    pub active: bool,
    /// What Fontface has recorded for the file now (its `activated`): the state asked for once
    /// that's written, else what was recorded before. It differs from `active` when another app
    /// keeps the font on, or macOS didn't load it, so the UI can show those states at once.
    pub activated: bool,
    /// On until logout or restart: the file's scope after the request (see
    /// `activation::temporary_after`). The UI shows it without reloading the list.
    pub temporary: bool,
    pub error: Option<String>,
}
