# Tags, colors, import and export

Tags group fonts however you like: by style, by project, by where you bought them. Every tag
has a color. Library locations (Font Book, services, your folders and the folders inside them)
have colors too, so you can see at a glance where a font lives.

Code: `src-tauri/src/tags/` (storage, imports, exports) and `src/tags/` (interface).

## Using tags

- **Make a tag:** the "+" (New tag) button in the sidebar's Tags section, or "Create" in any tag picker.
- **Tag fonts:** the tag button on a row (shown on hover), right-click a row, or the "Tag" button
  in the detail panel. A family row tags every style in the family, even ones the current view
  hides.
- **Tag many at once:** Cmd-click rows to add them to the selection, Shift-click to select a
  range. With the list focused, Cmd-A selects every row and Escape clears the selection. A bar
  appears with a "Tags…" button. Selected rows get a bar along their left edge.
- **Keyboard:** right-click menus (rows, tags, locations) also open with Shift-F10 (fn-Shift-F10
  on most Mac keyboards) on whatever has focus, or with VoiceOver's VO-Shift-M. Rows can't take
  focus yet, so selecting a range still needs the pointer; Cmd-A then "Tags…" works from the
  keyboard.
- **Nest tags** with `/`: "Sci-Fi/Star Trek" sits under "Sci-Fi". A tag's view shows its own
  fonts and those of every tag inside it.
- **Rename, recolor, export or delete** a tag from its "…" button or by right-clicking it.
  Renaming moves the tags inside it too. Deleting removes the tags inside it as well; the fonts
  themselves are never touched.
- **Search** matches tag names, so typing "sci-fi" finds every font tagged with it.
- Tag views work with the All / Active / Inactive filter like any other view.

## Location colors

Right-click a location in the sidebar (or focus it and press Shift-F10) to pick its color.
Picking the color marked "(default)", or "Use default color", goes back to the default, so the
location follows its parent folder or Font Book again. The color tints the location's icon, and
each font row shows a small dot in the color of the places its copies live (hover for the list;
screen readers hear the places).

| Location | Default color | Notes |
|---|---|---|
| Font Book and the macOS font folders | Gray | The three folders follow Font Book's color unless you set their own |
| Google Fonts | Blue | Fontface's download folder |
| Adobe Fonts | Red | |
| Google Drive (`~/Library/CloudStorage/GoogleDrive-*`) | Green | Recognized from the folder's path |
| iCloud Drive (`~/Library/Mobile Documents/…`) | Sky | |
| Dropbox (`~/Library/CloudStorage/Dropbox*` or `~/Dropbox`) | Indigo | |
| OneDrive (`~/Library/CloudStorage/OneDrive*`) | Teal | |
| Box (`~/Library/CloudStorage/Box*`) | Pink | Box's own blue is taken by Google Fonts |
| Any other `~/Library/CloudStorage/*` | Purple | |
| Any other folder you add | Amber | Like a manila folder |

Each folder you add can be opened (the arrow before its name) to show the folders inside it,
built from where its fonts are. Each of those is a view with its own count and color. A folder
without its own color takes the color of the nearest folder above it that has one.

### The palette

Twelve colors: gray, red, orange, amber, green, teal, sky, blue, indigo, purple, pink and brown.
They're CSS tokens (`--tag-<name>` in `src/tags/colors.css`) with a light and a dark value. They
only ever color icons, dots and chip markers, never text, so they need 3:1 contrast against the
background (WCAG 1.4.11). Measured against the background, sidebar and highlight colors:

- Light mode: 3.7:1 at the lowest (amber, on the highlight color), most above 3.8:1.
- Dark mode: 5.4:1 at the lowest (indigo).
- Chip text stays in the normal text color on a light tint of the tag color: at least 15:1
  (light) and 8.9:1 (dark).

## Data model

Three tables, created by `tags::ensure_schema` at launch:

```sql
tags            (id, name UNIQUE COLLATE NOCASE, color, created_at)
tag_fonts       (tag_id → tags.id ON DELETE CASCADE, face_key, added_at)   -- one row per font and tag
location_colors (location PRIMARY KEY, color)                              -- only colors you picked
```

