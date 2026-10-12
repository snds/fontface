# Feature plan and parity checklist

"Parity" means: the feature works the way a font manager user expects, checked against
Typeface's *public* feature list and docs. No Typeface code or binaries are used.

Status: ✅ done · 🟡 partial · ⬜ not started. Each item gets checked on macOS first, then Windows.

## Phase 1: Library, previews, activation (current)

| Feature | macOS | Windows | Notes |
|---|---|---|---|
| Add / remove watched folders | ✅ | ⬜ | Nested folders are refused; parent folders absorb children |
| macOS font folders added automatically | ✅ | ⬜ | ~/Library/Fonts, /Library/Fonts, /System/Library/Fonts; shown as "Installed", always on |
| Scan .ttf / .otf / .ttc / .otc | ✅ | ⬜ | Rescans skip unchanged files (size + modified time) |
| Scan progress, per-folder spinner, Cancel | ✅ | ⬜ | Progress during discovery and reading; fonts appear while scanning |
| Online-only cloud files (Google Drive, iCloud) | ✅ | ⬜ | Detected; read 8 at a time so downloads overlap; count shown |
| Unreachable folder never wipes the library | ✅ | ⬜ | Removal only after a complete walk |
| Rescan all folders at launch | ✅ | ⬜ | Quiet unless something changed |
| Switches show the real OS state | ✅ | ⬜ | Reflects fonts turned on/off by other apps (e.g. Typeface); refreshed when the window regains focus |
| On/off results confirmed with macOS | ✅ | ⬜ | Explains when another app or Font Book keeps a font on/off |
| Duplicate copies shown as one style | ✅ | ⬜ | "×N" badge; turning on registers one preferred copy, turning off covers all copies |
| Online-only files never stall a scan | ✅ | ⬜ | Fast readers skip them instantly; 3 background downloaders fetch them |
| Group by family, expand to styles | ✅ | ⬜ | Representative face = closest to Regular |
| Custom preview text + size | ✅ | ⬜ | |
| Lazy preview loading (large libraries) | ✅ | ⬜ | Virtualized list; faces load only when on screen |
| Collection faces preview individually | ✅ | ⬜ | Face is extracted from the .ttc in Rust |
| Activate / deactivate a style or family | ✅ | ⬜ | Persistent: stays on after quit and restart |
| Activation survives app not running | ✅ | ⬜ | CoreText persistent user scope |
| Re-apply activations at launch and after scans | ✅ | ⬜ | Keeps intent if a file is only temporarily unreachable |
| Detail panel: waterfall, characters, metadata | ✅ | ⬜ | |
| Variable font axis sliders | ✅ | ⬜ | |
| Search by family / style / PostScript name | ✅ | ⬜ | |
| Show in Finder / Explorer | ✅ | ⬜ | |

## Views and services (2026-10-12)

