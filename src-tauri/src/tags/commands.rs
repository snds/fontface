//! Commands the UI calls for tags, location colors, imports and exports.
//! Slow work (reading files, Finder tags, Font Book) runs without holding the database lock.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use super::{
    export,
    import::{self, ImportPreview, ImportResult, Source},
    typeface, Organize, Tag,
};
use crate::{
    error::{AppError, AppResult},
    AppState,
};

#[tauri::command(async)]
pub fn tags_list(state: State<'_, AppState>) -> AppResult<Organize> {
    super::organize(&*state.conn()?)
}

#[tauri::command(async)]
pub fn tags_create(state: State<'_, AppState>, name: String, color: Option<String>) -> AppResult<Tag> {
    state.write(|conn| super::create_tag(conn, &name, color.as_deref()))
}

#[tauri::command(async)]
pub fn tags_rename(state: State<'_, AppState>, tag_id: i64, name: String) -> AppResult<Tag> {
    state.write(|conn| super::rename_tag(conn, tag_id, &name))
}

#[tauri::command(async)]
pub fn tags_recolor(state: State<'_, AppState>, tag_id: i64, color: String) -> AppResult<()> {
    state.write(|conn| super::set_tag_color(conn, tag_id, &color))
}

/// Deletes a tag and the tags nested under it. Returns the ids deleted.
#[tauri::command(async)]
pub fn tags_delete(state: State<'_, AppState>, tag_id: i64) -> AppResult<Vec<i64>> {
    state.write(|conn| super::delete_tag(conn, tag_id))
}

/// Adds (`on`) or removes tags on fonts, given by face key.
#[tauri::command(async)]
pub fn tags_assign(state: State<'_, AppState>, tag_ids: Vec<i64>, keys: Vec<String>, on: bool) -> AppResult<usize> {
    state.write(|conn| super::assign(conn, &tag_ids, &keys, on))
}

#[tauri::command(async)]
pub fn location_color_set(state: State<'_, AppState>, location: String, color: Option<String>) -> AppResult<()> {
    state.write(|conn| super::set_location_color(conn, &location, color.as_deref()))
}

// ---------------------------------------------------------------------------------- import

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImportRequest {
    Typeface { path: String },
    Fontface { path: String },
    Finder,
    FontBook,
}

/// Reads a file the user picked. Never writes to it.
fn read_source_file(path: &str, max: u64) -> AppResult<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(path)?;
    if file.metadata()?.len() > max {
        return Err(AppError::Invalid("That file is too large to be a tags backup".into()));
    }
    let mut bytes = Vec::new();
    file.take(max + 1).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Runs AppKit work on the main thread and waits for it. Apple doesn't document NSFontCollection
/// as safe on other threads, and commands run on worker threads.
#[cfg(target_os = "macos")]
fn on_main_thread<T: Send + 'static>(app: &AppHandle, f: impl FnOnce() -> T + Send + 'static) -> AppResult<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| AppError::Other(e.to_string()))?;
    rx.recv().map_err(|_| AppError::Other("Font Book didn't answer".into()))
}

fn load_source(app: &AppHandle, state: &AppState, request: &ImportRequest) -> AppResult<Source> {
    match request {
        ImportRequest::Typeface { path } => typeface::parse(&read_source_file(path, typeface::MAX_BYTES)?),
        ImportRequest::Fontface { path } => export::parse_json(&read_source_file(path, typeface::MAX_BYTES)?),
        #[cfg(target_os = "macos")]
        ImportRequest::Finder => {
            let paths: Vec<String> = super::LibraryIndex::load(&*state.conn()?)?.paths().cloned().collect();
            Ok(super::macos::finder_source(paths.iter()))
        }
        #[cfg(target_os = "macos")]
        ImportRequest::FontBook => on_main_thread(app, super::macos::font_book_source),
        #[cfg(not(target_os = "macos"))]
        ImportRequest::Finder | ImportRequest::FontBook => {
            let _ = (app, state);
            Err(AppError::Unsupported("Finder tags and Font Book collections".into()))
        }
    }
}

/// The library, ready to match `source`. Reading named styles from font files happens after
/// the database lock is released, so the rest of the app isn't held up.
fn matcher_for(state: &AppState, source: &Source) -> AppResult<import::Matcher> {
    let matcher = import::Matcher::load(&*state.conn()?)?;
    Ok(matcher.with_named_styles(source))
}

#[tauri::command(async)]
pub fn tags_import_preview(app: AppHandle, state: State<'_, AppState>, source: ImportRequest) -> AppResult<ImportPreview> {
    let source = load_source(&app, &state, &source)?;
    let matcher = matcher_for(&state, &source)?;
    import::preview_with(&*state.conn()?, &matcher, &source)
}

/// Applies the tags the user ticked in the preview (by name).
#[tauri::command(async)]
pub fn tags_import_apply(
    app: AppHandle,
    state: State<'_, AppState>,
    source: ImportRequest,
    tags: Vec<String>,
    keep_unmatched: bool,
) -> AppResult<ImportResult> {
    let source = load_source(&app, &state, &source)?;
    let matcher = matcher_for(&state, &source)?;
    state.write(|conn| import::apply_with(conn, &matcher, &source, &tags, keep_unmatched))
}