**Tags belong to a font, not to a file or a database row.** `face_key` is the same identity
the library list uses to group duplicate copies (`faceKey` in `src/library.ts`, `face_key` in
Rust):

| Font | Key |
|---|---|
| Has a PostScript name | `ps:<PostScript name>\|<var or static>\|<i or r>` |
| Has no PostScript name | `file:<path>#<face index>` |
| Kept from an import, not in the library yet | `ps:<PostScript name>` (matches any kind or slant), or a full key |

So every copy of a font shares its tags, a rescan keeps them, and a font you delete and
download again gets them back. Keys kept from an import let it remember fonts you don't have
yet: they get their tags the moment you add them (for example, from Google Fonts).

Known limit: a PostScript name may legally contain `|`. A font named, say, `X|var|i` would share
its key with font `X` (variable, italic). No real font does this; Fontface doesn't guard it.

**Names.** `/` nests. Names are unique ignoring letter case (`Style/Sans` and `style/sans` are
the same tag). Each level is trimmed, so " Sci-Fi / Star Trek " becomes "Sci-Fi/Star Trek".
Parents always exist as tags of their own. At most 200 characters.

**Locations** are keyed by folder path, or `fontbook` and `service:adobe`.

**Schema rule.** These tables live outside the numbered migrations in `db.rs`, and
`PRAGMA user_version` is left alone, so other features can add their own tables without
clashing. `ensure_schema` uses `CREATE TABLE IF NOT EXISTS`. Add any new column with
`tags::ensure_column`, never with a migration.

## Importing

Import tags… (the "…" button next to Tags) opens a preview first. It lists each tag, how many
styles in your library it will be on, how many are new, and how many of its fonts aren't in
the library. Nothing changes until you press Import. Running the same import again adds
nothing: tags merge by name and each font gets a tag once.

| Source | What's read | How fonts are matched | Built |
|---|---|---|---|
| Typeface backup (`.typeface-backup`) | The file you export from Typeface | PostScript name | ✅ |
| Fontface tags file (`.json`) | A file exported from Fontface | Fontface key | ✅ |
| Finder tags | Each font file's tags, through `NSURL`'s documented tag names key | The file | ✅ |
| Font Book collections | Your collections, through AppKit's `NSFontCollection` | PostScript name or family | ✅ |
| FontBase | Nothing | | ⬜ Skipped |
| RightFont | Nothing | | ⬜ Skipped |

### Typeface backups

Typeface's help describes its backup as plain JSON. Fontface reads it as data; no Typeface code
is involved. The layout below comes from the user's own backups (formats 2, 3 and 4, from 2023
to 2026):

```json
{
  "version": 4,
  "date": 1778460977.67,
  "tags": [{ "tag": { "name": "Sci-Fi/Star Trek/TNG" }, "fonts": ["Okuda", "Inter-Regular_Bold"] }],
  "families": [],
  "mainFonts": [],
  "locations": ["/Users/…/Fonts"]
}
```

- `date` is Unix seconds. `version` 2 has no `mainFonts`; 4 adds `locations`.
- `fonts` holds PostScript names. A named instance of a variable font is written
  `<variable font's PostScript name>_<instance>`, such as `Inter-Regular_Bold`. Fontface tags the
  variable font itself, since it stores one row per variable file. Only a variable font counts:
  a static `Inter-Regular` is a different style and isn't tagged.
- A name that isn't in the library is kept as is, and an instance name is also kept for the
  variable font it comes from (cut at the last `_`, upright or italic), so either arriving later
  gets the tag.
- Names over 512 characters and files over 16 MB are refused, so a damaged or hostile file
  stays cheap to read.
- Tag names nest with `/`, like Fontface's. Parent tags appear as entries of their own, often
  empty. Some backups spell the same tag two ways (`Style/Sans` and `style/sans`); the preview
  merges them and says so.
- `typeface/active`, `typeface/active/temporary`, `quick-collection` and
  `saved-quick-collection` are Typeface's own lists (fonts it had turned on, its quick
  collection), not tags you made. They're shown unticked.
