// Run with `npm run test:ui`. Tiles' grid math (components/library/tileGrid.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  firstVisibleIndex,
  GRID_PADDING,
  gridHeight,
  offsetFor,
  pageItems,
  reloadShift,
  rowCount,
  rowOf,
  rowStride,
  scrolledAnchor,
  TILE_GAP,
  tileColumns,
  tileHeight,
  tileMinWidth,
} from "./components/library/tileGrid.ts";

test("cards follow the size: 5.5 × size wide, within 180–520px, and a fixed height", () => {
  assert.equal(tileMinWidth(32), 180);
  assert.equal(tileMinWidth(48), 264);
  assert.equal(tileMinWidth(128), 520);
  assert.equal(tileHeight(32), 28 + 43 + 24 + 24);
  assert.equal(rowStride(32), tileHeight(32) + TILE_GAP);
});

test("columns: as many as fit across, at least one", () => {
  // 5 cards of 180 and 4 gaps of 12 need 948px.
  assert.equal(tileColumns(948, 32), 5);
  assert.equal(tileColumns(947, 32), 4);
  assert.equal(tileColumns(100, 32), 1, "even a narrow window shows one");
  assert.equal(tileColumns(0, 32), 1);
  assert.equal(tileColumns(1200, 128), 2);
});

test("rows and positions", () => {
  assert.equal(rowCount(0, 5), 0);
  assert.equal(rowCount(11, 5), 3);
  assert.equal(rowOf(0, 5), 0);
  assert.equal(rowOf(4, 5), 0);
  assert.equal(rowOf(5, 5), 1);
});

test("the first visible card stays at the top when the column count changes", () => {
  const stride = rowStride(32);
  // Scrolled to the top of row 40 with 5 across: card 200 is first.
  const top = GRID_PADDING + 40 * stride;
  const first = firstVisibleIndex(top, 5, stride);
  assert.equal(first, 200);
  // With 4 across, card 200 is on row 50; scrolling there puts it on the top row again.
  const to = offsetFor(first, 4, stride);
  assert.equal(to, GRID_PADDING + 50 * stride);
  assert.equal(firstVisibleIndex(to, 4, stride), 200);
  assert.equal(offsetFor(0, 4, stride), 0, "the top stays the top");
  // Partway down a row still counts that row (until half of the gap below it).
  assert.equal(firstVisibleIndex(top + stride / 2, 5, stride), 200);
  assert.equal(firstVisibleIndex(0, 5, stride), 0);
});

test("resizing back and forth keeps the same card at the top, without creeping", () => {
  const stride = rowStride(32);
  let anchor = 2000;
  for (const columns of [6, 5, 6, 5, 6, 5, 7, 4, 5]) {
    // The geometry change scrolls to the anchor's row; that scroll reports back as a scroll.
    const top = offsetFor(anchor, columns, stride);
    anchor = scrolledAnchor(anchor, top, columns, stride);
    assert.equal(anchor, 2000, `${columns} across`);
    assert.equal(rowOf(firstVisibleIndex(top, columns, stride), columns), rowOf(2000, columns), "on the top row");
  }
  // Scrolling within the top row keeps it; scrolling to another row takes that row's first card.
  assert.equal(scrolledAnchor(2000, offsetFor(2000, 6, stride) + stride / 3, 6, stride), 2000);
  assert.equal(scrolledAnchor(2000, offsetFor(2000, 6, stride) + stride, 6, stride), 2004);
});

test("a reload that adds cards above the top one scrolls by whole rows to keep it in place", () => {
  const stride = rowStride(32);
  assert.equal(reloadShift(200, 200, 5, stride), 0, "nothing moved");
  assert.equal(reloadShift(200, 203, 5, stride), 0, "still on the same row");
  assert.equal(reloadShift(200, 212, 5, stride), 2 * stride, "two rows down");
  assert.equal(reloadShift(200, 190, 5, stride), -2 * stride, "cards removed above: up");
});

test("the grid's height is known before it's measured again", () => {
  const stride = rowStride(32);
  assert.equal(gridHeight(0, 5, stride), GRID_PADDING * 2 - TILE_GAP);
  assert.equal(gridHeight(11, 5, stride), GRID_PADDING + 3 * stride + GRID_PADDING - TILE_GAP);
});

test("Page Up and Page Down move whole rows", () => {
  const stride = rowStride(32);
  assert.equal(pageItems(stride * 5 + 10, 4, stride), 20);
  assert.equal(pageItems(10, 4, stride), 4, "at least one row");
});
