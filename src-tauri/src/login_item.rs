//! "Open at login" on macOS: a LaunchAgent at
//! `~/Library/LaunchAgents/design.snds.fontface.plist` that starts Fontface's executable when
//! the user logs in.
//!
//! The file is the truth: the setting reads as on only while the file exists, is Fontface's,
//! and starts this copy of the app. Every function takes the LaunchAgents folder, so tests use
//! a temporary folder.

use std::path::{Path, PathBuf};

use plist::{Dictionary, Value};

use crate::error::{AppError, AppResult};

pub const LABEL: &str = "design.snds.fontface";

/// `~/Library/LaunchAgents`.
pub fn agents_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/LaunchAgents"))
}

pub fn plist_path(dir: &Path) -> PathBuf {
    dir.join(format!("{LABEL}.plist"))
}

/// The program our LaunchAgent starts, if the file is there and is Fontface's.
pub fn program(dir: &Path) -> Option<PathBuf> {
    let value = Value::from_file(plist_path(dir)).ok()?;
    let dict = value.as_dictionary()?;
    if dict.get("Label").and_then(Value::as_string) != Some(LABEL) {
        return None;
    }
    let first = dict.get("ProgramArguments")?.as_array()?.first()?.as_string()?;
    Some(PathBuf::from(first))
}

/// Compares the way the OS will: through any links.
fn same_file(a: &Path, b: &Path) -> bool {
    a == b || matches!((std::fs::canonicalize(a), std::fs::canonicalize(b)), (Ok(x), Ok(y)) if x == y)
}

/// True if the LaunchAgent exists and starts `exe`.
pub fn is_enabled(dir: &Path, exe: &Path) -> bool {
    program(dir).is_some_and(|p| same_file(&p, exe))
}

/// Writes the LaunchAgent so `exe` opens at login. Replaces an older one. Refuses a copy that
/// won't be there at the next login (see `temporary_location`).
pub fn enable(dir: &Path, exe: &Path) -> AppResult<()> {
    if temporary_location(exe) {
        return Err(AppError::Invalid(
            "Fontface can't open at login from here. Move it to your Applications folder, open it from there, and try again."
                .into(),
        ));
    }
    let exe = exe.to_str().ok_or_else(|| AppError::Invalid("Fontface's location has characters macOS can't use here".into()))?;
    let mut dict = Dictionary::new();
    dict.insert("Label".into(), Value::String(LABEL.into()));
    dict.insert("ProgramArguments".into(), Value::Array(vec![Value::String(exe.into())]));
    dict.insert("RunAtLoad".into(), Value::Boolean(true));
    dict.insert("ProcessType".into(), Value::String("Interactive".into()));
    let mut xml = Vec::new();
    Value::Dictionary(dict)
        .to_writer_xml(&mut xml)
        .map_err(|e| AppError::Other(format!("Couldn't write the login item: {e}")))?;
    let xml = String::from_utf8(xml).map_err(|e| AppError::Other(e.to_string()))?;
    std::fs::create_dir_all(dir)?;
    crate::tags::export::write_file(&plist_path(dir), &xml)
}

/// Removes the LaunchAgent. Fine if it isn't there.
pub fn disable(dir: &Path) -> AppResult<()> {
    match std::fs::remove_file(plist_path(dir)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// If the LaunchAgent starts a copy that's gone (the app was moved), points it at `exe`.
/// Returns whether it was rewritten. Does nothing when there's no LaunchAgent (the user turned
/// it off), when the copy it starts is still there (this is a second copy, e.g. a newer version
/// opened before it replaced the installed one), or when `exe` won't be there at the next login.
pub fn refresh(dir: &Path, exe: &Path) -> AppResult<bool> {
    if temporary_location(exe) {
        return Ok(false);
    }
    match program(dir) {
        Some(p) if !p.exists() && !same_file(&p, exe) => enable(dir, exe).map(|_| true),
        _ => Ok(false),
    }
}

/// True for a copy macOS takes away: one opened from a disk image (an app at the top of a
/// mounted volume, `/Volumes/<name>/Fontface.app`, on a read-only volume), or one macOS runs from
/// a random hidden folder because it was opened straight from a download (App Translocation).
/// An app kept at the top of a writable drive is fine.
pub fn temporary_location(exe: &Path) -> bool {
    temporary_location_with(exe, read_only_volume)
}

/// `temporary_location`, with the read-only check passed in (for tests).
pub fn temporary_location_with(exe: &Path, read_only: impl Fn(&Path) -> bool) -> bool {
    let parts: Vec<_> = exe.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    if parts.iter().any(|p| p == "AppTranslocation") {
        return true;
    }
    parts.len() > 3
        && parts[0] == "/"
        && parts[1] == "Volumes"
        && parts[3].ends_with(".app")
        && read_only(&Path::new("/Volumes").join(&parts[2]))
}

/// Disk images mount read-only.
#[cfg(target_os = "macos")]
fn read_only_volume(root: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(root.as_os_str().as_bytes()) else { return false };
    let mut fs = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: `c_path` is a valid C string and `fs` is written by statfs before it's read.
    if unsafe { libc::statfs(c_path.as_ptr(), fs.as_mut_ptr()) } != 0 {
        return false;
    }
    let flags = unsafe { fs.assume_init() }.f_flags;
    flags & libc::MNT_RDONLY as u32 != 0
}

#[cfg(not(target_os = "macos"))]
fn read_only_volume(_: &Path) -> bool {
    false
}

/// True for an executable inside an app bundle (`….app/Contents/MacOS/…`), as opposed to a
/// development build.
pub fn in_app_bundle(exe: &Path) -> bool {
    let parts: Vec<_> = exe.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    parts.windows(3).any(|w| w[0].ends_with(".app") && w[1] == "Contents" && w[2] == "MacOS")
}
