// Run with `npm run test:ui`. Selecting rows and moving through them with the keyboard (selection.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearSelection,
  clickRow,
  ensureFocus,
  focusAfterRemoval,
  focusRow,
  listKeyCommand,
  moveFocus,
  NO_SELECTION,
  prune,
  selectAll,
  toggleFocused,
  type ListKey,
  type Selection,
} from "./selection.ts";

const ORDER = ["a", "b", "c", "d", "e", "f"];
const plain = { toggle: false, range: false };
const cmd = { toggle: true, range: false };
const keys = (s: Selection) => [...s.keys].sort();

const key = (k: string, mods: Partial<ListKey> = {}): ListKey => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test("a click selects one row and makes it the anchor and focus", () => {
  const s = clickRow(NO_SELECTION, ORDER, "c", plain);
  assert.deepEqual(keys(s), ["c"]);
  assert.equal(s.anchor, "c");
  assert.equal(s.focus, "c");
  assert.deepEqual(keys(clickRow(s, ORDER, "e", plain)), ["e"]);
  // A row that isn't listed changes nothing.
  assert.equal(clickRow(s, ORDER, "zz", plain), s);
});

test("Cmd-click adds and removes rows; Shift-click selects a range from the anchor", () => {
  let s = clickRow(NO_SELECTION, ORDER, "b", plain);
  s = clickRow(s, ORDER, "d", { toggle: true, range: false });
  assert.deepEqual(keys(s), ["b", "d"]);
  assert.equal(s.anchor, "d");
  s = clickRow(s, ORDER, "b", { toggle: true, range: false });
  assert.deepEqual(keys(s), ["d"]);

  const ranged = clickRow(clickRow(NO_SELECTION, ORDER, "b", plain), ORDER, "e", { toggle: false, range: true });
  assert.deepEqual(keys(ranged), ["b", "c", "d", "e"]);
  assert.equal(ranged.anchor, "b", "the anchor stays, so another Shift-click re-ranges from it");
  assert.equal(ranged.focus, "e");
  assert.deepEqual(keys(clickRow(ranged, ORDER, "a", { toggle: false, range: true })), ["a", "b"]);
});

test("Cmd-Shift-click adds a range to what's selected", () => {
  let s = clickRow(NO_SELECTION, ORDER, "a", plain);
  s = clickRow(s, ORDER, "d", { toggle: true, range: false });
  s = clickRow(s, ORDER, "f", { toggle: true, range: true });
  assert.deepEqual(keys(s), ["a", "d", "e", "f"]);
});

test("Shift-click with no anchor is a plain click", () => {
  const s = clickRow(NO_SELECTION, ORDER, "c", { toggle: false, range: true });
  assert.deepEqual(keys(s), ["c"]);
});

test("arrow keys move and select one row; Shift extends from the anchor", () => {
  const opts = { extend: false, pageSize: 3 };
  let s = moveFocus(NO_SELECTION, ORDER, "down", opts);
  assert.deepEqual([s.focus, ...keys(s)], ["a", "a"], "with nothing focused, Down starts at the top");
  s = moveFocus(s, ORDER, "down", opts);
  assert.deepEqual([s.focus, ...keys(s)], ["b", "b"]);
  s = moveFocus(s, ORDER, "down", { ...opts, extend: true });
  s = moveFocus(s, ORDER, "down", { ...opts, extend: true });
  assert.deepEqual(keys(s), ["b", "c", "d"]);
  assert.equal(s.anchor, "b");
  s = moveFocus(s, ORDER, "up", { ...opts, extend: true });
  assert.deepEqual(keys(s), ["b", "c"], "extending back shrinks the range");
  s = moveFocus(s, ORDER, "up", opts);
  assert.deepEqual([s.focus, s.anchor, ...keys(s)], ["b", "b", "b"]);
});

