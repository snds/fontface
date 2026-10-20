//! The main window's native side: the macOS menu bar (with the View and Font menus the page
//! drives), the window's File menu on Windows and Linux, double-clicking the title bar, the
//! window's color before the page paints, and hiding the window when it's closed (with the Dock
//! icon, on macOS; see tray.rs).
//!
//! On macOS the title bar is an overlay (src-tauri/tauri.macos.conf.json): the page draws the
//! top row and marks it as the place to drag the window from (src/components/TitleBar.tsx).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
#[cfg(target_os = "macos")]
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::{
    error::{AppError, AppResult},
    settings::Theme,
};

// ----------------------------------------------------------------------------------- menu

/// The id of the "Settings…" item: in the app menu on macOS, in the window's File menu
/// elsewhere. There's no Settings button in the window itself.
const SETTINGS_ITEM: &str = "settings";

/// The id of the File menu's "Exit" (Windows) or "Quit" (Linux) item. macOS quits from the app
/// menu instead.
#[cfg(not(target_os = "macos"))]
const QUIT_ITEM: &str = "file.quit";

/// One item of the View or Font menu. Choosing it sends "menu" to the page with its id, and the
/// page keeps the items' state in step with what's on screen (`set_menu_state`). The ids must
/// match src/fontActions.ts (src/menuIds.test.ts reads this file to check).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MenuEntry {
    pub id: &'static str,
    /// The name it has until the page gives it another (Turn On's name follows the activation
    /// mode, Compare's the selection).
    pub text: &'static str,
    pub accelerator: Option<&'static str>,
    /// A check item (a layout, the sort, Group Styles into Families).
    pub check: bool,
}

/// What a menu holds, in order.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, Copy)]
pub enum Slot {
    Item(MenuEntry),
    Separator,
    Submenu(&'static str, &'static [Slot]),
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const fn item(id: &'static str, text: &'static str, accelerator: Option<&'static str>) -> Slot {
    Slot::Item(MenuEntry { id, text, accelerator, check: false })
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const fn check(id: &'static str, text: &'static str, accelerator: Option<&'static str>) -> Slot {
    Slot::Item(MenuEntry { id, text, accelerator, check: true })
}

/// The View menu, above Enter Full Screen: the library's layouts, grouping and sort (what View
/// options holds), the preview size (the preview bar's), and Back.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const VIEW_MENU: &[Slot] = &[
    check("view.tiles", "Tiles", Some("CmdOrCtrl+1")),
    check("view.rows", "Rows", Some("CmdOrCtrl+2")),
    check("view.table", "Table", Some("CmdOrCtrl+3")),
    Slot::Separator,
    check("view.group", "Group Styles into Families", None),
    Slot::Submenu(
        "Sort By",
        &[
            check("sort.name", "Name", None),
            check("sort.added", "Date Added", None),
            check("sort.styles", "Number of Styles", None),
            check("sort.weight", "Weight", None),
            check("sort.foundry", "Foundry", None),
            check("sort.active", "On or Off", None),
            Slot::Separator,
            check("sort.asc", "A to Z", None),
            check("sort.desc", "Z to A", None),
        ],
    ),
    Slot::Separator,
    item("view.bigger", "Bigger Preview", Some("CmdOrCtrl+=")),
    item("view.smaller", "Smaller Preview", Some("CmdOrCtrl+-")),
    Slot::Separator,
    item("view.back", "Back", Some("CmdOrCtrl+[")),
];

/// The Font menu: what can be done to the selected fonts, or the open font page's family. The
/// same actions as the right-click menu.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const FONT_MENU: &[Slot] = &[
    item("font.open", "Open", None),
    item("font.info", "Show Info", Some("CmdOrCtrl+I")),
    Slot::Separator,
    item("font.turnOn", "Turn On", Some("CmdOrCtrl+Enter")),
    item("font.turnOnOther", "Turn On Until Logout", Some("Alt+CmdOrCtrl+Enter")),
    item("font.turnOff", "Turn Off", Some("Shift+CmdOrCtrl+Enter")),
    Slot::Separator,
    item("font.tags", "Tags…", Some("CmdOrCtrl+T")),
    item("font.compare", "Compare With…", None),
    item("font.pair", "Pair With…", None),
    item("font.familyGroup", "Family Group…", None),
    Slot::Separator,
    item("font.reveal", "Show in Finder", None),
    item("font.copyPostScript", "Copy PostScript Name", None),
    Slot::Separator,
    item("font.remove", "Remove from Library…", None),
];