- Custom families (`families`), family settings (`mainFonts`) and watched folders (`locations`)
  have no Fontface equivalent. The preview mentions them instead of importing them.

Real-world check (2026-10-12), the newest backup against a copy of the library: 33 tags naming
7,744 fonts. 4,881 match the library (4,202 by exact name, 679 through variable-font instances);
2,863 aren't in it, mostly Google Fonts that Typeface had downloaded itself. Every hand-made
Sci-Fi tag matched completely. Importing the 30 ticked tags tagged 4,284 different styles and
kept tags for 2,860 fonts not in the library yet ("Remember…", ticked by default). The April 2025
backup (41 tags after merging seven `style/…` and `Style/…` pairs) matches 5,347 of 8,992 fonts.

### Finder tags and Font Book

- **Finder tags** are read per file with `NSURL getResourceValue:forKey:` and
  `NSURLTagNamesKey`. A tag named after one of Finder's seven colors (Red, Orange, Yellow, Green,
  Blue, Purple, Gray) gets the matching color.
- **Font Book collections** come from `NSFontCollection allFontCollectionNames`. Font Book's own
  lists (All Fonts, User, Recents) are skipped; Favorites is kept as "Favorites". Each collection's
  own entries (`queryDescriptors`) cover fonts that are turned off; what they currently match
  (`matchingDescriptors`) covers whole families. The `.collection` files are never opened.

### Skipped sources

- **FontBase** can export collections, but the format isn't documented, and its tags can't be
  exported at all. Its developers suggest copying its private app database instead. Reading that
  would mean reverse engineering it, so Fontface doesn't.
- **RightFont** documents no export of tags or libraries.
- **Suitcase / Connect, FontAgent, Font Explorer X** keep tags in private databases. Not read.

## Exporting

