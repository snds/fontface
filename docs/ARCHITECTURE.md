# Architecture

Fontface is a Tauri 2 app: a Rust back end does the real work, and a React web view draws the interface.

```
React UI (src/)                              Rust core (src-tauri/src/)
───────────────                              ──────────────────────────
App / Sidebar / FontList / DetailPanel
   │  invoke("list_fonts" …)  ───────────▶   commands.rs   ── db.rs (SQLite, WAL)
   │  listen("scan-progress") ◀───────────     │               scanner.rs (walk + parse)
   │  FontFace("ff://localhost/<id>") ───▶   protocol.rs   ── sfnt.rs (split .ttc faces)
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
`kind = 'system'` folders. macOS loads their fonts by itself, so they show as "Installed" with
no switch, and the folders can't be removed. Private UI families whose names start with `.`
are skipped.

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

**Changes made in other apps.**
If a font Fontface turned on was loaded earlier in the session and is then unloaded while its
file still exists, another app turned it off. That becomes the recorded choice, so the next
launch doesn't silently turn it back on. A change made while Fontface is closed can't be told
apart from macOS dropping a font before its drive mounted, so launch still re-applies it.

**Previews.**
- Installed fonts load by PostScript name (`local()`).
- Other fonts are fetched over `ff://`, 6 at a time, newest first. Rows that scroll away are dropped from the queue.
- Online-only files are never downloaded for a preview; they show "Not downloaded yet". Files over 96 MB aren't previewed.

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
  idempotent `ensure_schema`. Missing keys take their defaults, unknown keys are ignored, and a
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

Sync shares choices (tags, tags on fonts, which fonts are on, per-computer exceptions) between
the user's computers through a folder another app keeps in sync. Font files, settings and the
database never sync. Full details: [SYNC.md](SYNC.md).

- **Each computer writes only its own folder** (`Fontface Sync/v1/devices/<device id>/`):
  `device.json`, change files that are never edited, and a snapshot. So a plain file-sync
  service can't create conflicts. Files are written whole and renamed into place; anything
  unreadable is skipped and tried again, never acted on.
- **Merging** (`sync/merge.rs`, pure data): a hybrid logical clock orders changes; single
  values are "latest wins"; deletes are final; tags on fonts are an add-wins set. Any order,
  any number of times, gives the same result.
- **Local tags ↔ changes** (`sync/engine.rs`): local edits are found by comparing the tables
  with what sync last wrote into them, so applying other computers' changes never echoes back.
  On/off changes come only from the user's switch (`set_activation` calls
  `sync::activation_chosen`); synced choices are switched through `commands::switch`, once each.
- **Hooks elsewhere are one line each:** `AppState::write` wakes sync after a UI write, and
  `set_activation` records the switch. Sync's own tables (`sync_meta`, `sync_outbox`) come from
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
- **Title bar (macOS):** an overlay (`src-tauri/tauri.macos.conf.json`: `titleBarStyle` Overlay, hidden title, window buttons inset). The app's 52px first row (sidebar strip, toolbar or page header, detail header) is the title bar: `src/components/TitleBar.tsx` marks it as a drag region (`data-tauri-drag-region="deep"`), with controls left clickable. A double-click does what macOS's "Double-click a window's title bar to" setting says (zoom, minimize or nothing) through the `title_bar_double_click` command, which reads `AppleActionOnDoubleClick` (or the older `AppleMiniaturizeOnDoubleClick`), instead of Tauri's built-in zoom. In full screen the row is a plain header. Windows keeps its native frame.
- **App menu (macOS):** built in `src-tauri/src/window.rs`. It repeats Tauri's default menu (About, Services, Hide, Quit; Edit with undo, cut, copy, paste and select all; View; Window; Help) and adds Settings… (⌘,) and Show All to the Fontface menu. Settings… shows the window if it was closed and sends `open-settings` to the page.
- **Settings screen:** `src/settings/`. It covers the library while open: the sidebar becomes the list of sections, and a search box finds settings across all of them. Each change saves as it's made (`settings_update`); there's no Save button. Esc goes back to the library.
- **Large libraries:** the list is virtualized, so only rows on screen exist. A font file loads only when its row scrolls into view.
