// Run with `npm run test:ui`. The Google Fonts view: what you have, the filters, each row's
// actions (googleCatalog.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FontSummary } from "./api.ts";
import {
  CATALOG_SHOWS,
  catalogCounts,
  countText,
  filterCatalog,
  holdingsOf,
  isActive,
  nameMatches,
  noMatchText,
  openFace,
  removalWords,
  rowLabel,
  rowPlan,
  switchFaces,
  type CatalogFamily,
} from "./googleCatalog.ts";
import { groupFamilies, type Face } from "./library.ts";

const GOOGLE = "/Users/me/Library/Application Support/fontface/Services/Google Fonts";

let nextId = 1;
function font(family: string, subfamily: string, more: Partial<FontSummary> = {}): FontSummary {
  const id = nextId++;
  return {
    id,
    folderId: 1,
    path: `/fonts/${family}-${subfamily}-${id}.otf`,
    faceIndex: 0,
    family,
    subfamily,
    fullName: null,
    postscriptName: `${family.replace(/\s/g, "")}-${subfamily}`,
    weight: subfamily.includes("Bold") ? 700 : 400,
    width: 5,
    italic: subfamily.includes("Italic"),
    monospace: false,
    variable: false,
    format: "OpenType CFF",
    activated: false,
    installed: false,
    mtime: 1,
    fileSize: 1,
    osActive: false,
    glyphCount: 1,
    preview: null,
    ...more,
  };
}

const facesOf = (fonts: FontSummary[]): Face[] => groupFamilies(fonts).flatMap((f) => f.faces);

function fam(id: string, family: string, more: Partial<CatalogFamily> = {}): CatalogFamily {
  return { id, family, category: "sans-serif", variable: false, installed: null, updateAvailable: false, unavailable: null, ...more };
}

const downloadedAt = (folder: string) => ({ dir: `${GOOGLE}/${folder}`, lastModified: "2024-01-01" });

// Inter: downloaded here (two styles, one of them on). Roboto: your own copy, in your folder,
// with a macOS-installed copy of Roboto Mono beside it. Lora: nothing.
const CATALOG = [
  fam("inter", "Inter", { installed: downloadedAt("Inter"), variable: true, updateAvailable: true }),
  fam("roboto", "Roboto"),
  fam("roboto-mono", "Roboto Mono", { category: "monospace" }),
  fam("lora", "Lora", { category: "serif" }),
  fam("material-symbols", "Material Symbols", { category: "icons", unavailable: "Not in the icon table yet" }),
];
const FONTS = [
  font("Inter", "Regular", { path: `${GOOGLE}/Inter/Inter-Regular.ttf`, activated: true, osActive: true }),
  font("Inter", "Bold", { path: `${GOOGLE}/Inter/static/Inter-Bold.ttf` }),
  font("Roboto", "Regular", { path: "/Users/me/Fonts/Roboto/Roboto-Regular.ttf" }),
  font("Roboto", "Italic", { path: "/Users/me/Fonts/Roboto/Roboto-Italic.ttf" }),
  font("RobotoMono", "Regular", { path: "/Library/Fonts/RobotoMono-Regular.ttf", installed: true, osActive: true }),
  font("Helvetica", "Regular", { path: "/System/Library/Fonts/Helvetica.ttc", installed: true, osActive: true }),
];
const FACES = facesOf(FONTS);
const HOLDINGS = holdingsOf(CATALOG, FACES);
/** Each style by its file's name, so grouping by name (Inter Display as Inter's "Display") doesn't matter. */
const names = (faces: Face[]) => faces.map((f) => f.primary.path.split("/").pop()!.replace(/-\d+\.otf$/, "").replace(/\.(ttf|otf|ttc)$/, "")).sort();

test("what you have: styles in a downloaded folder, or your own copy by name", () => {
  assert.deepEqual(names(HOLDINGS.get("inter")!.downloaded), ["Inter-Bold", "Inter-Regular"], "at any depth in its folder");
  assert.deepEqual(HOLDINGS.get("inter")!.yours, []);
  assert.deepEqual(names(HOLDINGS.get("roboto")!.yours), ["Roboto-Italic", "Roboto-Regular"]);
  // "RobotoMono" and "Roboto Mono" are the same name, ignoring spaces.
  assert.deepEqual(names(HOLDINGS.get("roboto-mono")!.yours), ["RobotoMono-Regular"]);
  assert.ok(!HOLDINGS.has("lora"), "nothing of it");
  assert.equal([...HOLDINGS.values()].flatMap((h) => [...h.downloaded, ...h.yours]).length, 5, "Helvetica isn't a Google family");
});

