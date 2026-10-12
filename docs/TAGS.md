# Tags, colors, import and export

Tags group fonts however you like: by style, by project, by where you bought them. Every tag
has a color. Library locations (Font Book, services, your folders and the folders inside them)
have colors too, so you can see at a glance where a font lives.

Code: `src-tauri/src/tags/` (storage, imports, exports) and `src/tags/` (interface).

## Using tags

- **Make a tag:** the label button in the sidebar's Tags section, or "Create" in any tag picker.
- **Tag fonts:** the tag button on a row (shown on hover), right-click a row, or the "Tag" button
  in the detail panel. A family row tags every style in the family, even ones the current view
  hides.
- **Tag many at once:** Cmd-click rows to add them to the selection, Shift-click to select a
  range, Cmd-A to select every row. A bar appears with a "Tags…" button. Escape clears it.
- **Nest tags** with `/`: "Sci-Fi/Star Trek" sits under "Sci-Fi". A tag's view shows its own
  fonts and those of every tag inside it.
- **Rename, recolor, export or delete** a tag from its "…" button or by right-clicking it.
  Renaming moves the tags inside it too. Deleting removes the tags inside it as well; the fonts
  themselves are never touched.
- **Search** matches tag names, so typing "sci-fi" finds every font tagged with it.
- Tag views work with the All / Active / Inactive filter like any other view.

## Location colors

Right-click a location in the sidebar to pick its color. "Use default color" goes back to the
default. The color tints the location's icon, and each font row shows a small dot in the color
of the places its copies live (hover for the list).

| Location | Default color | Notes |
|---|---|---|
| Font Book and the macOS font folders | Gray | The three folders follow Font Book's color unless you set their own |
| Google Fonts | Blue | Fontface's download folder |
| Adobe Fonts | Red | |
| Google Drive (`~/Library/CloudStorage/GoogleDrive-*`) | Green | Recognized from the folder's path |
| iCloud Drive (`~/Library/Mobile Documents/…`) | Sky | |
| Dropbox (`~/Library/CloudStorage/Dropbox*` or `~/Dropbox`) | Indigo | |
| OneDrive (`~/Library/CloudStorage/OneDrive*`) | Teal | |
| Box (`~/Library/CloudStorage/Box*`) | Blue | |
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

- Light mode: 3.7:1 at the lowest (amber), most above 3.8:1.
- Dark mode: 5.4:1 at the lowest (indigo).
- Chip text stays in the normal text color on a light tint of the tag color: 17:1 (light), 6:1 (dark).

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
| Kept from an import, not in the library yet | `ps:<PostScript name>` (matches any kind or slant) |

So every copy of a font shares its tags, a rescan keeps them, and a font you delete and
download again gets them back. The last form lets an import remember fonts you don't have yet:
they get their tags the moment you add them (for example, from Google Fonts).

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
  variable font itself, since it stores one row per variable file.
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
Sci-Fi tag matched completely. Fonts that don't match can be kept for later (ticked by default).

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

- `key` is the Fontface key described above. On import it's matched first; without it, the
  PostScript name (with `variable` and `italic` if present), then the first file.
- A font that isn't in the library is exported with what's known: `key`, `postscriptName`, and
  no `family`, `style` or `files`.
- `files` lists every copy. They're for people; matching never needs them.
- An import only sets location colors that aren't set yet, and never changes existing tags' colors.
- A file whose `version` is higher than 1 is refused with a request to update Fontface.

### CSV

Columns: `tag, color, postscript_name, family, style, variable, italic, file`. `variable` and
`italic` are `yes`, `no` or empty. `file` is the first copy. Quoting follows RFC 4180, with CRLF
line ends. A value starting with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading
`'`, so a spreadsheet never runs a font's name as a formula (font names come from the files).

### Typeface backup

The same layout as Typeface's format 3: `version`, `date`, `tags` (name and PostScript names),
and empty `families` and `mainFonts`. Fonts without a PostScript name are left out, and the
export says how many. Typeface hasn't been tried with it yet.

### Finder tags

- Writes through `NSURL setResourceValue:forKey:` with `NSURLTagNamesKey`.
- Tags already on a file are kept; Fontface only adds. A file that already has every tag is left alone.
- Nested names are written in full ("Sci-Fi/Star Trek").
- Fonts in the macOS font folders are skipped (system files, and the macOS license). Adobe Fonts
  files are never in the library, and are refused again here.

### Font Book collections

- One collection per tag, through `NSFontCollection showFontCollection:withName:visibility:error:`
  with user visibility. Nested names use " › " ("Sci-Fi › Star Trek"), because a collection name
  can't hold `/`. Importing turns " › " back into `/`.
- A collection that already exists keeps its fonts; Fontface only adds. This matters because
  Typeface and Font Book may already have collections with the same names.
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
