//! App settings: how Fontface behaves, chosen in the settings screen.
//!
//! **Storage.** One row per setting in `app_settings` (key → JSON value), so a setting added
//! later needs no migration, and an unknown or damaged row never breaks the others. Missing
//! settings take their defaults. Like the tag tables, the table lives outside the numbered
//! migrations in db.rs.
//!
//! **Changes** arrive as a partial object (`apply_patch`): only the keys present change,
//! `sidebar` merges key by key, unknown keys are ignored, numbers are clamped to their range,
//! and a value of the wrong kind is refused with a plain-words error, leaving everything as it was.
//!
//! **In memory.** `AppState` keeps a copy, so window and quit handlers never wait on the
//! database. Lock order: the settings lock is taken first or alone, never while holding the
//! activation lock or the DB mutex.
//!
//! `launchAtLogin` isn't trusted from storage: it reports whether the LaunchAgent file exists
//! and starts this copy of Fontface (see login_item.rs).

use std::ops::RangeInclusive;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

/// How turning a font on registers it with the OS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivationMode {
    /// Stays on after quitting and restarting.
    #[default]
    Persistent,
    /// On until logout or restart (CoreText's session scope).
    Temporary,
}

/// What launch does with fonts that were on when Fontface last ran but aren't on now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RestorePolicy {
    #[default]
    Always,
    Ask,
    Never,
}

/// The font page tab used last; the next font page opens on it. The page shows Axes only for a
/// variable style and falls back to Specimen otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FontPageTab {
    #[default]
    Specimen,
    Characters,
    Axes,
    Info,
}

/// How the library lists fonts: a grid of cards, the list of rows, or a table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Layout {
    Tiles,
    #[default]
    Rows,
    Table,
}

/// What the library is sorted by: the View options' choices, and the Table's other columns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortKey {
    #[default]
    Name,
    Added,
    Styles,
    Weight,
    Foundry,
    Active,
    Format,
    Source,
    Version,
    Designer,
    File,
    Size,
    Glyphs,
}

const SORT_KEYS: &[(&str, SortKey)] = &[
    ("name", SortKey::Name),
    ("added", SortKey::Added),
    ("styles", SortKey::Styles),
    ("weight", SortKey::Weight),
    ("foundry", SortKey::Foundry),
    ("active", SortKey::Active),
    ("format", SortKey::Format),
    ("source", SortKey::Source),
    ("version", SortKey::Version),
    ("designer", SortKey::Designer),
    ("file", SortKey::File),
    ("size", SortKey::Size),
    ("glyphs", SortKey::Glyphs),
];

/// The library's sort: a key, and whether it runs the other way (Z–A, oldest first…).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SortOrder {
    pub key: SortKey,
    pub desc: bool,
}

/// How tall the Table's rows are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TableDensity {
    Compact,
    #[default]
    Regular,
}

/// One of the Table's columns, in the order shown: whether it shows, and its width if the user
/// dragged it. The ids belong to the UI (src/components/library/columns.ts), which drops any it
/// doesn't know, so a column from a newer Fontface survives here untouched.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableColumn {
    pub id: String,
    pub shown: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
}

/// What the sidebar shows. All Fonts and the user's folders always show. Must match
/// `SidebarSections` in src/api.ts: a key only the UI knows is dropped by `apply_key`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SidebarSections {
    /// The smart entries under Library: Your Fonts, Recently Added, Active, Not Tagged.
    pub yours: bool,
    pub recent: bool,
    pub active: bool,
    pub untagged: bool,
    /// The sources.
    pub font_book: bool,
    pub google: bool,
    pub adobe: bool,
    pub purchases: bool,
    pub tags: bool,
    /// The Built-in group under Tags (tags from Font Book and Typeface). Hidden, they still exist
    /// and still show on fonts.
    pub builtin_tags: bool,
}

impl Default for SidebarSections {
    fn default() -> Self {
        SidebarSections {
            yours: true,
            recent: true,
            active: true,
            untagged: true,
            font_book: true,
            google: true,
            adobe: true,
            purchases: true,
            tags: true,
            builtin_tags: true,
        }
    }
}

