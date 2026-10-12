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
another app turned on or off. At launch, `activation::reconcile` re-applies recorded intent the
OS isn't honoring. Files it can't reach yet, such as on a cloud drive that hasn't mounted, are
retried after their folder's next scan. Reconcile doesn't run after every scan, so it won't undo
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
- Its tables come from an idempotent `ensure_schema` (no `user_version` bump), so they merge cleanly with other features.

**Cloud storage.**
Online-only files (Google Drive or iCloud via File Provider; `SF_DATALESS` in `st_flags`)
download when first read. The scanner counts them and the UI says so. Activated fonts must stay
downloaded, so keep cloud font folders set to "Available offline".

**Folders don't overlap.**
Adding a folder inside an existing one is refused. Adding a parent of existing folders absorbs
them and keeps their fonts' activation state. This guarantees each file belongs to one folder.

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
- **Theme:** follows the macOS light or dark setting (a `.dark` class mirrors `prefers-color-scheme`).
- **Large libraries:** the list is virtualized, so only rows on screen exist. A font file loads only when its row scrolls into view.
