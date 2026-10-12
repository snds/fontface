//! The fixed color palette for tags and library locations.
//!
//! Colors are stored by name. The UI draws each one from a CSS token (`--tag-<name>`) with a
//! light and a dark value, both checked for at least 3:1 contrast against the app's backgrounds
//! (src/tags/colors.css).

/// Every color a tag or location can have, in picker order.
pub const PALETTE: &[&str] =
    &["gray", "red", "orange", "amber", "green", "teal", "sky", "blue", "indigo", "purple", "pink", "brown"];

pub fn is_valid(color: &str) -> bool {
    PALETTE.contains(&color)
}

/// The palette color with the fewest uses so far (ties go to palette order). Gray is left out:
/// it's the default for the macOS font folders, so new tags stand apart from them.
pub fn least_used<'a>(used: impl IntoIterator<Item = &'a str>) -> &'static str {
    let mut counts = vec![0usize; PALETTE.len()];
    for c in used {
        if let Some(i) = PALETTE.iter().position(|p| *p == c) {
            counts[i] += 1;
        }
    }
    let (i, _) = counts.iter().enumerate().skip(1).min_by_key(|(_, n)| **n).expect("palette has colors");
    PALETTE[i]
}

/// Finder's seven standard tag names, mapped onto the palette.
pub fn for_finder_name(name: &str) -> Option<&'static str> {
    Some(match name.to_ascii_lowercase().as_str() {
        "red" => "red",
        "orange" => "orange",
        "yellow" => "amber",
        "green" => "green",
        "blue" => "blue",
        "purple" => "purple",
        "gray" | "grey" => "gray",
        _ => return None,
    })
}
