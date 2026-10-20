// Run with `npm run test:ui`. The private Figma plugin (figma-plugin/code.js), run against a
// stand-in for Figma's plugin API: which fonts it lists, which it marks missing, and the text it
// copies for "Turn on fonts from a list…".
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { parseFontList } from "./fontList.ts";

const PLUGIN = new URL("../figma-plugin/", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, PLUGIN), "utf8");
const CODE = read("code.js");

type Font = [family: string, style: string];
type Message = { type: string; scope: string; [field: string]: any };
interface FakeNode {
  id: string;
  type: string;
  children?: FakeNode[];
  [field: string]: any;
}

const MIXED = Symbol("mixed");
let nextId = 1;

/** Every layer inside `node`, at any depth. */
function inside(node: FakeNode): FakeNode[] {
  return (node.children ?? []).flatMap((child) => [child, ...inside(child)]);
}

/** Figma's search: the layers inside `node` of the given types. */
function search(node: FakeNode, criteria: { types: string[] }) {
  return inside(node).filter((n) => criteria.types.includes(n.type));
}

/** A text layer with one character per entry of `runs`, each in that font. */
function text(runs: Font[], options: { missing?: boolean; broken?: boolean } = {}): FakeNode {
  const fonts = runs.map(([family, style]) => ({ family, style }));
  return {
    id: `text-${nextId++}`,
    type: "TEXT",
    characters: "x".repeat(fonts.length),
    fontName: fonts.length === 1 ? fonts[0] : MIXED,
    hasMissingFont: !!options.missing,
    getRangeAllFontNames(start: number, end: number) {
      if (options.broken) throw new Error("this layer can't be read");
      assert.deepEqual([start, end], [0, fonts.length], "asks for the whole layer");
      return fonts;
    },
  };
}

/** A text layer with no characters: its font is only in `fontName`. */
function emptyText([family, style]: Font): FakeNode {
  return {
    id: `text-${nextId++}`,
    type: "TEXT",
    characters: "",
    fontName: { family, style },
    hasMissingFont: false,
    getRangeAllFontNames() {
      throw new Error("an empty range can't be asked for");
    },
  };
}

function frame(children: FakeNode[]): FakeNode {
  const node: FakeNode = { id: `frame-${nextId++}`, type: "FRAME", children };
  node.findAllWithCriteria = (criteria: { types: string[] }) => search(node, criteria);
  return node;
}

/** A page that, like Figma's with "dynamic-page" access, can't be searched until loaded.
 *  `gate` holds its loading back until the test lets it go. */
function page(children: FakeNode[], gate: Promise<void> = Promise.resolve()): FakeNode {
  const node: FakeNode = { id: `page-${nextId++}`, type: "PAGE", children, loaded: false, selection: [] };
  node.loadAsync = async () => {
    await gate;
    node.loaded = true;
  };
  node.findAllWithCriteria = (criteria: { types: string[] }) => {
    if (!node.loaded) throw new Error("the page isn't loaded");
    return search(node, criteria);
  };
  return node;
}

/** Runs code.js against a stand-in Figma with these pages (the first one current) and these
 *  fonts available. */
function plugin(pages: FakeNode[], available: Font[]) {
  const posted: Message[] = [];
  const notices: unknown[] = [];
  const events: Record<string, () => void> = {};
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const figma = {
    mixed: MIXED,
    root: { children: pages },
    currentPage: pages[0],
    showUI() {},
    ui: {
      // A plain copy, so messages compare like any other object.
      postMessage: (message: unknown) => posted.push(JSON.parse(JSON.stringify(message))),
      onmessage: null as null | ((message: unknown) => Promise<void> | undefined),
    },
    on: (type: string, callback: () => void) => (events[type] = callback),
    notify: (text: string, options: unknown) => notices.push([text, JSON.parse(JSON.stringify(options))]),
    listAvailableFontsAsync: async () => available.map(([family, style]) => ({ fontName: { family, style } })),
  };
  const sandbox: Record<string, any> = {
    figma,
    __html__: "<p>ui.html</p>",
    setTimeout: (callback: () => void) => (timers.set(nextTimer, callback), nextTimer++),
    clearTimeout: (id: number) => timers.delete(id),
  };
  runInNewContext(CODE, sandbox, { filename: "code.js" });
  const results = () => posted.filter((m) => m.type === "result");
  return {
    figma,
    sandbox,
    posted,
    notices,
    events,
    timers,
    results,
    /** Asks for a read, as ui.html does, and waits for it. */
    async list(scope: string): Promise<Message> {
      await figma.ui.onmessage!({ type: "read", scope });
      const last = posted[posted.length - 1];
      assert.equal(last.scope, scope);
      return last;
    },
  };
}

const settle = () => new Promise((done) => setImmediate(done));

