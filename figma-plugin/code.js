// Fontface: Fonts in this file. A private Figma plugin that lists the fonts a Figma file uses,
// marks the ones Figma can't find, and copies the list for Fontface's "Turn on fonts from a
// list…". README.md says how to load it.
//
// Plain JavaScript, no build step: Figma runs this file as it is. It only reads the file: it
// changes no layers, stores nothing, and can't reach the network (manifest.json says "none").
// Top-level helpers are plain `function`s so src/figmaPlugin.test.ts can call them.

figma.showUI(__html__, { width: 360, height: 520, themeColors: true });

/** Which layers to read: every page, the page you're on, or the selected layers. */
var SCOPES = ["all", "page", "selection"];
var scope = "all";

/** One key per font, so the same font in many layers is counted once per layer. */
function fontKey(family, style) {
  return family + "\u0000" + style;
}

/** A real { family, style }, not `figma.mixed` or anything else. */
function isFontName(value) {
  return !!value && typeof value === "object" && typeof value.family === "string" && typeof value.style === "string";
}

/** The kinds of layer that hold text: text layers, and text on a path ("TEXT_PATH", in beta in
 *  Figma's plugin API). Both have the characters, fontName, getRangeAllFontNames and
 *  hasMissingFont that the fonts are read from. */
var TEXT_TYPES = ["TEXT", "TEXT_PATH"];

function isText(node) {
  return TEXT_TYPES.indexOf(node.type) >= 0;
}

/** The text layers inside `node` (a page or a frame), text on a path included. If this Figma
 *  refuses to search for text on a path, the plain text layers alone. */
function findTexts(node) {
  try {
    return node.findAllWithCriteria({ types: TEXT_TYPES });
  } catch (e) {
    return node.findAllWithCriteria({ types: ["TEXT"] });
  }
}

/** The fonts one text layer uses, each once. An empty layer has no characters but still has a
 *  font (the one typed text would get), so it counts too. */
function fontsInText(node) {
  var length = node.characters.length;
  var names = length > 0 ? node.getRangeAllFontNames(0, length) : [node.fontName];
  var seen = {};
  var fonts = [];
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    if (!isFontName(name)) continue;
    var key = fontKey(name.family, name.style);
    if (seen[key]) continue;
    seen[key] = true;
    fonts.push({ family: name.family, style: name.style });
  }
  return fonts;
}

/** Weights in their usual order, so a family reads Light, Regular, Bold rather than A to Z.
 *  Names are compared lower case, without spaces, hyphens or underscores. */
var WEIGHT_ORDER = {
  thin: 1, hairline: 1, extralight: 2, ultralight: 2, light: 3, book: 4, regular: 4, normal: 4,
  roman: 4, "": 4, medium: 5, semibold: 6, demibold: 6, bold: 7, extrabold: 8, ultrabold: 8,
  heavy: 9, black: 9,
};

/** Where a style goes in its family: by weight, then upright before italic. Styles whose names
 *  aren't a plain weight (say "Condensed Bold") go after, A to Z. */
function styleRank(style) {
  var name = style.toLowerCase().replace(/[\s_-]/g, "");
  var italic = /italic|oblique/.test(name);
  var weight = WEIGHT_ORDER[name.replace(/italic|oblique/g, "")];
  return { weight: weight === undefined ? 100 : weight, italic: italic ? 1 : 0 };
}

function compareFonts(a, b) {
  var byFamily = a.family.localeCompare(b.family, undefined, { sensitivity: "base", numeric: true });
  if (byFamily !== 0) return byFamily;
  // Names that differ only in capitals or accents ("Avenir Next", "Avenir next") sort together
  // but are listed as two families: keep each one's styles together.
  if (a.family !== b.family) return a.family < b.family ? -1 : 1;
  var ra = styleRank(a.style);
  var rb = styleRank(b.style);
  if (ra.weight !== rb.weight) return ra.weight - rb.weight;
  if (ra.italic !== rb.italic) return ra.italic - rb.italic;
  return a.style.localeCompare(b.style, undefined, { numeric: true });
}

/** Counts how many of `texts` use each font, and marks a font missing when it isn't in
 *  `available` (keys from fontKey). A layer that can't be read is counted, not fatal. */
function tallyFonts(texts, available) {
  var byKey = {};
  var fonts = [];
  var missingLayers = 0;
  var unreadable = 0;
  for (var i = 0; i < texts.length; i++) {
    var node = texts[i];
    var used;
    try {
      used = fontsInText(node);
    } catch (e) {
      unreadable++;
      continue;
    }
    if (node.hasMissingFont) missingLayers++;
    for (var j = 0; j < used.length; j++) {
      var key = fontKey(used[j].family, used[j].style);
      if (!byKey[key]) {
        byKey[key] = { family: used[j].family, style: used[j].style, layers: 0, missing: !available.has(key) };
        fonts.push(byKey[key]);
      }
      byKey[key].layers++;
    }
  }
  fonts.sort(compareFonts);
  return { fonts: fonts, layers: texts.length, missingLayers: missingLayers, unreadable: unreadable };
}

