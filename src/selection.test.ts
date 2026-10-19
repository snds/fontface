// Run with `npm run test:ui`. Selecting rows and moving through them with the keyboard (selection.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearSelection,
  clickRow,
  ensureFocus,
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

test("rows that leave the list leave the selection, the anchor and focus", () => {
  const s: Selection = { keys: new Set(["a", "c"]), anchor: "c", focus: "c" };
  const left = prune(s, new Set(["a", "b"]));
  assert.deepEqual(keys(left), ["a"]);
  assert.equal(left.anchor, null);
  assert.equal(left.focus, null);
  assert.equal(prune(s, new Set(ORDER)), s, "nothing gone: the same object");
});

test("focus arrives on the first selected row, else the first row", () => {
  assert.equal(ensureFocus(NO_SELECTION, ORDER).focus, "a");
  const s: Selection = { keys: new Set(["e", "c"]), anchor: null, focus: null };
  const focused = ensureFocus(s, ORDER);
  assert.equal(focused.focus, "c");
  assert.equal(focused.keys, s.keys, "the selection doesn't change");
  const already = focusRow(s, "b", false);
  assert.equal(ensureFocus(already, ORDER), already);
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