/// Every item of the View and Font menus, in menu order.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn menu_entries() -> Vec<MenuEntry> {
    fn walk(slots: &[Slot], out: &mut Vec<MenuEntry>) {
        for slot in slots {
            match slot {
                Slot::Item(entry) => out.push(*entry),
                Slot::Separator => {}
                Slot::Submenu(_, inner) => walk(inner, out),
            }
        }
    }
    let mut out = Vec::new();
    walk(VIEW_MENU, &mut out);
    walk(FONT_MENU, &mut out);
    out
}

/// The View and Font menus' items as the page wants them: which are enabled and checked, and
/// names that differ from the usual one. Items it doesn't name are disabled and unchecked, and
/// ids it names that aren't items are ignored. Must match NativeMenuState in src/fontActions.ts.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MenuState {
    pub enabled: BTreeSet<String>,
    pub checked: BTreeSet<String>,
    pub texts: BTreeMap<String, String>,
}

/// One change to make to a menu item.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuUpdate {
    Enabled(&'static str, bool),
    Checked(&'static str, bool),
    Text(&'static str, String),
}

/// The changes that take the menus from `before` to `after`. Each one is a trip to the main
/// thread, so only what changed is sent.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn menu_updates(before: &MenuState, after: &MenuState) -> Vec<MenuUpdate> {
    let mut out = Vec::new();
    for entry in menu_entries() {
        let enabled = after.enabled.contains(entry.id);
        if enabled != before.enabled.contains(entry.id) {
            out.push(MenuUpdate::Enabled(entry.id, enabled));
        }
        if entry.check {
            let checked = after.checked.contains(entry.id);
            if checked != before.checked.contains(entry.id) {
                out.push(MenuUpdate::Checked(entry.id, checked));
            }
        }
        let (was, now) = (shown_text(before, &entry), shown_text(after, &entry));
        if now != was {
            out.push(MenuUpdate::Text(entry.id, now.to_string()));
        }
    }
    out
}

/// An item's name in a state: the page's, or its usual one.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn shown_text<'a>(state: &'a MenuState, entry: &MenuEntry) -> &'a str {
    state.texts.get(entry.id).map(String::as_str).filter(|t| !t.trim().is_empty()).unwrap_or(entry.text)
}

/// The checkmark each check item of the View menu should show: the page's last word on it.
///
/// macOS (muda) flips a check item's mark by itself when it's chosen, before the page hears of
/// it. The page decides what really changes: choosing Tiles while in Tiles, Name while sorted by
/// name, or any item while a popover is open over the list changes nothing, and the page says
/// nothing back. So the mark is put back as soon as the choice arrives (`after_choice`), and
/// whatever the page then changes comes in with `set_menu_state` as usual.
///
/// Read on the main thread while `set_menu_state` may hold its lock and wait for that thread,
/// so it's lock-free: one flag per item, fixed when the menus are built.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct CheckMarks(HashMap<&'static str, AtomicBool>);

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl CheckMarks {
    /// Every check item of the View and Font menus, unchecked (as they're built).
    pub fn new() -> Self {
        Self(menu_entries().into_iter().filter(|e| e.check).map(|e| (e.id, AtomicBool::new(false))).collect())
    }

    /// Notes a change the page asked for (`menu_updates`); other kinds of change don't matter here.
    pub fn note(&self, update: &MenuUpdate) {
        if let MenuUpdate::Checked(id, on) = update {
            if let Some(mark) = self.0.get(id) {
                mark.store(*on, Relaxed);
            }
        }
    }

    /// The mark a chosen item goes back to: what the page last said. None for an item that isn't
    /// a check item (nothing to put back).
    pub fn after_choice(&self, id: &str) -> Option<bool> {
        self.0.get(id).map(|mark| mark.load(Relaxed))
    }
}