test("lists every font on every page, once per layer using it, and marks the ones Figma can't find", async () => {
  const later = page([text([["Lora", "Italic"]], { missing: true }), emptyText(["Inter", "Bold"])]);
  const p = plugin(
    [page([frame([text([["Inter", "Regular"], ["Inter", "Bold"], ["Inter", "Regular"]]), text([["Inter", "Regular"]])])]), later],
    [["Inter", "Regular"], ["Inter", "Bold"]],
  );
  const result = await p.list("all");
  assert.equal(result.type, "result");
  assert.ok(later.loaded, "every page is loaded before it's searched");
  assert.deepEqual(result.families, [
    {
      family: "Inter",
      missing: 0,
      styles: [
        { family: "Inter", style: "Regular", layers: 2, missing: false },
        { family: "Inter", style: "Bold", layers: 2, missing: false },
      ],
    },
    { family: "Lora", missing: 1, styles: [{ family: "Lora", style: "Italic", layers: 1, missing: true }] },
  ]);
  assert.equal(result.fonts, 3);
  assert.equal(result.missing, 1);
  assert.equal(result.layers, 4);
  assert.equal(result.missingLayers, 1);
  assert.equal(result.unreadable, 0);
  assert.equal(result.nothingSelected, false);
});

test("copies \"Family Style\" lines, missing ones on their own, and the same list as JSON", async () => {
  const p = plugin(
    [page([text([["Inter", "Bold"], ["IBM Plex Sans", "SemiBold Italic"]]), text([["Lora", "Regular"]])])],
    [["Inter", "Bold"]],
  );
  const { copy } = await p.list("all");
  assert.equal(copy.missing, "IBM Plex Sans SemiBold Italic\nLora Regular");
  assert.equal(copy.all, "IBM Plex Sans SemiBold Italic\nInter Bold\nLora Regular");
  assert.deepEqual(JSON.parse(copy.json), {
    fonts: [
      { family: "IBM Plex Sans", style: "SemiBold Italic" },
      { family: "Inter", style: "Bold" },
      { family: "Lora", style: "Regular" },
    ],
  });
});

test("nothing missing copies nothing for Copy missing, and an empty file copies an empty list", async () => {
  const p = plugin([page([text([["Inter", "Regular"]])])], [["Inter", "Regular"]]);
  assert.equal((await p.list("all")).copy.missing, "");
  const empty = plugin([page([])], []);
  const result = await empty.list("all");
  assert.deepEqual(result.families, []);
  assert.deepEqual(result.copy, { missing: "", all: "", json: '{\n  "fonts": []\n}' });
});

test("styles go by weight, upright before italic, other names after; families A to Z, numbers in order", async () => {
  const styles = ["Bold Italic", "Condensed", "Regular", "Light", "Bold", "Italic", "Black", "Extra-Bold", "Semi Bold"];
  const runs: Font[] = styles.map((style) => ["Sans", style]);
  const p = plugin([page([text([...runs, ["Abc 10", "Regular"], ["abc 9", "Regular"], ["Zed", "Regular"]])])], []);
  const result = await p.list("all");
  assert.deepEqual(
    result.families.map((f: { family: string }) => f.family),
    ["abc 9", "Abc 10", "Sans", "Zed"],
  );
  assert.deepEqual(
    result.families[2].styles.map((f: { style: string }) => f.style),
    ["Light", "Regular", "Italic", "Semi Bold", "Bold", "Bold Italic", "Extra-Bold", "Black", "Condensed"],
  );
});

test("This page reads only the page you're on; Selection reads the selected layers and what's in them, each once", async () => {
  const inFrame = text([["Inter", "Regular"]]);
  const box = frame([inFrame]);
  const alone = text([["Lora", "Bold"]]);
  const other = page([text([["Mono", "Regular"]])]);
  const current = page([box, alone]);
  const p = plugin([current, other], []);
  // Opening the plugin reads every page; this checks This page on its own.
  await settle();
  other.loaded = false;

  const onPage = await p.list("page");
  assert.deepEqual(onPage.copy.all, "Inter Regular\nLora Bold");
  assert.equal(other.loaded, false, "other pages aren't loaded");

  current.selection = [box, inFrame];
  const selected = await p.list("selection");
  assert.equal(selected.copy.all, "Inter Regular");
  assert.equal(selected.layers, 1, "a selected layer inside a selected frame counts once");

  current.selection = [];
  const none = await p.list("selection");
  assert.equal(none.nothingSelected, true);
  assert.deepEqual(none.families, []);
});

test("a layer that can't be read is counted, and the others are still listed", async () => {
  const p = plugin([page([text([["Inter", "Regular"]], { broken: true }), text([["Lora", "Bold"]])])], []);
  const result = await p.list("all");
  assert.equal(result.unreadable, 1);
  assert.equal(result.copy.all, "Lora Bold");
});

