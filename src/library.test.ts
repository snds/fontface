// Run with `npm run test:ui`. Grouping the library into families (library.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FontSummary } from "./api.ts";
import { filterFamilies, groupFamilies, sortFamilies, ungroup } from "./library.ts";

let nextId = 1;
function font(family: string, subfamily: string, more: Partial<FontSummary> = {}): FontSummary {
  const id = nextId++;
  return {
    id,
    folderId: 1,
    path: `/fonts/${family}-${subfamily}.otf`,
    faceIndex: 0,
    family,
    subfamily,
    fullName: `${family} ${subfamily}`,
    postscriptName: `${family.replace(/\s/g, "")}-${subfamily.replace(/\s/g, "")}`,
    weight: subfamily.includes("Bold") ? 700 : 400,
    width: 5,
    italic: subfamily.includes("Italic"),
    monospace: false,
    variable: false,
    format: "OpenType CFF",
    activated: false,
    installed: false,
    mtime: 1,
    fileSize: 1000,
    osActive: false,
    glyphCount: 100,
    preview: null,
    ...more,
  };
}

test("every family has an id that stays the same from one load to the next", () => {
  const fonts = [font("Inter", "Regular"), font("Inter", "Bold"), font("Lora", "Italic")];
  const first = groupFamilies(fonts);
  const again = groupFamilies(fonts.map((f) => ({ ...f, osActive: true })));
  assert.deepEqual(
    first.map((f) => f.id),
    again.map((f) => f.id),
  );
  assert.equal(new Set(first.map((f) => f.id)).size, first.length, "ids are unique");
  assert.ok(first.every((f) => f.id !== f.name), "the id isn't the bare name, so nothing mixes them up");
});

test("a narrowed family keeps its id", () => {
  const fonts = [font("Inter", "Regular"), font("Inter", "Variable", { variable: true }), font("Lora", "Regular")];
  const all = groupFamilies(fonts);
  const inter = all.find((f) => f.name === "Inter")!;
  const narrowed = filterFamilies(all, { kind: "all" }, { variableOnly: true });
  assert.equal(narrowed.length, 1);
  assert.equal(narrowed[0].id, inter.id);
  assert.equal(narrowed[0].faces.length, 1);
  assert.ok(narrowed[0].representative.primary.variable, "opened from a Variable-only list, the variable style comes first");
});

// ------------------------------------------------------------------ View options: ungroup, sort

const names = (families: { name: string }[]) => families.map((f) => f.name);

test("grouping off lists every style on its own, as Family Style, keeping each family's order", () => {
  const all = groupFamilies([font("Inter", "Bold"), font("Inter", "Regular"), font("Lora", "Italic")]);
  const single = ungroup(all);
  assert.deepEqual(names(single), ["Inter Regular", "Inter Bold", "Lora Italic"], "lightest first within a family, as the family lists them");
  assert.ok(single.every((f) => f.faces.length === 1));
  assert.ok(single.every((f) => f.ungroupedFrom === f.faces[0].primary.family), "each knows its family");
  assert.equal(new Set(single.map((f) => f.id)).size, 3, "ids are unique");
  assert.ok(single.every((f) => f.id.startsWith("u:") && !all.some((g) => g.id === f.id)), "and never a family's id");
  const bold = single[1];
  assert.equal(bold.representative, bold.faces[0]);
  assert.equal(bold.switchable.length, 1);
  // Ungrouping twice changes nothing.
  assert.deepEqual(names(ungroup(single)), names(single));
});

test("a single style keeps its family's on/off and lock", () => {
  const all = groupFamilies([font("Inter", "Regular", { osActive: true }), font("Inter", "Bold"), font("Sys", "Regular", { installed: true })]);
  const [regular, bold, sys] = ungroup(all);
  assert.equal(regular.activeCount, 1);
  assert.equal(bold.activeCount, 0);
  assert.equal(sys.switchable.length, 0, "installed: locked, no switch");
});

test("sort by name A to Z leaves a sorted list as it is; Z to A turns it round", () => {
  const all = groupFamilies([font("beta", "Regular"), font("Alpha", "Regular"), font("Gamma", "Regular")]);
  assert.equal(sortFamilies(all, { key: "name", desc: false }), all, "the same array back");
  assert.deepEqual(names(sortFamilies(all, { key: "name", desc: true })), ["Gamma", "beta", "Alpha"]);
  const shuffled = [all[2], all[0], all[1]];
  assert.deepEqual(names(sortFamilies(shuffled, { key: "name", desc: false })), ["Alpha", "beta", "Gamma"]);
});

test("with grouping off, a name sort keeps each family's styles together, lightest first", () => {
  const all = groupFamilies([font("Zed", "Bold"), font("Zed", "Light", { weight: 300 }), font("Ash", "Regular")]);
  const single = ungroup(all);
  assert.deepEqual(names(sortFamilies(single, { key: "name", desc: false })), ["Ash Regular", "Zed Light", "Zed Bold"]);
  assert.deepEqual(names(sortFamilies(single, { key: "name", desc: true })), ["Zed Light", "Zed Bold", "Ash Regular"], "families Z to A, styles still lightest first");
});

test("sort by date added: newest first, unknown dates last either way", () => {
  const all = groupFamilies([
    font("Old", "Regular", { addedAt: 100 }),
    font("New", "Regular", { addedAt: 900 }),
    font("Mid", "Regular", { addedAt: 500 }),
    font("Mid", "Bold", { addedAt: 950 }),
    font("Unknown", "Regular"),
  ]);
  assert.deepEqual(names(sortFamilies(all, { key: "added", desc: true })), ["Mid", "New", "Old", "Unknown"], "a family counts from its newest style");
  assert.deepEqual(names(sortFamilies(all, { key: "added", desc: false })), ["Old", "New", "Mid", "Unknown"]);
});

