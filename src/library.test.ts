// Run with `npm run test:ui`. Grouping the library into families (library.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FontSummary } from "./api.ts";
import { filterFamilies, groupFamilies } from "./library.ts";

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