test("Home, End and Page Up/Down stop at the ends", () => {
  const opts = { extend: false, pageSize: 4 };
  const at = (k: string) => clickRow(NO_SELECTION, ORDER, k, plain);
  assert.equal(moveFocus(at("c"), ORDER, "home", opts).focus, "a");
  assert.equal(moveFocus(at("c"), ORDER, "end", opts).focus, "f");
  assert.equal(moveFocus(at("b"), ORDER, "pageDown", opts).focus, "f");
  assert.equal(moveFocus(at("e"), ORDER, "pageDown", opts).focus, "f");
  assert.equal(moveFocus(at("e"), ORDER, "pageUp", opts).focus, "a");
  assert.equal(moveFocus(at("a"), ORDER, "up", opts).focus, "a");
  assert.equal(moveFocus(at("f"), ORDER, "down", opts).focus, "f");
  assert.deepEqual(keys(moveFocus(at("c"), ORDER, "end", { ...opts, extend: true })), ["c", "d", "e", "f"]);
  assert.equal(moveFocus(NO_SELECTION, [], "down", opts), NO_SELECTION, "an empty list has nothing to move to");
});

test("moving starts from the first selected row when nothing has focus", () => {
  const s: Selection = { keys: new Set(["d", "b"]), anchor: null, focus: null };
  assert.equal(moveFocus(s, ORDER, "down", { extend: false, pageSize: 1 }).focus, "c");
});

test("Space adds or removes the focused row; Cmd-A selects all; Esc clears but keeps focus", () => {
  let s = clickRow(NO_SELECTION, ORDER, "b", plain);
  s = focusRow(s, "d", false);
  s = toggleFocused(s);
  assert.deepEqual(keys(s), ["b", "d"]);
  s = toggleFocused(s);
  assert.deepEqual(keys(s), ["b"]);
  assert.equal(toggleFocused(NO_SELECTION), NO_SELECTION);

  const all = selectAll(s, ORDER);
  assert.equal(all.keys.size, ORDER.length);
  const cleared = clearSelection(all);
  assert.equal(cleared.keys.size, 0);
  assert.equal(cleared.focus, "d");
  assert.equal(clearSelection(cleared), cleared);
});

test("rows that leave the list leave the selection and the anchor", () => {
  const s: Selection = { keys: new Set(["a", "c"]), anchor: "c", focus: "c" };
  const left = prune(s, new Set(["a", "b"]));
  assert.deepEqual(keys(left), ["a"]);
  assert.equal(left.anchor, null);
  assert.equal(left.focus, null, "without the old list there's no telling where focus was");
  assert.equal(prune(s, new Set(ORDER)), s, "nothing gone: the same object");
});

test("when the focused row leaves, focus goes to the row that took its place", () => {
  // The family at "c" left the list (a filter, or a tag removed on its page).
  const s = clickRow(NO_SELECTION, ORDER, "c", plain);
  const after = prune(s, new Set(["a", "b", "d", "e", "f"]), { before: ORDER });
  assert.equal(after.focus, "d");
  assert.deepEqual(keys(after), ["d"], "it was the only selected row, so its neighbor is selected");
  assert.equal(after.anchor, "d");

  // Several rows went, the last ones included: the nearest one before.
  const last = prune(clickRow(NO_SELECTION, ORDER, "e", plain), new Set(["a", "b", "c"]), { before: ORDER });
  assert.equal(last.focus, "c");

  // Others stay selected: focus moves, and nothing else is selected for it.
  let several = clickRow(NO_SELECTION, ORDER, "a", plain);
  several = clickRow(several, ORDER, "c", { toggle: true, range: false });
  const kept = prune(several, new Set(["a", "b", "d", "e", "f"]), { before: ORDER });
  assert.equal(kept.focus, "d");
  assert.deepEqual(keys(kept), ["a"]);

  // Focus on a row that isn't selected stays unselected where it lands.
  const unselected = focusRow(clickRow(NO_SELECTION, ORDER, "a", plain), "c", false);
  const moved = prune(unselected, new Set(["a", "b", "d", "e", "f"]), { before: ORDER });
  assert.equal(moved.focus, "d");
  assert.deepEqual(keys(moved), ["a"]);

  assert.equal(prune(s, new Set(), { before: ORDER }).focus, null, "an empty list has nothing to focus");
});

