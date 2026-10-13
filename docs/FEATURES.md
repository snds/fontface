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
| Rescan all folders at launch | ✅ | ⬜ | Quiet unless something changed; can be turned off in Settings |
| Switches show the real OS state | ✅ | ⬜ | Reflects fonts turned on/off by other apps (e.g. Typeface); refreshed when the window regains focus |
| On/off results confirmed with macOS | ✅ | ⬜ | Explains when another app or Font Book keeps a font on/off |
| Duplicate copies shown as one style | ✅ | ⬜ | "×N" badge; turning on registers one preferred copy, turning off covers all copies |
| Online-only files never stall a scan | ✅ | ⬜ | Fast readers skip them instantly; 3 background downloaders fetch them |
| Group by family, expand to styles | ✅ | ⬜ | Representative face = closest to Regular |
| Custom preview text + size | ✅ | ⬜ | An icon shows when the typed text uses characters the font doesn't have ("Not in this font: …") |
| Previews for symbol, icon, Expert and script fonts | 🟡 | ⬜ | A font that can't draw its name shows its name tidied (™ dropped, "-" as a space) or in capitals or lowercase, its own sample text, or a run of its real characters with a quiet badge: Symbols, Expert set, the script's name, or Partial set. Expert sets are found by their shared placeholder shape, empty letter slots or Expert glyph names, plus "Expert"/"Exp" in a name. Families show a style that can draw its name. Worked out by the scanner, once in the background for fonts scanned before, and on demand; online-only and Adobe files are never read for it. Not yet checked in the running app |
| Previews never clipped; baselines line up | 🟡 | ⬜ | Tall fonts (LI Glyphs, Zapfino, Christiana) are fitted into the row instead of cut off: moved, and shrunk (to half size at most) only when taller than the row. Baselines sit at the same height from row to row. Also in the Google Fonts and Adobe Fonts lists. Not yet checked in the running app |
| Lazy preview loading (large libraries) | ✅ | ⬜ | Virtualized list; faces load only when on screen |
| Collection faces preview individually | ✅ | ⬜ | Face is extracted from the .ttc in Rust |
| Activate / deactivate a style or family | ✅ | ⬜ | Persistent by default: stays on after quit and restart. Temporary mode in Settings |
| Activation survives app not running | ✅ | ⬜ | CoreText persistent user scope |
| Re-apply activations at launch and after scans | ✅ | ⬜ | Keeps intent if a file is only temporarily unreachable |
| Detail panel: waterfall, characters, metadata | ✅ | ⬜ | The waterfall shows the pangram only when the font has its letters (else its own text), and grows a row instead of clipping tall ink. "Character set" in the info section |
| Characters grid | 🟡 | ⬜ | Every real character of the font, by Unicode block (the biggest block first), with a summary line ("166 characters, all in Private Use Area …", "Expert set: 60 real characters; 175 slots share one placeholder (hidden)"). Hover shows the code point and glyph name; click or Enter copies the character. Arrow keys move between cells. 512 per block, then "Show all". Not yet checked in the running app |
| Variable font axis sliders | ✅ | ⬜ | |
| Search by family / style / PostScript name | ✅ | ⬜ | |
| Show in Finder / Explorer | ✅ | ⬜ | |

## Views and services (2026-10-12)

