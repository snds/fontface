//! Facts about one face that the library doesn't store, read from its file when the font page
//! asks (`font_facts`): its OpenType features (layout.rs), its named styles (`fvar` instances),
//! what its embedding permissions say (OS/2 `fsType`), a few more of its names (trademark,
//! description, foundry and designer websites, sample text), and on macOS the languages CoreText
//! says it supports. Plus, from the library, when Fontface last turned it on.
//!
//! **Safety.** The same rules as previews: Creative Cloud's files are never read, online-only
//! files are never downloaded (the answer says "cloud", and the page says "Download to see
//! details"), files over 96 MB are skipped, and a file that changed since its scan isn't read.
//! Reading runs on the preview reader threads through its own latest-wins lane, so stepping
//! through a family's styles reads only the one shown.
//!
//! **Cache.** Facts are kept in memory for the last few faces read, by path, face index, size and
//! modified time, so going back and forth between tabs and styles doesn't read a file again.

pub mod layout;

#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex};

use serde::Serialize;
use ttf_parser::{Face, Tag};

use crate::{
    error::{AppError, AppResult},
    preview::{self, FaceRow, Unreadable},
    tags::named_styles::{self, be16, name_string, NamedInstance},
    AppState,
};

pub use layout::{Feature, Script};

/// Longer names (a description, a trademark notice) are cut here.
const MAX_TEXT: usize = 4000;
/// How many faces' facts are kept in memory.
const CACHE_SIZE: usize = 24;

/// What a font file says about embedding it in documents (OS/2 `fsType`). Only the font's own
/// flags: the license decides.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Embedding {
    /// "installable", "editable", "previewPrint", "restricted", or "unclear" (flags that
    /// contradict each other).
    pub kind: &'static str,
    /// Documents must embed the whole font, not just the characters they use.
    pub no_subsetting: bool,
    /// Only bitmaps may be embedded, not outlines.
    pub bitmap_only: bool,
}

/// Reads `fsType` as the OpenType spec says. Up to OS/2 version 2 several usage bits may be set,
/// and the most permissive one counts; from version 3 exactly one may be.
pub fn embedding(version: u16, fs_type: u16) -> Embedding {
    let usage = fs_type & 0xF;
    let kind = if version <= 2 {
        match usage {
            0 => "installable",
            u if u & 8 != 0 => "editable",
            u if u & 4 != 0 => "previewPrint",
            u if u & 2 != 0 => "restricted",
            _ => "unclear",
        }
    } else {
        match usage {
            0 => "installable",
            2 => "restricted",
            4 => "previewPrint",
            8 => "editable",
            _ => "unclear",
        }
    };
    Embedding { kind, no_subsetting: version >= 2 && fs_type & 0x100 != 0, bitmap_only: version >= 2 && fs_type & 0x200 != 0 }
}

/// What the font page shows that the list doesn't have.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFacts {
    pub features: Vec<Feature>,
    pub scripts: Vec<Script>,
    /// The font uses Apple's own feature tables (`morx`) and has no OpenType ones.
    pub apple_features: bool,
    pub instances: Vec<NamedInstance>,
    /// None when the font has no OS/2 table.
    pub embedding: Option<Embedding>,
    /// Name IDs 7, 10, 11, 12 and 19.
    pub trademark: Option<String>,
    pub description: Option<String>,
    pub vendor_url: Option<String>,
    pub designer_url: Option<String>,
    pub sample_text: Option<String>,
    /// BCP 47 language codes CoreText says the face supports. None where the system can't say.
    pub languages: Option<Vec<String>>,
}

/// The `font_facts` answer. `facts` is None when the file wasn't read, and `unread` says why.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactsAnswer {
    pub facts: Option<FontFacts>,
    /// "cloud" (online-only), "adobe", "tooLarge", "missing", "changed" or "broken".
    pub unread: Option<&'static str>,
    /// Why, in words, when the file wasn't read.
    pub message: Option<String>,
    /// When Fontface last turned this font on, in Unix seconds (see `activation::record_turned_on`).
    pub last_turned_on: Option<i64>,
}

fn text(name: &[u8], id: u16) -> Option<String> {
    let s = name_string(name, id)?;
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    Some(if s.chars().count() > MAX_TEXT { s.chars().take(MAX_TEXT).collect::<String>() + "…" } else { s.to_string() })
}

/// The facts in a font file's data, for its face `face_index`. `languages` works out the
/// languages (CoreText on macOS; tests pass their own).
pub fn read_facts_with(
    data: &[u8],
    face_index: u32,
    languages: impl FnOnce(&[u8], u32) -> Option<Vec<String>>,
) -> Result<FontFacts, Unreadable> {
    let face = Face::parse(data, face_index).map_err(|e| Unreadable::Broken(e.to_string()))?;
    let raw = |tag: &[u8; 4]| face.raw_face().table(Tag::from_bytes(tag));
    let name = raw(b"name").unwrap_or_default();
    let (features, scripts) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| layout::features(&face, name)))
        .unwrap_or_else(|_| {
            eprintln!("fontface: couldn't read the OpenType features of a font");
            (Vec::new(), Vec::new())
        });
    let apple_features = features.is_empty() && raw(b"morx").is_some();
    let instances = raw(b"fvar").map(|fvar| named_styles::instances(fvar, name)).unwrap_or_default();
    let embedding = raw(b"OS/2").and_then(|os2| Some(embedding(be16(os2, 0)?, be16(os2, 8)?)));
    Ok(FontFacts {
        features,
        scripts,
        apple_features,
        instances,
        embedding,
        trademark: text(name, 7),
        description: text(name, 10),
        vendor_url: text(name, 11),
        designer_url: text(name, 12),
        sample_text: text(name, 19),
        languages: languages(data, face_index),
    })
}