test("when a family is collapsed, focus on one of its styles goes to the family row", () => {
  const before = ["f:A", "s:A1", "s:A2", "f:B"];
  const parentOf = (k: string) => (k.startsWith("s:A") ? "f:A" : null);
  const s = clickRow(NO_SELECTION, before, "s:A2", plain);
  const after = prune(s, new Set(["f:A", "f:B"]), { before, parentOf });
  assert.equal(after.focus, "f:A");
  assert.deepEqual(keys(after), ["f:A"]);
  // The family itself left too: on to the row that took its place.
  assert.equal(focusAfterRemoval("s:A2", new Set(["f:B"]), { before, parentOf }), "f:B");
  assert.equal(focusAfterRemoval("s:A2", new Set(["f:B"]), {}), null);
});

test("going to Tiles, selected styles become their families; a collapse in Rows still drops them", () => {
  const before = ["f:Arial", "f:Inter", "s:inter-bold", "s:inter-italic", "f:Lora", "s:lora-regular"];
  const parentOf = (k: string) => (k.startsWith("s:inter") ? "f:Inter" : k.startsWith("s:lora") ? "f:Lora" : null);
  const tiles = new Set(["f:Arial", "f:Inter", "f:Lora"]);
  // Inter Bold, then Cmd-click Inter Italic.
  const two = clickRow(clickRow(NO_SELECTION, before, "s:inter-bold", plain), before, "s:inter-italic", cmd);
  const inTiles = prune(two, tiles, { before, parentOf, toParent: true });
  assert.deepEqual(keys(inTiles), ["f:Inter"], "both styles are one family: listed once");
  assert.equal(inTiles.anchor, "f:Inter");
  assert.equal(inTiles.focus, "f:Inter");
  // Back in Rows, the family is still selected.
  assert.deepEqual(keys(prune(inTiles, new Set(before), { before: [...tiles], parentOf })), ["f:Inter"]);

  // A family and another family's style: both families.
  const mixed = clickRow(clickRow(NO_SELECTION, before, "f:Arial", plain), before, "s:lora-regular", cmd);
  assert.deepEqual(keys(prune(mixed, tiles, { before, parentOf, toParent: true })), ["f:Arial", "f:Lora"]);
  // A style whose family left too is dropped.
  assert.deepEqual(keys(prune(mixed, new Set(["f:Arial"]), { before, parentOf, toParent: true })), ["f:Arial"]);

  // Without toParent (Inter collapsed in Rows), the styles leave the selection as before.
  const collapsed = prune(two, new Set(["f:Arial", "f:Inter", "f:Lora", "s:lora-regular"]), { before, parentOf });
  assert.deepEqual(keys(collapsed), []);
  assert.equal(collapsed.focus, "f:Inter");
});

test("focus arrives on the first selected row, else the first row on screen, else the first row", () => {
  assert.equal(ensureFocus(NO_SELECTION, ORDER).focus, "a");
  assert.equal(ensureFocus(NO_SELECTION, ORDER, "d").focus, "d", "a list scrolled down starts where it shows");
  assert.equal(ensureFocus(NO_SELECTION, ORDER, "zz").focus, "a", "a row that isn't listed is ignored");
  const s: Selection = { keys: new Set(["e", "c"]), anchor: null, focus: null };
  const focused = ensureFocus(s, ORDER, "a");
  assert.equal(focused.focus, "c");
  assert.equal(focused.keys, s.keys, "the selection doesn't change");
  const already = focusRow(s, "b", false);
  assert.equal(ensureFocus(already, ORDER, "d"), already);
  assert.equal(ensureFocus(NO_SELECTION, []), NO_SELECTION);
});

test("keys: arrows, Return, Space, Esc, Cmd-A and Left/Right", () => {
  assert.deepEqual(listKeyCommand(key("ArrowDown"), true), { kind: "move", move: "down", extend: false });
  assert.deepEqual(listKeyCommand(key("ArrowUp", { shiftKey: true }), true), { kind: "move", move: "up", extend: true });
  assert.deepEqual(listKeyCommand(key("PageDown"), false), { kind: "move", move: "pageDown", extend: false });
  assert.deepEqual(listKeyCommand(key("End", { shiftKey: true }), false), { kind: "move", move: "end", extend: true });
  assert.deepEqual(listKeyCommand(key("Enter"), true), { kind: "open" });
  assert.deepEqual(listKeyCommand(key(" "), true), { kind: "toggle" });
  assert.deepEqual(listKeyCommand(key("Escape"), true), { kind: "clear" });
  assert.deepEqual(listKeyCommand(key("ArrowRight"), true), { kind: "expand" });
  assert.deepEqual(listKeyCommand(key("ArrowLeft"), true), { kind: "collapse" });
  assert.equal(listKeyCommand(key("Enter", { shiftKey: true }), true), null);
  assert.equal(listKeyCommand(key("x"), true), null);
});

