//! The main window's native side: the macOS menu bar (with the View and Font menus the page
//! drives), double-clicking the title bar, the window's color before the page paints, and hiding
//! the window when it's closed.
//!
//! On macOS the title bar is an overlay (src-tauri/tauri.macos.conf.json): the page draws the
//! top row and marks it as the place to drag the window from (src/components/TitleBar.tsx).

use std::collections::{BTreeMap, BTreeSet};
#[cfg(target_os = "macos")]
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering::Relaxed},
        Mutex,
    },
};

#[cfg(target_os = "macos")]
use tauri::{Emitter, WebviewWindow};
use tauri::{AppHandle, Manager};

use crate::{
    error::{AppError, AppResult},
    settings::Theme,
};

// ----------------------------------------------------------------------------------- menu

/// The id of the app menu's "Settings…" item.
#[cfg(target_os = "macos")]
const SETTINGS_ITEM: &str = "settings";

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

/// The View menu, above Enter Full Screen: the library's layouts, grouping, sort and preview
/// size (what View options holds), and Back.
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

/// The page's id for a chosen menu item, if it's one of the View or Font menus' items.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn page_menu_id(id: &str) -> Option<&'static str> {
    menu_entries().into_iter().find(|e| e.id == id).map(|e| e.id)
}

/// The View and Font menus' items, kept to change them later, and what they show now.
#[cfg(target_os = "macos")]
pub struct MenuHandles {
    items: HashMap<&'static str, MenuHandle>,
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
    app.manage(MenuHandles { items: handles, shown: Mutex::default() });
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

/// The page's view of the View and Font menus (`MenuState`). Only what changed since the last
/// call is applied. Elsewhere (no app menu) it does nothing.
#[tauri::command(async)]
pub fn set_menu_state(app: AppHandle, state: MenuState) -> crate::error::AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        let Some(handles) = app.try_state::<MenuHandles>() else { return Ok(()) };
        let mut shown = handles.shown.lock().unwrap_or_else(|p| p.into_inner());
        for update in menu_updates(&shown, &state) {
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
/// window resize uncovers matches the page.
pub fn paint_background(app: &AppHandle, theme: Theme) {
    let [r, g, b] = background(theme, system_dark());
    // Other systems keep their default until it's been tried there.
    if cfg!(target_os = "macos") {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_background_color(Some(tauri::window::Color(r, g, b, 255)));
        }
    }
}

// ------------------------------------------------------------- hiding and showing (macOS)

/// Set while the window leaves full screen on its way to being hidden.
#[cfg(target_os = "macos")]
static HIDE_AFTER_FULL_SCREEN: AtomicBool = AtomicBool::new(false);

/// "Keep running when the window is closed": hides the main window. A window in full screen
/// leaves full screen first and is hidden once it has (`full_screen::watch`): hidden in full
/// screen, it would leave its full-screen space behind, empty and black.
#[cfg(target_os = "macos")]
pub fn hide(window: &WebviewWindow) {
    // A hide is already waiting for the window to leave full screen (a second Cmd+W during the
    // animation): hiding now would leave the empty space behind after all.
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
    let _ = window.hide();
}

/// Brings the main window back (the Dock icon, or the Settings… menu item).
#[cfg(target_os = "macos")]
pub fn show(window: &WebviewWindow) {
    HIDE_AFTER_FULL_SCREEN.store(false, Relaxed);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
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
                    let _ = self.ivars().hide();
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