test("only the newest read reports: an older one that finishes late stays quiet", async () => {
  let release = () => {};
  const slow = page([text([["Slow", "Regular"]])], new Promise<void>((done) => (release = done)));
  const p = plugin([page([text([["Inter", "Regular"]])]), slow], []);
  // Opening the plugin starts reading all pages, which waits on the slow page.
  assert.deepEqual(p.posted, [
    { type: "busy", scope: "all", text: "Reading fonts…" },
    { type: "busy", scope: "all", text: "Reading page 1 of 2…" },
  ]);
  await settle();
  const onPage = await p.list("page");
  assert.equal(onPage.copy.all, "Inter Regular");
  release();
  await settle();
  assert.deepEqual(
    p.results().map((m) => m.scope),
    ["page"],
    "the first read, of all pages, never sends its list",
  );
});

test("follows the selection while Selection is chosen, once the selection settles", async () => {
  const first = text([["Inter", "Regular"]]);
  const second = text([["Lora", "Bold"]]);
  const current = page([first, second]);
  const p = plugin([current], []);
  await settle();

  p.events.selectionchange();
  assert.equal(p.timers.size, 0, "All pages is chosen: the selection doesn't matter");

  current.selection = [first];
  await p.list("selection");
  current.selection = [second];
  p.events.selectionchange();
  p.events.selectionchange();
  assert.equal(p.timers.size, 1, "many changes in a row read once");
  for (const [, callback] of p.timers) callback();
  await settle();
  assert.equal(p.results().at(-1)!.copy.all, "Lora Bold");
});

test("the window's notices show in Figma", () => {
  const p = plugin([page([])], []);
  p.figma.ui.onmessage!({ type: "notify", text: "Copied 3 missing fonts" });
  assert.deepEqual(p.notices, [["Copied 3 missing fonts", { error: false }]]);
});

test("the plugin stays offline: no network in the manifest, nothing loaded from the web", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.deepEqual(manifest.networkAccess, { allowedDomains: ["none"] });
  assert.equal(manifest.documentAccess, "dynamic-page");
  assert.deepEqual(manifest.editorType, ["figma"]);
  for (const file of [manifest.main, manifest.ui, "README.md"]) {
    assert.ok(existsSync(new URL(file, PLUGIN)), `${file} is there`);
  }
  const ui = read("ui.html");
  for (const source of [CODE, ui]) {
    assert.doesNotMatch(source, /https?:|fetch\(|XMLHttpRequest|WebSocket|<script\s+src|<link/);
  }
  assert.doesNotMatch(ui, /\stitle=/, "tooltips come from the window's own Tip, never `title`");
});

// ------------------------------------------------------- into Turn On Fonts from a List…

/** The fonts behind figma-plugin/fixtures/: a mix of names, weights, slants and variable styles,
 *  one Figma can't find. src-tauri/src/font_names/tests.rs matches the same files. */
const FIXTURE_FONTS: Font[] = [
  ["Univers LT Std", "45 Light"],
  ["Inter", "Regular"],
  ["Inter Display", "Bold"],
  ["IBM Plex Sans", "SemiBold Italic"],
  ["Lora", "Italic"],
  ["Fraunces", "Black Italic"],
  ["Noto Sans JP", "Medium"],
  ["Helvetica", "Bold Oblique"],
  ["Söhne", "Buch"],
];

test("what the plugin copies is the fixtures, and Turn On Fonts from a List… reads them font for font", async () => {
  const p = plugin([page([text(FIXTURE_FONTS)])], FIXTURE_FONTS.filter(([family]) => family !== "Söhne"));
  const { copy } = await p.list("all");
  const all = read("fixtures/copy-all.txt");
  const json = read("fixtures/copy-as-json.json");
  assert.equal(copy.all, all.trimEnd(), "Copy all gives fixtures/copy-all.txt");
  assert.equal(copy.json, json.trimEnd(), "Copy as JSON gives fixtures/copy-as-json.json");
  assert.equal(copy.missing, "Söhne Buch");

  // Lines: each one is a name for the matcher, as it is.
  const lines = parseFontList(all);
  assert.equal(lines.badJson, false);
  assert.equal(lines.repeats, 0);
  assert.deepEqual(
    lines.entries.map((e) => e.line),
    all.trimEnd().split("\n"),
  );
  // JSON: each font by family and style, labelled the same as its line.
  const fromJson = parseFontList(json);
  assert.equal(fromJson.badJson, false);
  assert.deepEqual(
    fromJson.entries.map((e) => e.line),
    JSON.parse(json).fonts,
  );
  assert.deepEqual(
    fromJson.entries.map((e) => e.label),
    lines.entries.map((e) => e.label),
  );
  assert.equal(fromJson.entries.length, FIXTURE_FONTS.length);
  // Copy missing reads the same way.
  assert.deepEqual(
    parseFontList(copy.missing).entries.map((e) => e.line),
    ["Söhne Buch"],
  );
});