/// Every setting. Must match `AppSettings` in src/api.ts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub theme: Theme,
    /// Empty: each family previews its own name.
    pub preview_text: String,
    pub preview_size: u32,
    /// The UI remembers the last view itself; this only says whether to reopen it.
    pub restore_last_view: bool,
    pub launch_at_login: bool,
    /// macOS: closing the window hides it, and clicking the Dock icon brings it back.
    pub keep_running_in_background: bool,
    /// The UI gates its launch rescan on this.
    pub scan_at_launch: bool,
    /// Whether "All" lists fonts in the macOS font folders (a UI filter).
    pub show_installed_in_all: bool,
    pub sidebar: SidebarSections,
    pub activation_mode: ActivationMode,
    /// Turn off fonts that are on temporarily when Fontface quits.
    pub clear_temporary_on_quit: bool,
    pub restore_on_launch: RestorePolicy,
    pub tag_backups: bool,
    pub tag_backup_keep: u32,
    /// Remembered by the UI, not chosen in the settings screen.
    pub font_page_tab: FontPageTab,
    /// The View options (and the toolbar's layout switch). Also remembered by the UI.
    pub layout: Layout,
    /// Off: every style is listed on its own, as "Family Style".
    pub group_styles: bool,
    pub sort: SortOrder,
    /// Empty: the UI's default columns.
    pub table_columns: Vec<TableColumn>,
    pub table_density: TableDensity,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            theme: Theme::System,
            preview_text: String::new(),
            preview_size: 32,
            restore_last_view: true,
            launch_at_login: false,
            keep_running_in_background: false,
            scan_at_launch: true,
            show_installed_in_all: true,
            sidebar: SidebarSections::default(),
            activation_mode: ActivationMode::Persistent,
            clear_temporary_on_quit: false,
            restore_on_launch: RestorePolicy::Always,
            tag_backups: true,
            tag_backup_keep: 10,
            font_page_tab: FontPageTab::Specimen,
            layout: Layout::Rows,
            group_styles: true,
            sort: SortOrder::default(),
            table_columns: Vec::new(),
            table_density: TableDensity::Regular,
        }
    }
}

pub const PREVIEW_SIZE: RangeInclusive<u32> = 10..=128;
/// A Table column's width in px.
pub const COLUMN_WIDTH: RangeInclusive<u32> = 32..=1200;
/// At most this many Table columns are kept.
pub const MAX_COLUMNS: usize = 40;
pub const BACKUP_KEEP: RangeInclusive<u32> = 1..=50;
pub const MAX_PREVIEW_TEXT: usize = 500;

// ------------------------------------------------------------------------------- changes

/// Applies a partial change. All or nothing: on an error, nothing changes.
pub fn apply_patch(current: &AppSettings, patch: &Value) -> AppResult<AppSettings> {
    let changes = patch.as_object().ok_or_else(|| invalid("Settings changes must be a list of names and values"))?;
    let mut next = current.clone();
    for (key, value) in changes {
        apply_key(&mut next, key, value)?;
    }
    Ok(next)
}

fn invalid(message: &str) -> AppError {
    AppError::Invalid(message.to_string())
}

