// Run with `npm run test:ui`. The Info tab's words (fontInfo.ts) and the Axes tab's named styles
// (axisField.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CharacterBlock } from "./api.ts";
import { currentInstance, instanceValues, type AxisInfo, type Instance } from "./axisField.ts";
import { embeddingWords, languageList, lastTurnedOnText, scriptsOfBlocks, unreadWords, webAddress } from "./fontInfo.ts";

test("embedding permissions in plain words, with their limits", () => {
  assert.equal(embeddingWords({ kind: "installable", noSubsetting: false, bitmapOnly: false }).title, "Installable");
  assert.match(embeddingWords({ kind: "editable", noSubsetting: false, bitmapOnly: false }).text, /edit/);
  assert.match(embeddingWords({ kind: "previewPrint", noSubsetting: false, bitmapOnly: false }).text, /viewing and printing only/);
  assert.equal(embeddingWords({ kind: "restricted", noSubsetting: false, bitmapOnly: false }).title, "Restricted");
  assert.equal(embeddingWords({ kind: "unclear", noSubsetting: false, bitmapOnly: false }).title, "Unclear");
  assert.deepEqual(embeddingWords({ kind: "previewPrint", noSubsetting: true, bitmapOnly: true }).extra, [
    "Documents must hold the whole font, not only the characters they use.",
    "Only its bitmaps may be embedded, not its outlines.",
  ]);
});

test("web addresses from a font open over https; anything else is just text", () => {
  assert.deepEqual(webAddress("https://rsms.me/inter/"), { text: "https://rsms.me/inter/", href: "https://rsms.me/inter/" });
  assert.deepEqual(webAddress("http://www.apple.com/"), { text: "http://www.apple.com/", href: "https://www.apple.com/" });
  assert.deepEqual(webAddress(" www.linotype.com "), { text: "www.linotype.com", href: "https://www.linotype.com/" });
  assert.equal(webAddress("fonts.example.co.uk/designers").href, "https://fonts.example.co.uk/designers");
  assert.equal(webAddress("hello@foundry.com").href, null);
  assert.equal(webAddress("Designed by Jane").href, null);
  assert.equal(webAddress("ftp://files.example.com").href, null);
  assert.equal(webAddress("javascript:alert(1)").href, null);
});

test("languages by name, each once, in order", () => {
  assert.deepEqual(languageList(["fr", "en", "de", "en", "zh_Hans", "xx-unknown-qq"]), ["English", "French", "German", "Simplified Chinese"]);
  assert.deepEqual(languageList([]), []);
});

const block = (name: string, runs: [number, number][]): CharacterBlock => ({ name, runs, glyphNames: [] });

test("scripts come from the character blocks, letters only, small sets left out", () => {
  const latinFont = [
    block("Basic Latin", [[0x20, 0x7e]]),
    block("Latin-1 Supplement", [[0xa0, 0xff]]),
    block("Latin Extended-A", [[0x100, 0x17f]]),
    block("Greek and Coptic", [[0x3a9, 0x3a9], [0x3c0, 0x3c0]]),
    block("General Punctuation", [[0x2010, 0x2030]]),
    block("Cyrillic", [[0x400, 0x45f]]),
    block("Cyrillic Supplement", [[0x500, 0x52f]]),
    block("Private Use Area", [[0xe000, 0xe0ff]]),
  ];
  assert.deepEqual(scriptsOfBlocks(latinFont).map((s) => s.name), ["Latin", "Cyrillic"], "Ω and π don't make it Greek");
  // A symbol font that maps pictures to the digits isn't Latin.
  assert.deepEqual(scriptsOfBlocks([block("Basic Latin", [[0x30, 0x39]])]), []);
  assert.deepEqual(
    scriptsOfBlocks([block("Hiragana", [[0x3041, 0x3096]]), block("Katakana", [[0x30a1, 0x30fa]]), block("CJK Unified Ideographs", [[0x4e00, 0x4fff]]), block("Hangul Syllables", [[0xac00, 0xac20]])]).map((s) => s.name),
    ["Han (Chinese characters)", "Kana (Japanese)", "Hangul"],
  );
  assert.deepEqual(scriptsOfBlocks([block("Devanagari Extended", [[0xa8e0, 0xa8ff]])]).map((s) => s.name), ["Devanagari"]);
});

test("last turned on, and what a page says when it can't read a file's details", () => {
  assert.match(lastTurnedOnText(1_760_000_000, false), /2025/);
  assert.equal(lastTurnedOnText(null, true), "Always on: macOS keeps it on");
  assert.equal(lastTurnedOnText(undefined, false), "Not by Fontface yet");
  assert.equal(unreadWords("cloud", "anything").title, "Download to see details");
  assert.deepEqual(unreadWords("missing", "The font file can't be found right now."), {
    title: "Details unavailable",
    text: "The font file can't be found right now.",
  });
});

const AXES: AxisInfo[] = [
  { tag: "wght", min: 100, max: 900, default: 400 },
  { tag: "wdth", min: 75, max: 100, default: 100 },
];
const STYLES: Instance[] = [
  { name: "Regular", values: [["wght", 400], ["wdth", 100]] },
  { name: "Bold", values: [["wght", 700], ["wdth", 100]] },
  { name: "Condensed Black", values: [["wght", 900], ["wdth", 75]] },
  { name: "Too far", values: [["wght", 1200]] },
];

test("a named style sets every axis, kept within range", () => {
  assert.deepEqual(instanceValues(STYLES[2], AXES), { wght: 900, wdth: 75 });
  assert.deepEqual(instanceValues(STYLES[3], AXES), { wght: 900, wdth: 100 }, "past the range: its end; unnamed axes: their defaults");
});

test("the picker shows the named style the axes are at, if any", () => {
  assert.equal(currentInstance(STYLES, AXES, {}), 0, "untouched axes are at the Regular style");
  assert.equal(currentInstance(STYLES, AXES, { wght: 700 }), 1);
  assert.equal(currentInstance(STYLES, AXES, instanceValues(STYLES[2], AXES)), 2);
  assert.equal(currentInstance(STYLES, AXES, { wght: 650 }), -1, "between styles: none");
  assert.equal(currentInstance([], AXES, {}), -1);
});
