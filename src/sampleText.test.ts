// Run with `npm run test:ui`. Which text a font is shown with when nothing is typed (sampleText.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PreviewInfo } from "./api.ts";
import { COMPARE_TEXT, PAIR_TEXT } from "./compare.ts";
import { fittingText, PANGRAM, PARAGRAPH, paragraphText, sampleFor, waterfallText } from "./sampleText.ts";

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const profile = (more: Partial<PreviewInfo>): PreviewInfo => ({ kind: "name", ascent: 0.9, descent: 0.2, ...more });

const capsOnly = profile({ kind: "case", asciiMissing: LOWER });
const symbols = profile({ kind: "symbols", familyText: "☀☁☂☃", label: "Symbols" });
const japanese = profile({ kind: "script", familyText: "あいうえお", asciiMissing: LOWER + LOWER.toUpperCase(), label: "Japanese" });
const noFigures = profile({ asciiMissing: "0123456789" });

test("a font that has the letters shows the page's own words", () => {
  assert.equal(sampleFor("", COMPARE_TEXT.columns, profile({}), "Inter"), COMPARE_TEXT.columns);
  assert.equal(sampleFor("", PAIR_TEXT.heading, undefined, "Inter"), PAIR_TEXT.heading, "no profile yet: the words");
  assert.equal(sampleFor("", COMPARE_TEXT.lines, profile({}), "Inter"), PANGRAM);
});

test("caps only: the same words in capitals", () => {
  assert.equal(sampleFor("", COMPARE_TEXT.lines, capsOnly, "Display"), PANGRAM.toUpperCase());
  assert.equal(sampleFor("", PAIR_TEXT.body, capsOnly, "Display"), PAIR_TEXT.body.toUpperCase());
});

test("symbol and non-Latin fonts show characters they have, not another font's letters", () => {
  assert.equal(sampleFor("", COMPARE_TEXT.lines, symbols, "Icons"), "☀☁☂☃");
  assert.equal(sampleFor("", PAIR_TEXT.heading, japanese, "Gothic"), "あいうえお");
  assert.equal(fittingText([PANGRAM], profile({ kind: "none", asciiMissing: LOWER }), "Odd"), PANGRAM.toUpperCase());
  assert.equal(fittingText([PANGRAM], profile({ kind: "none", asciiMissing: LOWER + LOWER.toUpperCase() }), "Odd"), "Odd", "nothing fits: the name");
});

test("words the font can't draw fall back to the pangram first", () => {
  assert.equal(sampleFor("", COMPARE_TEXT.columns, noFigures, "Serif"), PANGRAM, "the paragraph has figures");
  assert.equal(paragraphText(noFigures, "Serif"), PANGRAM);
});

test("typed text is shown as typed, whatever the font has", () => {
  assert.equal(sampleFor("Hamburgefonts", PAIR_TEXT.heading, symbols, "Icons"), "Hamburgefonts");
  assert.equal(waterfallText("abc", capsOnly, "Display"), "abc");
});

test("the font page's texts are unchanged", () => {
  assert.equal(waterfallText("", undefined, "Inter"), PANGRAM);
  assert.equal(waterfallText("", capsOnly, "Display"), PANGRAM.toUpperCase());
  assert.equal(waterfallText("", symbols, "Icons"), "☀☁☂☃");
  assert.equal(paragraphText(undefined, "Inter"), PARAGRAPH);
  assert.equal(paragraphText(capsOnly, "Display"), PARAGRAPH.toUpperCase());
  assert.equal(paragraphText(symbols, "Icons"), "☀☁☂☃");
});