fn apply_key(s: &mut AppSettings, key: &str, value: &Value) -> AppResult<()> {
    match key {
        "theme" => {
            s.theme = choice(value, "Appearance", &[("system", Theme::System), ("light", Theme::Light), ("dark", Theme::Dark)])?
        }
        "previewText" => s.preview_text = text(value)?,
        "previewSize" => s.preview_size = number(value, "Preview size", PREVIEW_SIZE)?,
        "restoreLastView" => s.restore_last_view = flag(value, "Reopen the last view")?,
        "launchAtLogin" => s.launch_at_login = flag(value, "Open at login")?,
        "keepRunningInBackground" => s.keep_running_in_background = flag(value, "Keep running when the window is closed")?,
        "scanAtLaunch" => s.scan_at_launch = flag(value, "Check folders at launch")?,
        "showInstalledInAll" => s.show_installed_in_all = flag(value, "Show installed fonts in All")?,
        "sidebar" => {
            let sections = value.as_object().ok_or_else(|| invalid("Sidebar sections must be a list of on or off choices"))?;
            for (section, on) in sections {
                let slot = match section.as_str() {
                    "yours" => &mut s.sidebar.yours,
                    "recent" => &mut s.sidebar.recent,
                    "active" => &mut s.sidebar.active,
                    "untagged" => &mut s.sidebar.untagged,
                    "fontBook" => &mut s.sidebar.font_book,
                    "google" => &mut s.sidebar.google,
                    "adobe" => &mut s.sidebar.adobe,
                    "purchases" => &mut s.sidebar.purchases,
                    "tags" => &mut s.sidebar.tags,
                    "builtinTags" => &mut s.sidebar.builtin_tags,
                    _ => continue,
                };
                *slot = flag(on, "Each sidebar section")?;
            }
        }
        "activationMode" => {
            s.activation_mode = choice(
                value,
                "Turning fonts on",
                &[("persistent", ActivationMode::Persistent), ("temporary", ActivationMode::Temporary)],
            )?
        }
        "clearTemporaryOnQuit" => s.clear_temporary_on_quit = flag(value, "Turn off temporary fonts at quit")?,
        "restoreOnLaunch" => {
            s.restore_on_launch = choice(
                value,
                "Fonts that were on last time",
                &[("always", RestorePolicy::Always), ("ask", RestorePolicy::Ask), ("never", RestorePolicy::Never)],
            )?
        }
        "tagBackups" => s.tag_backups = flag(value, "Back up tags")?,
        "tagBackupKeep" => s.tag_backup_keep = number(value, "Backups to keep", BACKUP_KEEP)?,
        "fontPageTab" => {
            s.font_page_tab = choice(
                value,
                "The font page tab",
                &[
                    ("specimen", FontPageTab::Specimen),
                    ("characters", FontPageTab::Characters),
                    ("axes", FontPageTab::Axes),
                    ("info", FontPageTab::Info),
                ],
            )?
        }
        "layout" => {
            s.layout = choice(value, "The layout", &[("tiles", Layout::Tiles), ("rows", Layout::Rows), ("table", Layout::Table)])?
        }
        "groupStyles" => s.group_styles = flag(value, "Group styles into families")?,
        "sort" => s.sort = sort_order(value)?,
        "tableColumns" => s.table_columns = table_columns(value)?,
        "tableDensity" => {
            s.table_density =
                choice(value, "Table density", &[("compact", TableDensity::Compact), ("regular", TableDensity::Regular)])?
        }
        // A setting from a newer Fontface, or a typo: ignored.
        _ => {}
    }
    Ok(())
}

/// `{ key, desc }`: the key is required, the direction defaults to the usual one.
fn sort_order(value: &Value) -> AppResult<SortOrder> {
    let order = value.as_object().ok_or_else(|| invalid("The sort must say what to sort by"))?;
    let key = choice(order.get("key").unwrap_or(&Value::Null), "The sort", SORT_KEYS)?;
    let desc = match order.get("desc") {
        None | Some(Value::Null) => false,
        Some(v) => flag(v, "Reverse the sort")?,
    };
    Ok(SortOrder { key, desc })
}

/// A list of `{ id, shown, width? }`. Widths are pulled into range; a column listed twice keeps
/// its first place; past `MAX_COLUMNS` the rest are dropped.
fn table_columns(value: &Value) -> AppResult<Vec<TableColumn>> {
    let bad = || invalid("Table columns must be a list of columns, each with a name and whether it shows");
    let list = value.as_array().ok_or_else(bad)?;
    let mut columns: Vec<TableColumn> = Vec::new();
    for item in list {
        let column = item.as_object().ok_or_else(bad)?;
        let id = column.get("id").and_then(Value::as_str).ok_or_else(bad)?;
        if id.is_empty() || id.len() > 32 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(bad());
        }
        let shown = flag(column.get("shown").unwrap_or(&Value::Null), "Each table column")?;
        let width = match column.get("width") {
            None | Some(Value::Null) => None,
            Some(w) => Some(number(w, "A column's width", COLUMN_WIDTH)?),
        };
        if columns.len() < MAX_COLUMNS && !columns.iter().any(|c| c.id == id) {
            columns.push(TableColumn { id: id.to_string(), shown, width });
        }
    }
    Ok(columns)
}

fn flag(value: &Value, label: &str) -> AppResult<bool> {
    value.as_bool().ok_or_else(|| AppError::Invalid(format!("“{label}” must be on or off")))
}

