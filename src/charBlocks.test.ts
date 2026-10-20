// Run with `npm run test:ui`. The Characters tab's Unicode block picker (charBlocks.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CharacterBlock } from "./api.ts";
import {
  alphabetical,
  biggestBlock,
  blockCount,
  eagerGroups,
  inBlockOrder,
  isAll,
  moreText,
  NO_MEMORY,
  openNewlyPicked,
  pickerLabel,
  pickerName,
  readStoredBlocks,
  remember,
  startingBlocks,
  toggleBlock,
  uniqueBlocks,
  type BlockInfo,
} from "./charBlocks.ts";

// A Latin font's blocks, in Unicode order, as font_characters lists them.
const LATIN: BlockInfo[] = [
  { name: "Basic Latin", count: 94 },
  { name: "Latin-1 Supplement", count: 94 },
  { name: "Latin Extended-A", count: 128 },
  { name: "Greek and Coptic", count: 73 },
  { name: "Cyrillic", count: 94 },
  { name: "Latin Extended Additional", count: 8 },
  { name: "Arrows", count: 7 },
];
// A Thai font: none of the Latin font's blocks but Basic Latin.
const THAI: BlockInfo[] = [
  { name: "Basic Latin", count: 20 },
  { name: "Thai", count: 87 },
];

test("a block's count is the sum of its runs", () => {
  const b: CharacterBlock = { name: "Basic Latin", runs: [[0x21, 0x7e]], glyphNames: [] };
  assert.equal(blockCount(b), 94);
  assert.equal(blockCount({ name: "x", runs: [[0x41, 0x41], [0x61, 0x63]], glyphNames: [] }), 4);
});

test("a name that turns up twice (No Block, in two gaps) becomes one group", () => {
  const blocks: CharacterBlock[] = [
    { name: "Basic Latin", runs: [[0x41, 0x42]], glyphNames: ["A", "B"] },
    { name: "No Block", runs: [[0x2fe0, 0x2fe0]], glyphNames: ["u2FE0"] },
    { name: "Hiragana", runs: [[0x3041, 0x3041]], glyphNames: ["a-hira"] },
    { name: "No Block", runs: [[0x10200, 0x10201]], glyphNames: ["", "x"] },
  ];
  const out = uniqueBlocks(blocks);
  assert.deepEqual(
    out.map((b) => b.name),
    ["Basic Latin", "No Block", "Hiragana"],
    "first place kept",
  );
  assert.deepEqual(out[1].runs, [[0x2fe0, 0x2fe0], [0x10200, 0x10201]]);
  assert.deepEqual(out[1].glyphNames, ["u2FE0", "", "x"], "glyph names still follow the runs");
  assert.equal(uniqueBlocks(blocks.slice(0, 1))[0], blocks[0], "nothing to merge: the same block");
});

test("a font starts on its biggest block, the first of equals", () => {
  assert.equal(biggestBlock(LATIN), "Latin Extended-A");
  assert.equal(biggestBlock([{ name: "A", count: 3 }, { name: "B", count: 3 }]), "A");
  assert.equal(biggestBlock([]), null);
  assert.deepEqual(startingBlocks(LATIN, NO_MEMORY), ["Latin Extended-A"]);
  assert.deepEqual(startingBlocks([], NO_MEMORY), []);
});

test("picks keep Unicode order, whatever order they were made in", () => {
  let picked = ["Arrows"];
  picked = toggleBlock(picked, "Basic Latin", LATIN);
  picked = toggleBlock(picked, "Cyrillic", LATIN);
  assert.deepEqual(picked, ["Basic Latin", "Cyrillic", "Arrows"]);
  assert.deepEqual(toggleBlock(picked, "Cyrillic", LATIN), ["Basic Latin", "Arrows"], "a second press unpicks");
  assert.deepEqual(inBlockOrder(["Thai", "Arrows", "Arrows", "Basic Latin"], LATIN), ["Basic Latin", "Arrows"], "unknown names and repeats dropped");
});

test("all is every block of a font with more than one", () => {
  assert.equal(isAll(LATIN.map((b) => b.name), LATIN), true);
  assert.equal(isAll(["Basic Latin"], LATIN), false);
  assert.equal(isAll(["Thai"], [{ name: "Thai", count: 87 }]), false, "a one-block font's only block isn't a choice of all");
});

test("a choice carries to the next font: the blocks it has, else its biggest", () => {
  const memory = remember(NO_MEMORY, LATIN, ["Basic Latin", "Cyrillic", "Arrows"]);
  assert.deepEqual(memory, { all: false, picked: ["Basic Latin", "Cyrillic", "Arrows"] });
  assert.deepEqual(startingBlocks(THAI, memory), ["Basic Latin"], "only the blocks this font has");
  assert.deepEqual(startingBlocks([{ name: "Thai", count: 87 }, { name: "Lao", count: 90 }], memory), ["Lao"], "none of them: the biggest");
});

test("a font that lacks a block doesn't make the app forget it", () => {
  let memory = remember(NO_MEMORY, LATIN, ["Basic Latin", "Cyrillic"]);
  // In the Thai font, Thai is added; Cyrillic isn't there to unpick.
  memory = remember(memory, THAI, ["Basic Latin", "Thai"]);
  assert.deepEqual(startingBlocks(LATIN, memory), ["Basic Latin", "Cyrillic"]);
  assert.deepEqual(startingBlocks(THAI, memory), ["Basic Latin", "Thai"]);
  // Unpicking Basic Latin where it is, is remembered everywhere.
  memory = remember(memory, THAI, ["Thai"]);
  assert.deepEqual(startingBlocks(LATIN, memory), ["Cyrillic"]);
});

