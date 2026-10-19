# Architecture

Fontface is a Tauri 2 app: a Rust back end does the real work, and a React web view draws the interface.

```
React UI (src/)                              Rust core (src-tauri/src/)
───────────────                              ──────────────────────────
App / Sidebar / LibraryPane / FontPage
   │  invoke("list_fonts" …)  ───────────▶   commands.rs   ── db.rs (SQLite, WAL)
   │  listen("scan-progress") ◀───────────     │               scanner.rs (walk + parse)
   │  FontFace("ff://localhost/<id>") ───▶   protocol.rs   ── sfnt.rs (split .ttc faces)
   │  invoke("preview_profiles" …) ──────▶   preview/      (what previews draw; face_previews)
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

**Changes made in other apps.**
If a font Fontface turned on was loaded earlier in the session and is then unloaded while its
file still exists, another app turned it off. That becomes the recorded choice, so the next
launch doesn't silently turn it back on. A change made while Fontface is closed can't be told
apart from macOS dropping a font before its drive mounted, so launch still re-applies it.

**Previews.**
- Installed fonts load by PostScript name (`local()`).
- Other fonts are fetched over `ff://`, 6 at a time, newest first. Rows that scroll away are dropped from the queue.
- Online-only files are never downloaded for a preview; they show "Not downloaded yet". Files over 96 MB aren't previewed.

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
- Both commands read files on two long-lived preview reader threads (`preview::Readers`), not
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
never shrinks: a row grows to fit the ink. A preview (in the list and on the Google Fonts page)
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
| Preview URL | `ff://localhost/<id>` | `http://ff.localhost/<id>` (handled by `convertFileSrc`) |
| Path display | `/` splitting in UI | Needs a separator-aware helper |

Everything else (scanner, database, protocol, UI) is already cross-platform.

## Front end

