# Integrations plan

Fontface can work with cloud font services in three safe ways.
First, it downloads open-licensed fonts through official APIs (documented ways for one program to ask a service for data) into a folder it manages.
Second, it shows fonts another app, such as Adobe Creative Cloud, has already turned on. These rows are read-only and link back to that app.
Third, it recognizes fonts the user bought when the download lands in a watched folder.
Fontface never copies, decrypts, converts or re-shares a font in a way its license forbids.

Status (2026-10-12): built so far:
- the All Fonts, Font Book and Folders views;
- Google Fonts (keyless: the Fontsource catalog plus full files from the google/fonts repository);
- the read-only Adobe Fonts listing;
- the Purchases download watcher (§3.3). Still to do there: the "Replace with newer version" offer, the 30-day trial reminder, and a "License transferred" status. Everything else here is still a plan. Facts were checked live on 2026-10-12, and each section ends with its sources. Fontface uses only other font managers' public documentation, never their code, binaries or hosted data (see [FEATURES.md](FEATURES.md)).

## 1. Summary

**Official** means a documented, supported path that fits the service's terms of service (ToS). **Local** means Fontface only reads what the operating system (OS) already reports. **Unofficial** means it works today but is undocumented, may break and has unclear terms, so it is opt-in only.
**P0** = core views. **P1** = build next. **P2** = after that. **P3** = nice to have. **P4** = only if asked.