/// The page's id for a chosen menu item, if it's one of the View or Font menus' items.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn page_menu_id(id: &str) -> Option<&'static str> {
    menu_entries().into_iter().find(|e| e.id == id).map(|e| e.id)
}

/// The View and Font menus' items, kept to change them later, and what they show now.
#[cfg(target_os = "macos")]
pub struct MenuHandles {
    items: HashMap<&'static str, MenuHandle>,
    /// What the check items should show (see `CheckMarks`); never behind `shown`'s lock.
    marks: CheckMarks,
    shown: Mutex<MenuState>,
}

#[cfg(target_os = "macos")]
enum MenuHandle {
    Plain(tauri::menu::MenuItem<tauri::Wry>),
    Check(tauri::menu::CheckMenuItem<tauri::Wry>),
}

/// Adds `slots` to `menu`, every item disabled until the page says otherwise.
#[cfg(target_os = "macos")]
fn fill(
    app: &AppHandle,
    menu: &tauri::menu::Submenu<tauri::Wry>,
    slots: &[Slot],
    handles: &mut HashMap<&'static str, MenuHandle>,
) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItem, MenuItem, PredefinedMenuItem, Submenu};
    for slot in slots {
        match slot {
            Slot::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
            Slot::Item(e) if e.check => {
                let item = CheckMenuItem::with_id(app, e.id, e.text, false, false, e.accelerator)?;
                menu.append(&item)?;
                handles.insert(e.id, MenuHandle::Check(item));
            }
            Slot::Item(e) => {
                let item = MenuItem::with_id(app, e.id, e.text, false, e.accelerator)?;
                menu.append(&item)?;
                handles.insert(e.id, MenuHandle::Plain(item));
            }
            Slot::Submenu(title, inner) => {
                let sub = Submenu::new(app, *title, true)?;
                fill(app, &sub, inner, handles)?;
                menu.append(&sub)?;
            }
        }
    }
    Ok(())
}

/// The macOS menu bar: Tauri's default menu, with "Settings…" (⌘,) and "Show All" added to the
/// app menu, and the View and Font menus the page drives. A menu built here replaces the default
/// one, so every standard item is repeated: the Edit menu's shortcuts are what make copy, paste
/// and undo work in text fields.
#[cfg(target_os = "macos")]
pub fn app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem as Item, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
    let name = app.package_info().name.clone();
    let about = AboutMetadata {
        name: Some(name.clone()),
        version: Some(app.package_info().version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app.config().bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let settings = MenuItem::with_id(app, SETTINGS_ITEM, "Settings…", true, Some("CmdOrCtrl+,"))?;
    let app_menu = Submenu::with_items(
        app,
        name,
        true,
        &[
            &Item::about(app, None, Some(about))?,
            &Item::separator(app)?,
            &settings,
            &Item::separator(app)?,
            &Item::services(app, None)?,
            &Item::separator(app)?,
            &Item::hide(app, None)?,
            &Item::hide_others(app, None)?,
            &Item::show_all(app, None)?,
            &Item::separator(app)?,
            &Item::quit(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(app, "File", true, &[&Item::close_window(app, None)?])?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &Item::undo(app, None)?,
            &Item::redo(app, None)?,
            &Item::separator(app)?,
            &Item::cut(app, None)?,
            &Item::copy(app, None)?,
            &Item::paste(app, None)?,
            &Item::select_all(app, None)?,
        ],
    )?;
    let mut handles = HashMap::new();
    let view = Submenu::new(app, "View", true)?;
    fill(app, &view, VIEW_MENU, &mut handles)?;
    view.append(&Item::separator(app)?)?;
    view.append(&Item::fullscreen(app, None)?)?;
    let font = Submenu::new(app, "Font", true)?;
    fill(app, &font, FONT_MENU, &mut handles)?;
    app.manage(MenuHandles { items: handles, marks: CheckMarks::new(), shown: Mutex::default() });
    // These ids make them macOS's Window menu (with the open windows listed) and Help menu
    // (with its search field), as in the default menu.
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[&Item::minimize(app, None)?, &Item::maximize(app, None)?, &Item::separator(app)?, &Item::close_window(app, None)?],
    )?;
    let help = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &font, &window, &help])
}