test("All blocks carries as all; unpicking one goes back to names", () => {
  let memory = remember(NO_MEMORY, LATIN, LATIN.map((b) => b.name), true);
  assert.equal(memory.all, true);
  assert.deepEqual(startingBlocks(THAI, memory), ["Basic Latin", "Thai"], "every block of the next font");
  memory = remember(memory, LATIN, toggleBlock(LATIN.map((b) => b.name), "Arrows", LATIN));
  assert.equal(memory.all, false);
  assert.deepEqual(startingBlocks(THAI, memory), ["Basic Latin"]);
});

test("every block picked one by one carries as those names, not as all", () => {
  const memory = remember(NO_MEMORY, THAI, ["Basic Latin", "Thai"]);
  assert.equal(memory.all, false);
  assert.deepEqual(startingBlocks(LATIN, memory), ["Basic Latin"]);
});

test("none picked is remembered as none, and the next font starts on its biggest", () => {
  const memory = remember(NO_MEMORY, LATIN, []);
  assert.deepEqual(memory, NO_MEMORY);
  assert.deepEqual(startingBlocks(LATIN, memory), ["Latin Extended-A"]);
});

test("what was kept reads back; anything unreadable is nothing kept", () => {
  const kept = { memory: { all: false, picked: ["Cyrillic", "Arrows"] }, closed: ["Arrows"] };
  assert.deepEqual(readStoredBlocks(JSON.stringify(kept)), kept);
  assert.deepEqual(readStoredBlocks(JSON.stringify({ memory: { all: true, picked: ["Thai", 3, null] } })), { memory: { all: true, picked: ["Thai"] }, closed: [] });
  for (const bad of [null, "", "{", "null", "42", "[]", JSON.stringify({ memory: "x", closed: "y" })]) {
    assert.deepEqual(readStoredBlocks(bad), { memory: NO_MEMORY, closed: [] }, String(bad));
  }
});

test("a block just picked opens its group; others keep how they were", () => {
  assert.deepEqual(openNewlyPicked(["Arrows", "Cyrillic"], ["Basic Latin", "Cyrillic"], ["Basic Latin", "Cyrillic", "Arrows"]), ["Cyrillic"]);
  const closed = ["Cyrillic"];
  assert.equal(openNewlyPicked(closed, ["Cyrillic"], []), closed, "unpicking changes nothing");
});

test("groups from the top are made at once while they're small together; closed ones cost nothing", () => {
  const groups = [
    { name: "Basic Latin", cells: 94 },
    { name: "CJK Unified Ideographs", cells: 0 },
    { name: "Hiragana", cells: 90 },
    { name: "Katakana", cells: 96 },
    { name: "Hangul Syllables", cells: 512 },
  ];
  assert.deepEqual([...eagerGroups(groups, 300)], ["Basic Latin", "CJK Unified Ideographs", "Hiragana", "Katakana"]);
  assert.deepEqual([...eagerGroups(groups, 200)], ["Basic Latin", "CJK Unified Ideographs", "Hiragana"], "stops at the first that doesn't fit");
  assert.deepEqual([...eagerGroups([{ name: "Hangul Syllables", cells: 512 }], 100)], ["Hangul Syllables"], "the first is always made");
  assert.deepEqual([...eagerGroups([], 100)], []);
});

test("the button names the alphabetically first block, with how many more", () => {
  assert.equal(pickerLabel([]), null);
  assert.deepEqual(pickerLabel(["Basic Latin"]), { first: "Basic Latin", more: 0 });
  assert.deepEqual(pickerLabel(["Basic Latin", "Cyrillic", "Arrows"]), { first: "Arrows", more: 2 });
  assert.equal(moreText(2), "+2");
  assert.equal(moreText(1200), "+1,200");
});

test("alphabetical order is English, ignores case, and counts numbers as numbers", () => {
  assert.deepEqual(alphabetical(["Latin Extended-B", "Latin Extended-A", "Arrows", "basic Latin"]), ["Arrows", "basic Latin", "Latin Extended-A", "Latin Extended-B"]);
  assert.deepEqual(alphabetical(["Block 10", "Block 9"]), ["Block 9", "Block 10"]);
});

test("the picker's name says what's picked", () => {
  assert.equal(pickerName([], 7), "Unicode blocks: none");
  assert.equal(pickerName(["Cyrillic"], 7), "Unicode blocks: Cyrillic");
  assert.equal(pickerName(["Cyrillic", "Arrows"], 7), "Unicode blocks: Arrows and Cyrillic");
  assert.equal(pickerName(["Cyrillic", "Arrows", "Basic Latin"], 7), "Unicode blocks: Arrows, Basic Latin and Cyrillic");
  assert.equal(pickerName(["Cyrillic", "Arrows", "Basic Latin", "Greek and Coptic"], 7), "Unicode blocks: Arrows, Basic Latin and 2 more");
  assert.equal(pickerName(LATIN.map((b) => b.name), 7), "Unicode blocks: all 7");
  assert.equal(pickerName(["Thai"], 1), "Unicode blocks: Thai", "a one-block font's block isn't called all");
});
