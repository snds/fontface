//! Where sync files live. The merge logic only talks to `Transport`, so another kind of storage
//! (a direct WebDAV, S3, Google Drive, OneDrive, Dropbox or iCloud connection through Apache
//! OpenDAL) can be added later without touching it.
//!
//! The rule every transport keeps: a device writes and removes only inside its own folder,
//! `devices/<its id>/`. It may read every device's folder. No two devices ever write the same
//! file, so a plain file-sync service can't create conflicts.

use std::{
    io::{self, Write},
    path::{Path, PathBuf},
};

use super::{is_device_id, ops};

pub trait Transport: Send + Sync {
    /// Ids of the device folders present (anything that isn't a device id is ignored).
    fn devices(&self) -> io::Result<Vec<String>>;
    /// Names of the sync files in a device's folder: `device.json`, `snapshot.json` and
    /// `changes-<n>.jsonl`. Anything else (temporary files, "conflicted copy" files) is ignored.
    fn list(&self, device: &str) -> io::Result<Vec<String>>;
    fn read(&self, device: &str, name: &str) -> io::Result<Vec<u8>>;
    /// Replaces a file in this device's own folder in one step: readers see the old file or the
    /// new one, never half of it.
    fn write_atomic(&self, name: &str, bytes: &[u8]) -> io::Result<()>;
    /// Removes a file from this device's own folder. A file that's already gone is fine.
    fn remove(&self, name: &str) -> io::Result<()>;
    /// Format folders newer than this version's (`v2`, …), from a newer Fontface elsewhere.
    fn newer_formats(&self) -> Vec<String>;
}

/// The folder all sync files go in, inside the folder the user picks.
pub const ROOT: &str = "Fontface Sync";
const FORMAT_DIR: &str = "v1";

/// A folder that something else keeps in sync: iCloud Drive, OneDrive, Google Drive, Dropbox,
/// the Nextcloud or Seafile client, Syncthing, an rclone mount.
pub struct FolderTransport {
    /// `<picked folder>/Fontface Sync`.
    root: PathBuf,
    device: String,
}

impl FolderTransport {
    pub fn new(picked: &Path, device: &str) -> Self {
        FolderTransport { root: picked.join(ROOT), device: device.to_string() }
    }

    fn devices_dir(&self) -> PathBuf {
        self.root.join(FORMAT_DIR).join("devices")
    }

    fn own_dir(&self) -> PathBuf {
        self.devices_dir().join(&self.device)
    }

    /// The folder to watch for other devices' changes.
    pub fn watch_dir(&self) -> PathBuf {
        self.devices_dir()
    }

    /// True for a path inside this device's own folder (its own writes, not worth waking for).
    pub fn is_own(&self, path: &Path) -> bool {
        path.starts_with(self.own_dir())
    }
}

fn is_sync_file(name: &str) -> bool {
    name == ops::DEVICE_NAME || name == ops::SNAPSHOT_NAME || ops::change_seq(name).is_some()
}

impl Transport for FolderTransport {
    fn devices(&self) -> io::Result<Vec<String>> {
        let dir = self.devices_dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_device_id(&name) && entry.file_type().is_ok_and(|t| t.is_dir()) {
                out.push(name);
            }
        }
        out.sort();
        Ok(out)
    }

    fn list(&self, device: &str) -> io::Result<Vec<String>> {
        if !is_device_id(device) {
            return Ok(Vec::new());
        }
        let dir = self.devices_dir().join(device);
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_sync_file(&name) && entry.file_type().is_ok_and(|t| t.is_file()) {
                out.push(name);
            }
        }
        out.sort();
        Ok(out)
    }

    fn read(&self, device: &str, name: &str) -> io::Result<Vec<u8>> {
        if !is_device_id(device) || !is_sync_file(name) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a sync file"));
        }
        let path = self.devices_dir().join(device).join(name);
        let len = std::fs::metadata(&path)?.len();
        if len > ops::MAX_FILE as u64 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "file too big"));
        }
        std::fs::read(path)
    }

    fn write_atomic(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
        if !is_sync_file(name) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a sync file"));
        }
        let dir = self.own_dir();
        std::fs::create_dir_all(&dir)?;
        // Same folder, so the rename is one step. The leading dot and odd ending keep readers
        // (and most sync services) from picking up the unfinished file.
        let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
        let result = (|| {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(bytes)?;
            f.sync_all()?;
            drop(f);
            std::fs::rename(&tmp, dir.join(name))
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        result
    }

    fn remove(&self, name: &str) -> io::Result<()> {
        if !is_sync_file(name) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a sync file"));
        }
        match std::fs::remove_file(self.own_dir().join(name)) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }

    fn newer_formats(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(&self.root) else { return Vec::new() };
        let mut out: Vec<String> = entries
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.strip_prefix('v').and_then(|v| v.parse::<u32>().ok()).is_some_and(|v| v > ops::VERSION))
            .collect();
        out.sort();
        out
    }
}
