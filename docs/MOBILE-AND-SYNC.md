# Mobile apps and sync (exploration, 2026-10-12)

Status: idea stage. Nothing here is built. It answers two questions: can Fontface run on
iPhone, iPad and Android, and how would tags and on/off choices sync between devices?

## Short answer

- **iPhone and iPad:** yes, with real font activation. Apple lets an app install fonts for other
  apps, but the user approves each install in a system prompt.
- **Android:** only as a companion. Stock Android has no way for an app to install a font for the
  whole phone. Fontface could browse, preview, tag and sync, and hand a font file to an app that
  imports fonts.
- **Sync:** yes, through any storage the user picks. Sync the *choices* (tags, on/off, per-device
  exceptions), not the database, and by default not the font files.

## What carries over

Tauri 2 builds for iOS and Android, so most of the app is reusable:

| Part | Reuse | What changes |
|---|---|---|
| React interface | High | New layouts for phone (one column) and iPad (two columns, pointer and keyboard) |
| SQLite, tags, settings, import/export | High | None to speak of |
| Font parsing (`sfnt.rs`, scanner parsing) | High | None |
| Folder scanning | Low | Mobile apps can't walk the disk. iOS needs folders the user picks (security-scoped bookmarks); Android needs the Storage Access Framework (`content://` addresses, not paths). Both need a small native plugin (Swift / Kotlin) |
| Activation (`activation/`) | New back end | iOS: CoreText with the "Install Fonts" capability. Android: none |
| Purchases watcher | Desktop only | Mobile has no Downloads folder to watch. A share-sheet "Open in Fontface" replaces it |
| Google Fonts | High | Same downloads, stored inside the app |
| Adobe Fonts | Desktop only | Adobe's terms allow only its own app to handle those fonts |

## iPhone and iPad

How it works:
- The app gets the `com.apple.developer.user-fonts` entitlement with `system-installation`.
- It calls `CTFontManagerRegisterFontURLs` with persistent scope. iOS shows an "Install Fonts"
  prompt. After the user agrees, the fonts appear in Settings › General › Fonts.
- Apps that support installed fonts can use them (Pages, Keynote, Procreate, Affinity, Office and
  others). Other apps must opt in (`CTFontManagerRequestFonts` or the system font picker).
- Apple says not to move or rename a file after registering it. So the files live in Fontface's
  own storage: imported from Files, downloaded from Google Fonts, or (opt-in) fetched by sync.
- Turning fonts off needs no prompt.

Limits compared with the Mac:
- Every batch of installs needs the user's approval. "Turn on everything in this tag" becomes one
  prompt, not zero.
- No equivalent of temporary (session) activation for other apps.
- No view of fonts other apps turned on, beyond what CoreText reports to Fontface.

**Risk to check first:** at WWDC 2019 Apple described font-provider apps as shipping the fonts
they install, and App Store Connect rejects a `system-installation` app with no fonts in it
(ITMS-90793). A manager that installs the user's *own* files may face App Review questions. Build
a small test app and submit it to TestFlight before committing to the iOS port. The fallback is a
configuration profile (`.mobileconfig`), which is clunky and has no off switch.

**Precedent:** Fontcase (open source, on the App Store) installs the user's own fonts by building
a configuration profile the user installs in Settings. So that route has passed review. It's
clunkier than the entitlement route, but it's a known-good fallback.

### App Review framing (decided 2026-10-12)

- "Fontface installs no fonts; it only reads them from a sync service" is **not available** for
  any version where fonts work in other apps. CoreText can only register a file on the device,
  the file must stay put while registered, and iOS shows its own "Install Fonts" prompt. Telling
  App Review otherwise breaks guideline 2.3 (accurate metadata) and risks the developer account.
- It *is* true for a preview-only mode (fonts render inside Fontface only, from bytes in memory).
  That mode can honestly say "no fonts are installed".
- Honest framing for the full app: "a font manager that installs fonts the user already owns,
  from files the user chooses, with the system's own approval prompt."

### Licensing (not legal advice)

- Reading a font from a cloud service to use it means downloading the whole file to the device.
  The OS keeps it while it's registered. Legally that's a copy, even if Fontface "saves" nothing
  itself, so "we only point to a sync service" doesn't remove the license question.
- The device limit in a font license binds the user, not Fontface. Fontface's own exposure is as
  a tool maker, and it stays low when the tool is neutral and the design and marketing don't
  encourage breaking licenses.
- What genuinely helps: Fontface hosts nothing and the user picks the storage; file sync is
  opt-in per folder; the Purchases and Adobe fonts are excluded; a plain license notice appears
  at opt-in; and the font's own embedding flags (OS/2 `fsType`) trigger a warning when they're
  restrictive.
- What hurts: describing the design as a way around licenses, anywhere.
- Before a paid or public release, have an IP lawyer review the sync feature.

## Android

- Stock Android (including Pixel) lets an app use a font only inside itself.
- Samsung allows system fonts only from the Galaxy Store, with signature checks. Workarounds exist
  but depend on loopholes Samsung can close. Fontface shouldn't rely on them.
