//! Font files in formats Fontface can't use yet (Type 1, web fonts, old Mac suitcases…), counted
//! by kind so a scan can say what it left out. Which files are added never depends on this: the
//! scanner reads .ttf, .otf, .ttc and .otc files only, and those never come here, so a scan of
//! them costs nothing extra. The scanner itself counts the files that couldn't be read.
//!
//! Most kinds are known from the file's name alone. Old Mac fonts often have no extension, so
//! for a name without one, the Finder type code in the file's `com.apple.FinderInfo` attribute
//! says what it is: 'FFIL' for a suitcase, 'LWFN' for a Type 1 outline. Nothing here opens a
//! file. The attribute is metadata, read on a thread of its own that never downloads an
//! online-only file, and a suitcase's resource fork (where its fonts are) is never touched.

use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering::Relaxed},
        Arc,
    },
    thread::JoinHandle,
};

use crate::model::SkippedFiles;

/// A kind of file Fontface finds but can't use yet: one per count in `SkippedFiles`, apart from
/// the unreadable files.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Type1,
    Type1Metrics,
    Woff,
    Woff2,
    Dfont,
    Eot,
    WindowsBitmap,
    Suitcase,
    NoExtension,
}

/// How to tell what a file is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Look {
    /// Its name says.
    Named(Kind),
    /// Its name has no extension: its Finder type code may say (`count_type_codes`).
    TypeCode,
}

/// Sorts a file the scanner doesn't read, by its name. None for anything that isn't a font
/// (a specimen PDF, a licence, a picture): it isn't counted.
pub fn look(path: &Path) -> Option<Look> {
    if no_extension(path) {
        return Some(Look::TypeCode);
    }
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let kind = match ext.as_str() {
        "pfb" | "pfa" | "lwfn" => Kind::Type1,
        "pfm" | "afm" | "inf" => Kind::Type1Metrics,
        "woff" => Kind::Woff,
        "woff2" => Kind::Woff2,
        "dfont" => Kind::Dfont,
        "eot" => Kind::Eot,
        "fon" | "fnt" => Kind::WindowsBitmap,
        "suit" => Kind::Suitcase,
        _ => return None,
    };
    Some(Look::Named(kind))
}

/// True for a name with no extension that says what the file is: none at all ("FutuBol"), or a
/// dot that's part of the name ("Times 2.0", "Helv. Neue", "Futura.Condensed").
fn no_extension(path: &Path) -> bool {
    let Some(ext) = path.extension() else { return true };
    let ext = ext.as_encoded_bytes();
    ext.is_empty() || ext.len() > 5 || ext[0].is_ascii_digit() || !ext.iter().all(u8::is_ascii_alphanumeric)
}

/// The kind a Finder type code stands for, when it's a font Fontface can't use yet.
pub fn kind_of_type_code(code: &[u8; 4]) -> Option<Kind> {
    Some(match code {
        b"FFIL" => Kind::Suitcase,
        b"LWFN" => Kind::Type1,
        b"dfon" => Kind::Dfont,
        // A TrueType or OpenType font the scanner would read if its name ended in .ttf or .otf.
        b"tfil" | b"sfnt" | b"OTTO" => Kind::NoExtension,
        _ => return None,
    })
}

/// The Finder type code in a file's FinderInfo attribute (its first 4 bytes). None when it has
/// none (most files made since Mac OS X), or when reading it would mean downloading the file.
#[cfg(target_os = "macos")]
pub fn finder_type_code(path: &Path) -> Option<[u8; 4]> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut info = [0u8; 32];
    // SAFETY: both names are NUL-terminated, and `info` is as long as the size passed. Reads the
    // one attribute only; XATTR_NOFOLLOW keeps it to the file itself (paths here are resolved).
    let read = unsafe {
        libc::getxattr(path.as_ptr(), c"com.apple.FinderInfo".as_ptr(), info.as_mut_ptr().cast(), info.len(), 0, libc::XATTR_NOFOLLOW)
    };
    let code = [info[0], info[1], info[2], info[3]];
    (read >= 4 && code != [0; 4]).then_some(code)
}

