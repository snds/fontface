// Run with `npm run test:ui`. The preview bar's size field (previewSize.ts), and that its range
// matches what the back end saves (src-tauri/src/settings.rs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buttonStep,
  clampSize,
  commitSize,
  discardSize,
  draftSize,
  keyStep,
  MAX_SIZE,
  MIN_SIZE,
  openDraft,
  sizeLabel,
  sizeOptions,
  typeSize,
  type FieldKey,
} from "./previewSize.ts";
import { SIZE_STEPS } from "./viewOptions.ts";

const key = (k: string, mods: Partial<FieldKey> = {}): FieldKey => ({ key: k, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...mods });

test("the range is the one Settings saves", () => {
  const rust = readFileSync(new URL("../src-tauri/src/settings.rs", import.meta.url), "utf8");
  const range = rust.match(/PREVIEW_SIZE: RangeInclusive<u32> = (\d+)..=(\d+);/);
  assert.ok(range, "PREVIEW_SIZE is in settings.rs");
  assert.deepEqual([Number(range[1]), Number(range[2])], [MIN_SIZE, MAX_SIZE]);
  assert.equal(clampSize(4), MIN_SIZE);
  assert.equal(clampSize(400), MAX_SIZE);
  assert.equal(clampSize(31.6), 32, "whole sizes only");
});

test("the select lists the common sizes, and the size in use when it's another", () => {
  assert.deepEqual(sizeOptions(32), [...SIZE_STEPS]);
  assert.deepEqual(sizeOptions(40), [12, 16, 24, 32, 40, 48, 64, 96, 128]);
  assert.deepEqual(sizeOptions(10), [10, 12, 16, 24, 32, 48, 64, 96, 128], "below the first step, first");
  assert.equal(sizeLabel(48), "48 px");
});

test("in the number field, Up and Down step by 1, with Shift by 10, within the range", () => {
  assert.equal(keyStep(32, key("ArrowUp")), 33);
  assert.equal(keyStep(32, key("ArrowDown")), 31);
  assert.equal(keyStep(32, key("ArrowUp", { shiftKey: true })), 42);
  assert.equal(keyStep(32, key("ArrowDown", { shiftKey: true })), 22);
  assert.equal(keyStep(32, key("PageUp")), 42);
  assert.equal(keyStep(32, key("PageDown")), 22);
  assert.equal(keyStep(125, key("ArrowUp", { shiftKey: true })), MAX_SIZE, "stops at the largest");
  assert.equal(keyStep(12, key("PageDown")), MIN_SIZE, "and at the smallest");
  assert.equal(keyStep(MAX_SIZE, key("ArrowUp")), MAX_SIZE);
  assert.equal(keyStep(40, key("Home")), MIN_SIZE);
  assert.equal(keyStep(40, key("End")), MAX_SIZE);
  assert.equal(keyStep(40, key("4")), null, "typing is the field's");
  assert.equal(keyStep(40, key("ArrowLeft")), null, "so is moving the caret");
  assert.equal(keyStep(40, key("ArrowUp", { metaKey: true })), null, "a shortcut isn't a step");
  assert.equal(buttonStep(40, 1), 41);
  assert.equal(buttonStep(MIN_SIZE, -1), MIN_SIZE);
});

test("a size in range applies as it's typed; Return keeps it within the range", () => {
  let d = openDraft(32);
  assert.deepEqual(d, { text: "32", before: 32 });
  let t = typeSize(d, "4");
  assert.equal(t.apply, undefined, "4 is too small to show yet");
  d = t.draft;
  t = typeSize(d, "40");
  assert.equal(t.apply, 40);
  assert.equal(t.draft.before, 32, "the size from before stays, for Esc");
  assert.equal(commitSize(t.draft), 40);
  assert.equal(commitSize(typeSize(d, "300").draft), MAX_SIZE, "too big: the largest");
  assert.equal(commitSize(typeSize(d, "5").draft), MIN_SIZE, "too small: the smallest");
  assert.equal(commitSize(typeSize(d, "").draft), 32, "nothing typed: back to before");
  assert.equal(commitSize(typeSize(d, "big").draft), 32, "not a number: back to before");
  assert.equal(commitSize(typeSize(d, " 64 ").draft), 64, "spaces around are fine");
  assert.equal(typeSize(d, "40.5").apply, undefined, "a fraction isn't applied as it's typed");
  assert.equal(commitSize(typeSize(d, "40.5").draft), 41, "Return rounds it");
  assert.equal(typeSize(d, "-20").apply, undefined);
  assert.equal(commitSize(typeSize(d, "-20").draft), 32, "a minus sign isn't a size");
});

test("steps start from what's typed; Esc goes back to the size from before", () => {
  const d = typeSize(openDraft(32), "50").draft;
  assert.equal(draftSize(d), 50);
  assert.equal(keyStep(draftSize(d), key("ArrowUp")), 51);
  assert.equal(draftSize(typeSize(d, "").draft), 32, "an empty field steps from the size from before");
  assert.equal(draftSize(typeSize(d, "999").draft), MAX_SIZE);
  assert.equal(discardSize(d), 32, "including any size applied along the way");
});
