//! macOS activation via CoreText's font manager.
//!
//! We register with the *persistent* user scope. That means:
//!   - fonts stay on after the app quits and after a restart, with no helper running;
//!   - nothing is copied into ~/Library/Fonts;
//!   - every app (Figma, Adobe, Office…) sees the change through CoreText's notification.

use std::{collections::HashSet, path::Path};

use core_foundation::{
    array::{CFArray, CFArrayRef},
    base::TCFType,
    error::{CFError, CFErrorRef},
    url::{CFURL, CFURLRef},
};

use crate::error::{AppError, AppResult};

type CTFontManagerScope = u32;
const SCOPE_PERSISTENT: CTFontManagerScope = 2; // kCTFontManagerScopePersistent (== User)
const SCOPE_SESSION: CTFontManagerScope = 3; // kCTFontManagerScopeSession: until logout

// CTFontManagerError codes we treat specially.
const ERR_ALREADY_REGISTERED: isize = 105;
const ERR_NOT_REGISTERED: isize = 201;

#[link(name = "CoreText", kind = "framework")]
extern "C" {
    fn CTFontManagerRegisterFontsForURL(url: CFURLRef, scope: CTFontManagerScope, error: *mut CFErrorRef) -> bool;
    fn CTFontManagerUnregisterFontsForURL(url: CFURLRef, scope: CTFontManagerScope, error: *mut CFErrorRef) -> bool;
    fn CTFontManagerCopyAvailableFontURLs() -> CFArrayRef;
}

type ManagerFn = unsafe extern "C" fn(CFURLRef, CTFontManagerScope, *mut CFErrorRef) -> bool;

fn call(f: ManagerFn, path: &Path, ok_code: isize) -> AppResult<()> {
    call_in(f, path, SCOPE_PERSISTENT, ok_code)
}

fn call_in(f: ManagerFn, path: &Path, scope: CTFontManagerScope, ok_code: isize) -> AppResult<()> {
    let url = CFURL::from_path(path, false)
        .ok_or_else(|| AppError::Activation(format!("invalid path: {}", path.display())))?;
    let mut err: CFErrorRef = std::ptr::null_mut();
    // SAFETY: `url` is a live CFURL for the call; `err` is either left null or set to an
    // owned CFError (create rule), which we take ownership of below.
    let ok = unsafe { f(url.as_concrete_TypeRef(), scope, &mut err) };
    if ok {
        return Ok(());
    }
    if err.is_null() {
        return Err(AppError::Activation("CoreText refused the font for an unknown reason".into()));
    }
    let err = unsafe { CFError::wrap_under_create_rule(err) };
    if err.code() == ok_code {
        return Ok(());
    }
    Err(AppError::Activation(describe(err.code(), &err.description().to_string())))
}

fn describe(code: isize, fallback: &str) -> String {
    let msg = match code {
        101 => "the font file was not found",
        102 => "no permission to read the font file",
        103 => "the file is not a font format macOS recognizes",
        104 => "the font data is damaged",
        106 => "too many fonts are active",
        202 => "the font is in use and can't be turned off yet",
        203 => "macOS requires this font and won't turn it off",
        305 => "a font with the same name is already active",
        _ => return format!("{fallback} (CoreText error {code})"),
    };
    format!("{msg} (CoreText error {code})")
}

pub fn activate(path: &Path) -> AppResult<()> {
    call(CTFontManagerRegisterFontsForURL, path, ERR_ALREADY_REGISTERED)
}

pub fn deactivate(path: &Path) -> AppResult<()> {
    call(CTFontManagerUnregisterFontsForURL, path, ERR_NOT_REGISTERED)
}

/// Other font managers often register with session scope. If a font is still loaded after
/// `deactivate`, this removes that registration too (it works across processes).
pub fn deactivate_elsewhere(path: &Path) -> AppResult<()> {
    call_in(CTFontManagerUnregisterFontsForURL, path, SCOPE_SESSION, ERR_NOT_REGISTERED)
}

/// Real on-disk paths of every font file the OS has loaded right now: installed fonts plus
/// fonts any app registered (Fontface, or another font manager). The ground truth for "is it on?".
///
/// CoreText doesn't hand back the path it was given. It returns one URL per face, resolves
/// symlinks, drops a leading `/private`, and decomposes accented letters (NFD). `canonicalize`
/// maps each one back to the on-disk form the scanner stores. Files that no longer exist can
/// stay listed; they fail to canonicalize and simply match nothing.
pub fn available_paths() -> Option<HashSet<String>> {
    // SAFETY: the function follows the Create rule and returns a CFArray of CFURLs (or null).
    let raw = unsafe { CTFontManagerCopyAvailableFontURLs() };
    if raw.is_null() {
        return None;
    }
    let urls: CFArray<CFURL> = unsafe { CFArray::wrap_under_create_rule(raw) };
    let unique: HashSet<std::path::PathBuf> = urls.iter().filter_map(|u| u.to_path()).collect();
    Some(
        unique
            .into_iter()
            .filter_map(|p| std::fs::canonicalize(&p).ok())
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
    )
}
