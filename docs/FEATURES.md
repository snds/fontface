# Feature plan and parity checklist

"Parity" means: the feature works the way a font manager user expects, checked against
Typeface's *public* feature list and docs. No Typeface code or binaries are used.

Status: ✅ done · 🟡 partial · ⬜ not started. Each item gets checked on macOS first, then Windows.

## Phase 1: Library, previews, activation (current)

| Feature | macOS | Windows | Notes |
|---|---|---|---|
| Add / remove watched folders | ✅ | ⬜ | Nested folders are refused; parent folders absorb children |
| macOS font folders added automatically | ✅ | ⬜ | ~/Library/Fonts, /Library/Fonts, /System/Library/Fonts; always on, with a lock that says "Part of macOS" (/System/Library/Fonts) or "Installed" (the other two) |
| Scan .ttf / .otf / .ttc / .otc | ✅ | ⬜ | Rescans skip unchanged files (size + modified time) |
| Scan progress, per-folder spinner, Cancel | ✅ | ⬜ | Progress during discovery and reading; fonts appear while scanning |
| Online-only cloud files (Google Drive, iCloud) | ✅ | ⬜ | Detected; read 8 at a time so downloads overlap; count shown |
| Unreachable folder never wipes the library | ✅ | ⬜ | Removal only after a complete walk |
| Rescan all folders at launch | ✅ | ⬜ | Quiet unless something changed; can be turned off in Settings |
| Switches show the real OS state | ✅ | ⬜ | Reflects fonts turned on/off by other apps (e.g. Typeface); refreshed when the window regains focus |
| On/off results confirmed with macOS | ✅ | ⬜ | Explains when another app or Font Book keeps a font on/off |
| Duplicate copies shown as one style | ✅ | ⬜ | "×N" badge; turning on registers one preferred copy, turning off covers all copies |
| Online-only files never stall a scan | ✅ | ⬜ | Fast readers skip them instantly; 3 background downloaders fetch them |
| Group by family, expand to styles | ✅ | ⬜ | Representative face = closest to Regular (by its style's words, where the font's numbers are wrong). Families are grouped by name too: see **Family groups**. Grouping can be turned off in View options |
| Custom preview text + size | ✅ | ⬜ | An icon shows when the typed text uses characters the font doesn't have ("Not in this font: …") |
| Previews for symbol, icon, Expert and script fonts | 🟡 | ⬜ | A font that can't draw its name shows its name tidied (™ dropped, "-" as a space) or in capitals or lowercase, its own sample text, or a run of its real characters with a quiet badge: Symbols, Expert set, the script's name, or Partial set. Expert sets are found by their shared placeholder shape, empty letter slots or Expert glyph names, plus "Expert"/"Exp" in a name. Icon fonts that can draw their names, but whose names say icons and that hold a big private-use icon set (Material Symbols, Google Symbols), show their icons too. Families show a style that can draw its name. Worked out by the scanner, once in the background for fonts scanned before, and on demand; online-only and Adobe files are never read for it. A file that's slow or stuck (say on a network share that stopped answering) never holds up other rows: a preview waits at most 300 ms for its profile, then shows the name (here and on the Google Fonts page). Not yet checked in the running app |
| Previews never clipped; baselines line up | 🟡 | ⬜ | Tall fonts (LI Glyphs, Zapfino, Christiana) are fitted into the row instead of cut off: moved, and shrunk (to half size at most) only when taller than the row. Baselines sit at the same height from row to row. Also in the Google Fonts and Adobe Fonts lists. Not yet checked in the running app |
| Lazy preview loading (large libraries) | ✅ | ⬜ | Virtualized list; faces load only when on screen |
| Collection faces preview individually | ✅ | ⬜ | Face is extracted from the .ttc in Rust |
| Activate / deactivate a style or family | ✅ | ⬜ | Persistent by default: stays on after quit and restart. Temporary mode in Settings |
| Activation survives app not running | ✅ | ⬜ | CoreText persistent user scope |
| Re-apply activations at launch and after scans | ✅ | ⬜ | Keeps intent if a file is only temporarily unreachable |
| Font page: waterfall, paragraph, characters, metadata | 🟡 | ⬜ | Replaces the side detail panel (see **Font page and Back**). The waterfall shows the pangram only when the font has its letters (else its own text), and grows a row instead of clipping tall ink. "Character set" on the Info tab. Not yet checked in the running app |
| Characters grid | 🟡 | ⬜ | On the font page's Characters tab. Every real character of the font, by Unicode block (the biggest block first), with a summary line ("166 characters, all in Private Use Area …", "Expert set: 60 real characters; 175 slots share one placeholder (hidden)"). Hover shows the code point and glyph name; click or Enter copies the character. Arrow keys move between cells. 512 per block, then "Show all". A search box finds typed characters or U+ codes (also ranges, "U+0041-U+005A"), and says which ones the font doesn't have (screen readers hear each result, the first one too); searching by character name isn't there yet. Not yet checked in the running app |
| Variable font axis sliders | 🟡 | ⬜ | The font page's Axes tab (variable styles only): a slider and a number field per axis; the values also show in Specimen and Characters. In the number field, a value in range shows as you type, Return or leaving the field applies it (kept within the axis's range), and Esc goes back to the value from before you typed. Not yet checked in the running app |
| Search by family / style / PostScript name | ✅ | ⬜ | |
| Show in Finder / Explorer | ✅ | ⬜ | |

