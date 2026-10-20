//! Fontface in the menu bar (macOS) or the notification area (Windows): an icon with a short
//! menu, so Fontface can keep running with its window closed.
//!
//! **What closing the window does** (`on_close`). While the icon is there, closing the window
//! keeps Fontface running: the icon is the way back. Without it, macOS's "Keep running when the
//! window is closed" decides (the Dock icon is the way back); elsewhere closing quits.
//!
//! **The Dock** (macOS, `dock_hidden_while_closed`). "Show in the Dock: only while the window is
//! open" makes Fontface a menu bar app while its window is closed (window.rs, `dock`). It needs
//! the icon: without it nothing would bring the window back.
//!
//! **Opening at login** (`starts_hidden`). The login item starts Fontface with `--login`
//! (login_item.rs). With the icon there, it starts with its window closed.
//!
//! **The menu** (`menu_slots`) is short: Open Fontface, Turn Off Temporary Fonts, Settings… and
//! Quit Fontface. It's rebuilt only when what it shows changes: the count of fonts that are on
//! until logout, read from the library when the pointer reaches the icon, after a switch, and
//! after launch's restore.
//!
//! Native menus can't show tooltips, so each label says what it does.

use std::sync::{
    atomic::{AtomicBool, Ordering::Relaxed},
    Mutex,
};

use tauri::{AppHandle, Emitter, Manager};

use crate::{
    activation,
    error::AppResult,
    settings::{AppSettings, DockIcon},
    AppState,
};

// ------------------------------------------------------------------------- staying open

/// What closing the main window does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnClose {
    Quit,
    /// Hide it; Fontface keeps running.
    Hide,
}

/// Closing the window keeps Fontface running while its icon is in the menu bar (`icon`), and on
/// macOS (`mac`) when "Keep running when the window is closed" is on; otherwise it quits.
pub fn on_close(settings: &AppSettings, icon: bool, mac: bool) -> OnClose {
    if icon || (mac && settings.keep_running_in_background) {
        OnClose::Hide
    } else {
        OnClose::Quit
    }
}

/// macOS: whether the Dock icon goes while the window is closed. Only with the menu bar icon
/// there (`icon`), so Fontface can always be found.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn dock_hidden_while_closed(settings: &AppSettings, icon: bool) -> bool {
    icon && settings.dock_icon == DockIcon::WhileOpen
}

/// Whether a launch starts with the window closed: opened at login, with the icon there.
pub fn starts_hidden(at_login: bool, icon: bool) -> bool {
    at_login && icon
}

/// Whether the login item started this launch (it passes `--login`; see login_item.rs).
pub fn launched_at_login() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::env::args().skip(1).any(|a| a == crate::login_item::LOGIN_ARG)
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

// ----------------------------------------------------------------------------- the icon

/// The menu bar icon (macOS): a rounded square with "Ff" cut out of it, after the app icon.
/// Black on clear, `size` pixels square, as RGBA. macOS draws it as a template image, in the
/// menu bar's own color, so it suits light and dark menu bars. Each pixel's opacity is how much
/// of it the shape covers (4×4 samples), so the edges are smooth.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn glyph(size: u32) -> Vec<u8> {
    const SAMPLES: u32 = 4;
    let unit = 36.0 / f64::from(size);
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);
    for py in 0..size {
        for px in 0..size {
            let mut covered = 0;
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let x = (f64::from(px) + (f64::from(sx) + 0.5) / f64::from(SAMPLES)) * unit;
                    let y = (f64::from(py) + (f64::from(sy) + 0.5) / f64::from(SAMPLES)) * unit;
                    covered += u32::from(glyph_covers(x, y));
                }
            }
            let alpha = (covered * 255 + SAMPLES * SAMPLES / 2) / (SAMPLES * SAMPLES);
            rgba.extend_from_slice(&[0, 0, 0, alpha as u8]);
        }
    }
    rgba
}

/// The icon's shape on a 36×36 grid (18 points at 2×): a square with rounded corners, less the
/// letters. Strokes are 3.5 units (1.75 points).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn glyph_covers(x: f64, y: f64) -> bool {
    let in_rect = |x0: f64, y0: f64, x1: f64, y1: f64| x >= x0 && x < x1 && y >= y0 && y < y1;
    let square = {
        let (lo, hi, r) = (3.0, 33.0, 7.0);
        let cx = x.clamp(lo + r, hi - r);
        let cy = y.clamp(lo + r, hi - r);
        in_rect(lo, lo, hi, hi) && (x - cx).powi(2) + (y - cy).powi(2) <= r * r
    };
    // F: stem, top arm, middle arm.
    let f_cap = in_rect(8.0, 10.0, 11.5, 28.0) || in_rect(8.0, 10.0, 18.0, 13.5) || in_rect(8.0, 17.5, 15.5, 21.0);
    // f: stem, the hook over its top (a quarter ring) and its end, and the crossbar.
    let hook = {
        let (cx, cy) = (27.0, 14.5);
        let d = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
        x <= cx && y <= cy && (3.0..=6.5).contains(&d)
    };
    let f_small = in_rect(20.5, 14.5, 24.0, 28.0) || hook || in_rect(27.0, 8.0, 29.5, 11.5) || in_rect(18.5, 17.5, 27.0, 21.0);
    square && !f_cap && !f_small
}

