# Sync

Sync shares your *choices* between your computers: your tags (with their colors and groups),
which fonts carry them, which fonts are on, and exceptions for one computer. It works through
any folder that something else keeps in sync: iCloud Drive, OneDrive, Google Drive, Dropbox,
the Nextcloud or Seafile client, Syncthing, or an rclone mount. Font files never sync. Each
computer uses its own copies.

Code: `src-tauri/src/sync/` (Rust) and `src/sync/` (interface). The plan it comes from is in
[MOBILE-AND-SYNC.md](MOBILE-AND-SYNC.md).

## What syncs

| Item | Syncs | Notes |
|---|---|---|
| Tags: names, nesting, colors | Yes | Each tag has its own sync id, so renames and moves carry over |
| Tag groups: My tags, Built-in | Yes | A top-level tag's group, which the tags inside it follow. See **Tag groups** |
| Which fonts carry which tags | Yes | By the font's key (PostScript name, variable or static, slant) |
| Which fonts are on | Yes | As a wish. Each computer turns on its own copy, if it has one |
| Exceptions for one computer | Yes | Always on here, Never on here, Follow sync |
| Exceptions for a device group | Yes | In the data; no menu for them yet |
| Fonts without a PostScript name | No | Their key is a file path, which means nothing on another computer |
| Font files | No | Purchased, Adobe and system fonts never will ([INTEGRATIONS.md](INTEGRATIONS.md)) |
| Settings | No | They belong to one computer, including which sidebar sections show (Built-in tags too) |
| Folders and their colors | No | Paths differ between computers |
| The library database | Never | Only small change files go in the folder |

## Using it

1. **Settings › Sync › Choose Folder…** and pick a folder your sync app keeps up to date.
   Fontface makes a `Fontface Sync` folder inside it. Picking `Fontface Sync` itself works too.
2. Do the same on each computer, with the same folder.
3. Each computer shares its tags and the fonts it has on. Tags with the same name become one
   tag, with the fonts from both. Joining only adds: it never turns another computer's fonts off.

After that:

- **Changes go out** about two seconds after you make them.
- **Changes come in** when your sync app delivers them. Fontface notices new files in the
  folder, checks when its window comes to the front, and checks every five minutes anyway.
- **Sync Now** reads and writes at once.
- **On this Mac** in a font's right-click menu: *Follow sync*, *Always on here* or *Never on
  here*. With an exception set, that font's switch changes only this computer's exception.
- **Name** and **Device group** set how this computer appears to the others. Computers in
  the same group (say "Work Macs") can share exceptions.
- **Turn Off Sync** stops sharing. Tags and fonts here stay as they are, and so do the files
  in the folder. Turning it back on later starts fresh and merges again.

The page shows when sync last ran, the other computers and when each was last seen, problems in
plain words, and fonts that are on elsewhere but aren't on this computer: fonts with no copy
here, and fonts sync is to turn on with no copy whose file is there.

**A cloud folder that can be online-only** (iCloud Drive, Google Drive, OneDrive, Dropbox):
reading a file there may download it first. Sync does that on its own thread, so the window
never waits, but it can make a sync slow. The page suggests keeping the folder downloaded
("Keep Downloaded" in Finder).

## Which fonts are on

- **Each computer decides from the same rule.** Its own exception first, then its device
  group's, then the shared choice.
- **Your switch is the choice.** Turning a font on or off shares it. If this computer has an
  exception for that font, the switch changes the exception instead, so the two never disagree.
- **Fonts Fontface turns on by itself aren't your switch.** A first download from Google Fonts, a
  purchase import, a Google Fonts update and a purchase Replace turn fonts on (an update puts
  back what was on, and the styles new in that version). A font nobody has chosen for yet is
  shared as on, the way joining shares fonts already on: a style new in an update reaches your
  other computers too. A font that already has a choice keeps it, and nothing is shared: a style
  turned off on another computer goes off here too, a moment after it comes in. That holds even
  when that choice is read while the font is still coming in (sync runs while the folder is
  rescanned, finds the font off already, and would otherwise count the choice as carried out
  before Fontface turns the font on).
