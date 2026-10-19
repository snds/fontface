# Architecture

Fontface is a Tauri 2 app: a Rust back end does the real work, and a React web view draws the interface.

```
React UI (src/)                              Rust core (src-tauri/src/)
───────────────                              ──────────────────────────
App / Sidebar / LibraryPane / FontPage
   │  invoke("list_fonts" …)  ───────────▶   commands.rs   ── db.rs (SQLite, WAL)
   │  listen("scan-progress") ◀───────────     │               scanner.rs (walk + parse)
   │  FontFace("ff://localhost/<id>") ───▶   protocol.rs   ── sfnt.rs (split .ttc faces)
   │  FontFace("ff://localhost/google/…") ▶     │            ── services/google/previews.rs (cache)
   │  invoke("preview_profiles" …) ──────▶   preview/      (what previews draw; face_previews)
   │  invoke("google_preview" …) ────────▶   services/google/previews.rs ── fonts.googleapis.com,
   │                                                                       fonts.gstatic.com
                                               │
                                             activation/   ── macos.rs   (CoreText)  ✅
                                                            ─ windows.rs (GDI + HKCU) ⬜
```

## Key decisions

**The database records intent; the OS reports the truth.**
SQLite lives in the app data folder (`~/Library/Application Support/design.snds.fontface/`).
`fonts.activated` is what the user asked for. The switches show `os_active`, which comes from
`CTFontManagerCopyAvailableFontURLs`: every font file macOS has loaded right now, including ones
another app turned on or off. At launch, recorded intent the OS isn't honoring is re-applied
(or asked about, or accepted as off: see **Settings**). Files it can't reach yet, such as on a
cloud drive that hasn't mounted, are retried after their folder's next scan. Reconcile doesn't run after every scan, so it won't undo
a change made in another app while Fontface is open. It never clears intent just because a file
is missing for now.

**macOS font folders are built in.**
`~/Library/Fonts`, `/Library/Fonts` and `/System/Library/Fonts` are added automatically as
`kind = 'system'` folders. macOS loads their fonts by itself, so they show a lock with no
switch, and the folders can't be removed. The lock says why: "Part of macOS" for a copy in
`/System/Library/Fonts`, "Installed" for one in `/Library/Fonts` or `~/Library/Fonts` (worked
out in the UI from the copy's path, `fontState.lockOf`). In the sidebar the three folders are
one source, Font Book. Private UI families whose names start with `.` are skipped.

**Activation works per file, not per face.**
Operating systems register whole files. A `.ttc` with eight faces turns on or off as one unit.
The UI reflects this: toggling one face of a collection updates every face from that file.

**macOS uses CoreText's persistent user scope.**
`CTFontManagerRegisterFontsForURL(url, kCTFontManagerScopePersistent)` makes fonts available to
every app. They stay on after the app quits and after a restart, and nothing is copied into
`~/Library/Fonts`. Both calls are idempotent: "already registered" and "not registered" count as success.
The "temporary" activation mode uses session scope instead (see **Settings**).

**Previews never depend on activation.**
The web view loads font bytes through a private `ff://` URL scheme, keyed by library id. It can
only serve files that are in the database. Each face becomes a page-only `FontFace` named
`ff-<id>`, so an inactive font still previews. For collections, Rust extracts the single face
first, because web engines can't select a face inside a `.ttc`.

The one other `ff://` path is `ff://localhost/google/<id>/<token>/<kind>` (Windows:
`http://ff.localhost/…`; `convertFileSrc` encodes its slashes, and Rust decodes them). It serves
a Google Fonts online preview already saved in the preview cache, and nothing else: the id must
be a family in the saved catalog, the token letters, digits and `-`, and the kind one of
`name`, `icons`, `script` or `alphabet`. The file must be a plain file (not a link) inside the
cache folder, at most 512 KB. Anything else, or previews turned off in Settings, is 404. It never
uses the network. It's checked before the library-id path, which works exactly as before.

**Scans are incremental, parallel, cancellable, and safe.**
A scan runs off the UI thread with its own SQLite connection (WAL mode allows this).
1. **Discover:** walk the folder and compare each file's size and modified time. Unchanged files are skipped.
2. **Read:** 8 worker threads read and parse changed files. A single writer thread commits about every 400 ms.
3. **Clean up:** forget files that are gone.

Progress events (`discovering` → `reading`) begin immediately, and the UI reloads the list
during a scan, so fonts appear while it runs. One scan per folder at a time, and each can be
cancelled. Rows are removed only after a complete walk, so an unreachable folder (cloud drive
offline, permission denied, disk unplugged) never wipes the library.

**A click never fails behind a background writer.**
Scans and the preview backfill write through their own connections. A UI write
(`AppState::write`) raises a gate they check after each file: they commit and wait until it's
done. Every transaction is IMMEDIATE (`db::open` sets it): it takes SQLite's write lock at
BEGIN, waiting in the 10 s busy timeout until the background writer has committed. A DEFERRED
transaction that reads before it writes (adding a tag checks the tag first) can't wait like
that: if another connection holds the write lock at its first write, SQLite fails it at once
with "database is locked". The scanner and the backfill begin with `BEGIN IMMEDIATE` too.

**Online-only files never stall a scan.**
A single Google Drive download was measured at 15 seconds to over 10 minutes. So the 8 reader
threads use `setiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, thread, OFF)`, which makes
reading an online-only file fail at once (EDEADLK) instead of downloading it. Those files go to 3
separate download threads. The workers are detached, so Cancel returns at once, even when a
download is stuck. A read that fails never deletes a font's rows, because they carry the user's
on/off choice. Files that hold no usable font are remembered in `skipped_files`, so they aren't
re-read and re-reported on every launch.

**Remove from Library** (`src-tauri/src/removed.rs`). A font you remove is turned off, its file's
rows are deleted, and its path goes into `removed_files` (a side table, created like the tag
tables). Every scan skips those paths, from any folder that reaches them, and asks again just
before it lists a changed file, since a removal can land while a scan is reading. Put Back marks
a path `restored`: the folder's next scan lists the file again with the `added_at` it had, then
forgets it. A scan that no longer finds a removed file forgets it, and removing its folder
cascades. Only files in your own folders can be removed (`kind = 'user'`), and a file that can't
be turned off stays listed, so nothing is left on that Fontface no longer shows. Files are never
moved or deleted. Lock order: the activation lock, then the DB mutex, as for removing a folder.

**Matching paths with the OS.**
CoreText rewrites the paths it reports: one URL per face, symlinks resolved, `/private` dropped,
and accented names decomposed (NFD). The scanner stores each file's real path (`canonicalize`),
and `available_paths()` canonicalizes CoreText's paths too, so both sides compare the same form.

**Every on/off change is serialized and checked.**
`activation::lock()` covers UI changes, scan cleanup and reconcile, so they never interleave.
After an on/off request, `set_activation` asks the OS what's actually loaded. If another app
still has the font on, it tries removing a session-scope registration, then explains the result.

**Duplicates.**
Copies of a font (same PostScript name, and both variable or both static) show as one style with
a "×N" badge. Fonts with no PostScript name are never merged. The whole library is grouped once,
and views filter whole styles, so a switch always covers every copy, not only the visible ones.
Turning on registers each font once:
- Styles already on are left alone.
- A variable font in the request covers the static styles of the same slant.
- Styles that exist only inside a collection pick the collection first, and its other styles count as covered.
- Everything else uses a single-font file.

Turning off unregisters every copy.

**The font list, and when fonts arrived.**
`list_fonts` sends every font row (12,257 in a large real library) whenever the list reloads: at
launch, during scans, after on/off changes. Besides names, style numbers, file and state, each
row carries what the Table shows: version, designer and foundry (name IDs 5, 9 and 8), glyph
count, a variable font's weight range (its `wght` axis; only variable rows' axes are read) and
`added_at`. A file Fontface turned on until logout carries `temporary: true` (from
`temporary_activations`, read under the same hold of the DB mutex as the list and marked by
`db::mark_temporary`; left out when false), and each on/off outcome (`ActivationOutcome`) says
whether its file is now on until logout (`activation::temporary_after`), so the UI shows the
mark without a reload. Copyright and license text stay out (`get_font` has them). Unknown values are left
out of the JSON rather than sent as null. The rows are sorted in Rust (`db::list_fonts`, the
same order as `ORDER BY family COLLATE NOCASE, italic, width, weight`, ties by id) rather than
in SQL, because SQLite's sorter carries every column of every row and cost more than the query
itself. Measured on a copy of that library (`list_fonts_timing` in `tests.rs`, release build,
median of 30): 37.0 ms before these fields (30.2 ms query + 6.7 ms JSON, 7.3 MB); 42.6 ms with
them and SQL's sort; 28.1 ms with them sorted in Rust (19.8 + 8.3 ms, 8.8 MB).