#[cfg(not(target_os = "macos"))]
pub fn finder_type_code(_: &Path) -> Option<[u8; 4]> {
    None
}

/// Counts files with no extension by their Finder type codes, on a thread of its own: there,
/// reading the attribute of an online-only file fails at once instead of downloading it (and
/// that file isn't counted). Join it for the counts; None when there's nothing to look at.
pub fn count_type_codes(paths: Vec<PathBuf>, cancel: Arc<AtomicBool>) -> Option<JoinHandle<SkippedFiles>> {
    if paths.is_empty() {
        return None;
    }
    Some(std::thread::spawn(move || {
        crate::cloud::fail_fast_on_this_thread();
        let mut counts = SkippedFiles::default();
        for path in &paths {
            if cancel.load(Relaxed) {
                break;
            }
            if let Some(kind) = finder_type_code(path).as_ref().and_then(kind_of_type_code) {
                add(&mut counts, kind, 1);
            }
        }
        counts
    }))
}

/// Adds `n` files of `kind`.
pub fn add(counts: &mut SkippedFiles, kind: Kind, n: usize) {
    let count = match kind {
        Kind::Type1 => &mut counts.type1,
        Kind::Type1Metrics => &mut counts.type1_metrics,
        Kind::Woff => &mut counts.woff,
        Kind::Woff2 => &mut counts.woff2,
        Kind::Dfont => &mut counts.dfont,
        Kind::Eot => &mut counts.eot,
        Kind::WindowsBitmap => &mut counts.windows_bitmap,
        Kind::Suitcase => &mut counts.suitcase,
        Kind::NoExtension => &mut counts.no_extension,
    };
    *count += n;
}

/// Adds the kinds counted in `more` (its unreadable files are the scanner's own count).
pub fn merge(counts: &mut SkippedFiles, more: &SkippedFiles) {
    counts.type1 += more.type1;
    counts.type1_metrics += more.type1_metrics;
    counts.woff += more.woff;
    counts.woff2 += more.woff2;
    counts.dfont += more.dfont;
    counts.eot += more.eot;
    counts.windows_bitmap += more.windows_bitmap;
    counts.suitcase += more.suitcase;
    counts.no_extension += more.no_extension;
}

#[cfg(test)]
mod tests {
    use std::{
        path::{Path, PathBuf},
        sync::{atomic::AtomicBool, Arc},
    };

    use super::{kind_of_type_code, look, Kind, Look};
    use crate::{db, model::SkippedFiles, scanner};

    const ANDALE_MONO: &str = "/System/Library/Fonts/Supplemental/Andale Mono.ttf";

    #[test]
    fn names_say_what_most_files_are() {
        let kind = |name: &str| look(Path::new(name));
        assert_eq!(kind("Garamond.PFB"), Some(Look::Named(Kind::Type1)), "any case");
        assert_eq!(kind("Garamond.pfa"), Some(Look::Named(Kind::Type1)));
        for metrics in ["Garamond.pfm", "Garamond.afm", "Garamond.inf"] {
            assert_eq!(kind(metrics), Some(Look::Named(Kind::Type1Metrics)), "{metrics}");
        }
        assert_eq!(kind("Inter.woff"), Some(Look::Named(Kind::Woff)));
        assert_eq!(kind("Inter.woff2"), Some(Look::Named(Kind::Woff2)));
        assert_eq!(kind("Keyboard.dfont"), Some(Look::Named(Kind::Dfont)));
        assert_eq!(kind("Old.eot"), Some(Look::Named(Kind::Eot)));
        assert_eq!(kind("Courier.fon"), Some(Look::Named(Kind::WindowsBitmap)));
        assert_eq!(kind("Courier.FNT"), Some(Look::Named(Kind::WindowsBitmap)));
        assert_eq!(kind("Futura.suit"), Some(Look::Named(Kind::Suitcase)));
        for other in ["Specimen.pdf", "OFL.txt", "preview.png", "METADATA.pb", "Fonts.zip"] {
            assert_eq!(kind(other), None, "{other} isn't counted");
        }
    }