| Feature | macOS | Windows | Notes |
|---|---|---|---|
| All Fonts view | ✅ | ⬜ | Everything Fontface knows about |
| Font Book view (Windows: "Windows Fonts") | ✅ | ⬜ | OS-installed fonts; the three macOS font folders nested under it |
| Active / Inactive filter on any view | ✅ | ⬜ | Toolbar segments |
| Google Fonts: browse, download, update, remove | ✅ | ⬜ | Keyless: Fontsource catalog + google/fonts repo files; downloads go to a managed folder and are turned on |
| Adobe Fonts: list fonts Creative Cloud turned on | ✅ | ⬜ | Read-only by design (Adobe's terms); links to Adobe; untested with CC installed |
| Font Book: deactivated fonts, collections, Apple downloadable fonts | ⬜ | ⬜ | See INTEGRATIONS.md §2 |
| Purchases watcher (MyFonts, Fontspring, …) | ⬜ | ⬜ | INTEGRATIONS.md §3.3 |
| Open fonts catalog (Fontsource, Noto, Nerd Fonts, open foundries) | ⬜ | ⬜ | INTEGRATIONS.md §3.4 |
| "Managed by" badges for Monotype Fonts, Connect, Fontstand | ⬜ | ⬜ | INTEGRATIONS.md §3.5 |

## Phase 1.5: More formats

Sean's library also holds ~1,100 PostScript Type 1 files (.pfb/.pfm), plus WOFF/WOFF2 and EOT
files. These are currently skipped. Tested on macOS 27.0.1 (2026-10-12) with real and generated samples:

| Format | CoreText can activate? | Plan |
|---|---|---|
| .otc | Yes | ✅ already scanned |
| WOFF / WOFF2 | Yes | ⬜ add: needs a WOFF/WOFF2 decoder for metadata (ttf-parser reads raw sfnt only) |
| .dfont with a FOND resource | Yes | ⬜ add: needs a resource-fork reader for metadata |
| .dfont without FOND | No (error 103) | Skip |
| PostScript Type 1 (.pfb/.pfm, LWFN) | No (103 / -50) | Can't be activated on current macOS; list as "unsupported" so it's not silent |
| .eot | No (103) | Skip |
| Report skipped formats in the scan summary | | ⬜ |

## Phase 2: Organizing

Tags, colors, import and export are described in [TAGS.md](TAGS.md).

| Feature | macOS | Windows |
|---|---|---|
| Tags (add, rename, color, delete, nest with "/") | ✅ | ⬜ |
| Tag a style, a whole family, or many selected rows at once | ✅ | ⬜ |
| Tags survive rescans and duplicates (kept by PostScript name, not by file) | ✅ | ⬜ |
| Tag views in the sidebar, with counts; combine with All / Active / Inactive | ✅ | ⬜ |
| Search matches tag names | ✅ | ⬜ |
| Location colors (Font Book, services, folders, subfolders), with defaults by source | ✅ | ⬜ |
| Subfolder tree under each folder, each subfolder a view | ✅ | ⬜ |
| Collections (manual) | ⬜ | ⬜ |
| Smart collections (rule-based) | ⬜ | ⬜ |
| Activate / deactivate a whole collection | ⬜ | ⬜ |
| Favorites | ⬜ | ⬜ |
| Filters: classification, weight, width, mono, variable | ⬜ | ⬜ |
| Sort options | ⬜ | ⬜ |
| Live folder watching (no manual rescan) | ⬜ | ⬜ |
| Grid view (tiles) alongside list view | ⬜ | ⬜ |

## Phase 3: Inspecting

| Feature | macOS | Windows |
|---|---|---|
| Duplicate detection (same PostScript name / same file hash) | 🟡 | ⬜ |
| Font Book-disabled installed fonts shown as off | ⬜ | n/a |
| Conflict warnings (name already active from another file) | ⬜ | ⬜ |
| Broken / unreadable file report | 🟡 | ⬜ |
| Side-by-side compare | ⬜ | ⬜ |
| Full glyph grid with Unicode info | ⬜ | ⬜ |
| OpenType feature toggles (liga, ss01…) in previews | ⬜ | ⬜ |
| Language / script coverage | ⬜ | ⬜ |

## Phase 4: Workflow

| Feature | macOS | Windows |
|---|---|---|
| Import tags from a Typeface backup (preview first, safe to re-run) | ✅ | ⬜ |
| Import Finder tags and Font Book collections | ✅ | n/a |
| Export / import tags (Fontface JSON) | ✅ | ⬜ |
| Export tags as CSV or a Typeface backup | ✅ | ⬜ |
| Export tags as Finder tags or Font Book collections | ✅ | n/a |
| Export / import the rest of the library (folders, on/off choices) | ⬜ | ⬜ |
| Menu bar quick toggle | ⬜ | ⬜ |
| Launch at login | ⬜ | ⬜ |
| Auto-activate fonts a design file needs | ⬜ | ⬜ |
| Sync library between machines | ⬜ | ⬜ |

## Validation method

1. Point Fontface and Typeface at the same font folders.
2. For each checklist row, do the same action in both and compare results:
   - counts (families, styles)
   - what other apps see (TextEdit / Figma font menus)
   - behavior after restarting the app, and after restarting the Mac
3. Record any difference as a bug, with the font file that triggers it.
