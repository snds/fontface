//! Finder tags and Font Book collections (macOS only).
//!
//! Both use documented Apple APIs: NSURL's tag names resource key for Finder tags, and
//! NSFontCollection for Font Book. Fontface never parses or edits the files behind them
//! (extended attributes, `.collection` files).
//!
//! Windows plan: Windows has no Finder tags or Font Book collections. File Explorer's closest
//! idea, "Tags" in a file's properties, only exists for some file types and not for fonts, so
//! these stay macOS-only.

use std::collections::BTreeSet;

use objc2::{
    rc::{autoreleasepool, Retained},
    runtime::AnyObject,
};
use objc2_app_kit::{
    NSFontCollection, NSFontCollectionVisibility, NSFontDescriptor, NSFontFamilyAttribute, NSFontNameAttribute,
};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSString, NSURLTagNamesKey, NSURL};

use super::import::{Source, SourceFont, SourceTag};
use crate::error::{AppError, AppResult};

fn ns_error(e: Retained<NSError>) -> AppError {
    AppError::Other(e.localizedDescription().to_string())
}

fn strings(value: Retained<AnyObject>) -> Vec<String> {
    let Ok(array) = value.downcast::<NSArray>() else { return vec![] };
    array.iter().filter_map(|v| v.downcast::<NSString>().ok()).map(|s| s.to_string()).collect()
}

// ------------------------------------------------------------------------------ Finder tags

/// The Finder tags on a file (names only; Finder keeps their colors itself).
pub fn finder_tags(path: &str) -> AppResult<Vec<String>> {
    autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        let mut value: Option<Retained<AnyObject>> = None;
        // SAFETY: NSURLTagNamesKey is a constant from Foundation; its value is an array of strings.
        unsafe { url.getResourceValue_forKey_error(&mut value, NSURLTagNamesKey) }.map_err(ns_error)?;
        Ok(value.map(strings).unwrap_or_default())
    })
}

/// Replaces a file's Finder tags.
pub fn set_finder_tags(path: &str, names: &[String]) -> AppResult<()> {
    autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        let names: Vec<Retained<NSString>> = names.iter().map(|n| NSString::from_str(n)).collect();
        let array = NSArray::from_retained_slice(&names);
        let value: &AnyObject = &array;
        // SAFETY: the tag names key takes an array of strings.
        unsafe { url.setResourceValue_forKey_error(Some(value), NSURLTagNamesKey) }.map_err(ns_error)
    })
}

/// Reads Finder tags from these files. Each tag becomes a Fontface tag holding the fonts in
/// the files that carry it.
pub fn finder_source<'a>(paths: impl IntoIterator<Item = &'a String>) -> Source {
    let mut by_tag: std::collections::BTreeMap<String, BTreeSet<String>> = Default::default();
    let mut failed = 0;
    let mut checked = 0;
    for path in paths {
        checked += 1;
        match finder_tags(path) {
            Ok(tags) => {
                for tag in tags {
                    by_tag.entry(tag).or_default().insert(path.clone());
                }
            }
            Err(_) => failed += 1,
        }
    }
    let mut notes = vec![format!("Checked {} font files for Finder tags.", checked)];
    if failed > 0 {
        notes.push(format!("{failed} files couldn't be read (they may be offline)."));
    }
    Source {
        label: "Finder tags".into(),
        tags: by_tag
            .into_iter()
            .map(|(name, files)| SourceTag {
                color: super::colors::for_finder_name(&name).map(str::to_string),
                name,
                fonts: files.into_iter().map(SourceFont::File).collect(),
                suggested: true,
                note: None,
            })
            .collect(),
        notes,
        ..Default::default()
    }
}

// ----------------------------------------------------------------------- Font Book collections

/// Font Book's own lists, which aren't collections the user made.
const SKIPPED: &[&str] = &["com.apple.AllFonts", "com.apple.UserFonts", "com.apple.Recents"];
const FAVORITES: &str = "com.apple.Favorites";

/// Font Book can't put `/` in a collection name, so nested tags are written with this instead.
pub const LEVEL_SEPARATOR: &str = " › ";

