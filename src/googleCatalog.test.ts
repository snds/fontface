// Run with `npm run test:ui`. The Google Fonts view: what you have, the filters, each row's
// actions (googleCatalog.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FontSummary } from "./api.ts";
import {
  CATALOG_SHOWS,
  catalogCounts,
  catalogLoader,
  countText,
  filterCatalog,
  holdingsOf,
  isActive,
  nameMatches,
  noMatchText,
  openFace,
  rowLabel,
  rowPlan,
  switchFaces,
  switchIds,
  turnOnFaces,
  uninstallWords,
  yoursFirstTip,
  type CatalogFamily,
} from "./googleCatalog.ts";
import { activationIds, groupFamilies, type Face } from "./library.ts";

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
  assert.deepEqual(names(switchFaces({ downloaded: [], yours: h.yours, files: new Set() })), ["Inter-Regular"]);
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
  // Only the copy in the downloaded folder is the download.
  assert.deepEqual([...h.files], [`${GOOGLE}/Lora/Lora-Regular.ttf`]);
});

test("a downloaded style with a copy of yours too: Uninstall counts only the download and says yours stays; the switch turns on Google's", () => {
  // Your own Lora from fonts.google.com, then Get Google's Lora: the same PostScript name, so one
  // style with two copies. Your copy is the newer file.
  const google = font("Lora", "Regular", { path: `${GOOGLE}/Lora/Lora[wght].ttf`, postscriptName: "Lora-Regular", mtime: 1 });
  const mine = font("Lora", "Regular", { path: "/Users/me/Fonts/Lora-VariableFont_wght.ttf", postscriptName: "Lora-Regular", mtime: 2 });
  const h = holdingsOf([fam("lora", "Lora", { installed: downloadedAt("Lora") })], facesOf([google, mine])).get("lora")!;
  assert.deepEqual(uninstallWords("Lora", h), [
    "Fontface turns off its 1 downloaded font file and removes it from its Google Fonts folder.",
    "Your own copy of Lora stays in your library, as it is.",
    "You can get Lora from Google again at any time.",
  ]);
  // On: Google's copy, not yours (as Get turned it on). Off: every copy, so the style goes off.
  assert.deepEqual(switchIds(h, true), [google.id]);
  assert.deepEqual(switchIds(h, false).sort(), [google.id, mine.id].sort());
  // The font menu and the Font menu turn on the same copy as the switch (FontTarget.onFaces).
  assert.deepEqual(activationIds(turnOnFaces(h), true), [google.id]);
  // Your copy alone (nothing downloaded): the switch works on it, as the library's does.
  const yours = holdingsOf([fam("lora", "Lora")], facesOf([mine])).get("lora")!;
  assert.deepEqual(switchIds(yours, true), [mine.id]);
  assert.deepEqual(switchIds(undefined, true), []);
});

