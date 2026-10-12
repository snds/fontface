//! Online-only files from cloud storage (Google Drive, iCloud, Dropbox via File Provider).
//! Reading one makes macOS download it first, which can take from seconds to many minutes.

/// True for an online-only cloud placeholder (Google Drive, iCloud, Dropbox via File Provider).
/// Its contents download on first read.
#[cfg(target_os = "macos")]
pub fn is_dataless(meta: &std::fs::Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;
    const SF_DATALESS: u32 = 0x4000_0000;
    meta.st_flags() & SF_DATALESS != 0
}

#[cfg(not(target_os = "macos"))]
pub fn is_dataless(_: &std::fs::Metadata) -> bool {
    false
}

/// Controls whether reads on the current thread download online-only files.
#[cfg(target_os = "macos")]
mod placeholder {
    const IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES: i32 = 3;
    const IOPOL_SCOPE_THREAD: i32 = 1;
    const IOPOL_MATERIALIZE_DATALESS_FILES_OFF: i32 = 1;
    const EDEADLK: i32 = 11;

    extern "C" {
        fn setiopolicy_np(iotype: i32, scope: i32, policy: i32) -> i32;
    }

    /// After this, reading an online-only file on this thread fails at once with EDEADLK.
    pub fn fail_fast_on_this_thread() {
        // SAFETY: plain libc call that only changes this thread's I/O policy.
        unsafe {
            setiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, IOPOL_SCOPE_THREAD, IOPOL_MATERIALIZE_DATALESS_FILES_OFF);
        }
    }

    pub fn is_not_downloaded(e: &std::io::Error) -> bool {
        e.raw_os_error() == Some(EDEADLK)
    }
}

#[cfg(not(target_os = "macos"))]
mod placeholder {
    pub fn fail_fast_on_this_thread() {}
    pub fn is_not_downloaded(_: &std::io::Error) -> bool {
        false
    }
}

pub use placeholder::{fail_fast_on_this_thread, is_not_downloaded};
