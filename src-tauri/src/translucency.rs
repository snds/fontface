//! A see-through window: Settings › General › "Translucent window" (Off, Sidebar, Whole window).
//!
//! The window is see-through behind the page, and the OS draws its own blur there. The page then
//! decides where it shows (`data-translucent` and `data-translucent-window` on <html>,
//! src/index.css): the sidebars, and with Whole window, faintly behind the font lists and pages
//! too, under a tint heavy enough to keep text readable. Dialogs, menus, cards and the Table stay
//! solid. src/translucency.test.ts checks the text contrast that leaves, against a worst-case
//! desktop.
//!
//! - **macOS**: the sidebar material native sidebars use (an NSVisualEffectView under the page,
//!   through Tauri's window effects). It goes flatter while the window isn't the active one, as
//!   native sidebars do, and follows light and dark with the window. The window is always made
//!   see-through (tauri.macos.conf.json), so the setting applies at once; with it off, the
//!   window's own color is solid again (window.rs, `paint_background`).
//! - **Windows 11**: Mica. A window can only be made see-through when it's created, so it's made
//!   that way only when the setting is on at launch (`create_main_window`); turned on later, it
//!   shows the next time Fontface opens. Windows 10 gets nothing: Acrylic, its only blur, lags
//!   while the window is moved or resized there (Tauri's note on `Effect::Acrylic`), so the
//!   setting is greyed out.
//! - **Linux**: there's no standard blur. Off by default; on, the desktop shows through
//!   unblurred, under a heavier tint so text stays readable, on desktops that support
//!   see-through windows. Like Windows, it takes effect when the window is created.
//!
//! The OS's "reduce transparency" choice always wins: macOS's Accessibility › Display › Reduce
//! transparency (watched live), and Windows' Transparency effects (checked again whenever the
//! window comes to the front). The page also honors CSS `prefers-reduced-transparency` and
//! `prefers-contrast: more` where the web view knows them.
//!
//! Not tried on Windows or Linux yet: that code is written but has only been built for macOS.

use std::sync::{
    atomic::{AtomicBool, Ordering::Relaxed},
    Mutex,
};

use serde::Serialize;
use tauri::{
    window::{Effect, EffectState, EffectsBuilder},
    AppHandle, Emitter, Manager,
};

use crate::settings::{Theme, Translucency};

/// How the page draws its sidebars while they're see-through.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Look {
    /// The OS blurs what's behind the window (macOS, Windows 11): a light tint is enough.
    Blur,
    /// Nothing blurs it (Linux): a heavier tint keeps the sidebar readable.
    #[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
    Plain,
}

/// What the window shows now, for the page (`translucency_get` and "translucency-changed").
/// Must match `TranslucencyState` in src/api.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// None: the window is solid.
    pub look: Option<Look>,
    /// The content shows it too, not only the sidebars (Whole window).
    pub window: bool,
    /// The OS asks apps to reduce transparency, so the window stays solid.
    pub reduced: bool,
    /// This system has no blur Fontface uses (Windows 10): the setting is greyed out.
    pub unsupported: bool,
    /// Turned on after the window was made: it shows the next time Fontface opens (Windows, Linux).
    pub next_launch: bool,
}

/// What the system offers right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct System {
    /// What this system can show; None: nothing (Windows 10).
    pub look: Option<Look>,
    /// The OS asks apps to reduce transparency.
    pub reduced: bool,
    /// The window was made see-through: always on macOS, on Windows and Linux only when the
    /// setting was on at launch.
    pub window_ready: bool,
}