| Feature | macOS | Windows | Notes |
|---|---|---|---|
| All Fonts view | ✅ | ⬜ | Everything Fontface knows about |
| Font Book view (Windows: "Windows Fonts") | ✅ | ⬜ | OS-installed fonts; the three macOS font folders nested under it |
| Active / Inactive filter on any view | ✅ | ⬜ | Toolbar segments |
| Variable filter on any view | ✅ | ⬜ | Toolbar toggle: lists only variable styles, and only the families that have one; combines with All / Active / Inactive and search, and the counts follow it |
| Seamless top bar | 🟡 | n/a | No separate title bar: the window buttons sit in the sidebar's top strip, and the 52px top row (toolbar, page headers, detail header) moves the window, also while a dialog is open. Double-click does what macOS's "Double-click a window's title bar" setting says (zoom, minimize or nothing). Full screen drops the strip. Windows keeps its native frame. Not yet checked in the running app |
| Toolbar fits narrow windows | 🟡 | ⬜ | As the toolbar narrows (say a font is selected at the default window size), the count goes first, then Variable shows only its icon and the size slider shortens, then the preview text box and the slider go. Search always keeps room to type |
| Google Fonts: browse, download, update, remove | ✅ | ⬜ | Keyless: Fontsource catalog + google/fonts repo files; downloads go to a managed folder and are turned on |
| Adobe Fonts: list fonts Creative Cloud turned on | ✅ | ⬜ | Read-only by design (Adobe's terms); links to Adobe; untested with CC installed |
| Font Book: deactivated fonts, collections, Apple downloadable fonts | ⬜ | ⬜ | See INTEGRATIONS.md §2 |
| Purchases watcher (MyFonts, Fontspring, …) | ✅ | ⬜ | Watches Downloads (or chosen folders); a file, zip or unzipped folder counts as one download; store from the download's origin; copies desktop fonts + licenses into a managed folder; Subscription badge and "subscription ended" removal; a trial badge; manual import of zips/folders; fonts recognised by content, so a download tidied into a subfolder isn't offered again; single files of one family share a folder |
| Purchases: trial reminder after 30 days, "License transferred" status | ✅ | ⬜ | Reminder on the Purchases page with "Remove" and "I bought it" (clears the trial flag, also after a Replace); "License transferred…" turns the fonts off, removes the copy and never offers that download again |
| Purchases: "newer version available" offer | ✅ | ⬜ | "Replace" instead of "Add to library" when a download has the same store, the purchase's families and some of its fonts (by PostScript name) in different files. Version numbers aren't compared |
| Open fonts catalog (Fontsource, Noto, Nerd Fonts, open foundries) | ⬜ | ⬜ | INTEGRATIONS.md §3.4 |
| "Managed by" badges for Monotype Fonts, Connect, Fontstand | ⬜ | ⬜ | INTEGRATIONS.md §3.5 |

## Settings (2026-10-12)

Settings open inside the main window, over the library (Fontface › Settings… in the menu bar,
Cmd+, or the gear at the bottom of the sidebar; Esc goes back). Cmd+, does nothing while a dialog
or menu is open, or while you're dragging fonts or a tag. The sidebar lists the sections, the main column shows one section or
search results from all of them, and every change saves at once. Not yet checked in the running app.

| Feature | macOS | Windows | Notes |
|---|---|---|---|
| Settings screen: sections, search, keyboard | 🟡 | ⬜ | General, Library, Sidebar, Activation, Purchases, Backups, About. Search matches labels, descriptions and extra words (including choice and button words, e.g. "log out" or "Finder"). The library stays as it was underneath. The last section opened is remembered while Fontface runs. In a text box, Esc first leaves the box (which saves it) |
| Appearance: System / Light / Dark | 🟡 | ⬜ | Applies at once, to the window's own buttons too; System follows the OS live. The last choice is applied before the first paint (a small script in index.html), so launch doesn't flash |
| Default preview text and size | 🟡 | ⬜ | Used at launch; changing them also changes the current preview |
| Open where you left off | 🟡 | ⬜ | The view plus All / Active / Inactive and Variable; a folder, subfolder or hidden section that's gone opens All Fonts |
| Open at login | 🟡 | n/a | A LaunchAgent; hidden on Windows for now |
| Keep running when the window is closed | 🟡 | n/a | Click the Dock icon to bring the window back |
| Check folders for changes when Fontface opens | 🟡 | ⬜ | When off, only folders with no fonts yet are scanned |
| Show installed fonts in All Fonts | 🟡 | ⬜ | When off, All Fonts leaves out fonts that are only in the OS font folders (including ones the user installed); a font with a copy in one of their folders stays. Font Book still lists them; the All Fonts count follows |
| Show or hide sidebar sections | 🟡 | ⬜ | Font Book (with its folders), Google Fonts, Adobe Fonts, Purchases, Tags, and Built-in tags (inside Tags; off while Tags is off). All Fonts and folders always show. A view whose section is hidden goes to All Fonts. Hidden built-in tags still exist, still show on fonts and still appear in tag menus |
| Turn fonts on until logout or restart (temporary) | 🟡 | ⬜ | Applies to fonts turned on afterwards; optional "turn them off when Fontface quits". Updating a Google family or replacing a purchase keeps each font on the way it was |
| Fonts turned off while Fontface was closed: turn back on / ask / leave off | 🟡 | ⬜ | "Ask me" shows a toast at launch with "Turn back on" and "Keep off". Swiping it away asks again next launch |
| Turn off all fonts Fontface turned on | 🟡 | ⬜ | Asks first, with the number of font files on now, and how many more are set to come back on (e.g. on a drive that isn't connected) |
| Watch for font purchases (mirrors the Purchases page) | 🟡 | ⬜ | Shows the watched folders and any problem with each; "Open Purchases" goes to the page, which shows the change |
| Daily tag backups, number to keep, Back up now, Restore | 🟡 | ⬜ | Restore names the backup and opens its preview. "Add to my tags" brings its tags back next to yours; "Replace my tags" puts tags and location colors back as they were in the backup (tags made since are deleted). Font files aren't included |
| About: version, app data folder, reset all settings | 🟡 | ⬜ | Reset asks first. It leaves sync and watching for purchases as they are |

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
| Tag groups: My tags, and Built-in (Font Book's starter collections, Typeface's "Style" tags), each under a heading that opens and closes; move tags between them from the menu or by dragging onto a heading; groups kept in exports and backups. Not yet checked in the running app | 🟡 | ⬜ |
| Search matches tag names | ✅ | ⬜ |
| Location colors (Font Book, services, folders, subfolders), with defaults by source | ✅ | ⬜ |
| Subfolder tree under each folder, each subfolder a view | ✅ | ⬜ |
| Collections (manual) | ⬜ | ⬜ |
| Smart collections (rule-based) | ⬜ | ⬜ |
| Activate / deactivate a whole collection | ⬜ | ⬜ |
| Favorites | ⬜ | ⬜ |
| Filters: classification, weight, width, mono (variable: see Views) | ⬜ | ⬜ |
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
| Full glyph grid with Unicode info | 🟡 | ⬜ |
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
| Launch at login | 🟡 | ⬜ |
| Auto-activate fonts a design file needs | ⬜ | ⬜ |
| Sync tags and on/off choices between computers | 🟡 | ⬜ |

## Sync (2026-10-12)

Through a folder another app keeps in sync. Details in [SYNC.md](SYNC.md). Covered by tests
with two and three simulated computers; not yet checked in the running app.

| Feature | macOS | Windows | Notes |
|---|---|---|---|
| Choose a sync folder (iCloud Drive, Dropbox, OneDrive, Google Drive, Syncthing, Nextcloud, rclone) | 🟡 | ⬜ | Settings › Sync. Each computer writes only its own folder inside `Fontface Sync` |
| Tags, nesting, colors, groups (My tags / Built-in) and tags on fonts sync | 🟡 | ⬜ | Renames and moves carry over; tags with the same name merge; a group follows its top-level tag, and the one-time sort into groups isn't shared; fonts without a PostScript name don't sync |
| Which fonts are on syncs | 🟡 | ⬜ | Each computer turns on its own copy; fonts it lacks are listed and turn on when they arrive |
| On this Mac: Follow sync / Always on here / Never on here | 🟡 | ⬜ | In a font's right-click menu. Device groups are in the data; no menu for group exceptions yet |
| Status: last sync, other computers, problems, Sync Now, Turn Off Sync | 🟡 | ⬜ | Suggests keeping a cloud sync folder downloaded |
| Safe with half-synced, conflicted or newer-version files | 🟡 | ⬜ | Skipped and retried; newer versions are refused in plain words |
| Copied app data gets its own device id | 🟡 | ⬜ | Hardware id hash (`IOPlatformUUID`; Windows `MachineGuid`) |
| Direct connections (WebDAV, S3, Google Drive, OneDrive, Dropbox, iCloud) | ⬜ | ⬜ | Behind the `Transport` interface; planned with Apache OpenDAL |
| Encrypted sync files | ⬜ | ⬜ | |

## Validation method

1. Point Fontface and Typeface at the same font folders.
2. For each checklist row, do the same action in both and compare results:
   - counts (families, styles)
   - what other apps see (TextEdit / Figma font menus)
   - behavior after restarting the app, and after restarting the Mac
3. Record any difference as a bug, with the font file that triggers it.