- **A font this computer doesn't have** keeps its choice and is listed under "Not on this
  computer". It turns on when it arrives (from Google Fonts, a purchase, or a drive you connect).
- **A font whose file isn't there** (on a drive that isn't connected; the library keeps such
  fonts) is left as it is: nothing is turned on or recorded as on, and the choice isn't counted
  as carried out. It's listed under "Not on this computer", with no problem message. The first
  sync after a copy's file is back turns it on, through the same switch as the window, with the
  activation mode; that needs no rescan of its folder. Removing its folder meanwhile, or
  relaunching with "Leave them off", changes nothing: launch only deals with fonts recorded as
  on. If the library has another copy whose file is there, that copy is turned on instead.
- **Each synced choice is carried out once.** If you turn a font off here in another app, sync
  doesn't keep turning it back on. It acts again only when someone changes that font's choice,
  or when the font comes into the library again.
- **A switch that fails** (macOS refuses the file, say) isn't counted as carried out. Sync tries
  again each time it runs, and the page says so until it works.
- **Other ways a font goes off aren't shared:** Turn Off All, "Leave them off" at launch,
  another app turning a font off, a folder being removed, temporary fonts ending at logout.
  They only affect this computer.
- **Changing this computer's device group** carries out again only the fonts whose on/off
  changes with the group (that group's exceptions). Every other font stays as it is here, so a
  font turned off in one of the ways above stays off.
- **Turning on picks one copy:** one already on, or else a file with only that font in it.
  Turning off skips a collection file that also holds a font that should stay on.
- **Different fonts with the same name** aren't merged. If both computers know a font's content
  fingerprint (today: fonts in Purchases) and none match, and the family names differ too, the
  font's tags and on/off stay local. Same family with another fingerprint counts as another
  version of the same font, and is matched.

## The folder

```
<the folder you picked>/
  Fontface Sync/
    v1/
      devices/
        3f2a…/                 one folder per computer, named by its device id
          device.json          name, group, app version, last seen
          changes-000001.jsonl changes, never edited once written
          changes-000002.jsonl
          snapshot.json        that computer's changes, squeezed
        9b1c…/
          …
```

**The safety rule: each computer writes only its own folder.** No two computers ever write the
same file, so a plain file-sync service can't create conflicts or mix two versions of a file.

- Every file is written whole to a temporary file in the same folder, then renamed into place.
  Readers see the old file or the new one, never half of one.
- **Change files** are JSON Lines: a header line, then one change per line. A file is written
  once and never changed.
- **Snapshots:** after 24 change files, a computer writes `snapshot.json` (its own changes,
  keeping only the latest value of each) and deletes the change files it covers.
- **`device.json`** is rewritten when something changes, and otherwise at most once an hour,
  so computers don't wake each other up in a loop.
- **Anything else is ignored:** "conflicted copy" files from Dropbox or OneDrive, temporary
  files, notes, folders that aren't device ids.
- **A file that can't be read yet** (still downloading, cut short, damaged) is skipped and tried
  again next time. Later files are still read, because changes apply in any order. Nothing
  local is ever changed or wiped because of a bad file. The page names the computer whose file
  it is.
- **Format versions.** Every file says its format and version. A file from a newer major
  version is refused with "Update Fontface here to sync with it". A `v2` folder next to `v1`
  shows the same message. Smaller additions (a new field, a new kind of change) keep the
  version; older apps skip what they don't know and keep fields they don't understand.

### A change file

```json
{"format":"fontface-sync-changes","version":1,"device":"3f2a…","seq":7}
{"hlc":"1760280000000.0.3f2a…","op":"tag","id":"9b1c…","set":{"name":"Star Trek","parent":"77aa…","color":"blue"}}
{"hlc":"1760280000000.1.3f2a…","op":"tag","id":"77aa…","set":{"group":"builtin"}}
{"hlc":"1760280000000.2.3f2a…","op":"add","tag":"9b1c…","key":"ps:Okuda|static|r"}
{"hlc":"1760280000001.0.3f2a…","op":"remove","tag":"9b1c…","key":"ps:Inter|var|r","dots":["1760270000000.0.77aa…"]}
{"hlc":"1760280000002.0.3f2a…","op":"face","key":"ps:Okuda|static|r","set":{"on":true,"family":"Okuda","style":"Regular"}}
{"hlc":"1760280000003.0.3f2a…","op":"tagDel","id":"55e0…"}
```

| Change | Fields |
|---|---|
| `tag` | `id` (sync id) and `set`: `name` (its own level only), `parent` (a sync id, or null), `color`, `group` (`"builtin"` or `"mine"`; see **Tag groups**) |
| `tagDel` | `id`. Final |
| `add` | `tag`, `key`. Its clock value is its id |
| `remove` | `tag`, `key`, and `dots`: the adds it saw |
| `face` | `key` and `set`: `on`; `family` and `style` (for "Not on this computer"); `prints` (fingerprints); `x:<device id>` and `xg:<group>` exceptions, `"on"`, `"off"` or null |

`set` is a field map on purpose, so a later version can add a field without a new format
version. `group` arrived that way: files from before tag groups don't have it, and still apply.

### Tag groups

A tag is in **My tags** or **Built-in** ([TAGS.md](TAGS.md)). The group belongs to a top-level
tag; every tag inside it is in the same group, on every computer.

- **Where a tag starts:** where its name puts it (`tags::BUILTIN_NAMES`: Font Book's starter
  collections and Typeface's "Style"), the rule the one-time sort uses when groups arrive. Every
  computer works that out alike, so it needs no change in the folder.
- **What's written:** `group` on a top-level tag, only when it differs from what the tag's name
  gives it, or when it changes here. So a new "Sci-Fi" in My tags writes nothing, and a new
  "Fun" made in Fontface (always My tags) writes `"mine"`.
- **Every way a group changes here is sent,** because sync compares the tags with the base
  (see **No echoes**): Move to Built-in / Move to My tags (menu or a drag onto a heading), its
  Undo, a move into a tag of the other group, imports and restores (adding or replacing).
  Undone before sync runs, it's no change at all.
- **Renames and moves keep the group.** A top-level tag renamed so that its new name alone would
  give the other group, or a tag taken out of its parent to the top level, writes the group it
  has, so the other computers don't work out another one. A tag moved inside another tag needs
  nothing: it follows its new top-level tag.
- **Coming in:** a top-level tag is in the group chosen last for it, else where its name puts
  it. A tag inside it (made, renamed or moved there on another computer) takes its group. A tag
  that a loop of moves leaves at the top level is a top-level tag like any other.
- **The one-time sort is never shared.** When groups arrive, each computer sorts its tags by
  name once (`tags::ensure_schema`). Sync's saved state from before groups has no groups, and
  counts each tag as having the group that sort gives it. So updating Fontface writes no
  change, two computers that update never undo each other's sort, and a group someone chose on
  another computer wins over the sort. A tag moved by hand after the update, even before the
  first sync, does count as a change.
- **A sync from before groups, in a library that had them** (a build like main at 4f5aeb0) made
  the tags it brought in with the column's default, My tags, whatever their name. So at launch,
  before the window can change anything (`sync::upgrade_saved_state`), a top-level tag whose
  name was written on another computer, that's in My tags here, and whose name gives Built-in,
  counts as having been in My tags. Nothing is sent for it, and it takes the group the other
  computers give it. A tag named on this computer still counts by its name, so one made in
  Fontface stays in My tags everywhere. A tag from elsewhere that someone moved from Built-in to
  My tags on such a build looks the same, and goes back to Built-in.
- **Older files and older apps.** A change without `group` (any file from before tag groups)
  leaves the name to decide. A `group` value this version doesn't know counts as no choice. A
  computer still on a Fontface from before tag groups keeps the field and passes it on, but has
  no groups itself: a tag it renames or moves to the top level goes where its new name puts it.

## How changes merge

- **Clock.** Every change carries a hybrid logical clock value: wall time in milliseconds, a
  counter, and the device id. It orders changes; the device id breaks ties. A computer that
  sees a change from the future (a clock set wrong) moves its own clock past it, so its next
  change still comes later. A wrong clock can win early, but not for ever.
- **Single values** (a tag's name, parent, color and group; a font's on/off; each exception):
  the latest change wins, field by field. Renaming on one computer and recoloring on another
  keeps both, and so does renaming on one and moving to Built-in on another.
- **Deletes** are final (tombstones). A tag deleted on one computer and renamed on another at
  the same time stays deleted. Tags inside a deleted tag go too, as they do locally.
- **Tags on fonts** are an add-wins set. Each add has its own id; a remove lists the adds it
  saw. If one computer removes a tag from a font while another adds it, the add wins.
- **Order doesn't matter.** Changes can arrive in any order, any number of times. A remove
  before its add, a tag before its parent, the same file twice: the result is the same.
- **Same name, two tags.** Two computers that each had "Sci-Fi" before they first synced have
  two sync ids for it. They show as one tag with both ids. Renames, colors, groups and deletes go
  to both. The spelling, color and group come from the most recent change to either; a group
  someone chose beats one that only comes from the name.
- **A loop of moves** (A into B on one computer, B into A on another): the later move is
  dropped, the same way everywhere.
- **No echoes.** Local tag changes are found by comparing the tags now with the tags as sync
  last left them, never with the merged state. Writing other computers' changes into the
  library never counts as a change here. On/off changes come only from your switch, and from
  fonts nobody has chosen for yet when this computer joins or they arrive.

## Identity

- **Device id:** random, made when sync first starts.
- **Copied app data.** Migration Assistant or a backup restored onto a new Mac copies the
  device id. Two computers with one id would write the same folder. So each computer keeps a
  hash of its hardware id (macOS: `IOPlatformUUID`; Windows: `MachineGuid`) with its sync
  settings and in `device.json`. If the hash doesn't match this computer, or the folder's
  `device.json` for this id was written by another computer, this one takes a new id and says
  so on the page. Changes it hadn't written yet move to the new id.
- **Tag sync ids** are random too, and kept apart from the database's own ids.

## Where it runs

- All file work happens on a sync thread, never while a lock is held. Lock order: the cycle
  lock, the engine lock, then the database mutex. Fonts are switched through the same code as the
  window's switches (`commands::switch`), under the cycle lock but never the engine lock: that
  code takes the activation lock, then the database mutex. Whether a font's files are there is
  checked without the engine lock too, both when switching and for the page's list (the engine
  hands over the files to check, then lets go): a file on a network drive that dropped can take
  seconds to check, and your switch waits for that lock.
- **What wakes it:** any write the window makes to the database (it then compares tags, after
  1.5 s of quiet), an on/off switch, fonts a download, an import, an update or a Replace turned
  on, the window coming to the front, a file event in the folder (after 3 s of quiet; its own
  writes are ignored), and every five minutes. Saving preview profiles doesn't wake it: they're
  a cache, not a choice.
- **Stored locally**, outside the numbered migrations, like the tag tables: `sync_meta` (this
  computer's sync settings, and the merged state as JSON) and `sync_outbox` (changes not yet
  written to the folder, so nothing is lost if the folder is unreachable or Fontface quits).
- **`Transport`** (`sync/transport.rs`) is the only part that touches files: list, read,
  write whole, remove. `FolderTransport` is the folder. A direct connection through Apache
  OpenDAL (WebDAV, S3, Google Drive, OneDrive, Dropbox, iCloud) only needs another `Transport`.

## Choices to review

- **Joining adds, it never removes.** A computer's fonts that are on are shared as on when it
  joins, even if another computer turned that font off earlier. The opposite would turn fonts
  off on a new computer by surprise.
- **A download turns on every style first** (an update, every style that was on, and the new
  ones). A style turned off elsewhere is on for a moment, until the next sync turns it off.
  Turning only some styles on would make the download look unfinished.
- **A font whose file isn't there waits for sync, not for a scan.** It turns on the first time
  sync runs after its drive is connected: after your next change in the window, when the window
  comes to the front, or within five minutes. Recording it as on and leaving it to the folder's
  next scan, as launch does, would lose the choice if the folder went away, and would put it in
  the hands of launch's "Leave them off" or "Ask", for a font that was never on here.
- **"Replace my tags" reaches every computer.** Restoring a backup that way deletes the tags made
  since, on every computer, and deletes are final. The restore dialog says so when sync is on.
- **Delete beats a rename made at the same time.** A rename doesn't bring a deleted tag back.
- **A group someone chose beats the name rule.** When two computers' same-named tags meet, a
  computer that never chose a group for its tag doesn't outvote one that did, even if it joins
  later. Between two choices, the later one wins, as for colors.
- **A tag inside a deleted tag goes too,** even one just made on another computer.
- **Fingerprints only come from Purchases.** Hashing every font in a big library on each
  computer would take minutes and download online-only files. So "different font with the same
  name" is caught for purchased fonts only, and only when the family names differ.

## Not built yet

- Menus for device-group exceptions (the data supports them).
- Encryption of the sync files with a passphrase (tag names can be revealing).
- Direct connections (OpenDAL), and a way to remove another computer from the folder.
- Windows: the code is cross-platform; the hardware id uses `MachineGuid`. Not tried yet.
- Not yet checked in the running app: the tests cover the merge rules and the files, not the window.

## Tests

`cargo test sync::` covers:

- **Merge rules:** concurrent add and remove, rename against delete, a deleted parent, clock
  skew, changes out of order and twice, a child before its parent, loops of moves, tags with
  the same name, bad names and colors, exceptions (device, group, shared, back to follow),
  snapshots holding the same state, and tag groups (the name rule when nobody chose, nested tags
  following their top-level tag, unknown values, the latest choice winning, same-named tags).
- **Files:** round trips, unfinished files, files in the wrong folder, newer versions, unknown
  kinds of change, and which names count.
- **Two or three computers sharing a temporary folder**, each with its own library: tags,
  renames, moves, recolors, deletes; tags both had before joining; concurrent renames; on/off
  with exceptions; a font one computer lacks until it arrives; joining; no echoes; a half-
  downloaded file and a conflicted copy; a damaged local state rebuilt from the folder; a newer
  format; copied app data; snapshots for a computer that joins later; and different fonts that
  share a name.
- **Tag groups across computers:** a group change both ways, with Undo; tags made inside a
  moved tag; renames and moves that keep a group; group changes racing renames and moves;
  same-named tags; the one-time sort on two computers (nothing written, an earlier choice kept,
  a move made just after updating sent); tags an older sync made in My tags (nothing sent when
  it updates); change files from before groups; and a backup restored with "Replace my tags",
  then added to, and synced.
- **Fonts Fontface switches by itself:** a download that brings styles with choices made
  elsewhere (Bold turned off there goes off here; only a new style is shared), an update made
  before reading a newer choice (nothing written, the newer choice wins), and an update during
  which a sync reads a newer choice and finds nothing to switch yet (that choice still wins, and
  a style new in the update is shared); a switch that fails (tried again, the message stays until
  it works); a file on a drive that isn't connected (nothing recorded, listed as not on this
  computer, another copy used if its file is there, turned on by the first sync after the drive
  is back, and not listed when the drive goes away again later), even if its folder is removed
  and added back, or Fontface relaunches with "Leave them off" first; and device group changes
  (fonts turned off here stay off; only fonts that group's exceptions change are switched).