/// What the window shows, for the setting and the system.
pub fn decide(setting: Translucency, system: System) -> State {
    let wanted = setting != Translucency::Off && system.look.is_some() && !system.reduced;
    let look = if wanted && system.window_ready { system.look } else { None };
    State {
        look,
        window: look.is_some() && setting == Translucency::Window,
        reduced: system.reduced,
        unsupported: system.look.is_none(),
        next_launch: wanted && !system.window_ready,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Mac,
    Windows,
    Linux,
}

pub const OS: Os = if cfg!(target_os = "macos") {
    Os::Mac
} else if cfg!(windows) {
    Os::Windows
} else {
    Os::Linux
};

/// The OS's own blur behind the window, or None for none.
pub fn effect(os: Os, look: Option<Look>, theme: Theme) -> Option<Effect> {
    if look != Some(Look::Blur) {
        return None;
    }
    match os {
        // Light or dark follows the window's appearance, which follows the Appearance setting
        // (src/settings/theme.ts).
        Os::Mac => Some(Effect::Sidebar),
        // Mica follows Windows' light or dark unless Appearance picks one.
        Os::Windows => Some(match theme {
            Theme::System => Effect::Mica,
            Theme::Light => Effect::MicaLight,
            Theme::Dark => Effect::MicaDark,
        }),
        Os::Linux => None,
    }
}

/// Mica came with Windows 11, build 22000.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn has_mica(windows_build: u32) -> bool {
    windows_build >= 22_000
}

/// Whether the window was made see-through (see `System::window_ready`).
static WINDOW_READY: AtomicBool = AtomicBool::new(cfg!(target_os = "macos"));
/// macOS's Reduce transparency, kept by `watch` (read on the main thread only).
#[cfg(target_os = "macos")]
static REDUCED: AtomicBool = AtomicBool::new(false);
/// What the window and the page show now. None until the first `apply`.
static SHOWN: Mutex<Option<State>> = Mutex::new(None);

fn shown() -> Option<State> {
    *SHOWN.lock().unwrap_or_else(|p| p.into_inner())
}

/// True while the window is see-through behind the page.
pub fn see_through() -> bool {
    shown().is_some_and(|t| t.look.is_some())
}

