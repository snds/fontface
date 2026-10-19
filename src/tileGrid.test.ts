// Run with `npm run test:ui`. Tiles' grid math (components/library/tileGrid.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  firstVisibleIndex,
  GRID_PADDING,
  offsetFor,
  pageItems,
  rowCount,
  rowOf,
  rowStride,
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

test("Page Up and Page Down move whole rows", () => {
  const stride = rowStride(32);
  assert.equal(pageItems(stride * 5 + 10, 4, stride), 20);
  assert.equal(pageItems(10, 4, stride), 4, "at least one row");
});