| Service | What Fontface will do | How | Auth | Legitimacy | Priority |
|---|---|---|---|---|---|
| Font Book (macOS) / Windows Fonts | Show installed fonts by source, deactivated fonts and Font Book collections | Local OS APIs (CoreText, AppKit, DirectWrite) | None | Official, local | P0 |
| Google Fonts | Browse, install, update and remove | Web Fonts Developer API v1, plus the google/fonts GitHub repo for licenses | The user's own Google API key, kept in the OS keychain | Official | P1 |
| Adobe Fonts | List and preview fonts Creative Cloud installed; link out to turn them on or off | Local OS font APIs, plus links to fonts.adobe.com and the Creative Cloud app | None. The user signs in to Adobe's own app | Official OS APIs. Adobe has no third-party API | P1 |
| Purchases (MyFonts, Fontspring, Type Network, Future Fonts, Fontstore, I Love Typography, Envato Elements, foundry sites) | Spot font downloads, import them with their license, tag the store | Watch a folder and read each file's "downloaded from" data | None. macOS asks for folder access | Official, local | P2 |
| Open fonts: Fontsource, Noto, Nerd Fonts, Collletttivo, League of Moveable Type, Velvetyne | Browse about 2,100 open families; install full fonts from each project's own releases | Fontsource API for the catalog; GitHub and GitLab APIs for files | None. Optional GitHub token | Official | P2 |
| Other font managers (Monotype Fonts, Monotype Connect, Fontstand, SkyFonts) | Badge their active fonts "Managed by …", read-only; open their app | Local OS APIs, matched by file location | None | Official, local | P2 |
| Apple downloadable fonts | List fonts macOS can download; download one on request | Apple's catalog file (undocumented) and CoreText's download call (documented) | None | Listing unofficial, download official | P3 |
| Fontshare | Browse the catalog; send the user to Fontshare to download; import the zip | Fontshare's catalog endpoint (undocumented), a link, and the watcher | None | Unofficial catalog; strict license | P3 |
| Creative Market | Import purchases Creative Market syncs to Dropbox | Watch Dropbox's "Apps/Creative Market" folder | None. The user links Dropbox on Creative Market's site | Official | P3 |
| Envato Market (GraphicRiver) | List and download purchased font items | Envato API v3 | The user's personal Envato token | Official for personal use | P4 |
| Homebrew fonts (macOS) | Spot fonts Homebrew installed; show upstream updates | formulae.brew.sh JSON API | None | Official | P4 |
| Adobe Fonts metadata | Add foundry, class and page link to installed Adobe fonts | Typekit API v1 (legacy) | None | Official but unmaintained | P4 |
| Monotype Fonts API | Not built | Partner and enterprise customers only | OAuth for server apps | Gated | — |
| Font Squirrel, Open Foundry, uncut.wtf, Fontesk, Bunny Fonts, Fonts.com, Type.World | A plain link at most | — | — | See [Won't do](#4-wont-do) | — |

## 2. Library views

The sidebar has four groups. All Fonts, Font Book (Windows Fonts on Windows) and Folders exist today. Services is new.

### All Fonts

- Shows every font Fontface knows about: user folders, OS fonts and Fontface's own downloads. The Active / Inactive filter still applies.
- Fonts another app manages (Adobe, Monotype, Fontstand) also appear, with a badge and a locked switch. A filter, "Show fonts managed by other apps", can hide them (open question 2).
- Duplicates collapse with the existing preference rule. Rows managed by other apps never take part in duplicate removal.

### Font Book (macOS)

This view mirrors what Apple's Font Book app covers. It gets these sub-sections:

| Sub-section | Where the fonts live | Fontface can |
|---|---|---|
| System | `/System/Library/Fonts` and `…/Supplemental` | View only |
| Computer | `/Library/Fonts` | View, deactivate, activate |
| User | `~/Library/Fonts` | View, deactivate, activate |
| Downloaded from Apple | `/System/Library/AssetsV2/com_apple_MobileAsset_Font*/…` | View only |
| Available from Apple (P3) | Apple's download catalog | Download on request |
| Activated by apps | Any other path CoreText reports | View. Fontface's own fonts work as today |
| Font Book collections | `~/Library/FontCollections`, read through AppKit | View only |

Fonts in `/System/Library/PrivateFrameworks/FontServices.framework/Resources/Reserved` are hidden. That folder holds one private interface font file (`PingFangUI.ttc`).

How it works:

- List fonts with `CTFontManagerCopyAvailableFontURLs`, which `activation/macos.rs` already calls. CoreText is Apple's text and font system.
- That call returns one entry per face, not per file: 638 entries but 286 files on the test Mac. Remove duplicate paths and resolve symlinks first.
- Include deactivated fonts with `CTFontCollectionCreateFromAvailableFonts` and `kCTFontCollectionIncludeDisabledFontsOption`. Read `kCTFontEnabledAttribute`, accepting a boolean or a number (Apple's header and docs disagree).
- A deactivated font may not report its names. Fall back to Fontface's own metadata for that file.
- Sort fonts into sub-sections by path. Do not use the registration scope for this: every font on the test Mac reports scope 2 (persistent), even system fonts.
- "Activated by apps" means anything outside the known folders. Fontface recognizes its own fonts from its database, because Apple's API for listing registered fonts (`CTFontManagerCopyRegisteredFontDescriptors`) is unavailable on macOS.
- Deactivate and activate with `CTFontManagerEnableFontDescriptors`. Never offer this for System, Reserved or Apple-downloaded fonts. Use Font Book's words: Deactivate and Activate.
- Read collections with `NSFontCollection` (crate `objc2-app-kit` 0.3.2): `allFontCollectionNames`, then `matchingDescriptors`. Skip `com.apple.AllFonts`, `UserFonts` and `Recents`; show `com.apple.Favorites` as "Favorites". Refresh on its change notification. Never parse or edit `.collection` files.
- Font Book "libraries" are left out. Apple does not document where they are stored.
- Unknown: Font Book may hide fonts Fontface activates unless its "Show fonts managed by non-Apple utilities" setting is on. Test this before writing help text.
- License: the macOS license lets its fonts be used to display and print while running Apple software. So Fontface offers no export, copy or collect for System, Reserved or Apple-downloaded fonts.

Available from Apple (P3):

- Read Apple's catalog file read-only: `/System/Library/AssetsV2/com_apple_MobileAsset_Font*/com_apple_MobileAsset_Font*.xml` (crate `plist`). The number in the name changes between macOS releases, so match it with a wildcard. Hide the section if the file is missing.
- Show only faces whose `PlatformDelivery` includes `macOS-download` (893 on the test Mac). Never show `macOS-invisible`. Leave out `macOS-autoactivated`, which are document-support fonts that apps get by name.
- Download only when the user clicks, with `CTFontDescriptorMatchFontDescriptorsWithProgressHandler`, and show its progress. Matching with `kCTFontDownloadableAttribute` can itself start a download, so never use it as a check.
- Never fetch Apple's asset URLs directly. Never copy files out of `AssetsV2`.

Sources: [Font Book guide](https://support.apple.com/guide/font-book/fntbk1004/mac) · [CTFontManagerEnableFontDescriptors](https://developer.apple.com/documentation/coretext/ctfontmanagerenablefontdescriptors(_:_:)) · [NSFontCollection](https://developer.apple.com/documentation/appkit/nsfontcollection) · [Fonts in macOS Tahoe](https://support.apple.com/en-us/122869)

### Windows Fonts (Windows)

Windows has no Font Book. The closest thing is Settings > Personalization > Fonts. This view gets four sub-sections: All users, Current user, Microsoft Store and Available to download.

- Main source: DirectWrite, Windows' text and font system (`IDWriteFactory3::GetSystemFontSet`). Label each font with `IDWriteFontSet3::GetFontSourceType` (Windows 10 1809+): per-machine, per-user, Store package or remote (downloadable).
- Cross-check file paths with the registry keys `HKLM` and `HKCU\Software\Microsoft\Windows NT\CurrentVersion\Fonts`. A bare file name there means `%WINDIR%\Fonts`.
- Fallback: GDI's `EnumFontFamiliesExW` (names only), because fonts added at runtime with `AddFontResourceEx` may not show up in DirectWrite.
- Refresh on `WM_FONTCHANGE` and on window focus. Not every app broadcasts that message.
- Hidden fonts: read the undocumented `HKCU\…\Font Management\Inactive Fonts` value, read-only. Never write it. Fontface keeps its own deactivate state in its database.
- License: Microsoft says Windows fonts may not be copied to other computers or converted. Fontface views them in place only.

Sources: [Manage fonts in Windows](https://support.microsoft.com/en-us/windows/manage-fonts-in-windows-f12d0657-2fc8-7613-c76f-88d043b334b8) · [DWRITE_FONT_SOURCE_TYPE](https://learn.microsoft.com/en-us/windows/win32/api/dwrite_3/ne-dwrite_3-dwrite_font_source_type) · [Font redistribution FAQ](https://learn.microsoft.com/en-us/typography/fonts/font-faq)

### Folders

- Lists folders the user added. This exists today.
- New guard: Fontface refuses to add another app's protected font store, or any folder inside one. Examples are Adobe's `livetype` folder and the Monotype, Extensis and Fontstand stores. If the user adds a parent folder, the scanner skips the stores inside it.
- This matters most on Windows, where Adobe's folders are not hidden and some files end in `.otf`. On macOS only `scanner.rs::is_hidden` keeps them out today.

### Services

- A new sidebar group with one row per source: Google Fonts, Adobe Fonts, Open fonts, Purchases, and each font manager Fontface detects. Each row shows a status: Connected, Needs API key, App not installed or Not set up.
- Downloads go to a managed folder (see 3.0). It is a folder row with a new `kind = 'managed'`. It scans like any folder but shows here, not under Folders.

## 3. Integrations

### 3.0 Shared parts, built once

**Managed folder.** Downloads go to `app_local_data_dir()/Sources/<source>/<family>/<version>/`.
- macOS: `~/Library/Application Support/design.snds.fontface/Sources/…`
- Windows: `%LOCALAPPDATA%\design.snds.fontface\Sources\…`. Use the local data folder, not the roaming one, so licensed fonts never follow the user to other computers.
- Each family folder keeps its license file (OFL.txt, LICENSE, EULA PDF) next to the fonts.
- Versions sit side by side. An update downloads the new version, checks that it parses, turns off the old files, turns on the new ones, then deletes the old folder. On Windows a loaded font file is locked, so a failed delete retries at next launch.
- `activation::reconcile` must cover managed folders. Today it only touches `kind = 'user'`.
- Fontface never writes into `~/Library/Fonts` or `C:\Windows\Fonts`.

**Fonts that other apps own.** This covers Adobe, Monotype, Fontstand and SkyFonts.
- Keep them in their own table, `external_faces`: manager, PostScript name, family, style, traits and axes. Their file paths never leave the Rust side.
- `protocol.rs` refuses any path inside a protected store. `set_activation`, `reveal_font`, file hashing, `ttf-parser` scans, duplicate removal and any future export skip these fonts.
- Previews: a new Rust command draws sample text by PostScript name and returns a PNG image (macOS: `CTFontCreateWithName`, `CTLine`, `CGBitmapContext`; Windows: DirectWrite with Direct2D). CSS by family name in the web view may also work ([WebKit bug 190195](https://bugs.webkit.org/show_bug.cgi?id=190195)); test it, but plan on native drawing.
- The list of protected stores is a data file of path patterns, so it can change without a code change.

**Secrets** (API keys and tokens).
- Use `keyring-core` 1.0 with `apple-native-keyring-store` 1.0 (feature `keychain`) and `windows-native-keyring-store` 1.1. They store secrets in the macOS Keychain and Windows Credential Manager.
- Service name `fontface`, user name such as `google-fonts/api-key`. Keep dots out: Windows joins the two with a dot, and different pairs could collide. On Windows use `Local` persistence, so secrets don't roam.
- Only Rust commands touch secrets: `connect_service`, `disconnect_service` and `service_status`. They answer yes or no and never return the secret to the web view.
- Never store secrets in SQLite, `localStorage` or `tauri-plugin-store`. Skip Stronghold and the community keyring plugins: two use the old keyring v3, and `tauri-plugin-keychain` works only on mobile.
- Development builds use the older login keychain, which may ask for access after each rebuild. Move to the data protection keychain once release builds are signed with a provisioning profile.

**Network.**
- All requests go out from Rust with `reqwest` 0.13. Only optional previews load from the web view. Send a descriptive User-Agent, cache, use conditional requests (ETag) and back off on errors.
- Publish a short privacy note listing every host Fontface contacts and what it sends. Google's API terms require one.

**Sign-in.**
- No P1 to P3 integration needs OAuth, the standard "sign in and grant access" protocol. Google uses an API key, Adobe needs nothing and Envato takes a personal token.
- If one ever does, open the system browser (`tauri-plugin-opener`). Receive the answer on `http://127.0.0.1:<random port>` with `tauri-plugin-oauth` 2.1 and `redirect_uri` set. Use PKCE (Proof Key for Code Exchange, S256) through `oauth2` 5.0.
- That local listener accepts forged answers from any program on the computer, so checking the `state` value is mandatory. Never sign in inside the app's own web view; [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252) forbids it.
- Deep links (`tauri-plugin-deep-link`) are only for later "Open in Fontface" links. Treat every incoming link as untrusted.

### 3.1 Google Fonts (P1)

Google offers an official API that lists every family and links to complete desktop font files. All Google Fonts are open source, so Fontface can download and install them freely.

**User experience**

- Connect: Settings > Services > Google Fonts. Paste a Google API key. A short guide explains how: create a Google Cloud project, turn on the free "Web Fonts Developer API", create a key and restrict it to that API.
- No key: browsing and installing still work through Google's official google/fonts GitHub repo. It is slower, has no popularity sort and has a rate limit.
- Browse about 1,950 families. Sort by popularity, trending, newest or name. Filter by category, script and variable. Rows show each name in the API's `menu` font, a tiny file with just those letters.
- The type tester downloads the full font into a preview cache that is not turned on. Typed text never goes to Google.
- Install: one click per family. The variable font is the default. A "Prefer static fonts" setting installs separate weights instead, which helps older apps.
- Update: a daily check shows an update badge. Auto-update is optional. Fontface warns if PostScript names change, because documents may lose the link.
- If Google removes a family, Fontface keeps it and marks it "No longer on Google Fonts".
- Disconnect deletes the key. Installed fonts stay. A separate "Remove all Google fonts" turns them off and deletes the managed folder.

**Technical design**

- Catalog: `GET https://www.googleapis.com/webfonts/v1/webfonts?key=K&capability=VF&capability=FAMILY_TAGS&sort=popularity`. One call returns the whole list; without a key it gets HTTP 403. A second call without `capability=VF` gets the static file URLs.
- Fields used: `family`, `variants`, `subsets`, `version`, `lastModified`, `files`, `category`, `menu`, `axes` and `tags`.
- With `VF`, expect one file per style (upright and italic), as in Google's sample. Remove duplicate URLs anyway, but don't depend on that. Confirm with the first keyed call.
- Files come from `fonts.gstatic.com` as TTF. They are complete desktop fonts, not web pieces. Save them under `Sources/google/<slug>/<version>/`.
- Licenses: fetch `METADATA.pb` and the license file from `raw.githubusercontent.com/google/fonts/main/{ofl|apache|ufl}/<slug>/`. Parse with the `gf-metadata` crate (0.2.5). Ignore the `cc-by-sa/` folder, which holds articles, not fonts. Encode the brackets in file names such as `Inter[opsz,wght].ttf`.
- Material Icons and Material Symbols (9 families) have no folder in that repo. Their license is Apache 2.0 from google/material-design-icons. Show them under an "Icons" filter, not with text fonts.
- Eleven static families, such as Asap Condensed and Encode Sans Condensed, repeat the width axis of a variable sibling. Hide them when the sibling's variable font is installed.
- Caching: Google's terms (§5e) limit how long API data may be kept to the response's cache header. Keep the catalog only that long. Long-lived records of installed fonts come from the font files and `METADATA.pb`.
- Update check: a new `version`, or a new `/v<N>/` in a file URL.
- Repo fallback: the repo's `main` branch can run ahead of the live site, which updates about weekly. GitHub allows 60 unauthenticated requests an hour. Fetch one family at a time. Never clone the 3.3 GB repo.
- Opt-in, labeled unofficial: `fonts.google.com/metadata/fonts` (keyless catalog) and `fonts.google.com/download/list?family=X` (strip the `)]}'` prefix), which adds Google's extra optical-size and width statics. The old `fonts.google.com/download?family=` zip link now returns a web page.

**License and ToS guardrails**

- The user's own key is the default. A built-in key is allowed only in a closed-source build, because §4b bans keys in open-source projects.
- No Fontface server that passes on Google's data. It would re-share API content (§4a, §5e).
- Use the API only as documented (§2c) and never work around its limits (§2d). Show "Google Fonts" as plain text, with no logo or hint of endorsement (§6).
- Never install WOFF2 files or CSS2 output. They are web pieces.
- The fonts use the SIL Open Font License (OFL) 1.1, Apache 2.0 or the Ubuntu Font Licence. Keep the license with each family. Never modify fonts or generate new instances (OFL reserved names), and don't sell them on their own.
- The privacy note says that every request sends the user's IP address and Fontface's User-Agent to Google.

**Windows notes**

- Same API and files, saved under `%LOCALAPPDATA%\design.snds.fontface\Sources\google\`. Static fonts matter more, because older Office and GDI apps handle variable fonts poorly.
- A loaded font outside `%WINDIR%\Fonts` can't be replaced until it is unloaded. Updates unload first and may finish after a restart.

Sources: [Developer API](https://developers.google.com/fonts/docs/developer_api) · [Google APIs Terms](https://developers.google.com/terms) · [google/fonts](https://github.com/google/fonts) · [gf-metadata](https://github.com/googlefonts/gf-metadata) · [AddFontResourceEx](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-addfontresourceexa)

### 3.2 Adobe Fonts (P1)

Adobe gives other apps no way to turn Adobe Fonts on or off. Fontface will show what Creative Cloud has already installed and send the user to Adobe to change it.

**User experience**

- Connect: nothing to connect. Fontface checks whether Creative Cloud is installed. If it is, "Adobe Fonts" appears under Services.
- Browse fonts that Creative Cloud installed for all apps. A note explains that fonts added for Adobe apps only don't appear; the user installs them from the Creative Cloud app. Don't copy Adobe's exact button labels; they are unconfirmed.
- Each row has a locked switch ("Managed by Creative Cloud"), a preview drawn by the OS, "Open on Adobe Fonts" and "Open Creative Cloud".
- Turning fonts on or off happens in Adobe's app or website. Fontface notices when the OS reports a change.
- Adobe says fonts unused for over 150 days must be reinstalled for third-party apps. When one disappears, collections keep it as "Missing: reinstall from Creative Cloud".
- Without Creative Cloud, show one line linking to fonts.adobe.com. Don't assume a paid plan; Adobe has a free tier, though desktop fonts still need the Creative Cloud app. "Disconnect" is a setting that hides Adobe fonts.

**Technical design**

- Detect on macOS by bundle ID: `com.adobe.acc.AdobeCreativeCloud` (the app) and `com.adobe.accmac` (Core Sync, Adobe's background sync process). Check only that the store exists: `~/Library/Application Support/Adobe/CoreSync/plugins/livetype/` (macOS) or `%APPDATA%\Adobe\CoreSync\plugins\livetype\` (Windows).
- macOS listing: take the CoreText font list and keep faces whose real path is inside `livetype`. Read name, family, style, traits and axes from the font descriptor (`kCTFontNameAttribute` and friends). Never open the file.
- Refresh: listen for `kCTFontManagerRegisteredFontsChangedNotification` on the distributed notification center. Core Sync is a separate process, so the local center would miss it.
- Windows listing: walk DirectWrite's system font collection. For each face, call `IDWriteFontFace::GetFiles`, then `IDWriteLocalFontFileLoader::GetFilePathFromKey`, and keep `livetype` paths. Names come from `IDWriteFont::GetFaceNames` and `GetInformationalStrings`; the family name from `IDWriteFont::GetFontFamily`, then `IDWriteFontFamily::GetFamilyNames`.
- If DirectWrite misses Adobe fonts, use GDI's `EnumFontFamiliesExW` (names only). Refresh on `WM_FONTCHANGE` and on window focus. Save rows in `external_faces` with manager `adobe`.
- "Open on Adobe Fonts": use `https://fonts.adobe.com/search?query=<family>` until P4 metadata gives an exact page. "My Adobe Fonts" is `https://fonts.adobe.com/my_fonts`. "Open Creative Cloud" launches the app by bundle ID. Adobe documents no link straight to its fonts panel.

**Adobe metadata (P4, optional)**

- The legacy Typekit API at `https://typekit.com/api/v1/json/` still answers without a key. Its docs stop in 2011 and Adobe's developer portal for it returns 404.
- `families/<slug>` redirects to the family ID. API slugs can differ from website slugs, so use the API's `web_link`, switched to `https`, and let the website redirect.
- PostScript names come only from `families/<id>/<style>`, one call per style. So look up installed fonts only, on demand, and cache the result.
- Never mirror the whole catalog: Adobe's General Terms §6.18 ban data mining, and the Adobe Fonts terms 4.2(B) ban "excessively frequent requests". Never use web "kits"; their license covers websites only.

**License and ToS guardrails**

- The Adobe Fonts terms (October 7, 2024) §3.4(E)(7) forbid copying, moving or removing the fonts, or using them "other than … by the means we provide". (5) forbids getting around protection. (9) forbids sharing synced fonts. 4.2(C) warns of criminal penalties.
- Adobe's General Terms (October 3, 2025) §6.6 allow access only through interfaces Adobe provides. §17(B) bans reverse engineering, including working out how software stores its data.
- Our reading, not Adobe's words: listing and drawing fonts the OS already has active, through normal OS text APIs, is what every app's font menu does. The risk is low, but it is an interpretation.
- Never read, copy, hash, rename, register, unregister or reveal files in `livetype`. Tests on both OSes must prove it.
- Never read `entitlements.xml`, Core Sync's private list of fonts, without written permission from Adobe.

**Windows notes**

- The `livetype` folders `c`, `e` and `r` are not hidden on Windows, and some files end in `.otf` or `.ttf`. Only the path guard keeps them out of folder scans.
- Installed Adobe fonts show in Settings > Fonts and in GDI apps such as Notepad. They are not in `C:\Windows\Fonts` or the registry. How Core Sync registers them is unverified.

Sources: [Adobe Fonts terms](https://wwwimages2.adobe.com/content/dam/cc/en/legal/servicetou/Adobe-Fonts-Product-Specific-Terms-en_US-20241007.pdf) · [Adobe General Terms](https://www.adobe.com/legal/terms.html) · [Typekit API](https://fonts.adobe.com/docs/api) · [CTFontManagerScope](https://developer.apple.com/documentation/coretext/ctfontmanagerscope)

### 3.3 Purchases: download watcher (P2)

Most font stores have no API. Fontface instead notices font downloads, reads where they came from and imports them with their license.

**User experience**

- Set up: Settings > Services > Purchases > "Watch for font downloads". The default folder is `~/Downloads`. macOS asks the user for permission.
- When a `.zip`, `.otf`, `.ttf`, `.ttc` or `.otc` file arrives, Fontface asks, for example, "Fonts from MyFonts: add to library?"
- Import copies only desktop font files and license files into `Services/Purchases/<Store>/<Family>/` (web, app and ebook font files are left out; when a download has OTF and TTF of the same font, the OTF is kept). Font files that can't be read are listed on the find instead of being dropped silently. A folder with more than 2,000 fonts is too big to treat as one download; the panel says so and the user imports it by hand. The original download stays put. "Import zip or folder" handles older purchases; the user picks the store if Fontface can't tell.
- A newer version of an owned font (same PostScript name, higher `head.fontRevision`) gets a "Replace" offer. Apps may show the old version until restarted.
- Envato Elements fonts are marked "Subscription-bound". A "My Elements subscription ended" action uninstalls them all, because the license requires uninstalling, not just turning off.
- Fontstore trial fonts are marked "Trial, not for commercial use", with a reminder after 30 days. A "License transferred" status prompts removal. Turning the watcher off keeps imported fonts.

**Technical design**

- Watch folders with the `notify` crate.
- Origin on macOS: the `com.apple.metadata:kMDItemWhereFroms` extended attribute, a small property list holding the download URL and page (crates `xattr` and `plist`). On Windows: the `Zone.Identifier` stream's `HostUrl` and `ReferrerUrl`.
- A user-editable data file maps domains to stores: myfonts.com, fonts.com (legacy), fontspring.com, fontsquirrel.com, typenetwork.com, futurefonts.com, fontstore.com, ilovetypography.com, elements.envato.com, graphicriver.net, creativemarket.com, fontshare.com and foundry sites.
- Some unzip tools, copies to other drives and Windows "Unblock" strip the origin. Then the user tags the store. Skip online-only cloud placeholders (`cloud.rs::is_dataless`).

**License and ToS guardrails**

- Copying the user's own downloads into a library on the same computer is a normal install. Keep each license file and don't assume commercial rights.
- Never sync purchased fonts to other devices or cloud storage. Desktop licenses count users or computers, and MyFonts bans uploading to cloud platforms.
- Never sign in to stores, read account pages or get past bot checks.

**Windows notes:** same design. Files go under `%LOCALAPPDATA%\design.snds.fontface\Sources\purchases\`.

Sources: [MyFonts FAQ](https://myfonts.com/pages/faq) · [Envato Elements license](https://help.elements.envato.com/hc/en-us/articles/360000628966-License-Terms) · [Fontstore relaunch](https://www.indiantypefoundry.com/news)

### 3.4 Open fonts: Fontsource and open foundries (P2)

Fontsource offers a free, documented catalog of about 2,100 open fonts. Its own files are cut into web pieces, so Fontface gets full fonts from each project's own releases.

**User experience**

- Nothing to connect. "Open fonts" appears under Services. Families show a license badge (read from the real license file), designer and project link.
- Curated groups: Noto by script, developer fonts (Nerd Fonts), Collletttivo, The League of Moveable Type and Velvetyne.
- Install: Google families use the Google path (3.1). GitHub and GitLab projects install from a release zip, or from the repo's fonts folder at a fixed commit. Anything else gets an "Open project site" button.
- Update: compare the release tag or commit. Optional: paste a GitHub token (kept in the keychain) to raise the limit from 60 to 5,000 requests an hour.

**Technical design**

- Catalog: `GET https://api.fontsource.org/v1/fonts` once a day, then `/v1/fonts/{id}`. Compare license IDs without case (one is `mit`).
- Upstream: `/v1/registry/families/{id}` gives the project repository, revision and full license text. Its `/v1/registry/sources/{sha256}` links serve archived full fonts. These routes appear only in Fontsource's OpenAPI spec, so use them as a fallback.
- Never install `/v1/fonts` file URLs or the `/v1/download/{id}` zip. Both hold web pieces.
- GitHub limits unauthenticated `raw.githubusercontent.com` downloads too, since May 2025. Prefer release files and send ETags.
- Noto: catalog at `https://notofonts.github.io/noto.json`. Release zips are tagged `<Family>-v<version>`. Use `unhinted/otf` or `full/variable-ttf`. CJK fonts live in `notofonts/noto-cjk` and are large. Skip faces macOS already has.
- Nerd Fonts: `releases/latest`. Skip `FontPatcher.zip`, which is a tool. Check each zip against `SHA-256.txt`.
- Collletttivo: a GitHub user account with no releases. Take only the `fonts/` folder. Don't skip forked repos, because Sprat is one. Show their credit line and donate link, as they ask.
- League of Moveable Type: 18 font repos. Skip `fontship` and `licenses`. Read each repo's OFL file, because GitHub's license field is usually empty.
- Velvetyne: GitLab group API. Not every project is a font. Read the license per font; Velvelyne uses the CUTE license. Velvetyne's website returned errors on 2026-10-12; a mirror is at velvetyne.alwaysdata.net.
- Save under `Sources/open/<source>/<family>/<version or commit>/` with the license.

**License and ToS guardrails**

- OFL: keep the license, don't rename or modify, and don't sell a font on its own.
- Fontsource allows at most 2,500 requests per 10 seconds; Fontface stays far below. Add a "Sponsor Fontsource" link in About, as their docs ask. Stay within GitHub and GitLab limits.

**Windows notes:** same design. Users may already have Nerd Fonts from Scoop, so match duplicates by PostScript name.

Sources: [Fontsource API](https://fontsource.org/docs/api/introduction) · [Fontsource OpenAPI](https://api.fontsource.org/openapi.json) · [GitHub rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) · [Raw download limits](https://github.blog/changelog/2025-05-08-updated-rate-limits-for-unauthenticated-requests/)

### 3.5 Fonts managed by other apps (P2)

Monotype Fonts, Monotype Connect (formerly Extensis Connect) and Fontstand offer no API to other apps. Fontface will label their active fonts and leave them alone.

**User experience**

- Rows read "Managed by Monotype Fonts" (or Monotype Connect, Fontstand or SkyFonts). The switch is locked. An "Open <app>" button launches that app. Fontstand rentals vanish when they end; Fontface marks them missing.
- Leaving Suitcase or Connect: a guide points the user to that app's "File > Collect Fonts for Output" for fonts they own. The user then adds the collected folder.

**Technical design**

- Match active fonts from the CoreText or DirectWrite list against the protected-store table by path. Save them in `external_faces`.
- Known signs: Monotype Fonts at `/Applications/Monotype Fonts/` and `%LOCALAPPDATA%\Monotype Fonts`. Legacy Connect vaults at `~/Library/Extensis/Connect Fonts/` and `%LOCALAPPDATA%\Extensis\Connect Fonts\`.
- The font stores of Monotype Fonts 7.x, Monotype Connect 28.x, Fontstand and SkyFonts are undocumented. Check on a computer with each app. Monotype's app warns when another font manager runs, so test whether it flags Fontface.
- Monotype's API is not planned. It is for partners and enterprise customers. Its user sign-in works only for server apps that can keep a secret. File downloads depend on the contract and count as a desktop use.

**License and ToS guardrails**

- Never copy, decrypt, parse or re-host another manager's cache or vault. Never turn their fonts on or off; two managers fighting over one font causes conflicts.
- Fontstand doesn't let users work with rental files directly. Fontface never keeps them.

**Windows notes:** same design, with the GDI fallback from 3.2.

Sources: [Monotype API FAQ](https://support.monotype.com/en/articles/8805298-api-faqs) · [Monotype uninstall paths](https://support.monotype.com/en/articles/9267766-uninstalling-monotype-desktop-app-v7-x-x) · [Connect release notes](https://www.extensis.com/support/connect/release-notes) · [Fontstand help](https://fontstand.com/help)

### 3.6 Fontshare (P3)

Fontshare's fonts are free, but its 2026 license forbids other apps from handing them out. Fontface will show the catalog and send the user to Fontshare to download.

- Browse 100 families, such as Satoshi and General Sans, with their license: ITF Free Font License (64) or OFL (36). The catalog comes from `GET https://api.fontshare.com/v2/fonts` (undocumented, about 830 KB), at most once a day, from Rust.
- "Get on Fontshare" opens `https://www.fontshare.com/fonts/<slug>`. The user clicks "Download Family" there, which accepts the license. The watcher then imports `<Name>_Complete.zip`'s OTF files unchanged, with the license.
- Don't load Fontshare web fonts inside the app for previews. Show the Fontshare page instead.
- Guardrails: the ITF Free Font License v2.0 (17 August 2026) bans subsetting, format conversion and renaming. It bans distribution through "another … application or platform". Each user must get their copy from Fontshare.
- In-app downloads stay off for ITF-licensed fonts unless ITF gives written permission. The 36 OFL families may get in-app download later. Windows works the same.

Sources: [ITF Free Font License](https://www.fontshare.com/licenses/itf-ffl) · [Fontshare catalog](https://api.fontshare.com/v2/fonts)

### 3.7 Creative Market via Dropbox (P3)

Creative Market can copy purchases into the user's Dropbox, under Apps/Creative Market. Fontface watches that folder.

- Find Dropbox from its `info.json` (`personal.path` or `business.path`): `~/.dropbox/info.json` on macOS, `%APPDATA%\Dropbox\info.json` or `%LOCALAPPDATA%\Dropbox\info.json` on Windows. Don't hard-code the path; names vary, such as "Dropbox-Personal".
- Read only inside `Apps/Creative Market`. Skip online-only placeholders, so Fontface never downloads a whole Dropbox.
- Import like the watcher (3.3). The user syncs each item with its "Sync" button on Creative Market. Updates never re-sync on their own.
- Guardrails: the license tier varies (personal, commercial, extended). Keep the license and don't assume commercial rights.

Sources: [Syncing to Dropbox](https://support.creativemarket.com/hc/en-us/articles/203387294-Syncing-your-Purchases-to-Dropbox) · [Locate the Dropbox folder](https://help.dropbox.com/installs/locate-dropbox-folder)

### 3.8 Envato Market (P4)

This is the only store with a self-serve API for listing and downloading purchases.

- The user creates a personal token from a pre-filled link (`https://build.envato.com/create-token/?default=t&purchase:download=t&purchase:list=t`). It goes in the keychain.
- List with `GET https://api.envato.com/v3/market/buyer/list-purchases`. There is no font filter, so pick items by their GraphicRiver URL or `/catalog/item`'s `classification`.
- Download with `GET …/buyer/download?item_id=<id>`, which returns a `download_url` and counts against a daily limit. Respect HTTP 429 and `Retry-After`. Keep item data at most 6 hours.
- Guardrails: a personal token is fine for the user's own use; Envato's own WordPress plugin does the same. If Fontface is shared with others, Envato's terms (s.8) require its OAuth sign-in page, which needs a small server. Show "Powered by Envato API" and keep "Envato" out of the app's name.

Sources: [Envato API](https://build.envato.com/api/) · [Envato API terms](https://build.envato.com/terms/)

### 3.9 Homebrew fonts (P4, macOS)

- `https://formulae.brew.sh/api/cask.json` (about 19 MB, fetched weekly) lists 2,602 font packages with upstream link, version and file names.
- Use it to mark fonts in `~/Library/Fonts` as "Installed by Homebrew", so Fontface doesn't fight Homebrew. Also show upstream updates and an "Open upstream" link.
- Never run `brew` or download from these links automatically. There is no license field, and some point to restricted fonts. On Windows, Scoop and winget were not studied.

Sources: [Homebrew API](https://formulae.brew.sh/docs/api/)

## 4. Won't do

These would copy or decrypt licensed fonts, break a service's terms or get around its protection.

- Read, copy, move, rename, hash, register, unregister or reveal Adobe's `livetype` files. This includes the "extractor" scripts' approach.
- Read Adobe's `entitlements.xml` or call Core Sync's private download links without written permission from Adobe.
- Copy, decrypt, parse or re-host any font manager's cache or vault (Monotype, Connect, Suitcase, Fontstand, SkyFonts). Turn their fonts on or off.
- Use Monotype's font download API without a contract and a written license review.
- Get past a bot check, firewall challenge or CAPTCHA (Font Squirrel, Fontspring, uncut.wtf). Scrape web pages (fonts.adobe.com, Open Foundry's page data, Fontesk, store account pages) or sign in to a store for the user.
- Use Font Squirrel's old API. Its owner's terms ban automated scraping, and the site starts blocking after a few requests. Link out instead.
- Integrate Bunny Fonts, coollabs, Fontsource web files or Google's CSS2 and WOFF2 output as installs. They are web pieces, not desktop fonts.
- Integrate Fontesk (mixed personal-use licenses; terms ban data mining), Fonts.com (closed in 2024) or Type.World (shut down in October 2023).
- Convert, subset, rename or modify any font, or generate instances from variable fonts.
- Sync licensed or purchased fonts to other devices or cloud storage. Re-host font files. Pass Google's API data to other users through a server.
- Mirror whole catalogs where the terms ban data mining (Adobe's Typekit API).
- Embed an API key in an open-source build. Show a secret to the web view or store it in SQLite, `localStorage` or `tauri-plugin-store`. Sign in inside an embedded web view.
- Export, copy or sync macOS or Windows system fonts or Apple-downloaded fonts. Fetch Apple's font asset URLs directly.
- Write Font Book's private files, fontd's state or Windows' `Inactive Fonts` value.
- Use anything from Typeface's app or its hosted Google Fonts catalog.

## 5. Open questions

1. **Will Fontface be open source?** If yes, Google's terms rule out a built-in key, so every user brings their own. Envato would also need OAuth through a server.
2. **Other apps' fonts in All Fonts?** Recommended: show Adobe and other managed fonts in All Fonts with a badge, and also under their own Services row, with a filter to hide them. Agree?
3. **Google Fonts: on demand or "sync all"?** Syncing everything takes 2–3 GB, plus about 1 GB for Noto and other scripts. Recommended: on demand, with an optional "Download all".
4. **Static fonts from where?** The official API gives only named weights. Google's unofficial download list adds optical-size and width statics. Allow the unofficial source as an opt-in?
5. **Online previews?** Google CSS2 and jsDelivr previews send the user's IP address to those hosts. Recommended: local previews only, with online previews as an opt-in.
6. **Ask for permission?** Email ITF about in-app Fontshare downloads. Ask Adobe about reading `entitlements.xml`, which would show fonts added for Adobe apps only. The `fontintegrations@adobe.com` address came from a forum poster, not a confirmed Adobe contact.
7. **Test hardware.** Can you lend or set up a Mac with Creative Cloud, and ideally Monotype Fonts, Monotype Connect and Fontstand? We need to confirm where they keep fonts and how the OS lists them. A Windows 11 24H2 machine is needed for the Windows questions.
8. **GitHub token.** Allow users to paste one for higher download limits?
9. **Font Book.** Should Fontface deactivate fonts in `/Library/Fonts` and `~/Library/Fonts` (untested whether that survives logout), or leave it to Font Book? Should it ever publish its collections into Font Book?
10. **Signing.** The data protection keychain needs a Developer ID build with a provisioning profile. When should that happen?
11. **Envato.** GraphicRiver's font catalog is small. Still worth building?

Checks to run before shipping:

- Adobe: do installed fonts appear in `CTFontManagerCopyAvailableFontURLs` with `livetype` paths, and which scope does `kCTFontRegistrationScopeAttribute` report? Do CSS family names work in the web view? On Windows, how does Core Sync register fonts, and does DirectWrite see them?
- Font Book: does it hide fonts Fontface activates unless "Show fonts managed by non-Apple utilities" is on?
- Windows: does `GetSystemFontSet` include per-user fonts? Do `HKCU` font values that point outside `%LOCALAPPDATA%\Microsoft\Windows\Fonts` load at sign-in? If not, update the Windows plan in [ARCHITECTURE.md](ARCHITECTURE.md) to re-apply activation at sign-in instead.
- Google: run one keyed call. Check the `VF` file layout, the cache header and the quota in Google Cloud.