/// "Settings…": brings the window back if it was closed (see `hide`) and sends "open-settings"
/// to the page, which opens the settings screen. A View or Font menu item brings it back too and
/// sends "menu" with the item's id; the page checks it still applies (the menus can lag a
/// moment behind the page) and that its own key handler hasn't already acted on the same key
/// press (src/fontActions.ts, `createShortcutGuard`).
#[cfg(target_os = "macos")]
pub fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    let page_id = page_menu_id(id);
    if id != SETTINGS_ITEM && page_id.is_none() {
        return;
    }
    // A check item's mark goes back to what the page said (macOS flipped it on the click); the
    // page sends any real change. This runs on the main thread, so it's applied right here.
    if let Some(handles) = app.try_state::<MenuHandles>() {
        if let (Some(MenuHandle::Check(item)), Some(mark)) = (handles.items.get(id), handles.marks.after_choice(id)) {
            let _ = item.set_checked(mark);
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        show(&window);
    }
    match page_id {
        Some(id) => {
            let _ = app.emit_to("main", "menu", id);
        }
        None => {
            let _ = app.emit_to("main", "open-settings", ());
        }
    }
}

/// Windows and Linux: the window's own menu bar, with File › Settings… (Ctrl+,), since there's no
/// app menu as on macOS and no Settings button in the window, then File › Exit (Windows) or
/// Quit (Linux, Ctrl+Q). The page handles Ctrl+, itself too (App.tsx); if both act on one key
/// press, the second only moves to the settings' search field.
#[cfg(not(target_os = "macos"))]
pub fn app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem as Item, Submenu};
    let settings = MenuItem::with_id(app, SETTINGS_ITEM, "Settings…", true, Some("CmdOrCtrl+,"))?;
    let quit = if cfg!(target_os = "windows") {
        MenuItem::with_id(app, QUIT_ITEM, "Exit", true, None::<&str>)?
    } else {
        MenuItem::with_id(app, QUIT_ITEM, "Quit", true, Some("CmdOrCtrl+Q"))?
    };
    let file = Submenu::with_items(app, "File", true, &[&settings, &Item::separator(app)?, &quit])?;
    Menu::with_items(app, &[&file])
}

/// Windows and Linux: File › Settings… brings the window back (see `hide`) and sends
/// "open-settings" to the page; File › Exit quits, as the menu bar icon's Quit does.
#[cfg(not(target_os = "macos"))]
pub fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        SETTINGS_ITEM => {
            if let Some(window) = app.get_webview_window("main") {
                show(&window);
            }
            let _ = app.emit_to("main", "open-settings", ());
        }
        QUIT_ITEM => app.exit(0),
        _ => {}
    }
}

/// The page's view of the View and Font menus (`MenuState`). Only what changed since the last
/// call is applied. Elsewhere (no app menu) it does nothing.
#[tauri::command(async)]
pub fn set_menu_state(app: AppHandle, state: MenuState) -> crate::error::AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        let Some(handles) = app.try_state::<MenuHandles>() else { return Ok(()) };
        let mut shown = handles.shown.lock().unwrap_or_else(|p| p.into_inner());
        for update in menu_updates(&shown, &state) {
            // Noted first, so an item chosen while this one is on its way goes back to the new mark.
            handles.marks.note(&update);
            let result = match (&update, handles.items.get(update_id(&update))) {
                (MenuUpdate::Enabled(_, on), Some(MenuHandle::Plain(item))) => item.set_enabled(*on),
                (MenuUpdate::Enabled(_, on), Some(MenuHandle::Check(item))) => item.set_enabled(*on),
                (MenuUpdate::Checked(_, on), Some(MenuHandle::Check(item))) => item.set_checked(*on),
                (MenuUpdate::Text(_, text), Some(MenuHandle::Plain(item))) => item.set_text(text),
                (MenuUpdate::Text(_, text), Some(MenuHandle::Check(item))) => item.set_text(text),
                _ => Ok(()),
            };
            if let Err(e) = result {
                eprintln!("fontface: couldn't update the menu: {e}");
            }
        }
        *shown = state;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, state);
    Ok(())
}