test("keys: Cmd on macOS, Ctrl on Windows", () => {
  assert.deepEqual(listKeyCommand(key("a", { metaKey: true }), true), { kind: "selectAll" });
  assert.deepEqual(listKeyCommand(key("A", { metaKey: true }), true), { kind: "selectAll" }, "Caps Lock on");
  assert.equal(listKeyCommand(key("a", { ctrlKey: true }), true), null);
  assert.deepEqual(listKeyCommand(key("a", { ctrlKey: true }), false), { kind: "selectAll" });
  assert.equal(listKeyCommand(key("a", { metaKey: true }), false), null);
  // Finder's Cmd-Up and Cmd-Down go to the first and last row.
  assert.deepEqual(listKeyCommand(key("ArrowUp", { metaKey: true }), true), { kind: "move", move: "home", extend: false });
  assert.deepEqual(listKeyCommand(key("ArrowDown", { metaKey: true, shiftKey: true }), true), { kind: "move", move: "end", extend: true });
  // Cmd+[ is Back, and Alt+Left is Back on Windows: not the list's.
  assert.equal(listKeyCommand(key("[", { metaKey: true }), true), null);
  assert.equal(listKeyCommand(key("ArrowLeft", { altKey: true }), false), null);
  assert.equal(listKeyCommand(key("Enter", { metaKey: true }), true), null);
});

test("in a grid, Left and Right go item by item and Up and Down by line", () => {
  // 10 items, 4 across: rows [0-3] [4-7] [8-9].
  const grid = Array.from({ length: 10 }, (_, i) => `t${i}`);
  const at = (i: number) => focusRow(NO_SELECTION, grid[i], true);
  const go = (from: number, move: "up" | "down" | "prev" | "next") => moveFocus(at(from), grid, move, { extend: false, pageSize: 8, across: 4 }).focus;
  assert.equal(go(5, "down"), "t9");
  assert.equal(go(5, "up"), "t1");
  assert.equal(go(1, "up"), "t1", "the top line stays put");
  assert.equal(go(6, "down"), "t9", "nothing below: the last item, as in Finder");
  assert.equal(go(9, "down"), "t9", "the last line stays put");
  assert.equal(go(8, "down"), "t8");
  assert.equal(go(3, "next"), "t4", "Right wraps to the next line");
  assert.equal(go(4, "prev"), "t3");
  assert.equal(go(0, "prev"), "t0");
  assert.equal(moveFocus(at(1), grid, "pageDown", { extend: false, pageSize: 8, across: 4 }).focus, "t9");
  // Shift extends from the anchor, in item order.
  const range = moveFocus(at(1), grid, "down", { extend: true, pageSize: 8, across: 4 });
  assert.deepEqual(keys(range), ["t1", "t2", "t3", "t4", "t5"]);
  // In a list (across 1), Up and Down are one row, as before.
  assert.equal(moveFocus(at(5), grid, "down", { extend: false, pageSize: 8 }).focus, "t6");
});

test("keys in a grid: Left and Right move instead of collapsing and expanding", () => {
  assert.deepEqual(listKeyCommand(key("ArrowRight"), true, { grid: true }), { kind: "move", move: "next", extend: false });
  assert.deepEqual(listKeyCommand(key("ArrowLeft", { shiftKey: true }), true, { grid: true }), { kind: "move", move: "prev", extend: true });
  assert.deepEqual(listKeyCommand(key("ArrowRight"), true), { kind: "expand" });
  assert.deepEqual(listKeyCommand(key("ArrowDown"), true, { grid: true }), { kind: "move", move: "down", extend: false });
});