## Views and services (2026-10-12)

| Feature | macOS | Windows | Notes |
|---|---|---|---|
| All Fonts view | ✅ | ⬜ | Everything Fontface knows about |
| Font Book view (Windows: "Windows Fonts") | ✅ | ⬜ | OS-installed fonts. The three macOS font folders are one source; each is in the toolbar's folder picker |
| Active / Inactive filter on any view | ✅ | ⬜ | Toolbar segments. Hidden in the Active entry, where it would add nothing |
| Variable filter on any view | ✅ | ⬜ | Toolbar toggle: lists only variable styles, and only the families that have one; combines with All / Active / Inactive and search, and the counts follow it |
| Seamless top bar | 🟡 | n/a | No separate title bar: the window buttons sit in the sidebar's top strip, and the 52px top row (toolbar, page headers, the font page's header) moves the window, also while a dialog is open. Double-click does what macOS's "Double-click a window's title bar" setting says (zoom, minimize or nothing). Full screen drops the strip. Windows keeps its native frame. Not yet checked in the running app |
| Toolbar fits narrow windows | 🟡 | ⬜ | As the toolbar narrows (a small window), the count goes first, then Variable shows only its icon and the size slider shortens, then the preview text box and the slider go. Search always keeps room to type |
| Google Fonts: browse, download, update, remove | ✅ | ⬜ | The Google Fonts row lists the Google fonts in your library; Browse opens the catalog as a page with Back. Keyless: Fontsource catalog + google/fonts repo files; downloads go to a managed folder and are turned on. An update downloads only the files that changed upstream (by each file's ETag); unchanged files are reused. If none changed, nothing is turned off or swapped and the page says it was already up to date |
| Google Fonts: icon fonts (Material Icons, Material Symbols) | 🟡 | ⬜ | The 5 Material Icons styles and the 3 variable Material Symbols come from google/material-design-icons with its Apache 2.0 license (LICENSE.txt), and download, update, remove and turn on like other families. Listed under Icons with Apache-2.0 (Fontsource says OFL). The static "Material Symbols" entry is hidden: it's the same icons as Material Symbols Outlined. Downloaded icon families preview as five icons on the Google Fonts page, and as icons in the library list; Two Tone, a color font drawn in black, draws light in the dark theme. Updates are offered when the files change upstream (asked about on each catalog refresh), not by Fontsource's date, which runs ahead of Google's weekly push. An update in which nothing changed leaves the fonts on and says "already up to date". Checked live (all 8 download and parse); not yet checked in the running app. INTEGRATIONS.md §3.1 |
| Adobe Fonts: list fonts Creative Cloud turned on | ✅ | ⬜ | Read-only by design (Adobe's terms); links to Adobe; untested with CC installed |
| Font Book: deactivated fonts, collections, Apple downloadable fonts | ⬜ | ⬜ | See INTEGRATIONS.md §2 |
| Purchases watcher (MyFonts, Fontspring, …) | ✅ | ⬜ | Watches Downloads (or chosen folders); a file, zip or unzipped folder counts as one download; store from the download's origin; copies desktop fonts + licenses into a managed folder; Subscription badge and "subscription ended" removal; a trial badge; manual import of zips/folders; fonts recognised by content, so a download tidied into a subfolder isn't offered again; single files of one family share a folder |
| Purchases: trial reminder after 30 days, "License transferred" status | ✅ | ⬜ | Reminder on the Purchases page with "Remove" and "I bought it" (clears the trial flag, also after a Replace); "License transferred…" turns the fonts off, removes the copy and never offers that download again |
| Purchases: "newer version available" offer | ✅ | ⬜ | "Replace" instead of "Add to library" when a download has the same store, the purchase's families and some of its fonts (by PostScript name) in different files. Version numbers aren't compared |
| Open fonts catalog (Fontsource, Noto, Nerd Fonts, open foundries) | ⬜ | ⬜ | INTEGRATIONS.md §3.4 |
| "Managed by" badges for Monotype Fonts, Connect, Fontstand | ⬜ | ⬜ | INTEGRATIONS.md §3.5 |

## Font page and Back (2026-10-18)

The first stage of the library redesign. Checked with unit tests (`npm run test:ui`) and in a
browser against a stand-in back end; not yet checked in the running app.

| Feature | macOS | Windows | Notes |
|---|---|---|---|
| A click selects; double-click or Return opens | 🟡 | ⬜ | Cmd-click and Shift-click only select. Right-click selects and shows the menu, and never opens. A family row opens its family; a style row opens its family on that style |
| Font page in the main area | 🟡 | ⬜ | Opens over the list, which stays as it was underneath. Its top row: Back, the family name and style count, a style picker, the family switch (n/total) or the lock, Tags, and More (Show in Finder, Copy PostScript Name, Family Group…). Tag chips with remove buttons sit under it. Tabs: Specimen (waterfall, a paragraph, every style with its own switch), Characters, Axes (variable styles only) and Info (adds full name, file date, and each copy's place with Show in Finder). Right-click anywhere for the tag menu; on a style's line it covers that style. Tab goes from the tabs to the open tab's content, which shows a focus ring and scrolls with the arrow keys. In "All styles", a style's preview loads when its line comes near the screen. It always shows the whole family; opened from a Variable-only list, the variable style comes first. The tab used last is remembered |
| Back | 🟡 | ⬜ | The Back button, Cmd+[ (Alt+Left on Windows), the mouse's back button where the system passes it on, and Esc when focus isn't in a text field, menu or popover (in a text field Esc leaves the field first). The list comes back at the same scroll position, with the row that opened the page focused, and "Back to …" is announced. If that row has left the list meanwhile (a filter, or a tag removed on the page), the row that took its place is focused instead. A sidebar click closes the page instead; the list falling back to All Fonts by itself (a deleted or hidden tag, a removed folder) keeps it. Cmd+F leaves a font page and puts focus in Search; on the Google Fonts catalog it goes to the catalog's own search instead, and on the Purchases page it does nothing, so neither page closes |
| Keyboard in the list | 🟡 | ⬜ | The list is one Tab stop (plus the active row's expand, tag and on/off controls). Up/Down, Home/End and Page Up/Down move and select (Shift extends; Cmd-Up/Down go to the ends), Space adds or removes a row, Right and Left expand and collapse a family, Return opens, Cmd-A selects all, Esc clears, Shift-F10 opens the active row's menu. Tabbing into the list, or any of these keys, brings its active row back into view if it was scrolled away; while it's out of sight, the ring shows on the list. Focus on a row that leaves the list moves to a neighbor (a collapsed family's row, or the row that took its place). Screen readers hear each row's name, style count and on/off state, then its places, marks (Mono, duplicates, copies, a sample preview), missing characters and tags |
| The font leaves the library while its page is open | 🟡 | ⬜ | The page says "This font isn't in your library anymore" and offers Back. A rescan or a removed folder can cause this |

## Tiles, Table and View options (2026-10-18)

The second stage of the library redesign. Checked with unit tests (`npm run test:ui`, `cargo
test`) and in a browser against a stand-in back end with 12,000 families; not yet checked in the
running app.

| Feature | macOS | Windows | Notes |
|---|---|---|---|
| Three layouts: Tiles, Rows, Table | 🟡 | ⬜ | A switch at the right of the toolbar (it folds into View options when the toolbar is narrower than about 800px), Cmd+1, Cmd+2 and Cmd+3, or View options. Saved as a setting, so it survives a relaunch; Rows stays the default. Selecting, the keyboard, double-click or Return to open, right-click menus, dragging onto tags, previews, badges, locks and switches work the same in all three. Switching keeps the selection (selected styles become their families in Tiles), brings it into view, and keeps keyboard focus in the list. Every layout draws only what's on screen, keeps its place while a scan adds fonts above, and keeps keyboard focus in the list when a focused switch scrolls away. The shortcuts wait while a menu or dialog is open |
| Tiles | 🟡 | ⬜ | A grid of cards: name, style count and a small switch or lock; one fitted preview line; places, up to 4 tag dots and "+n", Variable and Mono, and the sample badge. Cards are at least 5.5 × the preview size wide (180–520px), as many as fit across; the first family showing stays at the top when the window or the size changes, even back and forth. A grid for screen readers: Left and Right go card by card, Up and Down by line. Cards have no tag button (no room): tag from the right-click menu (Shift-F10), the selection bar, or by dragging |
| Table | 🟡 | ⬜ | Columns: on/off, Name (with expand), Preview, Styles, Weights ("300–900", "Variable 100–900"), Foundry, Format, Source, Added and Tags; Version, Designer, File, Size and Glyphs can be added. Preview is on by default: 18px at the default size, following the slider within 12–32px; turned off, the table loads no font files at all. Click a header to sort (announced; again to turn it round). Right-click the header row, or use View options, to show or hide columns. Drag a column's edge, or press Shift+Left or Shift+Right on its header, to resize (the new width is announced). The header stays at the top, and on/off and Name stay at the left while the table scrolls sideways. Compact (28px) or Regular (32px) rows, 40px or more with Preview. A treegrid for screen readers: the header row is one Tab stop, Right and Left expand and collapse families, and each row reads its shown columns after its name ("Foundry: Rasmus Andersson.") |
| View options | 🟡 | ⬜ | The tune button: layout, Group styles into families, Sort by (with its direction), and in Table the row height and columns. Every choice is saved as a setting, so Reset covers it |
| Group styles into families: off | 🟡 | ⬜ | Every style becomes its own item, named "Family Style", in every layout. Each family's styles stay together, lightest first |
| Sort | 🟡 | ⬜ | Name, Date added (newest first), Number of styles, Weight (lightest first), Foundry, and On or off, each either way round; the Table's other columns (Format, Source, Version, Designer, File name, File size, Glyphs) sort from their headers. Fonts that don't say (no foundry, no date yet) go last; ties go by name. Versions sort as decimals, as font versions are meant (1.009 before 1.1). A new sort keeps the active row in view, else goes back to the top. The sort is announced |
| Preview size shortcuts | 🟡 | ⬜ | Cmd+= and Cmd+- step through 12, 16, 24, 32, 48, 64, 96 and 128, and say the new size (below 12, Cmd+- leaves it). Like the slider, the size isn't saved (the default size is in Settings) |
| When fonts were added | 🟡 | ⬜ | A font is dated when a scan first lists it. Fonts listed before this version get their file's creation date (its modified date where the disk keeps none, else the date their folder was added), once, in the background at the next launch; fonts on a drive that isn't connected wait for a launch when it is. That reads only file information, so online-only files aren't downloaded. Shown in the Table's Added column and used by Date added |
| Loaded fonts stay bounded | 🟡 | ⬜ | Fonts that no row shows stay loaded up to 500; past that, the one unused longest leaves the page and loads again if it comes back on screen. Scrolling through 12,000 tiles keeps the page at about 540 loaded fonts |

## Smart entries, Sources and font states (2026-10-18)

The third stage of the library redesign. Checked with unit tests (`npm run test:ui`, `cargo
test`) and in a browser against a stand-in back end; not yet checked in the running app.

| Feature | macOS | Windows | Notes |
|---|---|---|---|
| Smart entries under Library, with counts | 🟡 | ⬜ | All Fonts; Your Fonts (fonts with a copy outside the OS's font folders: your folders, Google Fonts, Purchases); Recently Added (added in the last 30 days, newest first, each item saying when in Rows and Tiles; sorting it another way doesn't change the library's sort); Active (on now, leaving out the fonts macOS always keeps on; All / Active / Inactive is hidden there); Not Tagged (none of your own tags; built-in tags don't count). Each but All Fonts can be hidden in Settings › Sidebar |
| One flat Sources section | 🟡 | ⬜ | Font Book (the three macOS font folders as one source), Google Fonts, Adobe Fonts, Purchases (with its "n new" badge), then your folders A to Z, one row each, with no chevrons; + adds a folder. Location colors show on each row. Right-click a row, or press Shift-F10 on it, for what applies to it: Rescan or Stop, Show in Finder (one folder), Locate… (a folder that moved), its color, and Remove from Library… (your folders). Rows with folders (Font Book, Google Fonts and Purchases once they have fonts, and your folders) also show Rescan or Stop on hover, and your folders Remove. A click anywhere on a row opens it, its count and "n new" badge included |
| Folder picker on a source's view | 🟡 | ⬜ | In the toolbar on Font Book (its three folders), Google Fonts, Purchases and your folders, when there are folders inside: narrows the list to one. A search field and a tree with each folder's style count and color; Up and Down move, Right and Left open and close, Return picks, Esc closes; right-click or Shift-F10 changes a folder's color. The source's row stays selected. Back from a font page says the folder's name |
| Google Fonts and Purchases list your fonts from them | 🟡 | ⬜ | Their rows show the library's fonts from that source, in any layout with sort and filters. Browse (with the number of new downloads, for Purchases) opens the catalog or the Purchases page as a page with Back; Back puts focus on Browse again. "Review" on a new-download message and Settings › Purchases › Open Purchases go there too. With nothing from the source yet, the list offers Browse. Adobe Fonts still opens its own page |
| Font states with a mark, a tooltip and screen-reader words | 🟡 | ⬜ | In Rows, Tiles, Table, the font page's header and its "All styles" lines: Part of macOS and Installed (a lock that says which); on until logout (a timer); on; partly on ("n/total" of the styles that are on in Rows and on the font page; a partly filled circle in Tiles and Table, where there's no room for the count); set to turn on but not on (its file may be on a drive that isn't connected, or online-only, or macOS didn't load it, say because it's turned off in Font Book: a paler switch and a link_off mark); turned on by another app (an info mark); off. A family shows the first mark that applies and its tooltip says the rest ("3 of 12 styles are on." "2 styles are on until you log out or restart."). With "Turn temporary fonts off when Fontface quits" on, on until logout says "until you quit Fontface, log out or restart". While a request runs, its spinner takes the mark's place. Screen readers hear the short state in each item's name and the rest in its description and the switch's. The states show as soon as a switch is done, including another app keeping a font on and macOS not loading one. The Info tab says the chosen style's state and each copy's ("On until logout", "On (another app)", "Set to turn on") |

## Family groups (2026-10-18)

The fourth stage of the library redesign: fonts whose family name carries a style ("AmintaBold",
"Aaux ProBlack Italic OSF", "Dynasty Heavy") are listed as styles of their family, wherever
their files are. Checked with unit tests (`npm run test:ui`: every example and guard below;
`cargo test`), on a copy of Sean's library, and in a browser against a stand-in back end; not
yet checked in the running app.

| Feature | macOS | Windows | Notes |
|---|---|---|---|
| Families grouped by name, wherever the files are | 🟡 | ⬜ | Folders are never a requirement, a signal or a guard, and neither is the order the library lists its rows in (a folder removed and added again gives its fonts new ids). On a copy of Sean's library: 3,370 families by the fonts' own names become 2,700 (803 names join a family; Aaux Pro gathers 50, Klavika 42, Roice 40, FarnhamDisplay 27, District 25), the same in every row order tried, with every folder renamed and whichever copy is on. When copies of one font carry different names of one family, it's grouped by the one whose names agree with its PostScript name, else the more general one ("Blindfish" over "BlindfishDemi"), never by its path; and a family whose every style also has a copy carrying a name more of the library has goes by that one (a per-style folder's "House-A-Rama-Kingpin", whose family-folder copy says "House-A-Rama", style Medium, is House-A-Rama's Kingpin). A style's label comes from the copy whose names say it best ("Light LF" for Engine-LightLF, not its other copy's "Medium"; "Expert Cameo" for ZeitgeistExpertMT-Cameo in Zeitgeist MT, not its family-folder copy's "Regular", which only a font with a copy of that family's name gets: Times New Roman moved into Times Roman stays "Times New Roman"), never from one whose label would name another family. A family only some of whose styles have such a copy stays whole (LTUnivers-Cond) |
| What joins a family on its own | 🟡 | ⬜ | A name ending in weight, slope or variant words (Bold, Black Italic, OSF, SC, Expert…), or differing only in spelling ("BigCaslon" / "Big Caslon"), whose base is a family in the library or the base of another name, and something else agrees: the PostScript name's family part, the same foundry or designer, or the weight number within 100 of the weight word. Abbreviations (Lt, Bd, Ital…) count only when the PostScript name agrees. See **The rules** below |
| What's only suggested | 🟡 | ⬜ | Width words (Condensed, Narrow, Extended…), size words (Display, Text, Caption…) and numbered styles ("Univers 45 Light"); a font that names its own family (name ID 16); different foundries; names nothing else backs. A family that others would join and that would join another family itself takes them along ("Neutra Text TF" and Neutra Text into Neutra), so "Merge all" leaves nothing behind. A width, size or numbered name is suggested for the longest name left that's a family as the families stand ("Times New Roman Condensed" and "Times New Roman 2 Bold" for Times New Roman, not "Times New"; "Gill Sans Light 2 Italic" for Gill Sans when grouping lists Gill Sans Light there), and names with no such family make one from what they share. The reason given is the word taken off first ("MINI 7 Condensed" into MINI 7: Width word “Condensed”). 89 suggestions (202 families) on Sean's library |
| Style names and order inside a family | 🟡 | ⬜ | A grouped style is named by the words past its family, spelled the usual way, then its own style unless that's Regular, Roman, Plain or Normal: AmintaBlackItalic is "Black Italic", Dynasty Heavy Italic "Heavy Italic", AauxPro-BlackOSF "Black OSF", FarnhamDisplay-RegItalSwash "Regular Italic Swash". An old Fontographer "Medium" (stored at 400) isn't added to a weight the name already says (VisageBold is "Bold", not "Bold Medium"). In every family, styles sort upright before italic, narrow to wide, light to heavy, then a plain style before its variants (Alt, Caps, LF). The weights come from the fonts' own numbers when those tell the styles apart (BB Strata Pro numbers its styles 100 to 500 on purpose), and from the styles' names where the numbers are shown wrong (1,583 of Sean's faces say 400; 406 italics aren't flagged): whole words before abbreviations ("Semi Medium" is Medium), the word nearest the number ("Book Heavy" at 850), and "Regular" never changes a lone style's number (Pokerface stays 900). The family's preview uses its most regular plain style. The Table's Weights column, the Weight sort and a one-style row in Rows go by the same weights. Rows, Table, Tiles, the font page, menus and "Family Style" items use these names; search finds them too |
| Family groups page | 🟡 | ⬜ | From View options, a font's right-click menu or the font page's More menu ("Family Group…", with its styles checked), and Settings › Library. Back, All · Suggested (n) · Your changes, a search box and Undo. All and Your changes list families with their styles as a tree of check boxes (one Tab stop; Up and Down move, Right and Left open and close, Space checks, a family checks all its styles, Cmd-A, Esc), each style with its PostScript name, source and "from <its own name>". Check styles, then "Group N styles selected into family: [type or pick] Apply", Keep separate (they stay under their own names), or Clear my choices. Suggested lists "Merge 3 families into Farnham (4 styles)" with each family's reason and a check box, Merge and Keep separate, and "Merge all suggestions (n)" after asking. Your changes also lists a family you kept out of the suggestions (a "Kept separate" badge), and Clear my choices on its styles forgets that. Every change says what it did with Undo, and the page's heading takes focus each time it's opened, from Settings too |
| Settings › Library › Group families by name | 🟡 | ⬜ | On by default. Off, families use the fonts' own names; your own merges, moves and Keep separate still apply, and what grouping would merge is listed under Suggested. A style whose other copy names its family still joins it (MorganAvec-BoldCaps, also a "MorganAvec" Bold file, is MorganAvec's either way), and a lone style keeps a style that also has a file of its name (Sansation Light's Light and Light Italic). A style whose other copy's family goes by yet another name follows it there when it has a file of that name too, else keeps its own name, never alone under a name whose own fonts went (FagoLf-BoldCaps, when FagoLf's styles go by Fago). Off only ever splits families: every family with it off lies inside one with it on, so LTUnivers-CondThin, whose other file says LTUnivers, stays on its own rather than join LTUnivers (grouping lists it in LTUnivers-Cond). Checked on Sean's library: no style is alone with it off while its other copy's family exists and grouping lists them together (73 were before). "Review n suggestions" opens them; with none, the button reads "Family groups…" and opens every family |
| Your choices are Fontface's own | 🟡 | ⬜ | Kept in the library database (a choice per font by face key; a rule per family name, which fonts that arrive later follow), never in the font files. They survive rescans, relaunches and Locate… (a choice for a font without a PostScript name follows its file). A rule for a name holds for a font when any of its copies carries that name, whichever copy is shown. Keep separate keeps every spelling of the name together under the one you chose ("MetaCond LF" with "Meta Cond LF"). Keeping one name's styles apart by hand doesn't rename the other name on its own. Tags are keyed by face key, so tag counts are the same however families are grouped (checked on Sean's library: 36 tags, 6,687 tagged styles, identical) |
| The Info tab says how a style got its family | 🟡 | ⬜ | "Grouped by name into Dynasty, from “Dynasty Heavy”" with Keep “Dynasty Heavy” separate; "Merged into … by you" with Undo this merge; "Moved into … by you" with Undo my move (grouping by name decides again); "You chose to keep … separate" with Allow grouping by name; and, for a family kept out of the suggestions, Allow suggestions. Its Details list the font's own family and style names when it's listed under others, and "Name in older apps" (name ID 1) when that differs |
| The fonts' own names | 🟡 | ⬜ | The scanner keeps name IDs 16, 1 and 2. Fonts scanned before get them once, in the background at launch, reading only each file's name table (1.6 s for Sean's 11,927 files); Creative Cloud files are never read and online-only files are never downloaded (they wait for a later launch, grouped meanwhile as if they didn't name their own family) |
| Family choices sync | ⬜ | ⬜ | Not yet: they stay on this computer. Keyed like tags, so a later version can share them ([SYNC.md](SYNC.md)) |

### The rules

In order (src/familyGroups.ts):

1. **Your choice for a font wins:** a family (and maybe a style) for that font, or "keep it under its own name".
2. **Your rule for its family name** comes next: merge into a family, or keep separate.
3. **Grouping by name**, while Settings › Library › "Group families by name" is on. All three must hold:
   - **a.** The name ends in whole style words that can merge: weight (Thin to ExtraBlack, Book, Regular, Roman, Plain, Normal, Demi, Ultra), slope (Italic, Oblique) or variant (OSF, OSTF, LF, TF, SC, SCTF, Caps, Small Caps, Expert, Alt, Swash). Or it differs from another name only in spelling. A word counts only at the end, after a space, hyphen or underscore, a lowercase-to-uppercase step ("AmintaBold"), a digit, or an all-capitals run ("078MKSDMedium"); the longest word wins ("ExtraBlack" over "Black"). "SC" right after the family part is small capitals (Elementa SC, LTAromaSC), unless it's a script: the font has more than 10,000 glyphs (Noto Sans SC) or the name has siblings for other scripts (TC, HK, JP, KR). Abbreviations (Th, Lt, Bk, Rg, Reg, Md, Med, Sb, Semi, Bd, XBd, Hv, Blk, It, Ital, Obl, Exp, Sw) count only when the PostScript name agrees, and never in capitals ("LT" is Linotype).
   - **b.** What's left is a family in the library, or two different names reduce to it. Names compare lowercase without spaces, hyphens, underscores, dots, ™ and ® ("Aaux Pro" = "AauxPro"). A family made this way is what all its names have in common. A style word they all share stays in its name only when it's part of it: a plain word ("Times New Roman" and "Times New Roman Italic" are Times New Roman), a weight the fonts' own numbers contradict (more than 100 away, and not the 400 so many fonts store: "Shadows Into Light" and its Bold at 700), or one a PostScript name's family part spells ("ShadowsIntoLight-Italic"), or when what's left couldn't be a family ("Univers 45 Light" and its Oblique). Otherwise it's their style: "Gotham Bold" and "Gotham Bold Italic" are Gotham: Bold, Bold Italic. It takes the spelling with spaces, then the one most fonts use, then one that isn't all capitals ("Gotham" over "GOTHAM").
   - **c.** Something else agrees: the PostScript name's family part (before the first "-", or the whole name, without its style words) is that base or a part the family's fonts already use; or both name the same foundry or designer (spelled loosely: "The Monotype Corporation" = "Monotype Typography, Inc."; foundries compare by their words, so "Daniel Bruce" and "Daniel Hernandez" are two, and one-letter words don't count); or the weight number is within 100 of the weight word. A name's own PostScript name, foundry or designer never backs it: "Futura" and "FUTURA" need something the other one says too.
   - Guards: **G1** the font names its own family (name ID 16, other than name ID 1); **G2** a width, size or numbered-style word (unless the number is part of a family that exists, like Bodoni 72); **G3** fewer than 3 letters left; **G4** both name a foundry and they differ; **G5** you chose Keep separate. G1, G2 and G4, and no signal, make a suggestion instead; G3 and G5 don't.
4. **Otherwise the font's own name** (name ID 16, else 1).

## Settings (2026-10-12)

Settings open inside the main window, over the library (Fontface › Settings… in the menu bar,
Cmd+, or the gear at the bottom of the sidebar; Esc goes back). Cmd+, does nothing while a dialog,
menu or select list (such as the font page's style picker) is open, or while you're dragging fonts or a tag. The sidebar lists the sections, the main column shows one section or
search results from all of them, and every change saves at once. Not yet checked in the running app.

| Feature | macOS | Windows | Notes |
|---|---|---|---|
| Settings screen: sections, search, keyboard | 🟡 | ⬜ | General, Library, Sidebar, Activation, Purchases, Backups, About. Search matches labels, descriptions and extra words (including choice and button words, e.g. "log out" or "Finder"). The library stays as it was underneath. The last section opened is remembered while Fontface runs. In a text box, Esc first leaves the box (which saves it) |
| Appearance: System / Light / Dark | 🟡 | ⬜ | Applies at once, to the window's own buttons too; System follows the OS live. The last choice is applied before the first paint (a small script in index.html), so launch doesn't flash |
| Default preview text and size | 🟡 | ⬜ | Used at launch; changing them also changes the current preview |
| Open where you left off | 🟡 | ⬜ | The view plus All / Active / Inactive and Variable; a folder, subfolder or hidden section that's gone opens All Fonts. Views saved before the flat Sources still open: a macOS font folder opens as Font Book narrowed to it, a Google Fonts or Purchases folder as that source's row |
| Open at login | 🟡 | n/a | A LaunchAgent; hidden on Windows for now |
| Keep running when the window is closed | 🟡 | n/a | Click the Dock icon to bring the window back |
| Check folders for changes when Fontface opens | 🟡 | ⬜ | When off, only folders with no fonts yet are scanned |
| Show installed fonts in All Fonts | 🟡 | ⬜ | When off, All Fonts leaves out fonts that are only in the OS font folders (including ones the user installed); a font with a copy in one of their folders stays. Font Book still lists them; the All Fonts count follows |
| Show or hide sidebar sections | 🟡 | ⬜ | In the sidebar's order: Your Fonts, Recently Added, Active and Not Tagged; Font Book, Google Fonts, Adobe Fonts and Purchases; Tags, and Built-in tags (inside Tags; off while Tags is off). All Fonts and your folders always show. A view whose entry or section is hidden (including the one you're in) goes to All Fonts. Hidden built-in tags still exist, still show on fonts and still appear in tag menus |
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
| Subfolders of a source in the toolbar's folder picker, each a view (replaced the sidebar trees) | 🟡 | ⬜ |
| Collections (manual) | ⬜ | ⬜ |
| Smart collections (rule-based) | ⬜ | ⬜ |
| Activate / deactivate a whole collection | ⬜ | ⬜ |
| Favorites | ⬜ | ⬜ |
| Filters: classification, weight, width, mono (variable: see Views) | ⬜ | ⬜ |
| Sort options (see Tiles, Table and View options) | 🟡 | ⬜ |
| Live folder watching (no manual rescan) | ⬜ | ⬜ |
| Grid view (Tiles) and a sortable Table alongside the list (Rows) | 🟡 | ⬜ |

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
| Family choices (merge, keep separate, move) | ⬜ | ⬜ | Not yet: they stay on this computer (see **Family groups**) |
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