Export tags… exports every tag, or (from a tag's menu) one tag and the tags inside it.

| Format | What it makes | Reads back into |
|---|---|---|
| Fontface tags file (`.json`) | Tags, colors, fonts and location colors | Fontface (Import tags…) |
| Spreadsheet (`.csv`) | One row per font and tag | Numbers, Excel, scripts |
| Typeface backup (`.typeface-backup`) | Typeface's backup layout (format 3) | Typeface (not yet tried) |
| Finder tags | Adds each tag to the font files | Finder, Spotlight, any app that reads Finder tags |
| Font Book collections | Adds a collection per tag | Font Book, and apps with a Font Book collections menu |

### Fontface tags file (format 1)

```json
{
  "format": "fontface-tags",
  "version": 1,
  "exportedAt": "2026-10-12T14:05:00Z",
  "tags": [
    {
      "name": "Sci-Fi/Star Trek",
      "color": "blue",
      "fonts": [
        {
          "key": "ps:Okuda|static|r",
          "postscriptName": "Okuda",
          "family": "Okuda",
          "style": "Regular",
          "variable": false,
          "italic": false,
          "files": ["/Users/…/Okuda.otf"]
        }
      ]
    }
  ],
  "locationColors": { "/Users/…/Fonts": "green", "fontbook": "gray" }
}
```

- `key` is the Fontface key described above. On import it's matched first. If that exact font
  isn't in the library (exported as a static font, say, and this library has the variable one),
  any font with the same PostScript name gets the tag. Without a usable key: the PostScript name
  (with `variable` and `italic` if present), then the first file.
- A font that isn't in the library is exported with what its key says: `key`, plus
  `postscriptName`, `variable` and `italic` for a PostScript key, or `files` for a file key. It
  has no `family` or `style`.
- Malformed entries (bad keys, names over 200 characters, unknown location keys) are skipped,
  and the preview says how many; they never stop the rest of the import.
- `files` lists every copy. They're for people; matching never needs them.
- An import only sets location colors that aren't set yet, and never changes existing tags' colors.
- A file whose `version` is higher than 1 is refused with a request to update Fontface.

### CSV

Columns: `tag, color, postscript_name, family, style, variable, italic, file`. `variable` and
`italic` are `yes`, `no` or empty. `file` is the first copy. Quoting follows RFC 4180, with CRLF
line ends; values with a semicolon or tab are quoted too, for spreadsheets set to split on them.
A value starting with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`, so a
spreadsheet never runs a font's name as a formula (font names come from the files).

JSON and CSV exports include each font's file paths, which contain your user name. Keep that in
mind before sharing one.

### Typeface backup

The same layout as Typeface's format 3: `version`, `date`, `tags` (name and PostScript names),
and empty `families` and `mainFonts`. Fonts without a PostScript name are left out, and the
export says how many. Typeface hasn't been tried with it yet.

### Finder tags

- Writes through `NSURL setResourceValue:forKey:` with `NSURLTagNamesKey`.
- Tags already on a file are kept; Fontface only adds. A file that already has every tag is left alone.
- Nested names are written in full ("Sci-Fi/Star Trek").
- Fonts in the macOS font folders (`~/Library/Fonts`, `/Library/Fonts`, `/System/Library/Fonts`)
  are skipped: Fontface never changes those folders, which belong to the OS and Font Book. The
  check uses where each file really is (following links), not just which library folder listed it.
- Adobe Fonts files are never in the library, and are refused again here, also after following links.
- Files in cloud folders (Google Drive, iCloud, Dropbox) sync their Finder tags to that service.

### Font Book collections

- One collection per tag, through `NSFontCollection showFontCollection:withName:visibility:error:`
  with user visibility. Nested names use " › " ("Sci-Fi › Star Trek"), because a collection name
  can't hold `/`. Importing turns " › " back into `/`.
- A collection that already exists keeps everything in it (fonts, whole families, exclusions);
  Fontface only adds, with `NSMutableFontCollection addQueryForDescriptors:`. This matters because
  Typeface and Font Book may already have collections with the same names.
- An existing collection is found ignoring letter case and how accented letters are stored
  ("fun" adds to "Fun"), because Font Book keeps collections as files and file names ignore both.
- A collection that exists but can't be read is left alone and reported. Names starting with
  `com.apple.` are refused; they're Font Book's own. A tag called "Favorites" becomes a collection
  of that name, not Font Book's built-in Favorites.
- Entries are PostScript names, so Font Book only lists fonts that are turned on, and fonts
  without a PostScript name can't be added.

## Windows plan

- Tags, colors, JSON, CSV and Typeface backups are cross-platform already.
- Location defaults need Windows paths: OneDrive (`%USERPROFILE%\OneDrive*`), Google Drive
  (a drive letter, `My Drive`), iCloud (`%USERPROFILE%\iCloudDrive`), Dropbox (`info.json`).
- Windows has no Finder tags or Font Book collections. Explorer's "Tags" property exists only for
  some file types, not fonts. Those two imports and exports stay macOS-only and say so.

## Tests

`cargo test tags::` covers the schema, names, nesting, renames, deletes, keys that survive
rescans, imports (Typeface formats 2–4 from synthetic files, merging, re-runs, unmatched fonts,
files and families), JSON round trips, CSV quoting, Typeface export, the Finder plan and Finder
tags on a temporary file.

Two tests only read real data and run on request:

```bash
cd src-tauri && cargo test font_book_collections -- --ignored --nocapture
cd src-tauri && FONTFACE_TYPEFACE_BACKUP=~/path/to/backup.typeface-backup FONTFACE_LIBRARY_COPY=/path/to/copy.sqlite3 cargo test real_typeface_backup -- --ignored --nocapture
```

Sources: [Typeface tag backups](https://typefaceapp.com/help/troubleshooting/backups) ·
[NSURLTagNamesKey](https://developer.apple.com/documentation/foundation/urlresourcekey/tagnameskey) ·
[NSFontCollection](https://developer.apple.com/documentation/appkit/nsfontcollection) ·
[FontBase on exporting tags](https://forum.fontba.se/t/export-import-font-collection-with-tagsd/266) ·
[RightFont docs](https://rightfontapp.com/docs) ·
[OWASP CSV injection](https://owasp.org/www-community/attacks/CSV_Injection)