#[cfg(target_os = "macos")]
fn update_id(update: &MenuUpdate) -> &'static str {
    match update {
        MenuUpdate::Enabled(id, _) | MenuUpdate::Checked(id, _) | MenuUpdate::Text(id, _) => id,
    }
}

// --------------------------------------------------------------------- title bar double-click

/// What double-clicking the title bar does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DoubleClick {
    Zoom,
    Minimize,
    Nothing,
}

/// The macOS setting "Double-click a window's title bar to" (System Settings > Desktop & Dock).
/// `action` is its value, `AppleActionOnDoubleClick`: "Maximize" (Zoom, also what an unset value
/// means), "Fill" (treated as Zoom), "Minimize" or "None" (Do Nothing). Older versions of macOS
/// only had `AppleMiniaturizeOnDoubleClick`, which means Minimize when it's on.
pub fn double_click_action(action: Option<&str>, miniaturize: bool) -> DoubleClick {
    match action.map(str::to_ascii_lowercase).as_deref() {
        Some("minimize") => DoubleClick::Minimize,
        Some("none") => DoubleClick::Nothing,
        Some(_) => DoubleClick::Zoom,
        None if miniaturize => DoubleClick::Minimize,
        None => DoubleClick::Zoom,
    }
}

fn double_click_setting() -> DoubleClick {
    #[cfg(target_os = "macos")]
    {
        double_click_action(prefs::global_text("AppleActionOnDoubleClick").as_deref(), prefs::global_flag("AppleMiniaturizeOnDoubleClick"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        double_click_action(None, false)
    }
}

/// A double-click on the title bar (the page's top row) does what the macOS setting says, on
/// the main window. The page calls this instead of Tauri's own handling, which always zooms.
/// Nothing happens in full screen, where there's no title bar.
#[tauri::command(async)]
pub fn title_bar_double_click(app: AppHandle) -> AppResult<()> {
    let Some(window) = app.get_webview_window("main") else { return Ok(()) };
    let fail = |e: tauri::Error| AppError::Other(e.to_string());
    if window.is_fullscreen().map_err(fail)? {
        return Ok(());
    }
    match double_click_setting() {
        // As Tauri's own handling does it.
        DoubleClick::Zoom if window.is_resizable().map_err(fail)? => {
            if window.is_maximized().map_err(fail)? {
                window.unmaximize().map_err(fail)?;
            } else if window.is_maximizable().map_err(fail)? {
                window.maximize().map_err(fail)?;
            }
        }
        DoubleClick::Minimize if window.is_minimizable().map_err(fail)? => window.minimize().map_err(fail)?,
        _ => {}
    }
    Ok(())
}

// ------------------------------------------------------------------------------ background

/// The page's background (`--background` in src/index.css) as sRGB, for the window behind it.
/// Light is oklch(1 0 0): white, #FFFFFF. Dark is oklch(0.145 0 0), a grey: with no chroma,
/// OKLab gives linear R = G = B = L³ = 0.00305. That's under sRGB's linear limit (0.0031308),
/// so it encodes as 12.92 × 0.00305 = 0.0394, which is 10 of 255: #0A0A0A.
pub const LIGHT_BACKGROUND: [u8; 3] = [0xFF, 0xFF, 0xFF];
pub const DARK_BACKGROUND: [u8; 3] = [0x0A, 0x0A, 0x0A];

/// The background for an Appearance setting. With "system", `system_dark` says what macOS uses.
pub fn background(theme: Theme, system_dark: bool) -> [u8; 3] {
    let dark = match theme {
        Theme::System => system_dark,
        Theme::Light => false,
        Theme::Dark => true,
    };
    if dark {
        DARK_BACKGROUND
    } else {
        LIGHT_BACKGROUND
    }
}

/// Whether macOS is in dark mode right now (`AppleInterfaceStyle` is "Dark").
fn system_dark() -> bool {
    #[cfg(target_os = "macos")]
    {
        prefs::global_text("AppleInterfaceStyle").as_deref() == Some("Dark")
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Colors the main window with the app's background for this Appearance setting (macOS), so a
/// dark launch doesn't flash white before the page's first paint. Called at launch, when the
/// setting changes, and when macOS switches between light and dark (for "system"), so the strip a
/// window resize uncovers matches the page. While the sidebar is see-through, the color is clear.
pub fn paint_background(app: &AppHandle, theme: Theme) {
    let [r, g, b] = background(theme, system_dark());
    // See-through behind the sidebar (translucency.rs): clear, so the system's blur shows.
    let alpha = if crate::translucency::see_through() { 0 } else { 255 };
    // Other systems keep their default until it's been tried there.
    if cfg!(target_os = "macos") {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_background_color(Some(tauri::window::Color(r, g, b, alpha)));
        }
    }
}

// ------------------------------------------------------------------- hiding and showing

/// Set while the window leaves full screen on its way to being hidden.
#[cfg(target_os = "macos")]
static HIDE_AFTER_FULL_SCREEN: AtomicBool = AtomicBool::new(false);

/// Closing the window while Fontface keeps running (tray.rs, `on_close`): hides the main window.
/// On macOS a window in full screen leaves full screen first and is hidden once it has
/// (`full_screen::watch`): hidden in full screen, it would leave its full-screen space behind,
/// empty and black. Once hidden, the Dock icon goes if the settings say so (`dock`). On Windows
/// the taskbar button goes with the window.
pub fn hide(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        // A hide is already waiting for the window to leave full screen (a second Cmd+W during
        // the animation): hiding now would leave the empty space behind after all.
        if HIDE_AFTER_FULL_SCREEN.load(Relaxed) {
            return;
        }
        if window.is_fullscreen().unwrap_or(false) {
            HIDE_AFTER_FULL_SCREEN.store(true, Relaxed);
            if window.set_fullscreen(false).is_ok() {
                return;
            }
            HIDE_AFTER_FULL_SCREEN.store(false, Relaxed);
        }
    }
    hidden(window);
}

/// The hide itself, and what follows it.
fn hidden(window: &WebviewWindow) {
    #[cfg(windows)]
    let _ = window.set_skip_taskbar(true);
    let _ = window.hide();
    #[cfg(target_os = "macos")]
    dock::closed(window.app_handle());
}

/// Brings the main window back (the menu bar icon, the Dock icon, opening Fontface again, or
/// the Settings… menu item): the Dock icon or taskbar button first, then the window, in front
/// and focused. A window left off every screen (its display was unplugged while it was closed)
/// comes back in the middle of the main one.
pub fn show(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        HIDE_AFTER_FULL_SCREEN.store(false, Relaxed);
        dock::opening(window.app_handle());
    }
    #[cfg(windows)]
    let _ = window.set_skip_taskbar(false);
    bring_on_screen(window);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// A rectangle in physical pixels: left, top, width, height.
pub type Area = (i32, i32, u32, u32);

/// How much of the window's top strip (where the title bar is) must be on a screen for it to be
/// reachable: enough to grab and drag.
const GRAB: (u32, u32) = (80, 24);

/// Whether enough of the window's top strip is on one of the screens to grab it.
pub fn reachable(window: Area, screens: &[Area]) -> bool {
    let (x, y, w, _) = window;
    let strip = (x, y, w, GRAB.1);
    screens.iter().any(|s| {
        let (ix, iy) = overlap(strip, *s);
        ix >= GRAB.0.min(w) && iy >= GRAB.1
    })
}

/// The width and height two rectangles share.
fn overlap(a: Area, b: Area) -> (u32, u32) {
    let span = |a0: i32, a1: u32, b0: i32, b1: u32| {
        let lo = i64::from(a0).max(i64::from(b0));
        let hi = (i64::from(a0) + i64::from(a1)).min(i64::from(b0) + i64::from(b1));
        (hi - lo).max(0) as u32
    };
    (span(a.0, a.2, b.0, b.2), span(a.1, a.3, b.1, b.3))
}

/// Where a window of `size` goes to sit in the middle of `screen` (kept inside it if it's bigger).
pub fn centered(size: (u32, u32), screen: Area) -> (i32, i32) {
    let along = |start: i32, room: u32, len: u32| start + (i64::from(room).saturating_sub(i64::from(len)).max(0) / 2) as i32;
    (along(screen.0, screen.2, size.0), along(screen.1, screen.3, size.1))
}

fn bring_on_screen(window: &WebviewWindow) {
    let (Ok(pos), Ok(size), Ok(monitors)) = (window.outer_position(), window.outer_size(), window.available_monitors()) else { return };
    let area = |m: &tauri::Monitor| (m.position().x, m.position().y, m.size().width, m.size().height);
    let screens: Vec<Area> = monitors.iter().map(area).collect();
    if screens.is_empty() || reachable((pos.x, pos.y, size.width, size.height), &screens) {
        return;
    }
    let main = window.primary_monitor().ok().flatten().map(|m| area(&m)).unwrap_or(screens[0]);
    let (x, y) = centered((size.width, size.height), main);
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

/// macOS: Fontface's Dock icon, with "Show in the Dock: only while the window is open" (see
/// tray.rs). Fontface is a regular app (Dock icon, menus, Cmd-Tab) while its window is open, and
/// a menu bar app (an "accessory") while it's closed.
///
/// macOS can leave a second, dead Dock icon behind when an app goes back and forth quickly. So
/// the icon never goes within `SETTLE` of coming back: the switch waits, and is called off if
/// the window opens again meanwhile. Launching at login straight into the menu bar sets the
/// policy before macOS finishes launching the app (lib.rs), so no icon shows at all.
#[cfg(target_os = "macos")]
pub mod dock {
    use std::{
        sync::{
            atomic::{AtomicBool, AtomicU64, Ordering::Relaxed},
            Mutex,
        },
        time::{Duration, Instant},
    };

    use tauri::{ActivationPolicy, AppHandle, Manager};

    /// Fontface is a regular app now, with its Dock icon.
    static REGULAR: AtomicBool = AtomicBool::new(true);
    /// Counts the window's openings, so a wait for the icon to go is called off by the next one.
    static OPENINGS: AtomicU64 = AtomicU64::new(0);
    /// When the icon last came back.
    static CAME_BACK: Mutex<Option<Instant>> = Mutex::new(None);
    const SETTLE: Duration = Duration::from_millis(1200);

    /// Launching with the window closed and no Dock icon (lib.rs set the policy).
    pub fn started_in_menu_bar() {
        REGULAR.store(false, Relaxed);
    }

    /// Before the window opens: the Dock icon (and the app's menus) come back. Requests reach
    /// the app in the order they're made, so the window then opens in a regular app.
    pub fn opening(app: &AppHandle) {
        OPENINGS.fetch_add(1, Relaxed);
        let mut came_back = CAME_BACK.lock().unwrap_or_else(|p| p.into_inner());
        if !REGULAR.swap(true, Relaxed) {
            *came_back = Some(Instant::now());
            if let Err(e) = app.set_activation_policy(ActivationPolicy::Regular) {
                eprintln!("fontface: couldn't bring back the Dock icon: {e}");
            }
        } else if came_back.is_none() {
            // The first opening, at launch: the icon has only just appeared.
            *came_back = Some(Instant::now());
        }
    }

    /// After the window has closed: the Dock icon goes, if the settings say so.
    pub fn closed(app: &AppHandle) {
        if !REGULAR.load(Relaxed) || !wanted(app) {
            return;
        }
        let since = CAME_BACK.lock().unwrap_or_else(|p| p.into_inner()).map(|t| t.elapsed());
        let wait = since.map_or(Duration::ZERO, |s| SETTLE.saturating_sub(s));
        if wait.is_zero() {
            go(app);
            return;
        }
        let (app, opening) = (app.clone(), OPENINGS.load(Relaxed));
        std::thread::spawn(move || {
            std::thread::sleep(wait);
            if OPENINGS.load(Relaxed) == opening {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || go(&handle));
            }
        });
    }

    /// Whether the icon should go now the window is closed.
    fn wanted(app: &AppHandle) -> bool {
        app.try_state::<crate::AppState>()
            .is_some_and(|s| crate::tray::dock_hidden_while_closed(&s.settings(), crate::tray::icon_shown()))
    }

    fn go(app: &AppHandle) {
        let open = app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false));
        if open || !wanted(app) || !REGULAR.swap(false, Relaxed) {
            return;
        }
        if let Err(e) = app.set_activation_policy(ActivationPolicy::Accessory) {
            REGULAR.store(true, Relaxed);
            eprintln!("fontface: couldn't take away the Dock icon: {e}");
        }
    }
}