fn system() -> System {
    #[cfg(target_os = "macos")]
    {
        System { look: Some(Look::Blur), reduced: REDUCED.load(Relaxed), window_ready: WINDOW_READY.load(Relaxed) }
    }
    #[cfg(windows)]
    {
        System {
            look: has_mica(win::build()).then_some(Look::Blur),
            reduced: win::transparency_off(),
            window_ready: WINDOW_READY.load(Relaxed),
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        System { look: Some(Look::Plain), reduced: false, window_ready: WINDOW_READY.load(Relaxed) }
    }
}

/// Puts the window and the page in step with the setting and the system. Called at launch and
/// when the setting or Appearance changes; the page hears when what it should draw changes.
pub fn apply(app: &AppHandle, setting: Translucency, theme: Theme) {
    let next = decide(setting, system());
    let changed = {
        let mut shown = SHOWN.lock().unwrap_or_else(|p| p.into_inner());
        std::mem::replace(&mut *shown, Some(next)) != Some(next)
    };
    if let Some(window) = app.get_webview_window("main") {
        let effects = effect(OS, next.look, theme).map(|e| EffectsBuilder::new().effect(e).state(EffectState::FollowsWindowActiveState).build());
        if let Err(e) = window.set_effects(effects) {
            eprintln!("fontface: couldn't change the window's see-through background: {e}");
        }
    }
    // macOS: the window's own color goes clear while it's see-through.
    crate::window::paint_background(app, theme);
    if changed {
        let _ = app.emit("translucency-changed", next);
    }
}

/// For when the system's choice may have changed (Reduce transparency, Transparency effects):
/// applies the saved setting again, only if that changes anything.
pub fn refresh(app: &AppHandle) {
    let Some(state) = app.try_state::<crate::AppState>() else { return };
    let (setting, theme) = {
        let s = state.settings();
        (s.translucency, s.theme)
    };
    if shown() != Some(decide(setting, system())) {
        apply(app, setting, theme);
    }
}

/// What the window shows now.
#[tauri::command]
pub fn translucency_get() -> State {
    shown().unwrap_or_default()
}

/// Windows and Linux: makes the main window (tauri.windows.conf.json and tauri.linux.conf.json
/// leave it to this), see-through only when the setting is on and the system can show it.
#[cfg(not(target_os = "macos"))]
pub fn create_main_window(app: &tauri::App, setting: Translucency) -> tauri::Result<()> {
    let see_through = setting != Translucency::Off && system().look.is_some();
    let Some(config) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() else { return Ok(()) };
    tauri::WebviewWindowBuilder::from_config(app, &config)?.transparent(see_through).build()?;
    WINDOW_READY.store(see_through, Relaxed);
    Ok(())
}

/// macOS: reads Reduce transparency, and follows it from then on. Call once, on the main thread
/// (at setup), before the first `apply`.
#[cfg(target_os = "macos")]
pub fn watch(app: &AppHandle) {
    mac::watch(app);
}

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::atomic::Ordering::Relaxed;

    use objc2::{define_class, msg_send, rc::Retained, runtime::NSObject, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSWorkspace, NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification};
    use objc2_foundation::NSNotification;
    use tauri::AppHandle;

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and `Observer` doesn't implement Drop.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "FontfaceDisplayOptionsObserver"]
        #[ivars = AppHandle]
        struct Observer;

        impl Observer {
            #[unsafe(method(displayOptionsDidChange:))]
            fn changed(&self, _notification: &NSNotification) {
                super::REDUCED.store(reduced(), Relaxed);
                super::refresh(self.ivars());
            }
        }
    );

    /// System Settings › Accessibility › Display › Reduce transparency.
    fn reduced() -> bool {
        NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceTransparency()
    }

    pub fn watch(app: &AppHandle) {
        let Some(mtm) = MainThreadMarker::new() else { return };
        super::REDUCED.store(reduced(), Relaxed);
        let observer = Observer::alloc(mtm).set_ivars(app.clone());
        // SAFETY: NSObject's init, on a freshly allocated object.
        let observer: Retained<Observer> = unsafe { msg_send![super(observer), init] };
        // SAFETY: the observer has the selector, takes the notification as its one argument, and
        // is never freed (forgotten below). The name is AppKit's own constant.
        unsafe {
            NSWorkspace::sharedWorkspace().notificationCenter().addObserver_selector_name_object(
                &observer,
                sel!(displayOptionsDidChange:),
                Some(NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification),
                None,
            );
        }
        std::mem::forget(observer);
    }
}

/// Windows' version and its Transparency effects switch, straight from the system libraries.
#[cfg(windows)]
mod win {
    use std::ffi::c_void;

