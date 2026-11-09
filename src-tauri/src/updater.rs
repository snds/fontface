//! Automatic updates, through Sean's shared update kit (`snds/app-updates`, the unified updates
//! proposal U1–U6). See README.md → Updates.
//!
//! CI publishes every merge to `main` as one rolling pre-release on `snds/releases`,
//! `fontface-main`, with a signed bundle per platform and the updater manifest `latest.json`.
//! Fontface follows it: it checks at launch and every six hours (or when asked: Settings › About,
//! and on macOS "Check for Updates…" in the app menu), downloads a newer build in the background,
//! checks its signature against the key built in from `updater.pub`, and offers "Restart to
//! update". An update not taken installs when Fontface quits.
//!
//! The kit drives Tauri's updater plugin from Rust, so no updater permission reaches the page.
//! What's Fontface's own is here: where its builds are published ([`FEED`]), its key
//! ([`built_in_key`]), and [`FontfaceHost`], which keeps "Check automatically" in the app
//! settings (`updateAutoCheck`, settings.rs).

use std::sync::Arc;

use app_updates::shell::{self as kit, Config, Host};
use app_updates::{Feed, GITHUB_HOSTS};
use tauri::{AppHandle, Manager};

use crate::AppState;

/// The "main" channel's manifest: the `latest.json` asset of the rolling `fontface-main`
/// pre-release. No part of the URL depends on this device, this person or this build.
pub const MAIN_ENDPOINT: &str = "https://github.com/snds/releases/releases/download/fontface-main/latest.json";

/// Where people are sent when Fontface can't replace itself (a Linux package, a Windows install
/// for every user, a Mac folder they can't write to).
pub const MAIN_PAGE: &str = "https://github.com/snds/releases/releases/tag/fontface-main";

/// Fontface's feed: the main channel on `snds/releases`, GitHub's hosts, no stable channel yet.
pub const FEED: Feed = Feed {
    app: "Fontface",
    main_endpoint: MAIN_ENDPOINT,
    main_page: MAIN_PAGE,
    stable_endpoint: None,
    stable_page: None,
    hosts: &GITHUB_HOSTS,
};

/// The event every change of the update status is sent on.
pub const EVENT: &str = "fontface://update";

/// The macOS app menu's "Check for Updates…" item.
pub const MENU_ID: &str = "fontface-check-for-updates";

/// The ID of the key Sean made for Fontface (2026-11-08), whose public half is `updater.pub`. A
/// test holds the committed file to it.
#[cfg(test)]
pub const RELEASE_KEY_ID: &str = "A22605A6D757D9B7";

/// The public key built in from `updater.pub` (build.rs), if the file was there when this build
/// was made. Without it, updates are off in the build and Settings says so.
pub fn built_in_key() -> Option<&'static str> {
    Some(env!("FONTFACE_UPDATER_PUBKEY")).filter(|k| !k.is_empty())
}

/// Tauri's updater plugin, configured from Rust. `plugins.updater` in tauri.conf.json holds only
/// what it can't take from code: the signed version required, and the passive Windows installer.
pub use kit::plugin;

/// What the kit asks of Fontface: where the "Check automatically" switch is kept. Nothing needs
/// doing before a restart: activations are recorded as they're made, and launch re-applies them.
pub struct FontfaceHost {
    handle: AppHandle,
}

impl Host for FontfaceHost {
    fn auto_check(&self) -> bool {
        self.handle.try_state::<AppState>().map(|s| s.settings().update_auto_check).unwrap_or(true)
    }

    fn set_auto_check(&self, on: bool) -> Result<(), String> {
        let state = self.handle.try_state::<AppState>().ok_or("Fontface hasn't finished opening")?;
        crate::commands::change_settings(&self.handle, &state, &serde_json::json!({ "updateAutoCheck": on }))
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

/// Sets up the updater, once `AppState` is managed: the plan, the status, the macOS menu item,
/// and the automatic check at launch and every six hours.
pub fn start(handle: &AppHandle) {
    let config = Config { feed: FEED, key: built_in_key(), test: None, event: EVENT, menu_id: MENU_ID, local: None };
    kit::start(handle, config, Arc::new(FontfaceHost { handle: handle.clone() }));
}

/// The switch changed through the settings (Settings, or Reset all settings): the status says
/// so, and turning it on checks at once if nothing has been checked since launch.
pub fn auto_check_saved(handle: &AppHandle, on: bool) {
    if let Err(e) = kit::auto_check_saved(handle, on) {
        eprintln!("fontface: the updater didn't hear about Check automatically: {e}");
    }
}

/// Fontface is quitting: a downloaded update not yet taken installs now, without relaunching.
pub fn on_exit(handle: &AppHandle) {
    kit::on_exit(handle);
}

#[cfg(test)]
mod tests {
    use super::*;
    use app_updates::{allowed, key_id, key_is_valid, plan, Channel, Off};
    use semver::Version;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn the_feed_is_fontfaces_main_channel_on_github() {
        assert_eq!(Channel::Main.endpoint(&FEED), Some(MAIN_ENDPOINT));
        assert_eq!(Channel::Stable.endpoint(&FEED), None);
        let hosts: Vec<String> = GITHUB_HOSTS.iter().map(|h| h.to_string()).collect();
        assert!(allowed(MAIN_ENDPOINT, &hosts).is_ok());
        assert!(allowed(MAIN_PAGE, &hosts).is_ok());
        assert_eq!(EVENT, "fontface://update");
        assert_eq!(MENU_ID, "fontface-check-for-updates");
    }

    #[test]
    fn main_builds_check_and_unstamped_builds_say_why_not() {
        let key = built_in_key().expect("updater.pub is committed");
        let main = v("0.1.0-main.20261108093000");
        let source = plan(&FEED, &main, Some(key), None).unwrap();
        assert_eq!(source.endpoint, MAIN_ENDPOINT);
        assert_eq!(source.page, MAIN_PAGE);
        assert_eq!(plan(&FEED, &main, None, None), Err(Off::NoKey));
        assert_eq!(plan(&FEED, &v("0.1.0"), Some(key), None), Err(Off::StableNotBuilt));
        assert_eq!(Off::NoKey.words(), "Updates are off in this build: it was made without the update key.");
    }

    /// The committed `updater.pub` is Sean's release key, whole: a file changed, cut short or
    /// swapped fails here before any build ships it.
    #[test]
    fn the_committed_key_is_the_release_key() {
        let file = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("updater.pub"))
            .expect("src-tauri/updater.pub is committed");
        assert!(key_is_valid(&file), "updater.pub doesn't parse as a minisign public key");
        assert_eq!(key_id(&file).as_deref(), Some(RELEASE_KEY_ID));
        assert_eq!(built_in_key(), Some(file.trim()));
        assert_eq!(built_in_key().and_then(key_id).as_deref(), Some(RELEASE_KEY_ID));
    }
}
