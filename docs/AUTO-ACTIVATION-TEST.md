# Auto-activation test: listen and log

Before Fontface turns fonts on by itself when an app needs them (auto-activation), this test
finds out which apps ask macOS for a missing font, how often, and what a request holds. It's a
developer test, off unless you ask for it at launch.

**It changes nothing for other apps.** Fontface answers every request with "no fonts", so the
asking app behaves exactly as if Fontface weren't running. It never turns a font on. It reads
the library and the asking app's Info.plist, and writes only its own log.

The code is `src-tauri/src/font_requests/` (macOS only). It uses CoreText's font request
listener (`CTFontManagerCreateFontRequestRunLoopSource`), which Apple has marked deprecated
since macOS 11 but still ships. Fontface looks it up by name at launch, so if a macOS no longer
has it, Fontface still runs and the log says so.

## Run it

1. Build the app: `npx tauri build --bundles app` from the repository's root. It lands in
   `src-tauri/target/release/bundle/macos/Fontface.app`.
2. Quit Fontface if it's running.
3. Start the built app from Terminal with the variable set. Either of these works:

   ```sh
   # Messages stay in this Terminal window (quit Fontface to get the prompt back).
   FONTFACE_LISTEN_FONT_REQUESTS=1 src-tauri/target/release/bundle/macos/Fontface.app/Contents/MacOS/fontface

   # Or let it run on its own (macOS 13 or later).
   open -n --env FONTFACE_LISTEN_FONT_REQUESTS=1 src-tauri/target/release/bundle/macos/Fontface.app
   ```

4. Check it's listening. Each launch adds one line that says so, and the log keeps the lines
   from earlier launches, so look at the newest such line:

   ```sh
   grep -E '"event":"(not-)?listening"' ~/Library/Logs/design.snds.fontface/font-requests.jsonl | tail -n 1
   ```

   `"event":"listening"` means it's ready. `"event":"not-listening"` gives the reason (for
   example, another font manager is already listening, or the call is gone from this macOS),
   with the macOS version and the global auto-activation setting.

To stop, quit Fontface and open it the usual way. Without the variable, nothing listens.

## What to try

Pick a font that's in your library but **off** (its switch is off in Fontface). For each app:

1. Make or open a document that uses that font, while the font is off. Saving a document with
   the font on, turning the font off, then opening the document again works well.
2. Note whether a line appears in the log, and anything the app does: a missing-font warning, a
   substitute font, a pause.
3. Do the same with a font that isn't in the library at all, and with one that's on (that
   shouldn't ask).

Apps worth trying, in three groups:

- **Design:** Figma (the desktop app), Sketch.
- **Adobe:** InDesign, Illustrator.
- **Office, Affinity and Apple:** TextEdit (rich text), Pages, Keynote, Word, PowerPoint,
  Affinity (the all-in-one app from late 2025), and Affinity Designer, Photo or Publisher 2 if
  you still have them (both the App Store and the direct versions).

Things to watch for:

- **Which process asks.** Some apps ask from a helper (a renderer, an extension). The log names
  the app and, when it's a helper, the helper's own bundle.
- **The app's auto-activation setting.** `"autoActivation"` is macOS's setting for that app:
  `default` follows the global one (in the `listening` line), and `disabled` means macOS won't
  ask for that app at all.
- **How long the app waits** for the answer. Fontface answers at once; note any app that pauses.
- **Another font manager running.** Try once with another font manager's auto-activation on, and
  note whether requests still reach Fontface.

## Read the log

The log is `~/Library/Logs/design.snds.fontface/font-requests.jsonl`: one JSON object per line.
Past 4 MB it starts again, and the one before is kept as `font-requests.1.jsonl`.

A request's line:

| Field | What it holds |
|---|---|
| `event` | `request` (others: `listening`, `not-listening`) |
| `time` | When it came, in UTC |
| `pid` | The asking process's id |
| `asker.app` | The app: its `name`, `bundleId` and `path` |
| `asker.process` | The helper inside the app that asked, when it wasn't the app itself |
| `asker.executable` | The program that asked |
| `autoActivation` | macOS's auto-activation setting for that app |
| `fonts` | Each font the request names: `postscriptName`, `family`, `style`, `displayName` (whichever it gives) |
| `fonts[].library` | Whether the library has it (`hasMatch`), how Fontface's name matcher found it (`how`), how many styles match, how many are on now and how many are online-only, their names, or the closest names when nothing matched |
| `request` | Everything the request held, as given (long values shortened) |
| `answer` | Always "no fonts (listen and log only)" |
| `dropped` | Requests that came too fast to log, since the line before (rare) |
| `libraryError` | Why the library couldn't be checked, if it couldn't |

Some ways to read it (`jq` comes with macOS):

```sh
# Every request: when, which app, which fonts, and whether the library has them.
jq -c 'select(.event == "request") | {time, app: (.asker.app.name // .asker.executable), fonts: [.fonts[] | {name: (.postscriptName // .displayName // ([.family, .style] | map(select(. != null)) | join(" "))), found: .library.hasMatch}]}' ~/Library/Logs/design.snds.fontface/font-requests.jsonl

# How many requests each app made.
jq -r 'select(.event == "request") | .asker.app.name // .asker.executable' ~/Library/Logs/design.snds.fontface/font-requests.jsonl | sort | uniq -c | sort -rn

# Watch requests as they come.
tail -f ~/Library/Logs/design.snds.fontface/font-requests.jsonl
```

## What it decides

The results decide whether system auto-activation is worth building next, and for which apps:
an app that never asks needs another route (a plugin, or a "fonts in this file" check).