/** Sorted fonts in families, for the list: [{ family, missing, styles: [font…] }]. */
function groupByFamily(fonts) {
  var families = [];
  for (var i = 0; i < fonts.length; i++) {
    var last = families[families.length - 1];
    if (!last || last.family !== fonts[i].family) {
      last = { family: fonts[i].family, missing: 0, styles: [] };
      families.push(last);
    }
    last.styles.push(fonts[i]);
    if (fonts[i].missing) last.missing++;
  }
  return families;
}

/** The copied text: one font per line, "Family Style". Figma knows a font by family and style
 *  (not by PostScript name), and Fontface's "Turn on fonts from a list…" reads these lines. */
function asLines(fonts) {
  return fonts
    .map(function (font) {
      return font.family + " " + font.style;
    })
    .join("\n");
}

/** The same fonts as JSON: {"fonts":[{"family":…,"style":…}]}. */
function asJson(fonts) {
  var list = fonts.map(function (font) {
    return { family: font.family, style: font.style };
  });
  return JSON.stringify({ fonts: list }, null, 2);
}

/** The text layers among `nodes` and inside them (text on a path included), each once. */
function textsUnder(nodes) {
  var seen = {};
  var texts = [];
  function add(node) {
    if (seen[node.id]) return;
    seen[node.id] = true;
    texts.push(node);
  }
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (isText(node)) add(node);
    if ("findAllWithCriteria" in node) findTexts(node).forEach(add);
  }
  return texts;
}

/** The text layers to read for `which` scope. With "dynamic-page" access a page must be loaded
 *  before it can be searched; the page you're on already is, but loading it again is harmless. */
async function textLayers(which, progress) {
  if (which === "selection") return textsUnder(figma.currentPage.selection);
  if (which === "page") {
    await figma.currentPage.loadAsync();
    return findTexts(figma.currentPage);
  }
  var pages = figma.root.children;
  var texts = [];
  for (var i = 0; i < pages.length; i++) {
    if (pages.length > 1) progress("Reading page " + (i + 1) + " of " + pages.length + "…");
    await pages[i].loadAsync();
    var found = findTexts(pages[i]);
    for (var j = 0; j < found.length; j++) texts.push(found[j]);
  }
  return texts;
}

/** Keys (fontKey) for every font Figma can use now: the list its font menu shows. Asked on every
 *  read. Figma reads that list when a file opens, so a font turned on in Fontface since shows as
 *  available only after the file's tab is reloaded (README.md). */
async function availableFonts() {
  var list = await figma.listAvailableFontsAsync();
  var keys = new Set();
  for (var i = 0; i < list.length; i++) keys.add(fontKey(list[i].fontName.family, list[i].fontName.style));
  return keys;
}

function errorText(e) {
  return e && e.message ? e.message : String(e);
}

/** Only the newest read talks to the list: an older one that finishes late (say a big file's
 *  "All pages" after you've switched to "This page") stays quiet. */
var latestRead = 0;

/** Reads the fonts for `which` scope and sends the list to ui.html. */
async function read(which) {
  var id = ++latestRead;
  function send(message) {
    if (id === latestRead) figma.ui.postMessage(message);
  }
  send({ type: "busy", scope: which, text: "Reading fonts…" });
  try {
    var texts = await textLayers(which, function (text) {
      send({ type: "busy", scope: which, text: text });
    });
    var tally = tallyFonts(texts, await availableFonts());
    var missing = tally.fonts.filter(function (font) {
      return font.missing;
    });
    send({
      type: "result",
      scope: which,
      nothingSelected: which === "selection" && figma.currentPage.selection.length === 0,
      families: groupByFamily(tally.fonts),
      fonts: tally.fonts.length,
      missing: missing.length,
      layers: tally.layers,
      missingLayers: tally.missingLayers,
      unreadable: tally.unreadable,
      copy: { missing: asLines(missing), all: asLines(tally.fonts), json: asJson(tally.fonts) },
    });
  } catch (e) {
    send({ type: "error", scope: which, text: "Couldn't read the fonts: " + errorText(e) });
  }
}

/** Messages from ui.html. Returns the read, so tests can wait for it. */
figma.ui.onmessage = function (message) {
  if (!message) return;
  if (message.type === "read" && SCOPES.indexOf(message.scope) >= 0) {
    scope = message.scope;
    return read(scope);
  }
  if (message.type === "notify") figma.notify(String(message.text), { error: !!message.error });
};

// Follow the selection, and the page you're on, while those are what's listed. Selecting by
// dragging fires many changes, so wait for it to settle.
var selectionTimer = 0;
figma.on("selectionchange", function () {
  if (scope !== "selection") return;
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(function () {
    read("selection");
  }, 150);
});
figma.on("currentpagechange", function () {
  if (scope !== "all") read(scope);
});

read(scope);
