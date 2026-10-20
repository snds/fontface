# Fontface: Fonts in this file (Figma plugin)

A small private Figma plugin. It lists the fonts a Figma file uses, marks the ones Figma can't
find, and copies the list so Fontface can turn them on (**File › Turn On Fonts from a List…**, or
the button by LIBRARY in Fontface's sidebar).

It only reads the file. It changes no layers, stores nothing, and sends nothing anywhere: its
manifest allows no network access (`"allowedDomains": ["none"]`), and its window loads nothing
from the web.

## Load it

1. Open the **Figma desktop app** (plugins in development can't be loaded in the browser).
2. Open any design file.
3. Choose **Plugins › Development › Import plugin from manifest…** in the Figma menu.
4. Pick `figma-plugin/manifest.json` in this repository.

It then shows under **Plugins › Development › Fontface: Fonts in this file**. Figma reads the
files from disk each time the plugin starts, so a change here needs no build step: close the
plugin and run it again.

There's no `id` in the manifest: Figma needs one only to publish a plugin, and this one stays
private. If Figma ever asks for one, make a new plugin with **Plugins › Development › New
plugin…**, copy the `id` it gives into `manifest.json`, and import it again.

## Use it

- **All pages**, **This page** or **Selection** choose which text layers to read. Selection
  follows what you select. A big file takes a moment on All pages.
- Each family is listed with its styles. Each style shows how many text layers use it, and
  **Missing** (Figma can't find it) or **Available**.
- **Copy missing** copies the missing fonts, one `Family Style` per line (for example
  `IBM Plex Sans SemiBold Italic`). **Copy all** copies every font listed the same way.
  **Copy as JSON** gives `{"fonts":[{"family":"…","style":"…"}]}`.
- Paste either into Fontface's **Turn On Fonts from a List…**. It finds each font in your library
  and turns them on, tags them, or copies the names it doesn't have.
- **Refresh** reads the file again: after you turn fonts on in Fontface, the marks change from
  Missing to Available.

Figma names fonts by family and style, not by PostScript name, so the copied lines are
`Family Style`. Fontface's name matcher understands that form, other spellings of the style
("Bold It", "Oblique" for "Italic"), and a style inside a variable font of that family.

## How it works

- `code.js` runs in Figma's plugin sandbox. It walks the text layers, reads each one's fonts with
  `getRangeAllFontNames`, counts layers per font, marks a font missing when it isn't in
  `figma.listAvailableFontsAsync()`, and sends the list to the window.
- `ui.html` is the window. It shows the list and copies the text. Figma's plugin window isn't
  allowed the modern clipboard call, so it copies through a selected text box and
  `document.execCommand("copy")`; if Figma refuses that too, it shows the text selected, ready
  for ⌘C.
- `manifest.json` uses `"documentAccess": "dynamic-page"`, which Figma requires of new plugins:
  each page is loaded (`page.loadAsync()`) before it's searched.
- The plugin is plain JavaScript, so Figma runs the files as they are. `src/figmaPlugin.test.ts`
  runs `code.js` against a stand-in for Figma's API (`npm run test:ui`).

## Figma's documentation

- Manifest fields (`documentAccess`, `networkAccess`, `editorType`):
  https://developers.figma.com/docs/plugins/manifest/
- Loading pages with `dynamic-page` access:
  https://developers.figma.com/docs/plugins/accessing-document/
- `TextNode` (`getRangeAllFontNames`, `fontName`, `hasMissingFont`):
  https://developers.figma.com/docs/plugins/api/TextNode/
- `figma.listAvailableFontsAsync`:
  https://developers.figma.com/docs/plugins/api/figma/#listavailablefontsasync
- `findAllWithCriteria`:
  https://developers.figma.com/docs/plugins/api/properties/nodes-findallwithcriteria/
- The plugin window and messages (`figma.showUI`, `postMessage`, `themeColors`):
  https://developers.figma.com/docs/plugins/creating-ui/
- Fonts in text layers, and missing fonts:
  https://developers.figma.com/docs/plugins/working-with-text/