// ----------------------------------------------------------------------------- the menu

/// What a menu item does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    Open,
    TemporaryOff,
    Settings,
    Quit,
}

const ACTIONS: [TrayAction; 4] = [TrayAction::Open, TrayAction::TemporaryOff, TrayAction::Settings, TrayAction::Quit];

impl TrayAction {
    pub fn id(self) -> &'static str {
        match self {
            TrayAction::Open => "tray.open",
            TrayAction::TemporaryOff => "tray.temporaryOff",
            TrayAction::Settings => "tray.settings",
            TrayAction::Quit => "tray.quit",
        }
    }

    /// The action of a chosen menu item, if it's one of this menu's (the app menu's items come
    /// through the same handler).
    pub fn parse(id: &str) -> Option<TrayAction> {
        ACTIONS.into_iter().find(|a| a.id() == id)
    }
}

/// One line of the menu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TraySlot {
    Item { action: TrayAction, text: String, enabled: bool },
    Separator,
}

fn item(action: TrayAction, text: impl Into<String>, enabled: bool) -> TraySlot {
    TraySlot::Item { action, text: text.into(), enabled }
}

/// The menu, top to bottom: open the window, temporary fonts off (`temporary`: how many fonts
/// are on until logout, or until Fontface quits), Settings and Quit.
pub fn menu_slots(temporary: usize) -> Vec<TraySlot> {
    vec![
        item(TrayAction::Open, "Open Fontface", true),
        TraySlot::Separator,
        match temporary {
            0 => item(TrayAction::TemporaryOff, "Turn Off Temporary Fonts", false),
            n => item(TrayAction::TemporaryOff, format!("Turn Off Temporary Fonts ({n})"), true),
        },
        TraySlot::Separator,
        item(TrayAction::Settings, "Settings…", true),
        TraySlot::Separator,
        item(TrayAction::Quit, "Quit Fontface", true),
    ]
}

// ------------------------------------------------------------------------- the running app

/// The icon's id.
const TRAY_ID: &str = "fontface";

/// The icon is in the menu bar now (it was made and is visible).
static ICON_SHOWN: AtomicBool = AtomicBool::new(false);

pub fn icon_shown() -> bool {
    ICON_SHOWN.load(Relaxed)
}

/// What the menu shows now.
#[derive(Default)]
pub struct TrayState {
    shown: Mutex<Option<Vec<TraySlot>>>,
}

/// Puts the icon in the menu bar, or takes it away, to match the setting. It's made the first
/// time, then only shown or hidden: Tauri never lets go of an icon's handlers.
pub fn show_icon(app: &AppHandle, on: bool) -> tauri::Result<()> {
    match app.tray_by_id(TRAY_ID) {
        Some(tray) => tray.set_visible(on)?,
        None if on => {
            build(app)?;
        }
        None => {}
    }
    ICON_SHOWN.store(on, Relaxed);
    if on {
        refresh_soon(app);
    } else if let Some(main) = app.get_webview_window("main") {
        // Nothing would bring a closed window back now.
        if !main.is_visible().unwrap_or(true) {
            crate::window::show(&main);
        }
    }
    Ok(())
}

fn build(app: &AppHandle) -> tauri::Result<tauri::tray::TrayIcon> {
    use tauri::tray::TrayIconBuilder;
    let slots = menu_slots(0);
    let menu = build_menu(app, &slots)?;
    let builder = TrayIconBuilder::with_id(TRAY_ID).tooltip("Fontface").menu(&menu);
    #[cfg(target_os = "macos")]
    let builder = builder
        .icon(tauri::image::Image::new_owned(glyph(36), 36, 36))
        .icon_as_template(true)
        .show_menu_on_left_click(true);
    // Elsewhere: the app icon. Clicking it opens the window; right-clicking opens the menu.
    #[cfg(not(target_os = "macos"))]
    let builder = match app.default_window_icon() {
        Some(icon) => builder.icon(icon.clone().to_owned()),
        None => builder,
    }
    .show_menu_on_left_click(false);
    let tray = builder.on_tray_icon_event(|tray, event| on_icon_event(tray.app_handle(), event)).build(app)?;
    if let Some(state) = app.try_state::<TrayState>() {
        *state.shown.lock().unwrap_or_else(|p| p.into_inner()) = Some(slots);
    }
    Ok(tray)
}

