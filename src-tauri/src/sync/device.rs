//! Who this computer is: a random device id, a name people recognize, and a hash of the hardware
//! id to notice app data that was copied to another computer (Migration Assistant, a backup
//! restored onto a new Mac). Two computers with the same device id would write the same folder.

use std::{
    collections::hash_map::RandomState,
    hash::{BuildHasher, Hasher},
    sync::atomic::{AtomicU64, Ordering},
};

/// A new random device or tag id: 32 hex characters.
pub fn new_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut out = String::with_capacity(32);
    for _ in 0..2 {
        // RandomState is seeded from the OS's random source; mix in time and a counter too.
        let mut h = RandomState::new().build_hasher();
        h.write_u64(super::hlc::now_ms());
        h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        h.write_u32(std::process::id());
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

/// FNV-1a, 64 bits. Stable across Rust versions (unlike `DefaultHasher`). Not for security.
pub fn stable_hash(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// A hash of this computer's hardware id, or "" if it can't be read (then copies can't be
/// told apart, and nothing is checked).
pub fn machine_hash() -> String {
    hardware_id().map(|id| format!("{:016x}", stable_hash(format!("fontface-sync:{id}").as_bytes()))).unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn hardware_id() -> Option<String> {
    // IOPlatformUUID: the same for the life of the Mac, different on every Mac.
    let out = std::process::Command::new("/usr/sbin/ioreg").args(["-rd1", "-c", "IOPlatformExpertDevice"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| l.contains("\"IOPlatformUUID\""))?;
    let value = line.rsplit('"').nth(1)?.trim().to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(target_os = "windows")]
fn hardware_id() -> Option<String> {
    // MachineGuid: set when Windows is installed.
    let out = std::process::Command::new("reg")
        .args(["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().find(|l| l.contains("MachineGuid"))?.split_whitespace().last().map(String::from)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn hardware_id() -> Option<String> {
    std::fs::read_to_string("/etc/machine-id").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The computer's name as the user set it ("Sean's MacBook Pro"), for other devices' lists.
pub fn default_name() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("/usr/sbin/scutil").args(["--get", "ComputerName"]).output() {
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !name.is_empty() {
            return name;
        }
    }
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "This computer".into())
}
