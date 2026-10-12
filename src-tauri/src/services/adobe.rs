//! Adobe Fonts: read-only.
//!
//! Adobe offers no API for other apps to turn its fonts on or off, and its terms forbid copying,
//! moving or otherwise using the font files outside Creative Cloud. So Fontface only:
//! - detects whether Creative Cloud is installed;
//! - lists the fonts Creative Cloud has turned on for all apps, from the OS's own font registry
//!   (names come from CoreText; Fontface never opens the files);
//! - links to fonts.adobe.com and the Creative Cloud app for turning fonts on or off.
//!
//! Guards elsewhere keep Fontface away from the files: folders inside Adobe's font store can't be
//! added, the scanner skips it, previews refuse it, and nothing there is ever (un)registered.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdobeFace {
    pub postscript_name: String,
    pub family: String,
    pub style: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdobeStatus {
    /// Creative Cloud (the desktop app) is installed.
    pub app_installed: bool,
    /// Creative Cloud's font store exists for this user (it has synced fonts at some point).
    pub font_store: bool,
    /// Fonts Creative Cloud has turned on for all apps right now.
    pub faces: Vec<AdobeFace>,
    /// This platform can't list them yet.
    pub supported: bool,
}

/// Creative Cloud keeps its synced fonts under this folder (per user).
pub fn font_store_root() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support/Adobe/CoreSync/plugins/livetype"))
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Adobe\\CoreSync\\plugins\\livetype"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

/// True for any path inside Creative Cloud's font store. Fontface must never touch these files.
pub fn is_adobe_path(path: &Path) -> bool {
    let s = path.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
    s.contains("/adobe/coresync/plugins/livetype")
}

#[cfg(target_os = "macos")]
pub fn status() -> AdobeStatus {
    use std::collections::BTreeMap;

    let app_installed = ["/Applications/Utilities/Adobe Creative Cloud", "/Applications/Adobe Creative Cloud"]
        .iter()
        .any(|p| Path::new(p).exists());
    let font_store = font_store_root().is_some_and(|p| p.is_dir());

    // One entry per PostScript name; names come from CoreText's registry, not the files.
    let mut faces = BTreeMap::new();
    if let Some(descriptors) = core_text::font_collection::create_for_all_families().get_descriptors() {
        for d in descriptors.iter() {
            if d.font_path().is_some_and(|p| is_adobe_path(&p)) {
                let face = AdobeFace { postscript_name: d.font_name(), family: d.family_name(), style: d.style_name() };
                faces.insert(face.postscript_name.clone(), face);
            }
        }
    }
    let mut faces: Vec<AdobeFace> = faces.into_values().collect();
    faces.sort_by(|a, b| a.family.cmp(&b.family).then(a.style.cmp(&b.style)));
    AdobeStatus { app_installed, font_store, faces, supported: true }
}

#[cfg(not(target_os = "macos"))]
pub fn status() -> AdobeStatus {
    // Windows plan: DirectWrite system collection, filtered to the font store path.
    AdobeStatus { app_installed: false, font_store: font_store_root().is_some_and(|p| p.is_dir()), faces: vec![], supported: false }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_adobe_font_store_paths() {
        assert!(is_adobe_path(Path::new("/Users/x/Library/Application Support/Adobe/CoreSync/plugins/livetype/.r/.123.otf")));
        assert!(is_adobe_path(Path::new("C:\\Users\\x\\AppData\\Roaming\\Adobe\\CoreSync\\plugins\\livetype\\r\\1")));
        assert!(!is_adobe_path(Path::new("/Users/x/Fonts/Adobe Garamond.otf")));
    }
}