    #[repr(C)]
    struct OsVersionInfo {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut OsVersionInfo) -> i32;
    }

    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(key: isize, sub_key: *const u16, value: *const u16, flags: u32, kind: *mut u32, data: *mut c_void, size: *mut u32) -> i32;
    }

    /// HKEY_CURRENT_USER: (HKEY)(ULONG_PTR)((LONG)0x80000001), sign-extended.
    const HKEY_CURRENT_USER: isize = 0x8000_0001_u32 as i32 as isize;
    const RRF_RT_REG_DWORD: u32 = 0x0000_0010;

    /// The real build number (GetVersionEx can report an older one to apps without a manifest).
    pub fn build() -> u32 {
        let mut info = OsVersionInfo { size: std::mem::size_of::<OsVersionInfo>() as u32, major: 0, minor: 0, build: 0, platform: 0, service_pack: [0; 128] };
        // SAFETY: `info` is a correctly sized OSVERSIONINFOW that lives for the call.
        if unsafe { RtlGetVersion(&mut info) } == 0 {
            info.build
        } else {
            0
        }
    }

    /// Settings › Personalization › Colors › Transparency effects is off.
    pub fn transparency_off() -> bool {
        let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let key = wide(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
        let value = wide("EnableTransparency");
        let mut data: u32 = 1;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: both names are NUL-terminated and live for the call; `data` holds a DWORD.
        let status = unsafe {
            RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), value.as_ptr(), RRF_RT_REG_DWORD, std::ptr::null_mut(), (&mut data as *mut u32).cast(), &mut size)
        };
        status == 0 && data == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAC: System = System { look: Some(Look::Blur), reduced: false, window_ready: true };

    #[test]
    fn with_nothing_in_the_way_the_chosen_parts_are_see_through() {
        let sidebar = decide(Translucency::Sidebar, MAC);
        assert_eq!((sidebar.look, sidebar.window), (Some(Look::Blur), false));
        let window = decide(Translucency::Window, MAC);
        assert_eq!((window.look, window.window), (Some(Look::Blur), true));
        assert!(!window.reduced && !window.unsupported && !window.next_launch);
        assert_eq!(decide(Translucency::Off, MAC), State::default(), "off: solid, and nothing to explain");
    }

    #[test]
    fn reduce_transparency_always_wins() {
        let reduced = System { reduced: true, ..MAC };
        for setting in [Translucency::Sidebar, Translucency::Window] {
            let t = decide(setting, reduced);
            assert_eq!((t.look, t.window), (None, false));
            assert!(t.reduced, "the page says why the choice is greyed out");
            assert!(!decide(setting, System { window_ready: false, ..reduced }).next_launch, "nothing waits for the next launch either");
        }
    }

    #[test]
    fn windows_10_has_nothing_to_show() {
        let win10 = System { look: None, reduced: false, window_ready: false };
        let t = decide(Translucency::Window, win10);
        assert_eq!((t.look, t.window), (None, false));
        assert!(t.unsupported && !t.next_launch);
        assert!(!has_mica(19_045), "Windows 10 22H2");
        assert!(has_mica(22_000) && has_mica(26_100), "Windows 11");
    }

    #[test]
    fn turned_on_after_a_solid_window_was_made_it_waits_for_the_next_launch() {
        let linux = System { look: Some(Look::Plain), reduced: false, window_ready: false };
        let t = decide(Translucency::Window, linux);
        assert_eq!((t.look, t.window), (None, false), "a window made solid can't turn see-through");
        assert!(t.next_launch);
        let ready = decide(Translucency::Window, System { window_ready: true, ..linux });
        assert_eq!((ready.look, ready.window), (Some(Look::Plain), true), "plain: nothing blurs it");
        assert_eq!(decide(Translucency::Off, linux), State::default(), "turned off again: nothing waits");
    }

    #[test]
    fn each_system_uses_its_own_blur() {
        assert_eq!(effect(Os::Mac, Some(Look::Blur), Theme::Dark), Some(Effect::Sidebar), "light or dark follows the window");
        assert_eq!(effect(Os::Windows, Some(Look::Blur), Theme::System), Some(Effect::Mica));
        assert_eq!(effect(Os::Windows, Some(Look::Blur), Theme::Light), Some(Effect::MicaLight));
        assert_eq!(effect(Os::Windows, Some(Look::Blur), Theme::Dark), Some(Effect::MicaDark));
        assert_eq!(effect(Os::Linux, Some(Look::Plain), Theme::System), None, "no standard blur on Linux");
        assert_eq!(effect(Os::Mac, None, Theme::System), None, "solid: no effect");
    }

    #[test]
    fn the_page_hears_the_shape_src_api_ts_expects() {
        let t = State { look: Some(Look::Blur), window: true, reduced: false, unsupported: false, next_launch: true };
        assert_eq!(
            serde_json::to_value(t).unwrap(),
            serde_json::json!({ "look": "blur", "window": true, "reduced": false, "unsupported": false, "nextLaunch": true })
        );
        assert_eq!(serde_json::to_value(State::default()).unwrap()["look"], serde_json::Value::Null);
    }

    #[test]
    fn index_css_has_see_through_parts_for_each_look() {
        let css = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/index.css")).unwrap();
        for look in ["blur", "plain"] {
            assert!(css.contains(&format!("[data-translucent=\"{look}\"]")), "index.css has no sidebar for the {look} look");
            assert!(css.contains(&format!("[data-translucent=\"{look}\"][data-translucent-window]")), "index.css has no content for the {look} look");
        }
    }
}