test("a style in a downloaded folder is that family's, whatever its name; your copy elsewhere stays yours", () => {
  const fonts = [
    font("Inter Display", "Regular", { path: `${GOOGLE}/Inter/Inter Display-Regular.ttf` }),
    font("Inter", "Regular", { path: "/Users/me/Fonts/Inter-Regular.otf", postscriptName: "Inter-Regular-Mine" }),
  ];
  const h = holdingsOf([fam("inter", "Inter", { installed: downloadedAt("Inter") })], facesOf(fonts)).get("inter")!;
  assert.deepEqual(names(h.downloaded), ["Inter Display-Regular"]);
  assert.deepEqual(names(h.yours), ["Inter-Regular"]);
  // The switch works on the download when there is one, else on your copy.
  assert.deepEqual(names(switchFaces(h)), ["Inter Display-Regular"]);
  assert.deepEqual(names(switchFaces({ downloaded: [], yours: h.yours })), ["Inter-Regular"]);
  assert.deepEqual(switchFaces(undefined), []);
});

test("the same style downloaded and in your folder is one style with two copies, counted as the download", () => {
  const fonts = [
    font("Lora", "Regular", { path: `${GOOGLE}/Lora/Lora-Regular.ttf`, postscriptName: "Lora-Regular" }),
    font("Lora", "Regular", { path: "/Users/me/Fonts/Lora-Regular.ttf", postscriptName: "Lora-Regular" }),
  ];
  const h = holdingsOf([fam("lora", "Lora", { installed: downloadedAt("Lora") })], facesOf(fonts)).get("lora")!;
  assert.equal(h.downloaded.length, 1);
  assert.equal(h.downloaded[0].copies.length, 2);
  assert.equal(h.yours.length, 0);
});

test("Active: some style of the family is on, downloaded here or your own copy", () => {
  assert.ok(isActive(HOLDINGS.get("inter")));
  assert.ok(!isActive(HOLDINGS.get("roboto")));
  assert.ok(isActive(HOLDINGS.get("roboto-mono")), "installed in macOS's font folders: always on");
  assert.ok(!isActive(undefined));
});

test("the toolbar's filters: All, Downloaded, Active, Updates", () => {
  const ids = (show: (typeof CATALOG_SHOWS)[number]["value"]) => filterCatalog(CATALOG, { show }, HOLDINGS).map((f) => f.id);
  assert.deepEqual(ids("all"), ["inter", "roboto", "roboto-mono", "lora", "material-symbols"]);
  assert.deepEqual(ids("downloaded"), ["inter"]);
  assert.deepEqual(ids("active"), ["inter", "roboto-mono"]);
  assert.deepEqual(ids("updates"), ["inter"]);
  assert.deepEqual(catalogCounts(CATALOG, HOLDINGS), { all: 5, downloaded: 1, active: 2, updates: 1 });
  // Every filter has words for its tooltip.
  for (const s of CATALOG_SHOWS) assert.ok(s.tip.length > 10);
});

test("search, category and Variable narrow the list, in the catalog's order", () => {
  const ids = (filters: Parameters<typeof filterCatalog>[1]) => filterCatalog(CATALOG, filters, HOLDINGS).map((f) => f.id);
  assert.deepEqual(ids({ query: "rob" }), ["roboto", "roboto-mono"]);
  assert.deepEqual(ids({ query: "  ROBOTO MONO " }), ["roboto-mono"]);
  assert.deepEqual(ids({ query: "robotomono" }), ["roboto-mono"], "spaces left out");
  assert.deepEqual(ids({ category: "serif" }), ["lora"]);
  assert.deepEqual(ids({ variableOnly: true }), ["inter"]);
  assert.deepEqual(ids({ query: "o", category: "monospace", show: "active" }), ["roboto-mono"]);
  assert.deepEqual(ids({ query: "zzz" }), []);
});

test("names match as typed, or with spaces and punctuation left out", () => {
  assert.ok(nameMatches("IBM Plex Sans", "plex s"));
  assert.ok(nameMatches("IBM Plex Sans", "ibmplex"));
  assert.ok(nameMatches("IBM Plex Sans", ""));
  assert.ok(!nameMatches("IBM Plex Sans", "serif"));
  assert.ok(!nameMatches("Inter", " - "), "punctuation alone finds only names that have it");
  assert.ok(nameMatches("Noto Sans JP", "sans-jp"));
});

