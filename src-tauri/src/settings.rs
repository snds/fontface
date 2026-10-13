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

/// Which sections the sidebar shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SidebarSections {
    pub font_book: bool,
    pub google: bool,
    pub adobe: bool,
    pub purchases: bool,
    pub tags: bool,
}

impl Default for SidebarSections {
    fn default() -> Self {
        SidebarSections { font_book: true, google: true, adobe: true, purchases: true, tags: true }
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
        }
    }
}

pub const PREVIEW_SIZE: RangeInclusive<u32> = 10..=128;
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
                    "fontBook" => &mut s.sidebar.font_book,
                    "google" => &mut s.sidebar.google,
                    "adobe" => &mut s.sidebar.adobe,
                    "purchases" => &mut s.sidebar.purchases,
                    "tags" => &mut s.sidebar.tags,
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
        // A setting from a newer Fontface, or a typo: ignored.
        _ => {}
    }
    Ok(())
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