- What Fontface can do: library, previews, tags, sync, choosing on/off for *other* devices, and
  "Share font" to apps that import fonts (many design and note apps do).
- Possible later: act as a downloadable-fonts provider (`FontsContract`). Only apps written to ask
  Fontface by name would use it, so it's low value.

## Sync

### What syncs

| Item | Syncs | Notes |
|---|---|---|
| Tags, nesting, colors, My tags / Built-in | Yes | |
| Which fonts are on | Yes | As intent. Each device turns them on locally if it has the file |
| Per-device exceptions | Yes | "Always on here", "Never on here", or follow the shared choice |
| Location colors | Optional | Paths differ by device, so only for services (Google Fonts, Purchases) |
| Settings | Optional, per setting | Most settings belong to one device |
| Font files | **No, by default** | See below |

### Font identity

Tags already belong to a font, not a file (`face_key`, e.g. `ps:Okuda|static|r`; see
[TAGS.md](TAGS.md)). That key works across devices unchanged. Add the content fingerprint the
purchases code already computes, so two different fonts that share a PostScript name don't merge.

### How choices merge

- **Rule:** each device writes only its own files in a shared `Fontface Sync/` folder:
  `devices/<device-id>/changes-<n>.json` (append-only) plus a periodic `snapshot.json`. No two
  devices ever write the same file, so plain file-sync services can't create conflicts or
  corrupt anything. Never sync the SQLite database itself.
- **Tags on fonts:** add and remove are tracked per tag and font. If one device adds and another
  removes at the same time, adding wins (an "add-wins set").
- **Single values** (on/off, tag name, color): the latest change wins, ordered by a hybrid
  logical clock (wall time plus a counter, so a wrong device clock can't win forever).
- **Per-device exceptions:** the effective choice is the first that applies:
  1. this device's exception,
  2. its device group's (e.g. "Phones", "Work Macs"),
  3. the shared choice.
- **Missing files:** a device that lacks a font keeps the intent and shows it as "Not on this
  device". This matches how the Mac already treats a drive that isn't mounted.
- **iOS approval:** synced "turn on" choices queue up and show one "Install N fonts" prompt the next
  time the app is open. iOS can't install fonts silently in the background.

### Font files

- The project already has a rule: never sync purchased or licensed fonts to other devices or cloud
  storage ([INTEGRATIONS.md](INTEGRATIONS.md)). Keep it.
- **Google Fonts and other open catalogs:** each device downloads its own copy from the source.
  Nothing is re-hosted.
- **The user's own folders:** opt-in per folder, off by default, with a plain warning that many
  licenses limit the number of devices. This is how fonts reach an iPad.
- **Adobe, system and Apple-downloaded fonts:** never.

### Storage choices

Two kinds of connection, behind one Rust interface:

1. **A folder the user picks.** Any folder their sync app keeps up to date: iCloud Drive,
   OneDrive, Google Drive, Dropbox, the Nextcloud or Seafile client, Syncthing, or an rclone
   mount. Simplest and the best fit on desktop. Weak on mobile: Android's Google Drive picker
   barely supports folders, and iOS limits background access.
2. **A direct connection** using [Apache OpenDAL](https://opendal.apache.org), a Rust library that
   builds for iOS and Android:
   - **WebDAV:** Nextcloud, ownCloud, OpenCloud, Seafile, Synology, Koofr, most NAS boxes.
   - **S3-compatible:** MinIO, Garage, Backblaze B2, Cloudflare R2, AWS.
   - **Google Drive, OneDrive, Dropbox:** each needs an app registration (OAuth client). Use the
     app-only folder (Drive `appDataFolder`, OneDrive App Folder, Dropbox App folder), so Fontface
     can't see the rest of the user's files.
   - **iCloud:** on Apple devices, the app's own iCloud container. Not reachable from Android.
3. **rclone (desktop, advanced):** use the user's existing rclone remotes (70+ services) by running
   `rclone rcd`. Not practical on mobile; WebDAV covers most of the same self-hosted crowd.

Tokens go in the OS keychain, following the rules already in [INTEGRATIONS.md](INTEGRATIONS.md).

### Privacy

Optional end-to-end encryption with a passphrase (e.g. XChaCha20-Poly1305 with an Argon2 key).
Tag names can be revealing (client and project names). Recommended on for third-party clouds.

## Suggested order

1. **Sync on desktop first:** Mac and (later) Windows, folder connection only. Proves the change
   format and merge rules where they're easiest to test.
2. **iOS feasibility spike:** a TestFlight build that installs one user-supplied font. Go / no-go
   for the iPhone and iPad port.
3. **iPad app**, then iPhone (same code, smaller layout).
4. **Direct connections:** WebDAV and iCloud first, then Google Drive, OneDrive, Dropbox, S3.
5. **Android companion.**

## Open questions

- Does App Review accept a font manager that installs the user's own files? (Step 2.)
- Should device groups exist in the first version, or only "this device" exceptions?
- Should the Mac app also offer to send fonts to an iPad directly (local network), skipping cloud
  storage entirely?