`fonts.added_at` (Unix seconds) is added by `db::open` itself through `tags::ensure_column`, the
way side tables add theirs, so no numbered migration: the list reads it, and the scanner,
backfills, sync and tests each open their own connection. A new row gets its scan's start
time; the scanner's update leaves it alone. Rows from before get a one-time backfill at launch
(`db::backfill_added_at`, on its own thread and connection): each file's creation date, else
its modified date, else its folder's `added_at`, never later than now. Fonts whose library
folder isn't there right now (a drive not mounted, a moved folder waiting for Locate…) are left
undated for a later launch, so they get their file's date once it can be read rather than the
folder's for good. It reads only file
metadata, so online-only files aren't downloaded, and it never looks at Creative Cloud's files.
The lookups come before any writing; the dates are saved 500 rows per transaction, in the scan
write turn and after any waiting UI write; then "added-dates" has the window reload the list.
Later launches find nothing to date (one quick query) unless a folder was out of reach. A future migration that rebuilds `fonts`
must list the column (v3's `SELECT *` would not carry it).

**Families group by name in the UI; your choices live in side tables.**
Exact family names split one family into dozens when the style is in the name ("AmintaBold",
"Aaux ProBlack Italic OSF"). The rules that put them back together are pure TypeScript
(`src/familyGroups.ts`, tested name by name in `familyGroups.test.ts`), run by `groupLibrary`
(`src/library.ts`) over the whole library on every list load, so folders play no part and
every view, count and filter sees the same families. In order: your choice for a font (by face
key), your rule for its family name (by squash key: lowercase, no spaces, hyphens,
underscores, dots, ™ or ®), grouping by name while Settings › Library › "Group families by
name" is on (style words that can merge at the end of the name, a base that exists or that two
names reduce to, and a signal: PostScript family part, foundry or designer, or weight number;
guards G1–G5), else the font's own name. Width, size and numbered words, and held-back names,
only become suggestions (`suggestGroups`), worked out when the Family groups page opens (and
counted while Settings are open), never for the list; suggestions that chain (a family that
others join, joining another) are folded into one. The work is per family name, not per face,
and name analysis, PostScript stems, style words, labels and traits are cached by string. On a
copy of Sean's library (12,257 rows, 11,047 faces, about 3,600 names, in the order `list_fonts`
sends them), in JavaScriptCore (WebKit's engine, the one the app's web view runs; the `jsc`
shell on this Mac) the first grouping after launch takes about 24 ms with empty caches and
about 20 ms after `warmUpGrouping` (App runs it, about 6 ms, on a made-up library with every
kind of name while the first list is on its way, so the code is compiled); in Node about 32
and 28 ms. Every regroup after that (each switch, each live reload during a scan) takes about
7 ms in JavaScriptCore, 10 in Node. Nothing depends on the order rows arrive in, a file's path
or which copy is on: when a face's copies carry different names of one family (`namedCopy`),
it's grouped by the one whose names agree with its PostScript name, then the more general one,
name ID 16, then A to Z; a family whose every style also has a copy with a name more of the
library carries goes by that name (`planByName`'s step 3: a per-style folder's
House-A-Rama-Kingpin is House-A-Rama's Kingpin). With "Group families by name" off, step 3
also rejoins (`rejoin`) a name whose every style has a copy named for the family grouping
would list it in (MorganAvec-BoldCaps, also "MorganAvec" Bold), and a lone style keeps a style
that has a file of its name too (Sansation Light); never into another family than grouping
gives, so the families with it off always lie inside the families with it on. A name whose
chosen name goes by another itself follows it there when its faces have that name too, else
stays under its own (FagoLf-BoldCaps, when FagoLf goes by Fago), so no style is left alone
under a name whose own styles went. Its label comes
from the copy whose names say it best (`labelFor`), and never from one whose label would name
another family (`relates`; when the font also has a copy named that family, a name with every
word of it, "ZeitgeistExpertMT-Cameo" in Zeitgeist MT, is labelled by the words it has besides:
"Expert Cameo"; a style you move keeps its own name first, "Times New Roman" in Times Roman). The copy shown and turned on (`primary`) is chosen by state,
format and date first, then the same names, and by path only between copies named alike.
Names and labels that tie ignoring case are put in code-point order. Each face carries its
`family`, its `style` label ("Black Italic"), how it got them (`groupedBy`: own, name, rule,
choice; `kept` and `ruleKey` for your rules), the name it was placed by (`name`: its own, or
the copy's it went by) and its sorting `traits`. A family's weights come
from its fonts' numbers when they tell its styles apart and from its styles' words where the
numbers are shown wrong (`familyWeightSource`). Your rule for a name applies when any of a
face's copies carries that name; a "separate" rule lists every spelling under the rule's own.
A new family made by grouping (no font of that name) keeps a style word all its names share
only when it's part of the name (`partOfName`: a plain word, a weight the fonts' numbers
contradict, or one a PostScript family part spells), so "Gotham Bold" and "Gotham Bold Italic"
are Gotham's. A width, size or numbered suggestion joins the longest name left that's a family
as the families stand (`WideName.steps`, and `Held.steps` for G2: "Times New Roman Condensed",
and "Times New Roman 2 Bold", for Times New Roman; "Gill Sans Light 2 Italic" for Gill Sans
when grouping lists Gill Sans Light there), with the outermost word as its reason
(`WideName.word`: "Condensed" for MINI 7 Condensed).

Your choices (`src-tauri/src/families.rs`) are two side tables made by `ensure_schema` at launch,
outside the numbered migrations like the tag tables: `family_overrides(face_key, family,
style, set_at)` (family NULL: keep it under its own name) and `family_rules(name_key, name,
decision 'merge'|'separate', into_family, set_at)`. They never touch a font file. Every
command (`families_merge`, `families_keep_separate`, `families_move`, `families_reset`,
`families_apply`) is one validated, all-or-nothing transaction through the UI write gate
(`AppState::write_local`: like `write`, but sync isn't woken, since these don't sync yet) and
returns the change that undoes it; `families_undo` applies such a change and returns its own
undo, so Undo and redo are the same call. Only the DB mutex is taken (no activation lock).
Tags, tag import and sync all key fonts by face key or raw names, so regrouping changes none of
them. Locate… (`tags/relocate.rs`) moves choices kept by file (`file:<path>#<face>`, fonts
without a PostScript name) to the new path in the same transaction as the tags kept by file.

The font's own names come with the list: whether it names its own grouping family
(`hasTypoFamily`: name ID 16 present and not just a copy of name ID 1; 775 of Sean's faces copy
it) and its name ID 1 where that differs. The scanner writes `fonts.typo_family`,
`legacy_family`, `legacy_style` and `names_rev` (`families::NAMES_REV`; columns added by
`ensure_column` in `db::open`). Rows from before get them once from `families::backfill_names`
at launch: two reader threads that fail fast on online-only files read only each file's header,
table directory and `name` table (`read_names`; never Creative Cloud's files), and one writer
saves them about every 400 ms in short transactions, in the scan write turn after any waiting UI
write, only where the row's size and modified time still match (a scan that rewrote it wins);
then "family-names" reloads the list. On Sean's library it read 12,257 faces in 11,927 files in
1.6 s. Until a font's names are read (online-only files), grouping treats it as not naming its
own family. The list grew from 8.8 to 9.2 MB and still takes 27.9 ms (`list_fonts_timing`).

**Changes made in other apps.**
If a font Fontface turned on was loaded earlier in the session and is then unloaded while its
file still exists, another app turned it off. That becomes the recorded choice, so the next
launch doesn't silently turn it back on. A change made while Fontface is closed can't be told
apart from macOS dropping a font before its drive mounted, so launch still re-applies it.

**Previews.**
- Installed fonts load by PostScript name (`local()`).
- Other fonts are fetched over `ff://`, 6 at a time, newest first. Rows that scroll away are dropped from the queue.
- Online-only files are never downloaded for a preview; they show "Not downloaded yet". Files over 96 MB aren't previewed.

**Google Fonts online previews: the preview cache.**
The Google Fonts page shows families that aren't downloaded in their own font
(`src-tauri/src/services/google/previews.rs`; the request details and privacy notes are in
[INTEGRATIONS.md](INTEGRATIONS.md) §3.1, "Online previews (as built)").
- **Who talks to Google.** Only the `google_preview(id, kind)` command, and only while the
  `googlePreviews` setting is on (the default). It runs on a blocking thread, never the main
  thread or an async worker. It asks Google's CSS2 API for a tiny `text=` file, downloads that
  file from `fonts.gstatic.com`, checks it parses and profiles it like a library font. The web
  view never contacts Google, so the content security policy (CSP) is unchanged: it loads the
  saved file over `ff://` (above).
- **Network plumbing** (`services/mod.rs`, `fetch_preview`). One shared `ureq` agent per host,
  keeping up to 6 idle connections (`Deadline::idle_per_host`; ureq keeps one by default), so a
  scroll's many small requests reuse connections; the proxy rules (`NO_PROXY` too) apply
  per host. A 10-second deadline, 5 to connect (`Deadline::Preview`). At most 6 preview requests
  at once, whatever the UI asks. The answer must come from the expected host. Tests never touch
  the network: `services::fake_net` answers instead, and can fail a URL with a status or as if
  offline.
- **The cache** is in the app's cache folder: `~/Library/Caches/design.snds.fontface/google-previews/`
  on macOS (Tauri's `app_cache_dir()`), never under the data folder's `Services/` (scanned and
  turned on). Layout: `<id>/<token>/<kind>.ttf`, plus `<kind>.json` (the profile, the characters
  the file holds, what a row draws and whether it's a sample) and, after a failure,
  `<kind>.fail`. `<token>` is the family's catalog `lastModified`; when it changes, the old
  folder goes, and families that leave the catalog go too (checked whenever the saved catalog
  changes). Each `.json` notes the `PREVIEW_REV` its profile was worked out with; after a bump
  the saved file is profiled again on its next use (no network) and its `.json` rewritten, and
  a "can't draw anything" failure is tried again. Writes are a temporary file and a rename; two
  requests for one family take turns. Past about 64 MB, the files used longest ago go (their
  modified time marks use, refreshed at most hourly). Failures that are the family's are
  retried after 7 days. Network trouble is never the family's: 3 failures in a row pause
  previews for 30 seconds, then twice as long for each pause in a row, up to 15 minutes; a
  download that gets through ends that (`Previews::network_trouble`, `network_fine`).
  `google_preview_cache()` reports the size and `clear_google_preview_cache()` empties it
  (and ends any pause).
- **Off limits.** `previews::is_preview_cache_path` sits next to every Adobe Fonts path check
  (scanner, database, activation, reveal, tags, named styles, relocate, preview reads, purchases
  and `ff://` by id), so the cache's files can't be scanned, listed, turned on, tagged or served
  by library id, even if the user adds their Library folder. Rows that slipped in are dropped at
  startup with the Adobe ones.

**Preview profiles: what a preview draws.**
A preview used to draw the font's name in the font itself. Icon, symbol, math, Expert and
non-Latin fonts often can't draw their own name, and WebKit fills the gaps with the system
font, so the preview showed plain text or the wrong glyphs. `src-tauri/src/preview/` works out
a small *profile* per face instead:
- **Character lookup as CoreText does it** (`font.rs`): a Unicode character map wins; a font
  with only a Microsoft Symbol (3,0) map also finds "A" at U+F041; a Mac Roman-only font is
  looked up through Mac Roman; a font with both a Symbol and a Unicode map uses only the Unicode
  one. A glyph is *real* when its id isn't 0, it has ink (an outline with area, or a COLR,
  sbix, CBDT or SVG image; sbix is read directly), and it isn't the placeholder shape. A
  glyph that outlines to nothing (a single point, as in Material Icons' letters) has no ink;
  only a variable font's glyph that won't outline counts as ink of unknown size.
- **Limits per face** (`font::limits`), so a damaged or hostile file can't stall a scan, the
  backfill or a command. The character map is read from the raw tables, not through
  ttf-parser's code point lists: format 4 segments are merged first, format 12/13 groups stop
  at U+10FFFF and take their glyph from the group, a subtable listed under many records is read
  once, codes mapped past the font's last glyph count as unmapped, and the whole face may look
  at 1,114,112 codes and keep 262,144 (planes 0–3). A glyph whose composite references expand
  past 4,096 glyphs isn't outlined, an outline is stopped after 200,000 segments, and a profile
  may take 2 s (the character grid 8 s); past a limit a glyph counts as drawn with unknown size,
  and the profile is flagged. In a release build the worst hostile character map takes under
  0.1 s; in an unoptimized test build the slowest of 12,167 real faces takes 0.2 s, file read
  included. Glyph names are read once per face (`post` names are
  otherwise found by walking the whole list each time).
- **Expert sets** keep extra characters in the letter slots, and often fill unused slots with
  one shared shape. Detection (`profile.rs`): the placeholder (one outline shared by 8+ code
  points, 5+ of them letters, in a font with 8–400 inked code points, covering under 90% of
  them), letter slots with no ink, old Expert glyph names (`Ethsmall`, `onequarter`, but not
  dotted names like `zero.oldstyle`), and the word Expert/Exp/Ep in the names or file name.
  An Expert name plus at least 3 missing letters also counts (BigCaslonExp has no placeholder,
  but draws "BigCaslon" as "ᵇIG¢ASLON").
- **The cascade**, run for the family name (family rows) and the full name (style rows), each
  keeping its own kind (`kind`, `full_kind`): the name as is; trimmed (missing ™ ® © dropped,
  missing `-` `_` as spaces); UPPER or lower case (not for icon fonts); the font's own sample
  text (name ID 19); a sample of its real characters. The sample is labelled **Symbols**,
  **Expert set**, the script name (from the `meta` table, or the biggest script) or **Partial
  set**. Symbol-only fonts go straight to the sample only when their letter keys hold pictures
  (an icon word in the name, or glyph names such as Webdings' "town"); Monica and Jedi Solid,
  plain letters in a symbol map, draw their names.
- **Icon fonts with plain letters** (Material Symbols, Google Symbols) can draw their names,
  but they are really their icons: typing "home" draws a house through a ligature. A font goes
  straight to a Symbols sample of its private-use icons only when both hold:
  - an icon word is in its names (Icons, Symbols, Glyphs, Pi …);
  - it has a big private-use icon set (`profile::pua_icons`): 200 or more real glyphs at
    private-use code points, or 20 or more ligatures (GSUB) that spell a run of 4+ letters,
    digits or `_` into one of them.

  The sample then takes its 12 icons from the private-use area only. Without an icon word, a
  big private-use set changes nothing: SF Pro keeps 8,300 symbols there, and text fonts such as
  Garamond Premier Pro put up to 44 short ligatures there (ffi, Th). Without a big set, an
  icon word keeps the cascade above (ITC Symbol is a text face). On the library this turned 10
  faces from the name to icons: the 7 Material Symbols faces, Google Symbols, Min Icon VF and
  National Code Pi Std.
- A letter that draws nothing alone but starts a ligature (Material Icons' "home") isn't listed
  as missing.
- The profile also keeps the printable ASCII characters the face can't draw, its line ascent
  and descent as CoreText uses them, and the ink of its preview text. CoreText's line metrics:
  hhea (a descender stored as positive still counts as below the baseline; a zero descender
  in a CFF font takes the font's lowest point); OS/2 typo for variable fonts with
  USE_TYPO_METRICS set (static fonts ignore the flag); OS/2 typo when hhea is all zero.
- An ignored test compares the lookup and the line metrics with CoreText's own on every face
  of the library (`coretext_agrees_across_the_library`): no differences on 12,167 faces.
- `src-tauri/scripts/gen_unicode.py` generates the Unicode block and skip tables
  (`preview/unicode.rs`) offline: Blocks.txt as macOS ships it with Perl, plus the blocks added
  in Unicode 14–16 (listed and checked in the script), and Python's `unicodedata` for categories.
- `ttf-parser`'s `gvar-alloc` feature is on: without it, outlines fail for large variable fonts
  (SF Pro, Roboto Flex), which would then look as if they couldn't draw their names.

**Where profiles live.** A side table, `face_previews`, keyed by font id (ON DELETE CASCADE),
created by `preview::ensure_schema` like the tag tables, outside the numbered migrations. A
row counts only while its file size, modified time and `rev` match the font and
`PREVIEW_REV`; `list_fonts` checks that in its LEFT JOIN, so a stale row arrives as
`preview: null`. Bumping `PREVIEW_REV` recomputes everything at the next launch.
- **The scanner** works the profile out from the face it already parsed and writes it in the
  same transaction as the font row.
- **The backfill** (`preview::backfill`, at launch) covers fonts scanned before profiles
  existed: two reader threads that fail fast on online-only files (which it skips, along with
  Creative Cloud's files and files over 96 MB), reading each collection once; one writer
  saving what they've read about every 400 ms through the scan write turn, stepping aside for
  UI writes. What's been read waits in memory between saves: no transaction stays open while
  the writer waits for the readers, so SQLite's write lock is free almost all the time. The
  turn is held from BEGIN until the COMMIT (or the ROLLBACK after an error) has run. Each
  batch goes to the UI as a `preview-profiles` event; the last one says how many profiles the
  run saved, and the list reloads only if that's more than 0 (missing and online-only files are
  looked at again every launch, and usually save nothing). It also removes orphaned rows.
- A face whose profile fails (a panic in the font code) gets its names as they are, stored like
  any other profile, so it isn't retried every launch.
- **On demand:** a row on screen whose profile is still missing asks `preview_profiles`, with
  the same safeguards. The UI keeps one call in flight with at most 64 ids, newest rows first,
  and drops rows that scrolled away before their turn (`src/previewQueue.ts`). Each row's want
  has its own token, so a row whose request already went can't drop a newer row's request for
  the same face. A call that takes longer than 3 s stops holding the queue: its rows draw their
  names (a late answer still counts) and the next call goes, so one stuck file read can't stop
  later rows getting profiles. Nothing ever downloads a cloud file or reads Creative Cloud's
  files to make a profile.
- `font_characters` works out the font page's character grid on demand (when its Characters or
  Info tab shows) and stores nothing.
- `font_facts` (`src-tauri/src/facts/`) reads what the font page shows beyond the list, when its
  OpenType, Axes or Info tab shows: the features of the face's `GSUB` and `GPOS` tables (the
  feature and script lists are read from the raw tables, since ttf-parser skips feature
  parameters, which hold stylistic sets' and character variants' own names; a sample of what
  each substitution changes follows its lookups through ttf-parser, back through the character
  map), the `fvar` named styles with their axis values (`tags/named_styles.rs`, which the tag
  import also uses), OS/2 `fsType` read as the spec says (the most permissive usage bit up to
  version 2, exactly one from version 3), name IDs 7, 10, 11, 12 and 19, and on macOS the
  languages `CTFontCopySupportedLanguages` gives for a font made from the file's data (nothing
  is registered). It never reads Creative Cloud's files, never downloads an online-only one
  (the answer says `unread: "cloud"`, and the page says "Download to see details"), and keeps
  the last 24 faces' facts in memory by path, face index, size and modified time. Every count is
  capped (2,048 records, 16 lookups per feature when read and when merged, 64 subtables per
  lookup, 200,000 glyphs looked at for one feature's sample, of which only the best 10
  characters are kept, ligatures of at most 16 glyphs, each tag's parameters read once per
  table) and the layout reading runs under
  `catch_unwind`, so a damaged table gives nothing rather than an error, and a crafted one
  can't keep the two preview readers busy. `apple_features` means a `morx` table and no `GSUB`
  features (GPOS kerning alone doesn't hide the note). The answer also carries "last turned
  on" from the library: `switch()` records it (`activation::record_turned_on`, the
  `last_turned_on` table, by face key like tags, for every font in the file) once macOS
  confirms a font this request registered is on. Sync doesn't share it.
- These commands read files on two long-lived preview reader threads (`preview::Readers`), not
  on Tauri's async workers: a slow disk or a stalled network share then can't hold up the
  other commands, such as the on/off switches. At most two reads run at once. Each command
  goes through its own latest-wins lane (`preview::Lane`): a job still queued when a newer one
  of the same command arrives is skipped when a thread takes it, reading nothing, and so is a
  job nobody waits for any more. Stepping quickly through a font page's styles then reads only
  the latest character grid, and a profile call the UI has given up on doesn't hold up the call it
  sent instead. A job that has started runs to the end; a stuck one holds only its own thread.

**Fitting previews: no clipping, aligned baselines.** A list preview is a 1.3 em box that hides
overflow (for the ellipsis), and fonts with tall ink (LI Glyphs, Zapfino, Christiana) were cut
off. `src/previewFit.ts` (pure; `npm run test:ui`) fits the text instead: with an explicit line
height L, WebKit puts the baseline (L + A − D) / 2 below the top of the line, so
L = 2B − k(A − D) puts it at B. The text shrinks (k, never below 0.5) only when its ink is
taller than the box, and B stays at 1 em below the top whenever the ink allows, so baselines
line up from row to row. Rows keep their 1.3 em height. Once the face has loaded, a shared
canvas measures the text as drawn (`previewMeasure.ts`, cached by face version and text): its
line metrics are what WebKit lays out with (they include WebKit's extra 15% ascent for
installed Times, Helvetica and Courier), and its ink includes shaping (Zapfino's swashes). For
the profile's own text the ink is the larger of the canvas's and Rust's per-glyph ink; Rust's
line metrics are the fallback when the canvas reports none. Nothing is measured before the
row's own face has loaded (`isFaceLoaded`), and a row whose font changes reads as loading at
once, so a fallback-font measurement is never taken or cached. The font page's waterfall
never shrinks: a row grows to fit the ink. The View options' preview styling keeps this
(`src/previewStyle.ts`, pure): the case is applied to the text itself (not CSS
`text-transform`), so the canvas measures what's drawn; an outline's stroke adds its half
width to the padding, and an underline (`from-font`) makes the ink reach at least 0.25 em below
the baseline (`FitExtra`). The four features every preview can have never draw outside the
plain text's ink; on the font page, OpenType switches that can (swashes, alternates, sets) add
0.2 em above and below (`openType.featureSlack`), since the canvas can't apply features. A preview (in the list and on the Google Fonts page)
stays hidden until its font has loaded and its profile is known, or 300 ms have passed; on the
font page, a face that fails to load draws in the fallback font, and the character grid then
shows only its summary.

**Purchases.**
`services/purchases.rs` and `services/purchase_watch.rs` handle font downloads.

How it works:
- The watcher uses `notify` (FSEvents on macOS) to watch folders the user picks. Downloads is the default.
- Bursts of file events are grouped for 2 seconds. Files still being written are left until their next event.
- Each font file or zip is looked at once; its size and modified time are remembered.
- The store comes from the download's origin, which macOS records in `kMDItemWhereFroms`. On Windows it's the `Zone.Identifier` stream. It's matched against a list of store domains.
- Importing copies only desktop font files and license files into `Services/Purchases/<Store>/<Family>/`. They go through a hidden temporary folder, with a `.fontface-purchase.json` file that records the store, the origin and flags. The original download stays put.
- The import folder is a library folder of kind `service`, so the normal scan and activation apply.
- An import has two steps: `prepare` copies into the hidden folder, and `place` moves it into `<Store>/<Family>/`. A single font file instead joins a folder of its family from the same store (hard-linked in, so a scan never sees half a file).
- Replace (`purchases::replace`) prepares the new version, then turns the old fonts off, then swaps. The old folder is renamed to `.replaced-<name>` while the new one moves in, and is renamed back if that fails. At startup, a leftover `.replaced-<name>` goes back if `<name>` is missing and is deleted otherwise. Turning fonts off and back on is passed in as functions, so tests run without touching the OS.
- Fonts are matched by content: each font's fingerprint (length + 64-bit hash) is kept on the find and in the sidecar, with its families and faces. `record` uses them to skip downloads whose fonts are already imported; `link_replacements` uses them to offer Replace.
- Lock order: the scan write turn, then the activation lock, then the DB mutex. File changes in the Purchases folder take turns through a separate lock that's only held for file work, never while waiting for the other three.
- `check_folders` is single-flight per library: a second caller waits for the running check and gets its result.
- Its tables come from an idempotent `ensure_schema` (no `user_version` bump), so they merge cleanly with other features.

**Cloud storage.**
Online-only files (Google Drive or iCloud via File Provider; `SF_DATALESS` in `st_flags`)
download when first read. The scanner counts them and the UI says so. Activated fonts must stay
downloaded, so keep cloud font folders set to "Available offline".

**Folders don't overlap.**
Adding a folder inside an existing one is refused. Adding a parent of existing folders absorbs
them and keeps their fonts' activation state. This guarantees each file belongs to one folder.

**Settings.**
`settings.rs` holds the app settings; the settings screen reads and changes them through
`settings_get`, `settings_update` (a partial object) and `settings_reset`.

- **Storage:** one row per setting in `app_settings` (key → JSON value), created by an
  idempotent `ensure_schema`. Missing keys take their defaults, unknown keys are ignored (so a
  key added to `AppSettings` or `SidebarSections` in src/api.ts must also get a field and an
  `apply_key` branch in `settings.rs`, or it's silently not saved), and a
  damaged row is skipped without resetting the rest. A change is checked as a whole: numbers
  are pulled into range, and a wrong value is refused in plain words and changes nothing.
  `AppState` keeps a copy, so window and quit handlers never wait on the database. The settings
  lock is taken first or alone. Every change sends `settings-changed`.
- **Activation modes:** "persistent" (the default) registers in CoreText's persistent scope.
  "Temporary" registers in session scope, which lasts until logout or restart and isn't tied
  to Fontface's process, and lists the file in `temporary_activations`. Turning a font on that's
  already on keeps the scope it has (`activation::turn_on_plan`): a temporary font turned on
  in persistent mode stays temporary, and a persistent one turned on in temporary mode stays
  persistent. Turning off removes both registrations and the list entry. With "turn off
  temporary fonts at quit", `RunEvent::Exit` turns them all off and records them as off.
- **Updates keep each font's scope:** a Google Fonts update and a purchases Replace turn the
  old files off, then the UI turns the new ones on. `activation::temporary_after_swap` decides
  which come back temporarily: a font that was temporary, and a font that's new in this
  version when everything that was on was temporary. The results list those names
  (`temporaryFiles`, `temporaryFaces`), and `set_activation` takes a `scope` ("persistent" or
  "temporary") that overrides the mode, so the rest come back to stay whatever the mode is now.
  It also takes an `origin` ("arrival" for a first download, an import, an update or a
  Replace), so sync doesn't share these as the user's choice: a font that has a choice keeps it,
  and only fonts nobody has chosen for are shared as on ([SYNC.md](SYNC.md)).
  If the swap fails, or a purchase can't be removed, each font is turned back on in the scope
  it had. A temporary font another app turns off is recorded as off and leaves the list, after
  Fontface removes its own session registration of it.
- **Launch:** `activation::launch_plan` is a pure function from what's recorded on, what's
  temporary, what's loaded and what exists, to a plan. A temporary font the OS no longer has
  means the login ended: it's recorded as off and never turned back on. For other fonts that
  were on and aren't loaded, the restore policy decides: "always" turns them back on; "ask"
  keeps the list, sends `restore-pending`, and waits for `activation_restore_decide`; "never"
  records them as off. Missing files keep their intent under every policy and are retried
  after their folder's next scan, since a drive that hasn't mounted isn't the user's choice.
- **Locate… keeps the scope:** moving a folder (`tags/relocate.rs`) moves its
  `temporary_activations` rows with its fonts, and removes the old paths' registrations (both
  scopes for a temporary font) under `activation::lock()`. Its fonts that were on are retried
  after the rescan, and `activation::reconcile` turns each back on in the scope
  `activation::wanted_scope` gives: session scope for a file listed as temporary, else
  persistent. Launch never hands reconcile a temporary file, so only Locate… does that.
- **Keep running (macOS):** closing the main window hides it, and clicking the Dock icon
  (`RunEvent::Reopen`) shows it again. Cmd+Q still quits. A window in full screen leaves full
  screen first and hides when macOS says it has (`NSWindowDidExitFullScreenNotification`, in
  `window.rs`), so no empty full-screen space is left behind.
- **Open at login (macOS):** a LaunchAgent at `~/Library/LaunchAgents/design.snds.fontface.plist`
  that runs Fontface's executable (`RunAtLoad`, `ProcessType` Interactive). The file is the
  truth: the setting reads as on only while it exists and starts this copy. At launch, a copy
  running from an app bundle points it at itself only if the copy it starts is gone (the app
  moved). A copy on a disk image, or one macOS runs from a hidden folder because it was opened
  straight from a download (App Translocation), never takes it, and turning the setting on
  there is refused with a plain message to move Fontface to Applications first.
- **View options:** `layout` ("tiles", "rows" or "table"), `groupStyles`, `sort` (`{ key, desc }`),
  `tableColumns` and `tableDensity` are remembered by the UI (the View options, the toolbar's
  layout switch, the Table's headers), like `fontPageTab`, and Reset covers them.
  `tableColumns` is the Table's columns in order, each `{ id, shown, width? }`; the ids belong to
  the UI (`src/components/library/columns.ts`), so the back end checks only their shape, pulls
  widths into 32–1200px, drops repeats and keeps at most 40, and keeps ids it doesn't know for
  the version that does. An empty list means the UI's defaults.
- **Tag backups:** at launch, if there are tags and the newest backup is a day old, a Fontface
  tags file (the JSON export) is written to `Backups/` in the app data folder, named
  `Tags YYYY-MM-DD HH-MM-SS.json` in UTC so names sort by time. Then the oldest beyond the
  number to keep are deleted, never the one just written. A backup dated a day or more ahead
  (written while the clock was wrong) counts as the oldest. Only files with exactly that name
  pattern are ever deleted.
- **Appearance:** System, Light or Dark (see **Front end**). At setup, and whenever the setting
  changes, `window::paint_background` colors the main window with the page's background:
  #FFFFFF, or #0A0A0A for dark (`--background` in `src/index.css`, oklch(1 0 0) and
  oklch(0.145 0 0)). With System it reads macOS's `AppleInterfaceStyle` then. This only matters
  before the page's first paint, so a dark launch doesn't flash white; a later macOS change is
  the page's to follow.

## Sync

Sync shares choices (tags with their colors and groups, tags on fonts, which fonts are on,
per-computer exceptions) between the user's computers through a folder another app keeps in
sync. Font files, settings and the database never sync. Full details: [SYNC.md](SYNC.md).

- **Each computer writes only its own folder** (`Fontface Sync/v1/devices/<device id>/`):
  `device.json`, change files that are never edited, and a snapshot. So a plain file-sync
  service can't create conflicts. Files are written whole and renamed into place; anything
  unreadable is skipped and tried again, never acted on.
- **Merging** (`sync/merge.rs`, pure data): a hybrid logical clock orders changes; single
  values are "latest wins"; deletes are final; tags on fonts are an add-wins set. Any order,
  any number of times, gives the same result.
- **Local tags ↔ changes** (`sync/engine.rs`): local edits are found by comparing the tables
  with what sync last wrote into them, so applying other computers' changes never echoes back.
  A top-level tag's group is written only when it differs from what its name gives
  (`tags::is_builtin_name`) or changes here, so the one-time sort into groups is never shared.
  On/off changes come only from the user's switch (`set_activation` calls
  `sync::activation_chosen`). Its `origin` says when it isn't the user's switch: fonts a download
  or an import turns on are shared only where nobody has chosen yet
  (`sync::activation_arrived`), and an update or a Replace putting back what was on records
  nothing. Synced choices are switched through `commands::switch`, once each; one that fails is
  tried again next time, and one whose file is missing is recorded as on and retried after its
  folder's next scan, like launch does.
- **Hooks elsewhere are one line each:** `AppState::write` wakes sync after a UI write, and
  `set_activation` records the switch. `AppState::write_cache` (preview profiles, a cache) is
  the same write without waking sync. Sync's own tables (`sync_meta`, `sync_outbox`) come from
  an idempotent `ensure_schema`, like the tag tables.
- **Threads:** all file work runs on a sync thread with no lock held, since a cloud folder may
  download on read. Lock order: cycle lock, engine lock, database mutex.
- **Storage is behind `Transport`** (`sync/transport.rs`), so direct connections (Apache
  OpenDAL: WebDAV, S3, Google Drive, OneDrive, Dropbox, iCloud) can be added without touching
  the merge rules.
- **Copied app data** (Migration Assistant, a restored backup) is caught with a hash of the
  hardware id, and the copy takes a new device id.

## Windows plan (architected, not built)

Windows-specific code is isolated behind `#[cfg(target_os = "windows")]`:

| Concern | macOS (done) | Windows (planned) |
|---|---|---|
| Activate | CoreText persistent scope | `AddFontResourceExW` + `HKCU\…\Windows NT\CurrentVersion\Fonts` value + `WM_FONTCHANGE` broadcast |
| Deactivate | CoreText unregister | `RemoveFontResourceExW` + delete value + broadcast |
| Survives restart | OS handles it | Registry value is reloaded at sign-in |
| Admin rights | None | None (per-user fonts, Windows 10 1809+) |
| Reveal file | `open -R` | `explorer /select,` |
| Preview URL | `ff://localhost/<id>`, `ff://localhost/google/<id>/<token>/<kind>` | `http://ff.localhost/<id>`, `http://ff.localhost/google/…` (handled by `convertFileSrc`) |
| Path display | `/` splitting in UI | Needs a separator-aware helper |

Everything else (scanner, database, protocol, UI) is already cross-platform.

## Front end

- **Components:** shadcn/ui (Base UI flavor), styled with Tailwind CSS v4. Generated components live in `src/components/ui/`.
- **Icons:** Google Material Symbols Rounded, from the bundled variable font (`<Icon name="…" />`).
- **Type:** IBM Plex Sans for the interface. IBM Plex Mono for technical values such as paths, PostScript names, axis tags and counts. Both are bundled.
- **Theme:** the Appearance setting: System, Light or Dark. `src/settings/theme.ts` puts a `.dark` class on `<html>`. The last setting used is kept in localStorage and applied before the first render, so the page never starts in the wrong colors; with System it follows `prefers-color-scheme` live. `window.setTheme` keeps the native parts (the window buttons) in step. The window's own background is set from Rust at setup (see **Settings**).
- **Title bar (macOS):** an overlay (`src-tauri/tauri.macos.conf.json`: `titleBarStyle` Overlay, hidden title, window buttons inset). The app's 52px first row (sidebar strip, toolbar, or a page's header such as the font page's) is the title bar: `src/components/TitleBar.tsx` marks it as a drag region (`data-tauri-drag-region="deep"`), with controls left clickable. A double-click does what macOS's "Double-click a window's title bar to" setting says (zoom, minimize or nothing) through the `title_bar_double_click` command, which reads `AppleActionOnDoubleClick` (or the older `AppleMiniaturizeOnDoubleClick`), instead of Tauri's built-in zoom. In full screen the row is a plain header. Windows keeps its native frame.
- **App menu (macOS):** built in `src-tauri/src/window.rs`. It repeats Tauri's default menu (About, Services, Hide, Quit; Edit with undo, cut, copy, paste and select all; View; Window; Help) and adds Settings… (⌘,) and Show All to the Fontface menu. Settings… shows the window if it was closed and sends `open-settings` to the page. The View and Font menus are the page's (`VIEW_MENU` and `FONT_MENU`: ids, names, accelerators, check items): choosing an item shows the window and sends `menu` with its id, and the page keeps them in step with what's on screen through `set_menu_state` (`MenuState`: the enabled and checked ids, and names that change, such as the saved activation mode's Turn On going first and "Compare With…" becoming "Compare"). Rust keeps the item handles (`MenuHandles`, managed state) and applies only what changed since the last state (`menu_updates`), since each change is a trip to the main thread. macOS flips a check item's mark by itself when it's chosen, before the page hears of it, so `on_menu_event` puts it back to the page's last word (`CheckMarks`, lock-free, read on the main thread) and the page sends any real change; the page sends a state only when it differs, a moment after it settles. The page's side is pure and tested in `src/fontActions.ts` (`nativeMenuState`, `menuCommand`), and `src/menuIds.test.ts` reads `window.rs` to check both list the same ids and that each accelerator is the page's own shortcut for the same command.
- **Shortcuts that are also menu items:** WebKit hands a Cmd-key press to the page first and to the menu only if the page didn't handle it (`preventDefault`), but a press can still reach both. So each command (Back, a layout, a size step, a font action) goes through one guard (`createShortcutGuard` in `src/fontActions.ts`, held by App and consulted by `useNav` for Cmd+[): the same command from the other source within 250 ms is the same press, and is dropped. A menu item that arrives while the page wouldn't act (settings open, a menu, dialog or popover open, a drag) is ignored with the same checks the key handlers use.
- **Font actions:** `src/fontActions.ts` (pure, tested) is the one list of what can be done to fonts: Open, Show Info, Turn On (the saved mode), Turn On the other way, Turn Off, Tags…, Compare, Pair, Family Group…, Show in Finder, Copy PostScript Name, Remove from Library…, with when each applies (`fontActionStates`) for a target (`FontTarget`: the list's selected rows, in list order, or the font page's family in its chosen style, or one style of it). `src/components/FontActions.tsx` draws them in right-click menus and the font page's More menu (`FontActionItems`, with the tag submenus and sync items in right-click menus), and App runs them (`FontActionsContext`) for those menus, the selection bar, the keyboard (Cmd+I, Cmd+T, Cmd+Return, Option-Cmd+Return, Shift-Cmd+Return; a focused switch leaves those keys to App) and the Font menu. Dialogs opened from code (the font picker, the tag picker, Remove from Library's question) give focus back to what had it when they were asked for (`src/focusReturn.ts`), since Base UI can't tell. Compare's and Pair's text, like the font page's, falls back to text the font can draw (`src/sampleText.ts`). The list reports its selection as a target (`LibraryPane`'s `onTarget`), which App reads when a shortcut or menu item arrives. Option-click on a switch turns on the other way (`switchScope`; the switch notes Option on the press, since the change event it gets doesn't carry it), and the switch's tooltip says so while it would turn fonts on. Remove from Library works out what goes first (`removalPlan`: files in your folders, other styles in the same files, styles that stay from another copy) and says it in the confirmation (`removalSummary`).
- **Compare and Pair:** `src/components/ComparePage.tsx` and `PairPage.tsx`, pages on the stack (`compare` holds face keys, how many were left out and the mode; `pair` holds the heading's and the body's face keys), so Back, focus and announcements work as for the other pages, and a font page opened from a Compare lane goes back to it. Their lists are pure in `src/compare.ts` (at most 8, adding, removing, moving, a lane's style picker swapping its face key, Swap). Fonts are found by face key in the whole library, like the font page. The library search (`searchFamilies`: names that start with what's typed, then word starts, then anywhere, accents ignored) backs the font picker dialog (`src/components/FontPicker.tsx`, opened through `FontPickerContext`), which App hosts; a pick that opens a page leaves focus on that page's heading.
- **Settings screen:** `src/settings/`. It covers the library while open: the sidebar becomes the list of sections, and a search box finds settings across all of them. Each change saves as it's made (`settings_update`); there's no Save button. Esc goes back to the library.
- **Large libraries:** every layout is virtualized, so only rows, cards and table rows on screen exist (Rows measures its rows as they draw; Tiles and Table use fixed heights for the size, so nothing is measured). A font file loads only when its row scrolls into view. On the font page, the "All styles" lines load theirs only near the screen (an `IntersectionObserver` on the tab panel), and the chosen style's file goes before everything else waiting (`src/loadOrder.ts`). Loaded faces that no row shows are kept up to 500 (`src/fontMemory.ts`, used by `fontLoader.ts`); past that, the one unused longest is removed from `document.fonts` and the loader's caches (and its dark-theme palette rule), and loads again if a row shows it later. Faces a row or a font page shows are never removed. In a browser check with 12,000 families (a production build, scrolling Tiles from top to bottom), the page kept at most 555 app fonts loaded, and no step of the scroll took over 25 ms to render.
- **Sidebar places:** `src/places.ts` (pure, tested). LIBRARY lists All Fonts and the smart entries (`SMART_ENTRIES`): Your Fonts (a copy outside the OS's font folders), Recently Added (added in the last 30 days by `added_at`, newest first), Active (on now, leaving out the always-on OS fonts) and Not Tagged (none of your own tags; built-in tags don't count, through `hasOwnTag` in the tag filter context). Each is a `LibraryView` kind that `filterFamilies` handles, with a count from `placeCounts` (`src/library.ts`), and each but All Fonts has a Settings › Sidebar switch (`sidebar.yours`, `recent`, `active`, `untagged`, in `settings.rs` too). Recently Added keeps its own sort (newest first each time you go there), so sorting it doesn't change the library's saved sort; Active hides All / Active / Inactive and counts as All. SOURCES is flat (`sourceRows`): Font Book (the three OS font folders as one source, view "installed"), Google Fonts and Purchases (view "service": your library's fonts from that service's managed folder; Browse opens its own page), Adobe Fonts (its own page, since Creative Cloud files are never read), then your folders A to Z. A source's commands are on its row's right-click menu (`LocationMenu` with `before`/`after` actions; Shift-F10 opens it): Rescan or Stop, Show in Finder (`reveal_folder`), Locate… for a missing folder, its color, and Remove from Library… for your folders. There are no folder trees: a folder inside a source is a "location" view picked from the toolbar's subfolder picker (`src/components/SubfolderPicker.tsx`, tree and search in `src/subfolders.ts`), shown only on a source's view with folders inside it (Font Book always offers its three); its source's row stays selected (`sourceOf`). The picker is a combobox over a tree: the search field keeps focus, Up and Down move, Right and Left open and close (with the field empty), Return picks, and Shift-F10 or a right-click sets a folder's color. Saved views from before go through `migrateView` (a macOS folder's view becomes Font Book narrowed to it; a service folder's view becomes the service's row) and `restoreView`; a view whose place is hidden in Settings › Sidebar falls back to All Fonts (`hiddenBySidebar`).
- **Font states:** `src/fontState.ts` (pure, tested) works out each style's state from the list's fields (part of macOS, installed, on until logout, on, set to turn on but not on, turned on by another app, off) and sums them for a family (`summarize`). `StateControl` (`src/components/ActivationSwitch.tsx`) draws it the same way in Rows, Tiles, Table, the font page header and its "All styles" lines: the lock badge with its reason, or the switch (on when every style is on or set to turn on; "n/total" of the styles that are on when only some are, or in Tiles and Table, which have no room for it, a `radio_button_partial` mark; paler when it's set to on but none of it is on yet) with one mark by priority (timer, link_off, info, then partly on in the compact layouts). A running request's spinner takes the mark's place, so the Table's on/off cell never needs more than one mark and the switch (`STATE_CONTENT_WIDTH` in `columns.ts` sets the column's minimum). Each mark has a tooltip, and the same words are screen-reader text that the item's description and the switch's description point at; the item's name says the short form ("on until logout", "always on, part of macOS"). With "Turn temporary fonts off when Fontface quits" on, the words say so ("until you quit Fontface, log out or restart"): App hands that to every state's words through `StateWordingContext`. After a switch, each `ActivationOutcome` carries both what the OS has (`active`) and what Fontface recorded (`activated`), and `applyOutcomes` puts both on the list, so "turned on by another app" and "set to turn on, not on" (macOS didn't load it; its registration and intent stay) show at once instead of after the next reload. The Info tab says the chosen style's state, and each copy's.
- **Places and pages:** the main column has two layers. The list layer is the place picked in the sidebar (App's `view` and filters): the toolbar and the list, or Adobe Fonts' own page. Pages are pushed on top of it (`src/nav.ts`, a pure reducer; `src/useNav.ts` wires it to the window): the font page, and the Google Fonts and Purchases pages, which Browse opens over those sources' lists (a "catalog" page; its header has Back, its `h1` takes focus, and Back puts focus on Browse again), Family groups (a "groups" entry: its filter and the faces it opened on; opened again while it's on top, it shows what was asked for instead of stacking), and Compare and Pair. While a page shows, the list layer stays mounted, `invisible` and `inert`, like the library under Settings, so its scroll position, selection and loaded previews survive. Only the top page shows; pages under it stay mounted the same way. A sidebar click (`goToPlace`) replaces the place and clears the stack; fallbacks to All Fonts (a removed folder, a hidden section, a deleted or hidden tag: the sidebar's `onFallback`, which is App's `setView`) keep the page. Back closes the top page: the header button, Cmd+[ (Alt+Left on Windows), the mouse's back button (`MouseEvent.button` 3), or Esc when focus isn't in a text field, menu or popover (`backKeyIntent`; a disabled button that stays focusable, Base UI's `focusableWhenDisabled`, takes Esc without handling it, so Esc there still goes back). They do nothing while Settings cover the page, a dialog, menu or select list is open (`popupOpen` in `useNav.ts`, also used by Cmd+, and Cmd+F), or a drag is under way. After Back, App asks the list to focus the row that opened the page (`ListHandle.focusRow`; if it has left the list, the neighbor the selection already moved to) and announces "Back to …" in the live region; opening announces the family and focuses the page's `h1`. Back to a page underneath focuses what opened the closed page there (More on a font page, a Compare lane's name), else that page's `h1`, in an effect once it's drawn on top again; a button on a layer that was hidden until then is still easing out of `visibility: hidden` (`transition-all`), so `focusShown` in App skips that transition to give it focus. Cmd+F leaves a font page and focuses Search; on the Google Fonts catalog it focuses the catalog's own search, and on the Purchases page it does nothing, so neither loses its place (`findIntent` in `src/nav.ts`). An action that closes Settings and opens a page in one go (Open Purchases, the "Review" toast) closes them with `restoreFocus: false`, so the page's heading keeps focus. "Open where you left off" restores the place only, never a page.
- **Font page:** `src/components/fontPage/`. Its stack entry holds the face key it was opened from, the chosen style (a face key) and the tab; App finds the family by face key in the whole library (`familyOfFace`), so filters never narrow it and regrouping families by name won't lose it. If no family has that face any more, the page says so and offers Back. Axis values and the character search live in the page's own state; the axis number field's rules (live values, Return, Esc back to the value from before typing) are pure, in `src/axisField.ts`. The character search's result line is an always-present status region, so the first result is read out too. Details (`get_font`) and characters (`font_characters`) are read for the chosen style only, characters only once a tab needs them. The tab used last is the `fontPageTab` setting (in `AppSettings` and `settings.rs`, so Reset covers it); Axes shows only for a variable style, and another style falls back to Specimen without changing the setting. The OpenType, Axes and Info tabs read `font_facts` for the chosen style (`useFontFacts` in `parts.tsx`; asked again quietly when the style is turned on or off, so "Last turned on" follows). The OpenType tab's names, groups, defaults, samples and switch rules are pure in `src/openType.ts`: the page keeps its switches (by tag, for every style, only the ones that differ from what the View options or the font would do anyway) and the text's language; `pageFeatureValues` lays them over the View options' features into one `font-feature-settings` for Specimen, the test text and the samples (each sample shows its own feature alone). The Axes tab's named style picker uses `currentInstance` and `instanceValues` (`src/axisField.ts`). The Info tab's words (embedding, web addresses, languages by name through `Intl.DisplayNames`, scripts from the character blocks, dates) are pure in `src/fontInfo.ts`.
- **Preview styling:** the View options' `preview` setting (`PreviewOptions` in `api.ts` and `settings.rs`, merged key by key like `sidebar`; colors are "#rrggbb" or null, features known ids in a fixed order; `previewStyle.test.ts` checks the lists against `settings.rs`). App turns it into a `PreviewStyle` (`src/components/PreviewStyle.tsx`: the options, the colors resolved for the theme, the features' CSS) and provides it around the library layouts and the font page only, so the catalogs, the font picker, Compare and Pair stay plain. `PreviewText` applies it (case through `previewCase`, `styleCss` for alignment, colors, outline and underline, `fontFeatureSettings`) and fits with `styleExtra`; `MissingHint` checks the text in its new case. Colors resolve in `resolveColors`: both chosen are kept (with a contrast warning under 3:1, WCAG's large-text minimum), one chosen gets a near-black or near-white partner when the theme's wouldn't read on it. A lone ink is checked against every surface previews sit on (`THEME_COLORS.*.surfaces`: the page, Tiles' cards, selected and hovered rows; `previewStyle.test.ts` checks them against `index.css`). Whatever draws the paper (`PreviewText`, Specimen's sheets, the OpenType test text) marks it `data-paper="dark"` or `"light"` (`paperTone`), and the all-dark color font palette rule (`colorPalette.ts`) follows that before the theme. The OpenType tab's feature samples are never put in the View options' case.
- **Library list:** `src/components/library/LibraryPane.tsx` shows the place in one of three layouts, the `layout` setting: Tiles (`FontTiles.tsx`), Rows (`src/components/FontList.tsx`) and Table (`FontTable.tsx`). The pane owns what they share: the rows (families, plus the styles of expanded families except in Tiles), the selection, the keyboard, opening, the right-click menu, dragging fonts onto tags, the selection bar and focus. Each layout draws its own virtualized scroll element, spreads the pane's handlers on it, and reports itself every render through a small adapter (its element, items per page, items per line, whether the active item is in sight, the first item on screen), which is how one key handler works for a list, a grid and a table. The selection lives in the pane, keyed by row key, so it survives a layout switch (Tiles has no style rows: every selected style, and the anchor, becomes its family, through `prune(…, { toParent })`, which the pane asks for only in Tiles; a family collapsed in Rows still lets its styles go); the switch then brings the active item into view and keeps focus in the list if it had it. A new sort or grouping (`orderKey`) does the same, or goes back to the top when nothing is active. Rows is a listbox, Tiles a grid (rows of gridcells; Left and Right go item by item, Up and Down by `across` items: `listKeyCommand(…, { grid })` and `moveFocus(…, { across })`), and Table a treegrid (rows with `aria-level`, `aria-expanded`, `aria-rowindex`; the header row is one Tab stop with roving focus, Return sorts, Shift+Left/Right resizes). In every layout the scroll element keeps focus and points at the active item with `aria-activedescendant` (items scrolled away don't exist, so focus can't live on them). Selection is a pure model (`src/selection.ts`: click, Cmd-click, Shift-click, arrows, Home/End, Page Up/Down, Space, Cmd-A, Esc, and the key map) held by `src/components/library/useSelection.ts`, keyed by row key so reloads and expanding don't shift it. Focus on a row that leaves the list moves to its parent (a collapsed family's row) or the row that took its place (`prune`), and a list given focus with no focused row starts on the first row on screen. A click selects; double-click or Return opens; right-click only selects. Only the active row's controls are in the Tab order. Key commands, keyboard focus and Back bring the active row into view (a counter, `reveal`, so only an explicit request scrolls); while it's out of sight the listbox shows the focus ring itself, and Shift-F10 still opens the active row's menu. Each option's accessible name is its family or style, style count, "variable" and on/off state; its description (`aria-describedby`) points at the row's screen-reader texts: places, marks, missing characters and tags. In the Table, where the arrow keys move by row and never into cells, the description is the shown columns in order, each with its column's name ("Foundry: Rasmus Andersson."). Rows and the Table key their virtualized rows by row key, so a row's DOM (and a focused switch or chevron in it) moves with its family when a reload or a re-sort moves it, and both anchor the row at the top (`anchorTo: "end"`) so a scan adding rows above doesn't move the view. Tiles keys its rows of cards by index, so it keeps the card at the top by key itself: after a reload it scrolls by whole rows (`reloadShift`), and its anchor only moves on a scroll that changes the top row (`scrolledAnchor`), so resizing back and forth doesn't creep. An item's own control that has focus and goes away with its row (scrolled out of the drawn ones, or a card drawn again elsewhere) hands focus back to the list, whose active descendant takes over (`keepFocus`, run after every layout render through `useKeepFocus`). In the Table, the multi-selection bar is drawn on the pinned on/off cell and the keyboard ring on an overlay above the pinned cells, which would otherwise cover both.
- **Family ids:** `Family.id` ("n:" plus the family's name after grouping) keys rows, the expanded set and lookups. A family that was already that name keeps its id when others join it, and the font page finds its family by face key, so regrouping never loses it. A family narrowed by a filter keeps its id.
- **Family groups page:** `src/components/FamilyGroupsPage.tsx`, opened through `FamilyGroupsContext` (`src/families/store.ts`) from View options, the list's and the font page's right-click menus (the font actions' Family Group…), the font page's More menu (focus comes back to More on Back) and Settings › Library. All and Your changes are a virtualized tree (`role="tree"`, rows `treeitem` with `aria-level`, `aria-setsize`, `aria-posinset`, `aria-expanded` and `aria-checked`, true, false or mixed); like the library list, the tree keeps focus and points at the current row with `aria-activedescendant`. Check boxes are drawn, not controls (the row is the control). The selection bar's family field is a Base UI Autocomplete (`src/components/ui/autocomplete.tsx`); a typed name that matches a family in spelling only becomes that family's name. Suggested is a list of cards with Merge and Keep separate, each family with a check box when there are several. Every change goes through the families store (save, then read back, in order), which keeps the session's undo changes; a toast with Undo and the header's Undo button both use them (`src/families/feedback.ts`). Merging a family writes a merge rule for each family name its styles carry, so fonts that arrive later follow it, and moves styles you'd placed by hand with it. The Info tab says how the chosen style got its family, with Keep separate or a way back.
- **View options:** `src/components/ViewOptions.tsx` (the popover and the toolbar's layout switch); the vocabulary is pure, in `src/viewOptions.ts` (layouts and Cmd+1/2/3, the size steps of Cmd+= and Cmd+-, sort keys with the words for each direction and the announcement). App filters the whole library (`filterFamilies`), then with "Group styles into families" off turns every style into its own item (`ungroup`: id "u:" plus the face key, name "Family Style", `ungroupedFrom` the family), then sorts once (`sortFamilies`, `src/library.ts`: unknown values last, ties by name and then the order they came in, so a family's styles stay together; name A to Z on an already sorted list returns the same array). Versions compare as decimals, like a font's head revision (`compareVersions`: 1.009 before 1.1, 1.10 before 1.9), with versions that don't start with a number after the numbered ones either way round. The Source sort and the Source column both go by `familySources` (the representative's places first), so the column reads in order. What the Table shows and sorting compares (weights, foundry, added dates, formats, sizes, short versions) is pure, in `src/familyFacts.ts`; the Table's columns (defaults, saved order, widths, row heights, the Preview column's size) in `src/components/library/columns.ts`; Tiles' grid math in `src/components/library/tileGrid.ts`. The size shortcuts change the session's size like the slider; the default size stays in Settings. Like Cmd+F and Back, the layout and size shortcuts wait while a menu, dialog or popover is open (`popupOpen`) or a drag is under way.