fn build_menu(app: &AppHandle, slots: &[TraySlot]) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
    let mut items: Vec<Box<dyn IsMenuItem<tauri::Wry>>> = Vec::with_capacity(slots.len());
    for slot in slots {
        items.push(match slot {
            TraySlot::Separator => Box::new(PredefinedMenuItem::separator(app)?),
            TraySlot::Item { action, text, enabled } => Box::new(MenuItem::with_id(app, action.id(), text, *enabled, None::<&str>)?),
        });
    }
    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items.iter().map(|i| i.as_ref()).collect();
    Menu::with_items(app, &refs)
}

/// How many fonts are on until logout now, for the menu.
fn temporary_now(app: &AppHandle) -> usize {
    app.try_state::<AppState>()
        .and_then(|state| state.conn().ok().and_then(|conn| activation::temporary_on_count(&conn).ok()))
        .unwrap_or(0)
}

/// Brings the menu up to date, if the icon is there and something it shows has changed. Reads
/// the library, so never call it on the main thread (`refresh_soon` from there).
pub fn refresh(app: &AppHandle) {
    if !icon_shown() {
        return;
    }
    let (Some(state), Some(tray)) = (app.try_state::<TrayState>(), app.tray_by_id(TRAY_ID)) else { return };
    let slots = menu_slots(temporary_now(app));
    let mut shown = state.shown.lock().unwrap_or_else(|p| p.into_inner());
    if shown.as_ref() == Some(&slots) {
        return;
    }
    match build_menu(app, &slots).and_then(|menu| tray.set_menu(Some(menu))) {
        Ok(()) => *shown = Some(slots),
        Err(e) => eprintln!("fontface: couldn't update the menu bar menu: {e}"),
    }
}

/// `refresh`, on its own thread.
pub fn refresh_soon(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || refresh(&app));
}

/// A menu item was chosen. Items of other menus are ignored. Runs on the main thread.
pub fn on_menu_event(app: &AppHandle, id: &str) {
    let Some(action) = TrayAction::parse(id) else { return };
    let open = || {
        if let Some(main) = app.get_webview_window("main") {
            crate::window::show(&main);
        }
    };
    match action {
        TrayAction::Open => open(),
        TrayAction::Settings => {
            open();
            let _ = app.emit_to("main", "open-settings", ());
        }
        TrayAction::TemporaryOff => {
            let app = app.clone();
            std::thread::spawn(move || {
                let report = turn_off_temporary(&app).unwrap_or_else(|e| TemporaryOff { error: Some(e.to_string()), ..Default::default() });
                let _ = app.emit("activation-changed", &report);
                refresh(&app);
            });
        }
        TrayAction::Quit => app.exit(0),
    }
}

fn on_icon_event(app: &AppHandle, event: tauri::tray::TrayIconEvent) {
    use tauri::tray::TrayIconEvent;
    match event {
        // The pointer is on its way to the menu: bring the count up to date.
        TrayIconEvent::Enter { .. } => refresh_soon(app),
        // Elsewhere a click opens the window (the menu is on the right button).
        #[cfg(not(target_os = "macos"))]
        TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. }
        | TrayIconEvent::DoubleClick { button: tauri::tray::MouseButton::Left, .. } => {
            if let Some(main) = app.get_webview_window("main") {
                crate::window::show(&main);
            }
        }
        _ => {}
    }
}

/// What "Turn Off Temporary Fonts" did, sent to the page with "activation-changed" (which also
/// reloads the list). Must match TemporaryOffReport in src/api.ts.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporaryOff {
    /// Fonts (styles) turned off.
    pub turned_off: usize,
    /// (file, why) for each file that couldn't be turned off.
    pub failed: Vec<(String, String)>,
    /// Why nothing could be done, if so.
    pub error: Option<String>,
}

/// Turns off every font that's on until logout, as the user's own switch would: the same locks
/// and checks with the OS, recorded as off, and shared by sync as their choice.
fn turn_off_temporary(app: &AppHandle) -> AppResult<TemporaryOff> {
    let state = app.state::<AppState>();
    let ids = activation::temporary_font_ids(&*state.conn()?)?;
    let mut report = TemporaryOff::default();
    if ids.is_empty() {
        return Ok(report);
    }
    let outcomes = crate::commands::switch(&state, &ids, false, None)?;
    crate::sync::activation_chosen(&state, &ids, false, &outcomes);
    for outcome in outcomes {
        match outcome.error {
            None => report.turned_off += outcome.ids.len(),
            Some(why) => report.failed.push((outcome.path, why)),
        }
    }
    Ok(report)
}

/// After a settings change: the icon follows "Show Fontface in the menu bar".
pub fn settings_changed(app: &AppHandle, before: &AppSettings, next: &AppSettings) {
    if before.show_in_menu_bar != next.show_in_menu_bar {
        if let Err(e) = show_icon(app, next.show_in_menu_bar) {
            eprintln!("fontface: couldn't {} the menu bar icon: {e}", if next.show_in_menu_bar { "show" } else { "hide" });
        }
    }
}
