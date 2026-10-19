// Run with `npm run test:ui`. "Installed" (yours first) on a catalog page (catalogOrder.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogItems, REST_HEADING, YOURS_HEADING, type CatalogItem } from "./catalogOrder.ts";

const fams = ["Abel", "Inter", "Lora", "Roboto", "Zilla Slab"];
const mine = new Set(["Inter", "Roboto"]);
const show = (items: CatalogItem<string>[]) => items.map((i) => (i.kind === "heading" ? `# ${i.label} · ${i.count}` : i.family));

test("yours first: your families, then everything else, each in the catalog's order", () => {
  assert.deepEqual(show(catalogItems(fams, (f) => mine.has(f), true)), [
    `# ${YOURS_HEADING} · 2`,
    "Inter",
    "Roboto",
    `# ${REST_HEADING} · 3`,
    "Abel",
    "Lora",
    "Zilla Slab",
  ]);
});

test("off: the catalog's own order, with no headings", () => {
  assert.deepEqual(show(catalogItems(fams, (f) => mine.has(f), false)), fams);
});

test("no headings when every family, or none, is yours", () => {
  assert.deepEqual(show(catalogItems(fams, () => true, true)), fams, "the Downloaded filter");
  assert.deepEqual(show(catalogItems(fams, () => false, true)), fams, "nothing of yours (or a search that finds none)");
  assert.deepEqual(catalogItems([], () => true, true), []);
});

test("heading ids stay the same, so the list keeps their rows across searches", () => {
  const ids = catalogItems(fams, (f) => mine.has(f), true).flatMap((i) => (i.kind === "heading" ? [i.id] : []));
  assert.deepEqual(ids, ["heading:yours", "heading:rest"]);
});
