// Run with `npm run test:ui`. The Characters tab's search (characterSearch.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CharacterBlock } from "./api.ts";
import { codeLabel, findCharacters, MAX_SEARCH, parseCharacterQuery } from "./characterSearch.ts";

test("typed characters are searched one by one, each once", () => {
  assert.deepEqual(parseCharacterQuery("ß€"), [0xdf, 0x20ac]);
  assert.deepEqual(parseCharacterQuery("aba"), [0x61, 0x62]);
  assert.deepEqual(parseCharacterQuery("😀"), [0x1f600], "a character outside the first plane is one code point");
  assert.deepEqual(parseCharacterQuery("a b"), [0x61, 0x62], "spaces separate, and aren't searched");
  assert.deepEqual(parseCharacterQuery("   "), []);
});

test("U+ codes, in any case, and ranges", () => {
  assert.deepEqual(parseCharacterQuery("U+00DF"), [0xdf]);
  assert.deepEqual(parseCharacterQuery("u+20ac U+41"), [0x20ac, 0x41]);
  assert.deepEqual(parseCharacterQuery("U+0041-U+0043"), [0x41, 0x42, 0x43]);
  assert.deepEqual(parseCharacterQuery("U+0043–0041"), [0x41, 0x42, 0x43], "an en dash, no second U+, either order");
  assert.deepEqual(parseCharacterQuery("U+41..43"), [0x41, 0x42, 0x43]);
  assert.deepEqual(parseCharacterQuery("U+1F600"), [0x1f600]);
});

test("a code being typed waits for its digits; a lone U is the letter", () => {
  assert.deepEqual(parseCharacterQuery("U+"), []);
  assert.deepEqual(parseCharacterQuery("U+0041-"), []);
  assert.deepEqual(parseCharacterQuery("U+0041-U"), []);
  assert.deepEqual(parseCharacterQuery("U"), [0x55]);
  assert.deepEqual(parseCharacterQuery("Ü"), [0xdc]);
});

test("impossible code points are left out, and a huge range is cut short", () => {
  assert.deepEqual(parseCharacterQuery("U+D800"), [], "a lone surrogate isn't a character");
  assert.deepEqual(parseCharacterQuery("U+110000"), []);
  assert.equal(parseCharacterQuery("U+0000-U+10FFFF").length, MAX_SEARCH);
});

const BLOCKS: CharacterBlock[] = [
  { name: "Basic Latin", runs: [[0x41, 0x43], [0x61, 0x62]], glyphNames: ["A", "B", "C", "a", ""] },
  { name: "Currency Symbols", runs: [[0x20ac, 0x20ac]], glyphNames: ["Euro"] },
];

test("found characters bring their glyph names; the rest are missing", () => {
  const { found, missing } = findCharacters(BLOCKS, [0x62, 0x20ac, 0xdf, 0x43, 0x61]);
  assert.deepEqual(found, [
    { cp: 0x62, name: "" },
    { cp: 0x20ac, name: "Euro" },
    { cp: 0x43, name: "C" },
    { cp: 0x61, name: "a" },
  ]);
  assert.deepEqual(missing, [0xdf]);
  assert.equal(codeLabel(0xdf), "U+00DF");
  assert.equal(codeLabel(0x1f600), "U+1F600");
});
