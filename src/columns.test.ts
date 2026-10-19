// Run with `npm run test:ui`. The Table's columns (components/library/columns.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLUMNS,
  gridTemplate,
  MAX_WIDTH,
  pinnedOffsets,
  resolveColumns,
  setShown,
  setWidth,
  shownColumns,
  tablePreviewSize,
  tableRowHeight,
  totalWidth,
} from "./components/library/columns.ts";

const ids = (cols: { def: { id: string } }[]) => cols.map((c) => c.def.id);

test("with nothing saved: the default columns, Preview on, the optional ones off", () => {
  const cols = resolveColumns([]);
  assert.deepEqual(ids(cols), COLUMNS.map((c) => c.id));
  assert.deepEqual(ids(shownColumns(cols)), ["state", "name", "preview", "styles", "weights", "foundry", "format", "source", "added", "tags"]);
  assert.ok(!shownColumns(cols).some((c) => ["version", "designer", "file", "size", "glyphs"].includes(c.def.id)));
});

test("on/off and Name are pinned first and always shown", () => {
  const cols = resolveColumns([
    { id: "tags", shown: true },
    { id: "name", shown: false },
    { id: "state", shown: false },
  ]);
  assert.deepEqual(ids(cols).slice(0, 2), ["state", "name"]);
  assert.ok(cols[0].shown && cols[1].shown, "they can't be hidden");
  assert.ok(resolveColumns(setShown([], "name", false))[1].shown, "hiding Name does nothing");
});

test("showing and hiding keeps the order and saves every column", () => {
  const saved = setShown([], "glyphs", true);
  assert.equal(saved.length, COLUMNS.length);
  assert.ok(saved.find((c) => c.id === "glyphs")!.shown);
  const off = setShown(saved, "preview", false);
  const cols = resolveColumns(off);
  assert.ok(!cols.find((c) => c.def.id === "preview")!.shown);
  assert.ok(cols.find((c) => c.def.id === "glyphs")!.shown, "the earlier change stays");
  assert.deepEqual(ids(cols), ids(resolveColumns([])), "same order");
});

test("widths: dragged widths are kept within range; untouched ones aren't saved", () => {
  const saved = setWidth([], "name", 40);
  const name = resolveColumns(saved).find((c) => c.def.id === "name")!;
  assert.equal(name.width, name.def.min, "not narrower than its smallest");
  assert.equal(resolveColumns(setWidth([], "foundry", 99999)).find((c) => c.def.id === "foundry")!.width, MAX_WIDTH);
  const wide = setWidth([], "foundry", 250.6);
  assert.equal(wide.find((c) => c.id === "foundry")!.width, 251);
  assert.equal(wide.find((c) => c.id === "added")!.width, undefined, "default widths stay out of the setting");
  assert.equal(resolveColumns([{ id: "added", shown: true, width: 5 }]).find((c) => c.def.id === "added")!.width, 80);
});

test("ids it doesn't know are kept for later; repeats and new columns are sorted out", () => {
  const saved = [
    { id: "fromTheFuture", shown: true, width: 120 },
    { id: "added", shown: true },
    { id: "added", shown: false },
    { id: "styles", shown: false },
  ];
  const cols = resolveColumns(saved);
  assert.ok(!ids(cols).includes("fromTheFuture" as never));
  assert.ok(cols.find((c) => c.def.id === "added")!.shown, "the first of a repeated id counts");
  assert.ok(!cols.find((c) => c.def.id === "styles")!.shown);
  assert.equal(new Set(ids(cols)).size, COLUMNS.length, "every known column, once");
  // Columns missing from the saved list take their default place: after the one before them.
  const order = ids(cols);
  assert.ok(order.indexOf("weights") === order.indexOf("styles") + 1, `${order}`);
  assert.ok(setShown(saved, "glyphs", true).some((c) => c.id === "fromTheFuture"), "still saved");
});

test("a saved order is kept, with new columns placed by their neighbors", () => {
  const cols = resolveColumns([
    { id: "added", shown: true },
    { id: "styles", shown: true },
  ]);
  const order = ids(cols);
  assert.ok(order.indexOf("added") < order.indexOf("styles"), "the saved order wins");
  assert.equal(order.indexOf("tags"), order.indexOf("added") + 1, "Tags follows Added, as by default");
});

test("grid template, total width and pinned offsets follow the shown columns", () => {
  const cols = resolveColumns(setShown([], "preview", false));
  const shown = shownColumns(cols);
  assert.equal(gridTemplate(cols), shown.map((c) => `${c.width}px`).join(" "));
  assert.equal(totalWidth(cols), shown.reduce((w, c) => w + c.width, 0));
  const offsets = pinnedOffsets(cols);
  assert.deepEqual([...offsets.keys()], ["state", "name"]);
  assert.equal(offsets.get("state"), 0);
  assert.equal(offsets.get("name"), cols[0].width);
});

test("the Preview column's size and row heights", () => {
  assert.equal(tablePreviewSize(32), 18, "18px at the default size");
  assert.equal(tablePreviewSize(10), 12);
  assert.equal(tablePreviewSize(128), 32);
  assert.equal(tablePreviewSize(48), 27);
  assert.equal(tableRowHeight("compact", false, 18), 28);
  assert.equal(tableRowHeight("regular", false, 18), 32);
  assert.equal(tableRowHeight("compact", true, 18), 40);
  assert.equal(tableRowHeight("regular", true, 32), Math.ceil(32 * 1.3) + 8, "tall enough for a 32px preview");
});