// ---------------------------------------------------------------------------------- export

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    Json,
    Csv,
    Typeface,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub tags: usize,
    /// Different fonts written.
    pub fonts: usize,
    /// Different fonts the format can't hold (Typeface needs a PostScript name).
    pub skipped: usize,
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[tauri::command(async)]
pub fn tags_export(
    state: State<'_, AppState>,
    format: ExportFormat,
    path: String,
    tag_ids: Option<Vec<i64>>,
) -> AppResult<ExportSummary> {
    // The save dialog adds the right extension; refuse anything else, so an export can never
    // land on a file of another kind (a shell profile, say).
    let ext = match format {
        ExportFormat::Json => "json",
        ExportFormat::Csv => "csv",
        ExportFormat::Typeface => "typeface-backup",
    };
    if Path::new(&path).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() != Some(ext) {
        return Err(AppError::Invalid(format!("Exports in this format must end in .{ext}")));
    }
    let (contents, tags, fonts, skipped) = {
        let conn = state.conn()?;
        let tags = export::collect(&conn, tag_ids.as_deref())?;
        let (count, fonts) = (tags.len(), export::font_count(&tags));
        match format {
            ExportFormat::Json => (export::to_json(&conn, tags, now())?, count, fonts, 0),
            ExportFormat::Csv => (export::to_csv(&tags), count, fonts, 0),
            ExportFormat::Typeface => {
                let (file, skipped) = export::to_typeface(&tags, now());
                (file, count, fonts - skipped, skipped)
            }
        }
    };
    export::write_file(Path::new(&path), &contents)?;
    Ok(ExportSummary { tags, fonts, skipped })
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileProblem {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinderExport {
    /// Files that got new Finder tags.
    pub changed: usize,
    /// Files that already had them.
    pub unchanged: usize,
    /// Fonts in the macOS font folders, which are left alone.
    pub skipped_installed: usize,
    pub failed: Vec<FileProblem>,
}

/// Adds each font's tags to its files as Finder tags. Tags already on a file are kept.
#[tauri::command(async)]
pub fn tags_export_finder(state: State<'_, AppState>, tag_ids: Option<Vec<i64>>) -> AppResult<FinderExport> {
    let (plan, skipped_installed) = export::finder_plan(&*state.conn()?, tag_ids.as_deref())?;
    let mut out = FinderExport { skipped_installed, ..Default::default() };
    let font_dirs: Vec<std::path::PathBuf> =
        crate::db::system_font_dirs().into_iter().filter_map(|(d, _)| std::fs::canonicalize(d).ok()).collect();
    for (path, names) in plan {
        match add_finder_tags(&path, &names, &font_dirs) {
            Ok(Some(true)) => out.changed += 1,
            Ok(Some(false)) => out.unchanged += 1,
            Ok(None) => out.skipped_installed += 1,
            Err(e) => out.failed.push(FileProblem { path, reason: e.to_string() }),
        }
    }
    Ok(out)
}

/// `None`: left alone, because the file (followed through any links) is in a macOS font folder.
#[cfg(target_os = "macos")]
fn add_finder_tags(path: &str, names: &std::collections::BTreeSet<String>, font_dirs: &[std::path::PathBuf]) -> AppResult<Option<bool>> {
    // Decide by where the file really is now, not by what the library recorded.
    let real = std::fs::canonicalize(path).map_err(|_| AppError::NotFound("The file isn't there any more".into()))?;
    if crate::services::adobe::is_adobe_path(Path::new(path)) || crate::services::adobe::is_adobe_path(&real) {
        return Err(AppError::Invalid("Adobe Fonts files are never changed".into()));
    }
    if font_dirs.iter().any(|d| real.starts_with(d)) {
        return Ok(None);
    }
    let path = real.to_string_lossy();
    let mut tags = super::macos::finder_tags(&path)?;
    let before = tags.len();
    for name in names {
        if !tags.iter().any(|t| t == name) {
            tags.push(name.clone());
        }
    }
    if tags.len() == before {
        return Ok(Some(false));
    }
    super::macos::set_finder_tags(&path, &tags)?;
    Ok(Some(true))
}

#[cfg(not(target_os = "macos"))]
fn add_finder_tags(_: &str, _: &std::collections::BTreeSet<String>, _: &[std::path::PathBuf]) -> AppResult<Option<bool>> {
    Err(AppError::Unsupported("Finder tags".into()))
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontBookExport {
    /// Collections created or added to.
    pub collections: usize,
    /// Fonts added, counted once per collection.
    pub added: usize,
    /// Different fonts without a PostScript name, which Font Book can't list.
    pub skipped: usize,
    pub failed: Vec<FileProblem>,
}

/// Adds each tag's fonts to a Font Book collection of the same name. Fonts already in a
/// collection stay there.
#[tauri::command(async)]
pub fn tags_export_font_book(app: AppHandle, state: State<'_, AppState>, tag_ids: Option<Vec<i64>>) -> AppResult<FontBookExport> {
    let tags = export::collect(&*state.conn()?, tag_ids.as_deref())?;
    let mut out = FontBookExport { skipped: export::without_postscript_name(&tags), ..Default::default() };
    for tag in tags {
        let mut names: Vec<String> = tag.fonts.iter().filter_map(|f| f.postscript_name.clone()).collect();
        names.sort();
        names.dedup();
        if names.is_empty() {
            continue;
        }
        match add_to_font_book(&app, tag.name.clone(), names) {
            Ok(added) => {
                if added > 0 {
                    out.collections += 1;
                    out.added += added;
                }
            }
            Err(e) => out.failed.push(FileProblem { path: tag.name, reason: e.to_string() }),
        }
    }
    Ok(out)
}

#[cfg(target_os = "macos")]
fn add_to_font_book(app: &AppHandle, name: String, postscript_names: Vec<String>) -> AppResult<usize> {
    on_main_thread(app, move || super::macos::add_to_collection(&name, &postscript_names))?
}

#[cfg(not(target_os = "macos"))]
fn add_to_font_book(_: &AppHandle, _: String, _: Vec<String>) -> AppResult<usize> {
    Err(AppError::Unsupported("Font Book collections".into()))
}
