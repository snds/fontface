//! Google's icon fonts: Material Icons and Material Symbols.
//!
//! Fontsource lists them with the other Google Fonts, but google/fonts doesn't hold them. Google
//! publishes them in a second repository, google/material-design-icons. `FAMILIES` says where
//! each family's desktop font lives there (checked 2026-10-13).
//!
//! - **License:** every family shares that repository's `LICENSE`, the Apache License 2.0. It's
//!   saved next to the fonts as `LICENSE.txt`, and an install without it is refused. Fontsource
//!   labels these families OFL-1.1, which is wrong, so the catalog shows Apache-2.0 for them.
//! - **Category:** they're always filed under Icons, whatever Fontsource says.
//! - **The static "material-symbols" entry is left out of the catalog** (`HIDDEN`). Fontsource
//!   lists it as static weights 100–700 under "monospace", but it's the same icons as Material
//!   Symbols Outlined, whose variable font covers all of those weights. Google publishes no
//!   desktop files for it on their own, so showing it would only offer a second copy of
//!   Outlined under another name. Each icon font shows once, as the file you get.
//! - **Updates:** like other Google families, by Fontsource's `lastModified`. Each file's ETag
//!   is recorded too, so an update downloads only files that changed (see `google::prepare`).
//!
//! Fontsource's own copies are web subsets, so they're never used.

use super::{urlencode_path, CatalogFamily, Source};

/// Raw files of google/material-design-icons (its default branch is `master`).
pub const REPO_RAW: &str = "https://raw.githubusercontent.com/google/material-design-icons/master";
/// Recorded as each install's source.
pub const SOURCE: &str = "google/material-design-icons";
/// The repository's license file, and the name it's saved under next to the fonts.
pub const LICENSE_FILE: (&str, &str) = ("LICENSE", "LICENSE.txt");
/// The license of every icon family (SPDX id, as the catalog shows licenses).
pub const LICENSE_ID: &str = "Apache-2.0";
pub const CATEGORY: &str = "icons";

pub struct IconFamily {
    /// Fontsource's catalog id.
    pub id: &'static str,
    /// The family name inside the font file (the tests check it).
    #[cfg_attr(not(test), allow(dead_code))]
    pub family: &'static str,
    /// Each font: its folder in the repository, and its file name (also the saved name).
    pub files: &'static [(&'static str, &'static str)],
}

pub const FAMILIES: &[IconFamily] = &[
    IconFamily { id: "material-icons", family: "Material Icons", files: &[("font", "MaterialIcons-Regular.ttf")] },
    IconFamily {
        id: "material-icons-outlined",
        family: "Material Icons Outlined",
        files: &[("font", "MaterialIconsOutlined-Regular.otf")],
    },
    IconFamily { id: "material-icons-round", family: "Material Icons Round", files: &[("font", "MaterialIconsRound-Regular.otf")] },
    IconFamily { id: "material-icons-sharp", family: "Material Icons Sharp", files: &[("font", "MaterialIconsSharp-Regular.otf")] },
    IconFamily {
        id: "material-icons-two-tone",
        family: "Material Icons Two Tone",
        files: &[("font", "MaterialIconsTwoTone-Regular.otf")],
    },
    IconFamily {
        id: "material-symbols-outlined",
        family: "Material Symbols Outlined",
        files: &[("variablefont", "MaterialSymbolsOutlined[FILL,GRAD,opsz,wght].ttf")],
    },
    IconFamily {
        id: "material-symbols-rounded",
        family: "Material Symbols Rounded",
        files: &[("variablefont", "MaterialSymbolsRounded[FILL,GRAD,opsz,wght].ttf")],
    },
    IconFamily {
        id: "material-symbols-sharp",
        family: "Material Symbols Sharp",
        files: &[("variablefont", "MaterialSymbolsSharp[FILL,GRAD,opsz,wght].ttf")],
    },
];

/// Catalog ids left out of the catalog: the static "material-symbols" (see the notes above).
pub const HIDDEN: &[&str] = &["material-symbols"];

pub fn lookup(id: &str) -> Option<&'static IconFamily> {
    FAMILIES.iter().find(|f| f.id == id)
}

pub fn hidden(id: &str) -> bool {
    HIDDEN.contains(&id)
}

/// An icon font, by Fontsource's category or by name, whether or not it's in `FAMILIES`.
pub fn looks_like_icons(f: &CatalogFamily) -> bool {
    f.category == CATEGORY || f.id.starts_with("material-icons") || f.id.starts_with("material-symbols")
}

/// A family in `FAMILIES` with its real license, filed under Icons. Others pass through.
pub fn corrected(mut f: CatalogFamily) -> CatalogFamily {
    if lookup(&f.id).is_some() {
        f.license = LICENSE_ID.to_string();
        f.category = CATEGORY.to_string();
    }
    f
}

/// Where a family's files come from.
pub(super) fn source(icon: &IconFamily) -> Source {
    let (license, saved_as) = LICENSE_FILE;
    Source {
        label: SOURCE.to_string(),
        fonts: icon
            .files
            .iter()
            .map(|(dir, name)| (name.to_string(), format!("{REPO_RAW}/{dir}/{}", urlencode_path(name))))
            .collect(),
        licenses: vec![(saved_as.to_string(), format!("{REPO_RAW}/{license}"))],
    }
}