/// Finishes a `hide` that waited for the window to leave full screen. macOS says when with
/// NSWindowDidExitFullScreenNotification. (`is_fullscreen` can't tell: it turns false as soon as
/// leaving starts, and the window reports resizes during the animation too.)
#[cfg(target_os = "macos")]
pub mod full_screen {
    use std::sync::atomic::Ordering::Relaxed;

    use objc2::{
        define_class, msg_send,
        rc::Retained,
        runtime::{AnyObject, NSObject},
        sel, DefinedClass, MainThreadMarker, MainThreadOnly,
    };
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSString};
    use tauri::WebviewWindow;

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {
        static NSWindowDidExitFullScreenNotification: &'static NSString;
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and `Observer` doesn't implement Drop.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "FontfaceFullScreenObserver"]
        #[ivars = WebviewWindow]
        struct Observer;

        impl Observer {
            #[unsafe(method(windowDidExitFullScreen:))]
            fn did_exit(&self, _notification: &NSNotification) {
                if super::HIDE_AFTER_FULL_SCREEN.swap(false, Relaxed) {
                    super::hidden(self.ivars());
                }
            }
        }
    );

    /// Starts listening for the main window leaving full screen. Call once, on the main thread
    /// (at setup). The listener stays for the life of the app.
    pub fn watch(window: &WebviewWindow) {
        let (Some(mtm), Ok(ns_window)) = (MainThreadMarker::new(), window.ns_window()) else { return };
        let observer = Observer::alloc(mtm).set_ivars(window.clone());
        // SAFETY: NSObject's init, on a freshly allocated object.
        let observer: Retained<Observer> = unsafe { msg_send![super(observer), init] };
        // SAFETY: `ns_window` is the window's live NSWindow; the observer has the selector, takes
        // the notification as its one argument, and is never freed (forgotten below).
        unsafe {
            NSNotificationCenter::defaultCenter().addObserver_selector_name_object(
                &observer,
                sel!(windowDidExitFullScreen:),
                Some(NSWindowDidExitFullScreenNotification),
                Some(&*(ns_window as *const AnyObject)),
            );
        }
        std::mem::forget(observer);
    }
}