/// `read_facts_with`, with the system's languages.
pub fn read_facts(data: &[u8], face_index: u32) -> Result<FontFacts, Unreadable> {
    read_facts_with(data, face_index, system_languages)
}

/// The languages CoreText says a face supports (`CTFontCopySupportedLanguages`), from the
/// file's data: nothing is registered with the system, and nothing else is read.
#[cfg(target_os = "macos")]
pub fn system_languages(data: &[u8], face_index: u32) -> Option<Vec<String>> {
    use core_foundation::{
        array::{CFArray, CFArrayRef},
        base::TCFType,
        string::CFString,
    };
    use core_text::font::CTFontRef;

    #[link(name = "CoreText", kind = "framework")]
    extern "C" {
        fn CTFontCopySupportedLanguages(font: CTFontRef) -> CFArrayRef;
    }

    let single;
    let bytes = if crate::sfnt::is_collection(data) {
        single = crate::sfnt::extract_face(data, face_index)?;
        &single[..]
    } else {
        data
    };
    let descriptor = core_text::font_manager::create_font_descriptor(bytes).ok()?;
    let font = core_text::font::new_from_descriptor(&descriptor, 12.0);
    // SAFETY: a CoreText call on a valid font; the array it returns is ours to release (the
    // Create rule), which CFArray does when dropped.
    let list = unsafe { CTFontCopySupportedLanguages(font.as_concrete_TypeRef()) };
    if list.is_null() {
        return None;
    }
    let list: CFArray<CFString> = unsafe { CFArray::wrap_under_create_rule(list) };
    let mut codes: Vec<String> = list.iter().map(|s| s.to_string()).filter(|s| !s.is_empty() && s.len() <= 32).collect();
    codes.sort();
    codes.dedup();
    Some(codes)
}

#[cfg(not(target_os = "macos"))]
pub fn system_languages(_: &[u8], _: u32) -> Option<Vec<String>> {
    None
}

// ------------------------------------------------------------------------------------ cache

type Key = (String, u32, i64, i64);

static CACHE: Mutex<Vec<(Key, Arc<FontFacts>)>> = Mutex::new(Vec::new());

fn key(row: &FaceRow) -> Key {
    (row.path.clone(), row.face_index, row.file_size, row.mtime)
}

fn cached(key: &Key) -> Option<Arc<FontFacts>> {
    let mut cache = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    let at = cache.iter().position(|(k, _)| k == key)?;
    // Most recently used last.
    let hit = cache.remove(at);
    let facts = hit.1.clone();
    cache.push(hit);
    Some(facts)
}

fn remember(key: Key, facts: Arc<FontFacts>) {
    let mut cache = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    cache.retain(|(k, _)| k != &key);
    cache.push((key, facts));
    if cache.len() > CACHE_SIZE {
        cache.remove(0);
    }
}

/// The facts of one face, from the cache or its file. A file that can't be read now isn't
/// remembered, so the next ask tries again (an online-only file may have downloaded since).
pub fn facts_for(row: &FaceRow, read: impl FnOnce(&[u8], u32) -> Result<FontFacts, Unreadable>) -> Result<Arc<FontFacts>, Unreadable> {
    let key = key(row);
    if let Some(hit) = cached(&key) {
        return Ok(hit);
    }
    let data = preview::read_file(&row.path, Some(row.stamp()))?;
    let facts = Arc::new(read(&data, row.face_index)?);
    remember(key, facts.clone());
    Ok(facts)
}

/// The answer for one font id. Reads its file, so run it on a reader thread (`Readers`), which
/// fails fast on online-only files.
pub fn answer(state: &AppState, font_id: i64) -> AppResult<FactsAnswer> {
    let (row, last_turned_on) = {
        let conn = state.conn()?;
        let row = preview::face_row_by_id(&conn, font_id)?.ok_or_else(|| AppError::NotFound(format!("font {font_id}")))?;
        (row, crate::activation::last_turned_on(&conn, font_id)?)
    };
    Ok(match facts_for(&row, read_facts) {
        Ok(facts) => FactsAnswer { facts: Some((*facts).clone()), unread: None, message: None, last_turned_on },
        Err(why) => FactsAnswer { facts: None, unread: Some(why.kind()), message: Some(details_message(&why)), last_turned_on },
    })
}

/// Why the details can't be shown, in words for the font page.
pub fn details_message(why: &Unreadable) -> String {
    match why {
        Unreadable::Cloud => "This file is online-only. Its details show once your cloud drive downloads it.".into(),
        Unreadable::TooLarge => "This file is too large to read its details.".into(),
        other => other.message(),
    }
}
