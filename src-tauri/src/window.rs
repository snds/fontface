//! The main window's native side: the macOS menu bar, double-clicking the title bar, the window's
//! color before the page paints, and hiding the window when it's closed.
//!
//! On macOS the title bar is an overlay (src-tauri/tauri.macos.conf.json): the page draws the
//! top row and marks it as the place to drag the window from (src/components/TitleBar.tsx).

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};

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

/// The macOS menu bar: Tauri's default menu, with "Settings…" (⌘,) and "Show All" added to the
/// app menu. A menu built here replaces the default one, so every standard item is repeated:
/// the Edit menu's shortcuts are what make copy, paste and undo work in text fields.
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
    let view = Submenu::with_items(app, "View", true, &[&Item::fullscreen(app, None)?])?;
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
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
}

/// "Settings…": brings the window back if it was closed (see `hide`) and sends "open-settings"
/// to the page, which opens the settings screen.
#[cfg(target_os = "macos")]
pub fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    if event.id() == SETTINGS_ITEM {
        if let Some(window) = app.get_webview_window("main") {
            show(&window);
        }
        let _ = app.emit_to("main", "open-settings", ());
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