// ----------------------------------------------------------------------------- preferences

/// Reads macOS's global preferences (NSGlobalDomain, what `defaults read -g` shows).
#[cfg(target_os = "macos")]
mod prefs {
    use core_foundation::{
        base::{CFType, CFTypeRef, TCFType},
        string::{CFString, CFStringRef},
    };

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFPreferencesAnyApplication: CFStringRef;
        fn CFPreferencesCopyAppValue(key: CFStringRef, application_id: CFStringRef) -> CFTypeRef;
        fn CFPreferencesGetAppBooleanValue(key: CFStringRef, application_id: CFStringRef, exists: *mut u8) -> u8;
    }

    /// A text value, if it's set and is text.
    pub fn global_text(key: &str) -> Option<String> {
        let key = CFString::new(key);
        // SAFETY: the function follows the Create rule and returns a property list, or null.
        let raw = unsafe { CFPreferencesCopyAppValue(key.as_concrete_TypeRef(), kCFPreferencesAnyApplication) };
        if raw.is_null() {
            return None;
        }
        let value = unsafe { CFType::wrap_under_create_rule(raw) };
        value.downcast::<CFString>().map(|s| s.to_string())
    }

    /// An on/off value: true only if it's set and on.
    pub fn global_flag(key: &str) -> bool {
        let key = CFString::new(key);
        let mut exists = 0u8;
        // SAFETY: plain values in and out; `exists` lives for the call.
        unsafe { CFPreferencesGetAppBooleanValue(key.as_concrete_TypeRef(), kCFPreferencesAnyApplication, &mut exists) != 0 }
    }
}