fn descriptor_string(d: &NSFontDescriptor, key: &NSString) -> Option<String> {
    d.objectForKey(key).and_then(|v| v.downcast::<NSString>().ok()).map(|s| s.to_string()).filter(|s| !s.is_empty())
}

/// Every collection the user made in Font Book (plus Favorites), with its fonts.
pub fn font_book_source() -> Source {
    autoreleasepool(|_| {
        let mut tags = Vec::new();
        for name in NSFontCollection::allFontCollectionNames().iter() {
            let raw = name.to_string();
            if SKIPPED.contains(&raw.as_str()) || (raw.starts_with("com.apple.") && raw != FAVORITES) {
                continue;
            }
            let Some(collection) = NSFontCollection::fontCollectionWithName(&name) else { continue };
            let mut fonts = BTreeSet::new();
            // The collection's own entries cover fonts that are off right now. They name a
            // font, or a whole family.
            for d in collection.queryDescriptors().map(|a| a.to_vec()).unwrap_or_default() {
                // SAFETY: both are AppKit constants.
                let (ps_key, family_key) = unsafe { (NSFontNameAttribute, NSFontFamilyAttribute) };
                if let Some(ps) = descriptor_string(&d, ps_key) {
                    fonts.insert(SourceFont::PostScript(ps));
                } else if let Some(family) = descriptor_string(&d, family_key) {
                    fonts.insert(SourceFont::Family(family));
                }
            }
            // What the entries match among fonts that are on right now.
            for d in collection.matchingDescriptors().map(|a| a.to_vec()).unwrap_or_default() {
                if let Some(ps) = d.postscriptName().map(|s| s.to_string()).filter(|s| !s.is_empty()) {
                    fonts.insert(SourceFont::PostScript(ps));
                }
            }
            let display = if raw == FAVORITES { "Favorites".to_string() } else { raw.replace(LEVEL_SEPARATOR, "/") };
            tags.push(SourceTag { name: display, color: None, fonts: fonts.into_iter().collect(), suggested: true, note: None });
        }
        Source {
            label: "Font Book collections".into(),
            notes: if tags.is_empty() { vec!["Font Book has no collections of yours.".into()] } else { vec![] },
            tags,
            ..Default::default()
        }
    })
}

/// Adds fonts (by PostScript name) to a Font Book collection, creating it if needed. Fonts
/// already in it stay, so nothing the user put there is lost. Returns how many were added.
pub fn add_to_collection(tag_name: &str, postscript_names: &[String]) -> AppResult<usize> {
    autoreleasepool(|_| {
        let name = NSString::from_str(&tag_name.replace('/', LEVEL_SEPARATOR));
        // SAFETY: AppKit constant.
        let ps_key = unsafe { NSFontNameAttribute };
        let mut descriptors: Vec<Retained<NSFontDescriptor>> = Vec::new();
        let mut have = BTreeSet::new();
        if let Some(existing) = NSFontCollection::fontCollectionWithName_visibility(&name, NSFontCollectionVisibility::User) {
            for d in existing.queryDescriptors().map(|a| a.to_vec()).unwrap_or_default() {
                if let Some(ps) = descriptor_string(&d, ps_key) {
                    have.insert(ps);
                }
                descriptors.push(d);
            }
        }
        let mut added = 0;
        for ps in postscript_names {
            if !have.insert(ps.clone()) {
                continue;
            }
            let value = NSString::from_str(ps);
            let object: &AnyObject = &value;
            let attributes = NSDictionary::from_slices(&[ps_key], &[object]);
            // SAFETY: the name attribute takes a string.
            descriptors.push(unsafe { NSFontDescriptor::fontDescriptorWithFontAttributes(Some(&attributes)) });
            added += 1;
        }
        if added == 0 {
            return Ok(0);
        }
        let collection = NSFontCollection::fontCollectionWithDescriptors(&NSArray::from_retained_slice(&descriptors));
        NSFontCollection::showFontCollection_withName_visibility_error(&collection, &name, NSFontCollectionVisibility::User)
            .map_err(ns_error)?;
        Ok(added)
    })
}
