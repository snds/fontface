// Run with `npm run test:ui`. What the Table shows about a family or a style (familyFacts.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FontSummary } from "./api.ts";
import {
  activeRank,
  addedAt,
  compareVersions,
  designerOf,
  familySources,
  fileNameOf,
  fileSizeOf,
  formatBytes,
  formatsOf,
  foundryOf,
  shortVersion,
  sourcesOf,
  weightSpan,
  weightText,
} from "./familyFacts.ts";
import { groupFamilies } from "./library.ts";

let nextId = 1;
function font(family: string, subfamily: string, more: Partial<FontSummary> = {}): FontSummary {
  return {
    id: nextId++,
    folderId: 1,
    path: `/fonts/${family}-${subfamily}.otf`,
    faceIndex: 0,
    family,
    subfamily,
    fullName: `${family} ${subfamily}`,
    postscriptName: `${family}-${subfamily}`.replace(/\s/g, ""),
    weight: 400,
    width: 5,
    italic: false,
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

const family = (...fonts: FontSummary[]) => groupFamilies(fonts)[0];

test("weights read as one number, a range, or a variable range", () => {
  assert.equal(weightText(family(font("A", "Regular")).faces), "400");
  assert.equal(weightText(family(font("A", "Light", { weight: 300 }), font("A", "Black", { weight: 900 })).faces), "300–900");
  const variable = family(font("A", "Regular", { variable: true, weightRange: [100, 900] }), font("A", "Bold", { weight: 700 }));
  assert.equal(weightText(variable.faces), "Variable 100–900");
  assert.deepEqual(weightSpan(variable.faces), { min: 100, max: 900, variable: true });
  // A variable font with no weight axis counts by its own weight.
  assert.equal(weightText(family(font("A", "Wide", { variable: true, weight: 500 })).faces), "Variable 500");
  assert.equal(weightText([]), "");
});

test("foundry and designer: the representative's, else another style's", () => {
  const f = family(font("A", "Regular"), font("A", "Bold", { weight: 700, manufacturer: " Type Co ", designer: "Ann" }));
  assert.equal(foundryOf(f), "Type Co");
  assert.equal(designerOf(f), "Ann");
  const own = family(font("B", "Regular", { manufacturer: "Own" }), font("B", "Bold", { weight: 700, manufacturer: "Other" }));
  assert.equal(foundryOf(own), "Own");
  assert.equal(foundryOf(family(font("C", "Regular"))), "");
});

test("added: a face by its earliest copy, a family by its newest face", () => {
  const f = family(
    font("A", "Regular", { addedAt: 300, path: "/1/A.otf" }),
    font("A", "Regular", { addedAt: 100, path: "/2/A.otf" }),
    font("A", "Bold", { weight: 700, addedAt: 200 }),
  );
  assert.equal(addedAt(f.faces), 200, "Regular arrived at 100, Bold at 200");
  assert.equal(addedAt(family(font("B", "Regular")).faces), undefined);
});

test("formats, file sizes and names", () => {
  const f = family(
    font("A", "Regular", { format: "TrueType", fileSize: 2048 }),
    font("A", "Bold", { weight: 700, format: "OpenType CFF", fileSize: 1024 }),
  );
  assert.equal(formatsOf(f.faces), "OpenType CFF, TrueType");
  assert.equal(fileSizeOf(f.faces), 3072);
  // Faces of one collection count the file once.
  const ttc = family(
    font("C", "Regular", { path: "/c.ttc", faceIndex: 0, fileSize: 5000 }),
    font("C", "Bold", { weight: 700, path: "/c.ttc", faceIndex: 1, fileSize: 5000 }),
  );
  assert.equal(fileSizeOf(ttc.faces), 5000);
  assert.equal(fileNameOf({ path: "/Users/me/Fonts/Inter-Bold.otf" }), "Inter-Bold.otf");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(48 * 1024), "48 KB");
  assert.equal(formatBytes(3.4 * 1024 * 1024), "3.4 MB");
});

test("version strings shorten to their number", () => {
  assert.equal(shortVersion("Version 1.009;PS 001.000;Core 1.0.38;makeotf.lib1.6.5960"), "1.009");
  assert.equal(shortVersion("OTF 1.018;PS 001.000;Core 1.0.31"), "1.018");
  assert.equal(shortVersion("version 1.00"), "1.00");
  assert.equal(shortVersion("22.0d2e1"), "22.0d2e1");
  assert.equal(shortVersion("Version 2.000;GOOG;noto-source:20170915:90ef993387c0"), "2.000");
  assert.equal(shortVersion("Altsys Fontographer 4.1 1/4/95"), "4.1");
  assert.equal(shortVersion("Beta; for testing"), "Beta");
  assert.equal(shortVersion(undefined), "");
  assert.equal(shortVersion(""), "");
});

test("versions compare as decimals, as font versions are meant", () => {
  const sorted = (...v: string[]) => [...v].sort(compareVersions);
  assert.deepEqual(sorted("1.1", "1.009"), ["1.009", "1.1"], "1.009 is less than 1.1");
  assert.deepEqual(sorted("1.9", "1.10"), ["1.10", "1.9"], "1.10 is 1.100");
  assert.deepEqual(sorted("2.1", "2.040", "10.0", "2"), ["2", "2.040", "2.1", "10.0"]);
  assert.deepEqual(sorted("1.0.38", "1.0.4", "1.0"), ["1.0", "1.0.4", "1.0.38"], "equal numbers: by the rest, numbers as numbers");
  assert.deepEqual(sorted("Beta", "0.5", "Alpha"), ["0.5", "Alpha", "Beta"], "no number in front: after the numbered ones");
  assert.equal(compareVersions("1.10", "1.1") > 0, true, "the same number written two ways still has an order");
});

test("a family's places: its representative's first, each once", () => {
  const sources: Record<number, string> = { 1: "Downloads", 2: "Google Fonts" };
  const sourceOf = (f: FontSummary) => sources[f.folderId] ?? "";
  // Thin in Downloads, Regular (the representative) in Google Fonts.
  const f = family(font("Inter", "Thin", { weight: 100, folderId: 1 }), font("Inter", "Regular", { folderId: 2 }), font("Inter", "Bold", { weight: 700, folderId: 1 }));
  assert.equal(f.representative.primary.subfamily, "Regular");
  assert.deepEqual(sourcesOf(f.faces, sourceOf), ["Downloads", "Google Fonts"], "in style order: lightest first");
  assert.deepEqual(familySources(f, sourceOf), ["Google Fonts", "Downloads"], "what the Source column names and sorts by");
  assert.deepEqual(sourcesOf([], sourceOf), []);
  assert.deepEqual(familySources(family(font("X", "Regular", { folderId: 9 })), sourceOf), [], "no place known");
});

test("on/off rank: all on (or always on), some, none", () => {
  assert.equal(activeRank({ switchable: [], activeCount: 0 }), 0, "always on");
  const two = family(font("A", "Regular", { osActive: true }), font("A", "Bold", { weight: 700 }));
  assert.equal(activeRank(two), 1);
  assert.equal(activeRank(family(font("B", "Regular"))), 2);
  assert.equal(activeRank(family(font("C", "Regular", { osActive: true }))), 0);
});