test("the Installed switch's tooltip says what flipping it does", () => {
  assert.equal(yoursFirstTip(true), "Lists every family A to Z");
  assert.equal(yoursFirstTip(false), "Lists installed families first, downloaded here or already in your library");
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

test("each row offers what fits: the switch and Uninstall once downloaded, Get before", () => {
  const plan = (id: string, working = false) => rowPlan(CATALOG.find((f) => f.id === id)!, HOLDINGS.get(id), working);
  // Downloaded, with an update: the switch, Update, and Uninstall on hover.
  assert.deepEqual(plan("inter"), { have: true, downloaded: true, main: "switch", hover: "uninstall", extras: ["update"] });
  // Your own copy, not downloaded from Google: no switch, and Google's version to get on hover.
  // Never Uninstall: those are your files.
  assert.deepEqual(plan("roboto"), { have: true, downloaded: false, main: null, hover: "getCopy", extras: [] });
  // Your copy is installed in macOS's font folders: still no switch (or lock) here.
  assert.deepEqual(plan("roboto-mono"), { have: true, downloaded: false, main: null, hover: "getCopy", extras: [] });
  // Nothing of it: Get.
  assert.deepEqual(plan("lora"), { have: false, downloaded: false, main: "get", hover: null, extras: [] });
  // Can't be downloaded: says why.
  assert.deepEqual(plan("material-symbols"), { have: false, downloaded: false, main: "unavailable", hover: null, extras: [] });
  // Working: progress takes Get's place, or stands for Update and Uninstall (the switch stays).
  assert.deepEqual(plan("lora", true), { have: false, downloaded: false, main: "working", hover: null, extras: [] });
  assert.deepEqual(plan("inter", true), { have: true, downloaded: true, main: "switch", hover: null, extras: ["working"] });
  // Getting Google's version beside your copy: its progress where Get would be.
  assert.deepEqual(plan("roboto", true), { have: true, downloaded: false, main: "working", hover: null, extras: [] });
  // Downloaded, but its styles aren't in the library yet (a scan is coming): no switch, no Get.
  assert.deepEqual(rowPlan(fam("lora", "Lora", { installed: downloadedAt("Lora") }), undefined, false), {
    have: false,
    downloaded: true,
    main: null,
    hover: "uninstall",
    extras: [],
  });
});

test("the switch works on a download only, never on your own copy beside it", () => {
  const mine = font("Lora", "Regular", { path: "/Users/me/Fonts/Lora-Regular.ttf", postscriptName: "Lora-Mine" });
  const yours = holdingsOf([fam("lora", "Lora")], facesOf([mine])).get("lora")!;
  // Only your copy: no switch.
  assert.equal(rowPlan(fam("lora", "Lora"), yours, false).main, null);
  // Just downloaded, before the scan lists Google's styles: your copy is all the library has of
  // it, so still no switch (it would turn your copy on and off).
  const downloaded = fam("lora", "Lora", { installed: downloadedAt("Lora") });
  assert.deepEqual(rowPlan(downloaded, yours, false), { have: true, downloaded: true, main: null, hover: "uninstall", extras: [] });
  // Once Google's styles are in the library: the switch, on those.
  const google = font("Lora", "Regular", { path: `${GOOGLE}/Lora/Lora-Regular.ttf`, postscriptName: "Lora-Regular" });
  const both = holdingsOf([downloaded], facesOf([google, mine])).get("lora")!;
  assert.equal(rowPlan(downloaded, both, false).main, "switch");
  assert.deepEqual(switchIds(both, true), [google.id]);
});

test("a row's name for screen readers is short and says what you have", () => {
  const label = (id: string) => {
    const f = CATALOG.find((x) => x.id === id)!;
    const h = HOLDINGS.get(id);
    return rowLabel(f, rowPlan(f, h, false), h);
  };
  assert.equal(label("inter"), "Inter, downloaded, 1 of 2 on, update available");
  // Your own copy has no switch here, so its row doesn't say whether it's on.
  assert.equal(label("roboto"), "Roboto, your copy");
  assert.equal(label("roboto-mono"), "Roboto Mono, your copy");
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

test("Uninstall's confirmation counts the downloaded files, leaves your copy alone, and says you can get it again", () => {
  assert.deepEqual(uninstallWords("Inter", HOLDINGS.get("inter")), [
    "Fontface turns off its 2 downloaded font files and removes them from its Google Fonts folder.",
    "You can get Inter from Google again at any time.",
  ]);
  const one = HOLDINGS.get("inter")!.downloaded.slice(0, 1);
  const both = { downloaded: one, yours: HOLDINGS.get("roboto")!.yours, files: new Set(one.flatMap((f) => f.copies.map((c) => c.path))) };
  assert.deepEqual(uninstallWords("Inter", both), [
    "Fontface turns off its 1 downloaded font file and removes it from its Google Fonts folder.",
    "Your own copy of Inter stays in your library, as it is.",
    "You can get Inter from Google again at any time.",
  ]);
  assert.deepEqual(uninstallWords("Inter", undefined), [
    "Fontface turns off its downloaded files and removes them from its Google Fonts folder.",
    "You can get Inter from Google again at any time.",
  ]);
  // Never "delete": uninstalling isn't final.
  for (const w of uninstallWords("Inter", both)) assert.doesNotMatch(w, /delet/i);
});

/** A promise to settle by hand. */
function later<T>() {
  let settle!: { resolve: (v: T) => void; reject: (e: unknown) => void };
  const promise = new Promise<T>((resolve, reject) => (settle = { resolve, reject }));
  return { promise, ...settle };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("a load asked for during a refresh waits for it, so the refresh's answer isn't lost to the saved copy", async () => {
  const asked: boolean[] = [];
  const network = later<string>();
  const load = catalogLoader((refresh) => {
    asked.push(refresh);
    return refresh ? network.promise : Promise.resolve("saved, with the new download");
  });
  // Refresh clicked; a download finishes while it waits on the network.
  const refresh = load(true);
  const after = load(false);
  await tick();
  assert.deepEqual(asked, [true], "the plain load hasn't asked yet");
  assert.ok(!refresh.newest() && after.newest());
  network.resolve("fresh");
  assert.equal(await refresh.result, "fresh");
  // Then it reads the catalog the refresh saved, with what's installed now; it's the one that lands.
  assert.equal(await after.result, "saved, with the new download");
  assert.deepEqual(asked, [true, false]);

  // No refresh under way: a plain load asks at once.
  const plain = load(false);
  await tick();
  assert.deepEqual(asked, [true, false, false]);
  assert.ok(plain.newest());
});

test("a refresh that fails still lets the waiting load go ahead", async () => {
  const network = later<string>();
  const load = catalogLoader((refresh) => (refresh ? network.promise : Promise.resolve("saved")));
  const refresh = load(true);
  const after = load(false);
  network.reject(new Error("offline"));
  await assert.rejects(refresh.result, /offline/);
  assert.equal(await after.result, "saved");
  // The waiting load, the newest one, can still say the Refresh failed.
  assert.ok(after.newest());
  assert.match(String(after.waited()?.error), /offline/);
  assert.equal(refresh.waited(), null, "the refresh waited for nothing");
});

test("a load that waited for a refresh knows what it answered", async () => {
  const network = later<{ stale: boolean }>();
  const load = catalogLoader((refresh) => (refresh ? network.promise : Promise.resolve({ stale: false })));
  load(true);
  const after = load(false);
  network.resolve({ stale: true });
  assert.deepEqual(await after.result, { stale: false });
  assert.deepEqual(after.waited(), { value: { stale: true } }, "the refresh couldn't reach the catalog: the view still says so");
});