test("a face's added date is its earliest copy", () => {
  const all = groupFamilies([
    font("Dup", "Regular", { addedAt: 800, path: "/a/Dup.otf" }),
    font("Dup", "Regular", { addedAt: 200, path: "/b/Dup.otf" }),
    font("Later", "Regular", { addedAt: 500 }),
  ]);
  assert.deepEqual(names(sortFamilies(all, { key: "added", desc: true })), ["Later", "Dup"]);
});

test("sort by number of styles, weight, foundry and on/off; ties go by name", () => {
  const all = groupFamilies([
    font("Ccc", "Regular", { manufacturer: "Zeta Type" }),
    font("Ccc", "Bold", { manufacturer: "Zeta Type" }),
    font("Aaa", "Light", { weight: 300, manufacturer: "Alpha Foundry", osActive: true }),
    font("Bbb", "Black", { weight: 900 }),
    font("Ddd", "Regular", { installed: true, manufacturer: "alpha foundry" }),
  ]);
  assert.deepEqual(names(sortFamilies(all, { key: "styles", desc: true })), ["Ccc", "Aaa", "Bbb", "Ddd"]);
  assert.deepEqual(names(sortFamilies(all, { key: "weight", desc: false })), ["Aaa", "Ddd", "Ccc", "Bbb"], "lightest weight first, then the heaviest");
  assert.deepEqual(names(sortFamilies(all, { key: "weight", desc: true })), ["Bbb", "Ccc", "Ddd", "Aaa"]);
  assert.deepEqual(names(sortFamilies(all, { key: "foundry", desc: false })), ["Aaa", "Ddd", "Ccc", "Bbb"], "letter case aside; no foundry last");
  assert.deepEqual(names(sortFamilies(all, { key: "foundry", desc: true })), ["Ccc", "Aaa", "Ddd", "Bbb"], "no foundry still last");
  assert.deepEqual(names(sortFamilies(all, { key: "active", desc: false })), ["Aaa", "Ddd", "Bbb", "Ccc"], "on (and always on) first");
});

test("a variable font sorts by its weight range", () => {
  const all = groupFamilies([
    font("Var", "Regular", { variable: true, weight: 400, weightRange: [100, 900] }),
    font("Light", "Light", { weight: 300 }),
  ]);
  assert.deepEqual(names(sortFamilies(all, { key: "weight", desc: false })), ["Var", "Light"], "it goes down to 100");
});

test("sort by the Table's other columns", () => {
  const all = groupFamilies([
    font("Aaa", "Regular", { version: "Version 1.10", glyphCount: 50, fileSize: 9000, format: "TrueType", path: "/x/zz.ttf" }),
    font("Bbb", "Regular", { version: "Version 1.9", glyphCount: 900, fileSize: 100, format: "OpenType CFF", path: "/x/aa.otf", designer: "Someone" }),
  ]);
  assert.deepEqual(names(sortFamilies(all, { key: "version", desc: false })), ["Aaa", "Bbb"], "1.10 (1.100) before 1.9: versions are decimals");
  assert.deepEqual(names(sortFamilies(all, { key: "glyphs", desc: true })), ["Bbb", "Aaa"]);
  assert.deepEqual(names(sortFamilies(all, { key: "size", desc: true })), ["Aaa", "Bbb"]);
  assert.deepEqual(names(sortFamilies(all, { key: "format", desc: false })), ["Bbb", "Aaa"]);
  assert.deepEqual(names(sortFamilies(all, { key: "file", desc: false })), ["Bbb", "Aaa"]);
  assert.deepEqual(names(sortFamilies(all, { key: "designer", desc: false })), ["Bbb", "Aaa"], "no designer last");
  const sources: Record<string, string> = { Aaa: "Google Fonts", Bbb: "Downloads" };
  assert.deepEqual(names(sortFamilies(all, { key: "source", desc: false }, { sourceOf: (f) => sources[f.name] })), ["Bbb", "Aaa"]);
  assert.deepEqual(names(sortFamilies(all, { key: "source", desc: false })), ["Aaa", "Bbb"], "without a way to tell, by name");
});

test("versions sort as decimals; ones with no number, then unknown ones, go last either way", () => {
  const all = groupFamilies([
    font("Aaa", "Regular", { version: "Version 1.1" }),
    font("Bbb", "Regular", { version: "Version 1.009;PS 001.000" }),
    font("Ccc", "Regular", { version: "Beta" }),
    font("Ddd", "Regular"),
    font("Eee", "Regular", { version: "Version 2.040" }),
  ]);
  assert.deepEqual(names(sortFamilies(all, { key: "version", desc: false })), ["Bbb", "Aaa", "Eee", "Ccc", "Ddd"]);
  assert.deepEqual(names(sortFamilies(all, { key: "version", desc: true })), ["Eee", "Aaa", "Bbb", "Ccc", "Ddd"]);
});

test("sorting 3,500 families stays quick", () => {
  const fonts: FontSummary[] = [];
  for (let i = 0; i < 3500; i++) {
    const name = `Family ${(i * 7919) % 3500}`;
    fonts.push(font(name, "Regular", { addedAt: i, manufacturer: `Foundry ${i % 40}` }), font(name, "Bold", { addedAt: i + 1 }));
  }
  const all = groupFamilies(fonts);
  const start = performance.now();
  for (const key of ["added", "foundry", "weight", "styles"] as const) sortFamilies(all, { key, desc: true });
  const each = (performance.now() - start) / 4;
  assert.ok(each < 60, `${each.toFixed(1)} ms per sort`);
});