    #[test]
    fn names_without_a_real_extension_ask_the_type_code() {
        for name in ["FutuBol", "Futura", "Times 2.0", "Helv. Neue", "Futura.Condensed", "Odd."] {
            assert_eq!(look(Path::new(name)), Some(Look::TypeCode), "{name}");
        }
    }

    #[test]
    fn type_codes_name_old_mac_fonts() {
        assert_eq!(kind_of_type_code(b"FFIL"), Some(Kind::Suitcase));
        assert_eq!(kind_of_type_code(b"LWFN"), Some(Kind::Type1));
        assert_eq!(kind_of_type_code(b"tfil"), Some(Kind::NoExtension));
        assert_eq!(kind_of_type_code(b"dfon"), Some(Kind::Dfont));
        assert_eq!(kind_of_type_code(b"TEXT"), None, "a text file");
        assert_eq!(kind_of_type_code(b"icon"), None, "a folder's custom icon");
    }

    /// A scratch folder of fonts and a fresh library database, removed when dropped.
    struct Sandbox(PathBuf);

    impl Sandbox {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("fontface-skipped-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("fonts")).unwrap();
            Self(std::fs::canonicalize(dir).unwrap())
        }
        fn fonts(&self) -> PathBuf {
            self.0.join("fonts")
        }
        fn db(&self) -> PathBuf {
            self.0.join("library.sqlite3")
        }
        fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.fonts().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, bytes).unwrap();
            path
        }
        fn add_folder(&self) -> i64 {
            db::insert_folder(&mut db::open(&self.db()).unwrap(), &self.fonts(), "user").unwrap()
        }
        fn scan(&self, folder: i64) -> crate::model::ScanReport {
            scanner::scan_folder(&self.db(), folder, &self.fonts(), &Arc::new(AtomicBool::new(false)), |_| {}).unwrap()
        }
        fn stored(&self, folder: i64) -> Option<SkippedFiles> {
            db::get_folder(&db::open(&self.db()).unwrap(), folder).unwrap().skipped
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Sets a file's Finder type code, as an old Mac would have. False where the disk can't
    /// keep extended attributes.
    fn set_type_code(path: &Path, code: &[u8; 4]) -> bool {
        let mut info = [0u8; 32];
        info[..4].copy_from_slice(code);
        info[4..8].copy_from_slice(b"test");
        #[cfg(target_os = "macos")]
        return xattr::set(path, "com.apple.FinderInfo", &info).is_ok();
        #[cfg(not(target_os = "macos"))]
        return false;
    }

    #[test]
    fn a_scan_counts_what_it_leaves_out_and_keeps_the_counts() {
        let sb = Sandbox::new("kinds");
        sb.write("Andale.ttf", &std::fs::read(ANDALE_MONO).unwrap());
        sb.write("broken.otf", b"not a font");
        sb.write("Type 1/Garamond.pfb", b"\x80\x01fake");
        sb.write("Type 1/Garamond.PFM", b"fake");
        sb.write("Type 1/Garamond.afm", b"StartFontMetrics");
        sb.write("Type 1/Garamond.inf", b"fake");
        sb.write("Type 1/Univers.pfa", b"%!PS-AdobeFont");
        sb.write("web/Inter.woff", b"wOFFfake");
        sb.write("web/Inter.woff2", b"wOF2fake");
        sb.write("web/Inter.eot", b"fake");
        sb.write("mac/Keyboard.dfont", b"fake");
        sb.write("windows/Courier.fon", b"MZfake");
        sb.write("windows/Courier.fnt", b"fake");
        sb.write("Specimen.pdf", b"%PDF");
        sb.write("OFL.txt", b"licence");
        sb.write("README", b"no type code, not counted");
        let folder = sb.add_folder();

        let report = sb.scan(folder);
        assert_eq!(report.added, 1, "only the font Fontface reads is added");
        assert_eq!(report.files, 2, "the files it reads: the font and the broken one");
        let expected = SkippedFiles {
            type1: 2,
            type1_metrics: 3,
            woff: 1,
            woff2: 1,
            dfont: 1,
            eot: 1,
            windows_bitmap: 2,
            unreadable: 1,
            ..Default::default()
        };
        assert_eq!(report.skipped, expected);
        assert_eq!(sb.stored(folder), Some(expected.clone()), "the folder keeps the latest counts");

        let again = sb.scan(folder);
        assert!(again.failed.is_empty(), "the broken file isn't read or reported again");
        assert_eq!(again.skipped, expected, "but it still counts as unreadable while it's unchanged");

        std::fs::remove_file(sb.fonts().join("web/Inter.woff")).unwrap();
        std::fs::remove_file(sb.fonts().join("broken.otf")).unwrap();
        let after = sb.scan(folder);
        assert_eq!((after.skipped.woff, after.skipped.unreadable), (0, 0));
        assert_eq!(sb.stored(folder), Some(after.skipped), "each scan's counts replace the last");
    }

    #[test]
    fn old_mac_fonts_without_extensions_are_known_by_their_type_code() {
        let sb = Sandbox::new("typecodes");
        let suitcase = sb.write("Futura", b"");
        let outline = sb.write("FutuBol", b"");
        let truetype = sb.write("Times 2.0", b"");
        let text = sb.write("Read Me", b"words");
        if !set_type_code(&suitcase, b"FFIL") {
            eprintln!("skipped: this disk can't keep Finder type codes");
            return;
        }
        assert!(set_type_code(&outline, b"LWFN") && set_type_code(&truetype, b"tfil") && set_type_code(&text, b"TEXT"));
        sb.write("Plain", b"no type code");
        let folder = sb.add_folder();

        let report = sb.scan(folder);
        assert_eq!(report.files, 0, "none of them is read");
        let expected = SkippedFiles { suitcase: 1, type1: 1, no_extension: 1, ..Default::default() };
        assert_eq!(report.skipped, expected);
        // The files themselves were never changed.
        assert_eq!(std::fs::read(&suitcase).unwrap(), b"");
    }

    #[test]
    fn a_file_reached_twice_counts_once() {
        let sb = Sandbox::new("twice");
        sb.write("Type 1/Garamond.pfb", b"fake");
        std::os::unix::fs::symlink(sb.fonts().join("Type 1"), sb.fonts().join("Also Type 1")).unwrap();
        let folder = sb.add_folder();
        assert_eq!(sb.scan(folder).skipped.type1, 1);
    }

    #[test]
    fn a_cancelled_scan_keeps_the_counts_it_had() {
        let sb = Sandbox::new("cancel");
        sb.write("Garamond.pfb", b"fake");
        let folder = sb.add_folder();
        sb.scan(folder);
        sb.write("Univers.pfb", b"fake");
        let cancelled = scanner::scan_folder(&sb.db(), folder, &sb.fonts(), &Arc::new(AtomicBool::new(true)), |_| {}).unwrap();
        assert!(cancelled.cancelled);
        assert_eq!(sb.stored(folder).map(|s| s.type1), Some(1));
    }

    #[test]
    fn counts_stored_by_another_build_read_with_the_kinds_they_have() {
        let sb = Sandbox::new("json");
        let folder = sb.add_folder();
        assert_eq!(sb.stored(folder), None, "nothing until a scan has counted");
        let conn = db::open(&sb.db()).unwrap();
        conn.execute("UPDATE folders SET skipped_counts = '{\"type1\":3,\"later\":9}' WHERE id = ?1", [folder]).unwrap();
        assert_eq!(sb.stored(folder), Some(SkippedFiles { type1: 3, ..Default::default() }));
    }
}