test("the count and the empty list say what's shown", () => {
  assert.equal(countText(1876, 1876), "1,876 families");
  assert.equal(countText(12, 1876), "12 of 1,876 families");
  assert.equal(countText(1, 1), "1 family");
  assert.equal(noMatchText({}), "No families here.");
  assert.equal(noMatchText({ show: "downloaded", variableOnly: true, query: " inter " }), "No downloaded variable families match “inter”.");
  assert.equal(noMatchText({ category: "handwriting", show: "active" }), "No active handwriting families here.");
  assert.equal(noMatchText({ show: "updates" }), "No families have updates.");
});

test("each row offers what fits: the switch for what you have, Get for the rest", () => {
  const plan = (id: string, working = false) => rowPlan(CATALOG.find((f) => f.id === id)!, HOLDINGS.get(id), working);
  // Downloaded, with an update: the switch, Update and Remove.
  assert.deepEqual(plan("inter"), { have: true, downloaded: true, main: "switch", extras: ["update", "remove"] });
  // Your own copy: the switch, and Google's copy to get. Never Remove: those are your files.
  assert.deepEqual(plan("roboto"), { have: true, downloaded: false, main: "switch", extras: ["getCopy"] });
  // Nothing of it: Get.
  assert.deepEqual(plan("lora"), { have: false, downloaded: false, main: "get", extras: [] });
  // Can't be downloaded: says why.
  assert.deepEqual(plan("material-symbols"), { have: false, downloaded: false, main: "unavailable", extras: [] });
  // Working: progress takes Get's place, or stands for Update and Remove (the switch stays).
  assert.deepEqual(plan("lora", true), { have: false, downloaded: false, main: "working", extras: [] });
  assert.deepEqual(plan("inter", true), { have: true, downloaded: true, main: "switch", extras: ["working"] });
  // Downloaded, but its styles aren't in the library yet (a scan is coming): no switch, no Get.
  assert.deepEqual(rowPlan(fam("lora", "Lora", { installed: downloadedAt("Lora") }), undefined, false), {
    have: false,
    downloaded: true,
    main: null,
    extras: ["remove"],
  });
});

test("a row's name for screen readers is short and says what you have", () => {
  const label = (id: string) => {
    const f = CATALOG.find((x) => x.id === id)!;
    const h = HOLDINGS.get(id);
    return rowLabel(f, rowPlan(f, h, false), h);
  };
  assert.equal(label("inter"), "Inter, downloaded, 1 of 2 on, update available");
  assert.equal(label("roboto"), "Roboto, your copy, off");
  assert.equal(label("roboto-mono"), "Roboto Mono, your copy, always on, installed");
  assert.equal(label("lora"), "Lora, not downloaded");
  assert.equal(label("material-symbols"), "Material Symbols, can't be downloaded here");
  // While it downloads, updates or goes.
  const lora = CATALOG.find((x) => x.id === "lora")!;
  assert.equal(rowLabel(lora, rowPlan(lora, undefined, true), undefined), "Lora, not downloaded, working");
});

test("a family's page opens on its most regular style", () => {
  assert.equal(openFace(HOLDINGS.get("roboto")!.yours)?.style, "Regular");
  assert.equal(openFace(HOLDINGS.get("inter")!.downloaded)?.style, "Regular");
  assert.equal(openFace([]), undefined);
});

test("Remove's confirmation counts the downloaded files and leaves your copy alone", () => {
  assert.deepEqual(removalWords("Inter", HOLDINGS.get("inter")), ["Fontface turns off its 2 downloaded font files and deletes them from its Google Fonts folder."]);
  const both = { downloaded: HOLDINGS.get("inter")!.downloaded.slice(0, 1), yours: HOLDINGS.get("roboto")!.yours };
  assert.deepEqual(removalWords("Inter", both), [
    "Fontface turns off its 1 downloaded font file and deletes them from its Google Fonts folder.",
    "Your own copy of Inter stays in your library, as it is.",
  ]);
  assert.deepEqual(removalWords("Inter", undefined), ["Fontface turns off its downloaded files and deletes them from its Google Fonts folder."]);
});