- **Components:** shadcn/ui (Base UI flavor), styled with Tailwind CSS v4. Generated components live in `src/components/ui/`.
- **Icons:** Google Material Symbols Rounded, from the bundled variable font (`<Icon name="…" />`).
- **Type:** IBM Plex Sans for the interface. IBM Plex Mono for technical values such as paths, PostScript names, axis tags and counts. Both are bundled.
- **Theme:** the Appearance setting: System, Light or Dark. `src/settings/theme.ts` puts a `.dark` class on `<html>`. The last setting used is kept in localStorage and applied before the first render, so the page never starts in the wrong colors; with System it follows `prefers-color-scheme` live. `window.setTheme` keeps the native parts (the window buttons) in step. The window's own background is set from Rust at setup (see **Settings**).
- **Title bar (macOS):** an overlay (`src-tauri/tauri.macos.conf.json`: `titleBarStyle` Overlay, hidden title, window buttons inset). The app's 52px first row (sidebar strip, toolbar, or a page's header such as the font page's) is the title bar: `src/components/TitleBar.tsx` marks it as a drag region (`data-tauri-drag-region="deep"`), with controls left clickable. A double-click does what macOS's "Double-click a window's title bar to" setting says (zoom, minimize or nothing) through the `title_bar_double_click` command, which reads `AppleActionOnDoubleClick` (or the older `AppleMiniaturizeOnDoubleClick`), instead of Tauri's built-in zoom. In full screen the row is a plain header. Windows keeps its native frame.
- **App menu (macOS):** built in `src-tauri/src/window.rs`. It repeats Tauri's default menu (About, Services, Hide, Quit; Edit with undo, cut, copy, paste and select all; View; Window; Help) and adds Settings… (⌘,) and Show All to the Fontface menu. Settings… shows the window if it was closed and sends `open-settings` to the page.
- **Settings screen:** `src/settings/`. It covers the library while open: the sidebar becomes the list of sections, and a search box finds settings across all of them. Each change saves as it's made (`settings_update`); there's no Save button. Esc goes back to the library.
- **Large libraries:** every layout is virtualized, so only rows, cards and table rows on screen exist (Rows measures its rows as they draw; Tiles and Table use fixed heights for the size, so nothing is measured). A font file loads only when its row scrolls into view. On the font page, the "All styles" lines load theirs only near the screen (an `IntersectionObserver` on the tab panel), and the chosen style's file goes before everything else waiting (`src/loadOrder.ts`). Loaded faces that no row shows are kept up to 500 (`src/fontMemory.ts`, used by `fontLoader.ts`); past that, the one unused longest is removed from `document.fonts` and the loader's caches (and its dark-theme palette rule), and loads again if a row shows it later. Faces a row or a font page shows are never removed. In a browser check with 12,000 families (a production build, scrolling Tiles from top to bottom), the page kept at most 555 app fonts loaded, and no step of the scroll took over 25 ms to render.
- **Sidebar places:** `src/places.ts` (pure, tested). LIBRARY lists All Fonts and the smart entries (`SMART_ENTRIES`): Your Fonts (a copy outside the OS's font folders), Recently Added (added in the last 30 days by `added_at`, newest first), Active (on now, leaving out the always-on OS fonts) and Not Tagged (none of your own tags; built-in tags don't count, through `hasOwnTag` in the tag filter context). Each is a `LibraryView` kind that `filterFamilies` handles, with a count from `placeCounts` (`src/library.ts`), and each but All Fonts has a Settings › Sidebar switch (`sidebar.yours`, `recent`, `active`, `untagged`, in `settings.rs` too). Recently Added keeps its own sort (newest first each time you go there), so sorting it doesn't change the library's saved sort; Active hides All / Active / Inactive and counts as All. SOURCES is flat (`sourceRows`): Font Book (the three OS font folders as one source, view "installed"), Google Fonts and Purchases (view "service": your library's fonts from that service's managed folder; Browse opens its own page), Adobe Fonts (its own page, since Creative Cloud files are never read), then your folders A to Z. A source's commands are on its row's right-click menu (`LocationMenu` with `before`/`after` actions; Shift-F10 opens it): Rescan or Stop, Show in Finder (`reveal_folder`), Locate… for a missing folder, its color, and Remove from Library… for your folders. There are no folder trees: a folder inside a source is a "location" view picked from the toolbar's subfolder picker (`src/components/SubfolderPicker.tsx`, tree and search in `src/subfolders.ts`), shown only on a source's view with folders inside it (Font Book always offers its three); its source's row stays selected (`sourceOf`). The picker is a combobox over a tree: the search field keeps focus, Up and Down move, Right and Left open and close (with the field empty), Return picks, and Shift-F10 or a right-click sets a folder's color. Saved views from before go through `migrateView` (a macOS folder's view becomes Font Book narrowed to it; a service folder's view becomes the service's row) and `restoreView`; a view whose place is hidden in Settings › Sidebar falls back to All Fonts (`hiddenBySidebar`).
- **Font states:** `src/fontState.ts` (pure, tested) works out each style's state from the list's fields (part of macOS, installed, on until logout, on, set to turn on but not on, turned on by another app, off) and sums them for a family (`summarize`). `StateControl` (`src/components/ActivationSwitch.tsx`) draws it the same way in Rows, Tiles, Table, the font page header and its "All styles" lines: the lock badge with its reason, or the switch (on when every style is on or set to turn on; "n/total" when only some are; paler when it's set to on but none of it is on yet) with one mark by priority (timer, link_off, info). Each mark has a tooltip, and the same words are screen-reader text that the item's description and the switch's description point at; the item's name says the short form ("on until logout", "always on, part of macOS"). The Info tab says the chosen style's state, and each copy's.
- **Places and pages:** the main column has two layers. The list layer is the place picked in the sidebar (App's `view` and filters): the toolbar and the list, or Adobe Fonts' own page. Pages are pushed on top of it (`src/nav.ts`, a pure reducer; `src/useNav.ts` wires it to the window): the font page, and the Google Fonts and Purchases pages, which Browse opens over those sources' lists (a "catalog" page; its header has Back, its `h1` takes focus, and Back puts focus on Browse again). Compare, Pair and Family groups will join them. While a page shows, the list layer stays mounted, `invisible` and `inert`, like the library under Settings, so its scroll position, selection and loaded previews survive. Only the top page shows; pages under it stay mounted the same way. A sidebar click (`goToPlace`) replaces the place and clears the stack; fallbacks to All Fonts (a removed folder, a hidden section, a deleted or hidden tag: the sidebar's `onFallback`, which is App's `setView`) keep the page. Back closes the top page: the header button, Cmd+[ (Alt+Left on Windows), the mouse's back button (`MouseEvent.button` 3), or Esc when focus isn't in a text field, menu or popover (`backKeyIntent`). They do nothing while Settings cover the page, a dialog, menu or select list is open (`popupOpen` in `useNav.ts`, also used by Cmd+, and Cmd+F), or a drag is under way. After Back, App asks the list to focus the row that opened the page (`ListHandle.focusRow`; if it has left the list, the neighbor the selection already moved to) and announces "Back to …" in the live region; opening announces the family and focuses the page's `h1`. Cmd+F leaves the page and focuses Search. "Open where you left off" restores the place only, never a page.
- **Font page:** `src/components/fontPage/`. Its stack entry holds the face key it was opened from, the chosen style (a face key) and the tab; App finds the family by face key in the whole library (`familyOfFace`), so filters never narrow it and regrouping families by name won't lose it. If no family has that face any more, the page says so and offers Back. Axis values and the character search live in the page's own state; the axis number field's rules (live values, Return, Esc back to the value from before typing) are pure, in `src/axisField.ts`. The character search's result line is an always-present status region, so the first result is read out too. Details (`get_font`) and characters (`font_characters`) are read for the chosen style only, characters only once a tab needs them. The tab used last is the `fontPageTab` setting (in `AppSettings` and `settings.rs`, so Reset covers it); Axes shows only for a variable style, and another style falls back to Specimen without changing the setting.
- **Library list:** `src/components/library/LibraryPane.tsx` shows the place in one of three layouts, the `layout` setting: Tiles (`FontTiles.tsx`), Rows (`src/components/FontList.tsx`) and Table (`FontTable.tsx`). The pane owns what they share: the rows (families, plus the styles of expanded families except in Tiles), the selection, the keyboard, opening, the right-click menu, dragging fonts onto tags, the selection bar and focus. Each layout draws its own virtualized scroll element, spreads the pane's handlers on it, and reports itself every render through a small adapter (its element, items per page, items per line, whether the active item is in sight, the first item on screen), which is how one key handler works for a list, a grid and a table. The selection lives in the pane, keyed by row key, so it survives a layout switch (Tiles has no style rows: every selected style, and the anchor, becomes its family, through `prune(…, { toParent })`, which the pane asks for only in Tiles; a family collapsed in Rows still lets its styles go); the switch then brings the active item into view and keeps focus in the list if it had it. A new sort or grouping (`orderKey`) does the same, or goes back to the top when nothing is active. Rows is a listbox, Tiles a grid (rows of gridcells; Left and Right go item by item, Up and Down by `across` items: `listKeyCommand(…, { grid })` and `moveFocus(…, { across })`), and Table a treegrid (rows with `aria-level`, `aria-expanded`, `aria-rowindex`; the header row is one Tab stop with roving focus, Return sorts, Shift+Left/Right resizes). In every layout the scroll element keeps focus and points at the active item with `aria-activedescendant` (items scrolled away don't exist, so focus can't live on them). Selection is a pure model (`src/selection.ts`: click, Cmd-click, Shift-click, arrows, Home/End, Page Up/Down, Space, Cmd-A, Esc, and the key map) held by `src/components/library/useSelection.ts`, keyed by row key so reloads and expanding don't shift it. Focus on a row that leaves the list moves to its parent (a collapsed family's row) or the row that took its place (`prune`), and a list given focus with no focused row starts on the first row on screen. A click selects; double-click or Return opens; right-click only selects. Only the active row's controls are in the Tab order. Key commands, keyboard focus and Back bring the active row into view (a counter, `reveal`, so only an explicit request scrolls); while it's out of sight the listbox shows the focus ring itself, and Shift-F10 still opens the active row's menu. Each option's accessible name is its family or style, style count, "variable" and on/off state; its description (`aria-describedby`) points at the row's screen-reader texts: places, marks, missing characters and tags. In the Table, where the arrow keys move by row and never into cells, the description is the shown columns in order, each with its column's name ("Foundry: Rasmus Andersson."). Rows and the Table key their virtualized rows by row key, so a row's DOM (and a focused switch or chevron in it) moves with its family when a reload or a re-sort moves it, and both anchor the row at the top (`anchorTo: "end"`) so a scan adding rows above doesn't move the view. Tiles keys its rows of cards by index, so it keeps the card at the top by key itself: after a reload it scrolls by whole rows (`reloadShift`), and its anchor only moves on a scroll that changes the top row (`scrolledAnchor`), so resizing back and forth doesn't creep. An item's own control that has focus and goes away with its row (scrolled out of the drawn ones, or a card drawn again elsewhere) hands focus back to the list, whose active descendant takes over (`keepFocus`, run after every layout render through `useKeepFocus`). In the Table, the multi-selection bar is drawn on the pinned on/off cell and the keyboard ring on an overlay above the pinned cells, which would otherwise cover both.
- **Family ids:** `Family.id` (today "n:" plus the grouping name) keys rows, the expanded set and lookups, never the display name, so a later grouping by name, where two families may share a name, doesn't break them. A family narrowed by a filter keeps its id.
- **View options:** `src/components/ViewOptions.tsx` (the popover and the toolbar's layout switch); the vocabulary is pure, in `src/viewOptions.ts` (layouts and Cmd+1/2/3, the size steps of Cmd+= and Cmd+-, sort keys with the words for each direction and the announcement). App filters the whole library (`filterFamilies`), then with "Group styles into families" off turns every style into its own item (`ungroup`: id "u:" plus the face key, name "Family Style", `ungroupedFrom` the family), then sorts once (`sortFamilies`, `src/library.ts`: unknown values last, ties by name and then the order they came in, so a family's styles stay together; name A to Z on an already sorted list returns the same array). Versions compare as decimals, like a font's head revision (`compareVersions`: 1.009 before 1.1, 1.10 before 1.9), with versions that don't start with a number after the numbered ones either way round. The Source sort and the Source column both go by `familySources` (the representative's places first), so the column reads in order. What the Table shows and sorting compares (weights, foundry, added dates, formats, sizes, short versions) is pure, in `src/familyFacts.ts`; the Table's columns (defaults, saved order, widths, row heights, the Preview column's size) in `src/components/library/columns.ts`; Tiles' grid math in `src/components/library/tileGrid.ts`. The size shortcuts change the session's size like the slider; the default size stays in Settings. Like Cmd+F and Back, the layout and size shortcuts wait while a menu, dialog or popover is open (`popupOpen`) or a drag is under way.
