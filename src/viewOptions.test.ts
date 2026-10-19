// Run with `npm run test:ui`. Layouts, size steps and sort words (viewOptions.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSort, directionWords, layoutShortcut, nextSort, sizeShortcut, SORTS, stepSize, type ShortcutKey } from "./viewOptions.ts";

const key = (k: string, mods: Partial<ShortcutKey> = {}): ShortcutKey => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test("Cmd+1, Cmd+2 and Cmd+3 pick Tiles, Rows and Table (Ctrl on Windows)", () => {
  assert.equal(layoutShortcut(key("1", { metaKey: true }), true), "tiles");
  assert.equal(layoutShortcut(key("2", { metaKey: true }), true), "rows");
  assert.equal(layoutShortcut(key("3", { metaKey: true }), true), "table");
  assert.equal(layoutShortcut(key("4", { metaKey: true }), true), null);
  assert.equal(layoutShortcut(key("1"), true), null, "a plain 1 is typing");
  assert.equal(layoutShortcut(key("1", { ctrlKey: true }), true), null, "Ctrl on a Mac is something else");
  assert.equal(layoutShortcut(key("1", { metaKey: true, shiftKey: true }), true), null);
  assert.equal(layoutShortcut(key("3", { ctrlKey: true }), false), "table");
  assert.equal(layoutShortcut(key("3", { metaKey: true }), false), null);
  // The digit key itself, on layouts where the digits need Shift.
  assert.equal(layoutShortcut(key("&", { code: "Digit1", metaKey: true }), true), "tiles");
});

test("the size steps through 12, 16, 24, 32, 48, 64, 96 and 128, from wherever it is", () => {
  assert.equal(stepSize(32, 1), 48);
  assert.equal(stepSize(32, -1), 24);
  assert.equal(stepSize(40, 1), 48, "between steps: the next one up");
  assert.equal(stepSize(40, -1), 32);
  assert.equal(stepSize(128, 1), 128, "the ends stay");
  assert.equal(stepSize(12, -1), 12);
  assert.equal(stepSize(10, -1), 12, "below the first step");
  assert.equal(stepSize(10, 1), 12);
  let s = 12;
  const up: number[] = [];
  for (let i = 0; i < 8; i++) up.push((s = stepSize(s, 1)));
  assert.deepEqual(up, [16, 24, 32, 48, 64, 96, 128, 128]);
});

test("Cmd+= and Cmd+- step the size; plain keys don't", () => {
  assert.equal(sizeShortcut(key("=", { metaKey: true }), true), 1);
  assert.equal(sizeShortcut(key("+", { metaKey: true, shiftKey: true }), true), 1);
  assert.equal(sizeShortcut(key("-", { metaKey: true }), true), -1);
  assert.equal(sizeShortcut(key("=", { code: "Equal", ctrlKey: true }), false), 1);
  assert.equal(sizeShortcut(key("-"), true), null);
  assert.equal(sizeShortcut(key("-", { metaKey: true, altKey: true }), true), null);
});

test("picking a sort starts it its usual way; picking it again turns it round", () => {
  assert.deepEqual(nextSort({ key: "name", desc: false }, "added"), { key: "added", desc: true }, "newest first");
  assert.deepEqual(nextSort({ key: "added", desc: true }, "added"), { key: "added", desc: false });
  assert.deepEqual(nextSort({ key: "added", desc: true }, "name"), { key: "name", desc: false });
  assert.deepEqual(nextSort({ key: "name", desc: false }, "styles"), { key: "styles", desc: true }, "most first");
});

test("each direction has plain words, and the change is announced", () => {
  assert.equal(directionWords({ key: "name", desc: true }), "Z to A");
  assert.equal(describeSort({ key: "added", desc: true }), "Sorted by Date added, newest first");
  assert.equal(describeSort({ key: "name", desc: false }), "Sorted by Name, A to Z");
  assert.equal(describeSort({ key: "active", desc: false }), "Sorted by On or off, on first");
  assert.equal(new Set(SORTS.map((s) => s.key)).size, SORTS.length);
  assert.deepEqual(
    SORTS.filter((s) => s.main).map((s) => s.label),
    ["Name", "Date added", "Number of styles", "Weight", "Foundry", "On or off"],
  );
});
