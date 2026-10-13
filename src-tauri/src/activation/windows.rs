//! Windows activation — architected, not yet implemented (Mac first, by decision).
//!
//! Scopes: `Persistent` is the plan below. `Session` (the "temporary" activation mode) is step 1
//! alone, with no registry value, so the font is gone after the next sign-in.
//!
//! Plan (Windows 10 1809+ supports per-user fonts with no admin rights):
//!   activate(path):
//!     1. AddFontResourceExW(path, 0, null)  — makes it available to the current session now.
//!     2. Write HKCU\Software\Microsoft\Windows NT\CurrentVersion\Fonts
//!          "<Full Name> (TrueType)" = "<absolute path>"
//!        so Windows loads it again at the next sign-in (fonts may live outside %LOCALAPPDATA%).
//!     3. SendMessageTimeoutW(HWND_BROADCAST, WM_FONTCHANGE, …) so running apps refresh.
//!   deactivate(path):
//!     RemoveFontResourceExW, delete the HKCU value, broadcast WM_FONTCHANGE.
//!   Collections (.ttc) register as one resource, matching the macOS per-file model.
//!
//! Dependencies to add then: `windows-sys` with Win32_Graphics_Gdi, Win32_System_Registry,
//! Win32_UI_WindowsAndMessaging, Win32_Foundation.

use std::{collections::HashSet, path::Path};

use super::Scope;
use crate::error::{AppError, AppResult};

pub fn activate(_path: &Path, _scope: Scope) -> AppResult<()> {
    Err(AppError::Unsupported("font activation on Windows".into()))
}

pub fn deactivate(_path: &Path, _scope: Scope) -> AppResult<()> {
    Err(AppError::Unsupported("font activation on Windows".into()))
}

/// Planned: enumerate HKCU and HKLM Fonts registry values plus session-added resources.
pub fn available_paths() -> Option<HashSet<String>> {
    None
}

pub fn deactivate_elsewhere(_path: &Path) -> AppResult<()> {
    Ok(())
}