fn number(value: &Value, label: &str, range: RangeInclusive<u32>) -> AppResult<u32> {
    let n = value.as_f64().ok_or_else(|| AppError::Invalid(format!("{label} must be a number")))?;
    Ok(n.round().clamp(f64::from(*range.start()), f64::from(*range.end())) as u32)
}

fn text(value: &Value) -> AppResult<String> {
    let text = value.as_str().ok_or_else(|| invalid("Preview text must be text"))?;
    if text.chars().count() > MAX_PREVIEW_TEXT {
        return Err(AppError::Invalid(format!("Preview text can be at most {MAX_PREVIEW_TEXT} characters")));
    }
    Ok(text.to_string())
}

fn choice<T: Copy>(value: &Value, label: &str, options: &[(&str, T)]) -> AppResult<T> {
    let wanted = value.as_str().unwrap_or_default();
    if let Some((_, v)) = options.iter().find(|(name, _)| *name == wanted) {
        return Ok(*v);
    }
    let names: Vec<String> = options.iter().map(|(name, _)| format!("“{name}”")).collect();
    let list = match names.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} or {last}", rest.join(", ")),
        _ => names.join(""),
    };
    Err(AppError::Invalid(format!("{label} must be {list}")))
}

// ------------------------------------------------------------------------------- storage

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS app_settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);
";

/// Creates the settings table if it's missing. Idempotent; called once at launch.
pub fn ensure_schema(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(SCHEMA)?;
    Ok(())
}

/// The saved settings, over the defaults. A row that can't be read is skipped (and logged), so
/// one damaged value never resets the rest.
pub fn load(conn: &Connection) -> AppResult<AppSettings> {
    let mut stmt = conn.prepare("SELECT key, value FROM app_settings")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut settings = AppSettings::default();
    for row in rows {
        let (key, raw) = row?;
        let applied = serde_json::from_str::<Value>(&raw)
            .map_err(|e| AppError::Invalid(e.to_string()))
            .and_then(|value| apply_key(&mut settings, &key, &value));
        if let Err(e) = applied {
            eprintln!("fontface: ignoring saved setting {key}: {e}");
        }
    }
    Ok(settings)
}

/// Saves every setting. Rows for keys this version doesn't know are left alone.
pub fn save(conn: &mut Connection, settings: &AppSettings) -> AppResult<()> {
    let Value::Object(values) = serde_json::to_value(settings).expect("plain data always serializes") else {
        unreachable!("settings serialize as an object")
    };
    let tx = conn.transaction()?;
    for (key, value) in values {
        tx.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, value.to_string()],
        )?;
    }
    tx.commit()?;
    Ok(())
}

// ----------------------------------------------------------------------- launch at login

/// Whether the LaunchAgent is there and starts this copy of Fontface.
pub fn launch_at_login_enabled() -> bool {
    #[cfg(target_os = "macos")]
    {
        match (crate::login_item::agents_dir(), std::env::current_exe()) {
            (Some(dir), Ok(exe)) => crate::login_item::is_enabled(&dir, &exe),
            _ => false,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Writes or removes the LaunchAgent.
pub fn set_launch_at_login(on: bool) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        let dir = crate::login_item::agents_dir().ok_or_else(|| invalid("Couldn't find your home folder"))?;
        if on {
            crate::login_item::enable(&dir, &std::env::current_exe()?)
        } else {
            crate::login_item::disable(&dir)
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        if on {
            Err(invalid("Opening Fontface at login isn't available on this system yet"))
        } else {
            Ok(())
        }
    }
}

/// At launch: if the app has moved since the LaunchAgent was written (the copy it starts is
/// gone), points it at the new place. Only for a copy running from an app bundle, so running a
/// development build never takes over the installed app's login item, and never for a copy on a
/// disk image or one macOS moved aside (see `login_item::refresh`).
pub fn refresh_launch_at_login() {
    #[cfg(target_os = "macos")]
    {
        let (Some(dir), Ok(exe)) = (crate::login_item::agents_dir(), std::env::current_exe()) else { return };
        if !crate::login_item::in_app_bundle(&exe) {
            return;
        }
        if let Err(e) = crate::login_item::refresh(&dir, &exe) {
            eprintln!("fontface: couldn't update the login item: {e}");
        }
    }
}
