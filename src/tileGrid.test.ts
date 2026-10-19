// Run with `npm run test:ui`. Tiles' grid math (components/library/tileGrid.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SIZE_STEPS } from "./viewOptions.ts";
import { ROW_HEIGHT } from "./previewFit.ts";
import {
  firstVisibleIndex,
  GRID_PADDING,
  gridHeight,
  MIN_COLUMNS,
  keptOffset,
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
  tileWidth,
} from "./components/library/tileGrid.ts";

// The grid's width in a window `w` px wide: less the 240px sidebar and the grid's padding.
const gridIn = (w: number) => w - 240 - 2 * GRID_PADDING;

test("cards follow the size: 64px + 3.5 × size wide, at least 180px, and a fixed height", () => {
  assert.equal(tileMinWidth(12), 180, "small sizes: room for the name, count and switch");
  assert.equal(tileMinWidth(32), 180);
  assert.equal(tileMinWidth(34), 183);
  assert.equal(tileMinWidth(44), 218);
  assert.equal(tileMinWidth(48), 232);
  assert.equal(tileMinWidth(128), 512);
  assert.equal(tileHeight(32), 28 + 43 + 24 + 2 + 24);
  assert.equal(rowStride(32), tileHeight(32) + TILE_GAP);
});

test("columns: as many as fit across at their narrowest", () => {
  // 5 cards of 180 and 4 gaps of 12 need 948px.
  assert.equal(tileColumns(948, 32), 5);
  assert.equal(tileColumns(947, 32), 4);
  assert.equal(tileColumns(2000, 32), 10);
});

test("never fewer than two across, however narrow", () => {
  assert.equal(MIN_COLUMNS, 2);
  for (const size of [10, ...SIZE_STEPS]) {
    for (const width of [0, 1, 100, 300, 500, tileMinWidth(size) * 2]) {
      assert.ok(tileColumns(width, size) >= 2, `${width}px at ${size}`);
    }
  }
  // At the window's minimum width, the biggest size still shows two, narrower than their minimum.
  assert.equal(tileColumns(gridIn(900), 128), 2);
  assert.ok(tileWidth(gridIn(900), 2) < tileMinWidth(128));
});

test("columns grow with the width, a card at a time, and never shrink as it widens", () => {
  for (const size of [10, ...SIZE_STEPS]) {
    let last = tileColumns(0, size);
    for (let width = 0; width <= 4000; width++) {
      const columns = tileColumns(width, size);
      assert.ok(columns === last || columns === last + 1, `${width}px at ${size}: ${last} to ${columns}`);
      last = columns;
    }
  }
  // A new card joins as soon as one more fits at its narrowest, whatever the width.
  const pitch = tileMinWidth(32) + TILE_GAP;
  for (let n = 2; n <= 20; n++) {
    assert.equal(tileColumns(n * pitch - TILE_GAP, 32), n);
    assert.equal(tileColumns(n * pitch - TILE_GAP - 1, 32), Math.max(2, n - 1));
  }
});

test("bigger previews make fewer, wider cards; smaller ones fit more across", () => {
  const width = gridIn(1600);
  const across = [10, ...SIZE_STEPS].map((size) => tileColumns(width, size));
  for (let i = 1; i < across.length; i++) assert.ok(across[i] <= across[i - 1], `${across}`);
  assert.ok(across[0] > across[across.length - 1]);
  // The default size in windows of about 900, 1300, 1600 and 2000px.
  assert.deepEqual([900, 1300, 1600, 2000].map((w) => tileColumns(gridIn(w), 32)), [3, 5, 6, 9]);
  assert.deepEqual([900, 1300, 1600, 2000].map((w) => tileColumns(gridIn(w), 64)), [2, 3, 4, 5]);
  assert.deepEqual([900, 1300, 1600, 2000].map((w) => tileColumns(gridIn(w), 128)), [2, 2, 2, 3]);
});

test("cards fill the row exactly, with even gaps, and never get narrower than their minimum above two", () => {
  for (const size of [10, ...SIZE_STEPS]) {
    for (let width = 0; width <= 3000; width += 7) {
      const columns = tileColumns(width, size);
      const card = tileWidth(width, columns);
      if (width >= (columns - 1) * TILE_GAP) assert.ok(Math.abs(columns * card + (columns - 1) * TILE_GAP - width) < 1e-9, `${width}px at ${size}`);
      if (columns > MIN_COLUMNS) {
        assert.ok(card >= tileMinWidth(size), `${width}px at ${size}: ${card}`);
        // Never so wide that another would fit.
        assert.ok(card < tileMinWidth(size) + (tileMinWidth(size) + TILE_GAP) / columns, `${width}px at ${size}: ${card}`);
      }
    }
  }
});

test("the preview always has its fitted line's height in a card", () => {
  // The card less its header (28), footer (24), padding (24) and border (2).
  for (let size = 10; size <= 128; size++) assert.ok(tileHeight(size) - 28 - 24 - 24 - 2 >= ROW_HEIGHT * size, `${size}`);
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
  const to = keptOffset(top, { index: first, columns: 5, stride }, { index: first, columns: 4, stride });
  assert.equal(to, GRID_PADDING + 50 * stride);
  assert.equal(firstVisibleIndex(to, 4, stride), 200);
  assert.equal(keptOffset(0, { index: 0, columns: 5, stride }, { index: 0, columns: 4, stride }), 0, "the top stays the top");
  assert.equal(keptOffset(9, { index: 0, columns: 5, stride }, { index: 0, columns: 9, stride }), 9, "and a little below it too");
  // Partway down a row still counts that row (until half of the gap below it).
  assert.equal(firstVisibleIndex(top + stride / 2, 5, stride), 200);
  assert.equal(firstVisibleIndex(0, 5, stride), 0);
});

test("a column change moves nothing on screen but the cards that change rows", () => {
  const stride = rowStride(32);
  // 37px into row 40: the top card's row stays 37px above the top of the view.
  const top = GRID_PADDING + 40 * stride + 37;
  assert.equal(keptOffset(top, { index: 200, columns: 5, stride }, { index: 200, columns: 4, stride }), GRID_PADDING + 50 * stride + 37);
  assert.equal(keptOffset(top, { index: 200, columns: 5, stride }, { index: 200, columns: 7, stride }), GRID_PADDING + 28 * stride + 37);
  // A new size keeps it as far into its row in proportion.
  const bigger = rowStride(64);
  assert.equal(keptOffset(top, { index: 200, columns: 5, stride }, { index: 200, columns: 3, stride: bigger }), GRID_PADDING + 66 * bigger + (37 * bigger) / stride);
  // A reload that moved the card at the same time: from its old row to its new one.
  assert.equal(keptOffset(top, { index: 200, columns: 5, stride }, { index: 212, columns: 4, stride }), GRID_PADDING + 53 * stride + 37);
});

test("resizing back and forth keeps the same card at the top, without creeping", () => {
  for (const into of [0, 37, -5]) {
    for (const sizes of [[32], [32, 64, 12, 128, 48]]) {
      let anchor = 2000;
      let shape = { columns: 5, stride: rowStride(sizes[0]) };
      let top = GRID_PADDING + rowOf(anchor, 5) * shape.stride + into;
      let step = 0;
      for (const columns of [6, 5, 6, 5, 6, 5, 7, 4, 5, 2, 9, 3]) {
        const next = { columns, stride: rowStride(sizes[step++ % sizes.length]) };
        // The geometry change scrolls to keep the anchor; that scroll reports back as a scroll.
        top = keptOffset(top, { index: anchor, ...shape }, { index: anchor, ...next });
        shape = next;
        anchor = scrolledAnchor(anchor, top, columns, shape.stride);
        assert.equal(anchor, 2000, `${columns} across, ${into}px into the row`);
        assert.equal(rowOf(firstVisibleIndex(top, columns, shape.stride), columns), rowOf(2000, columns), "on the top row");
      }
    }
  }
  // Even from as far into the top row as it goes, or above it, the anchor's row stays the top one.
  const stride = rowStride(128);
  const small = rowStride(12);
  for (const into of [-6, stride - TILE_GAP / 2 - 1]) {
    const to = keptOffset(GRID_PADDING + 400 * stride + into, { index: 2000, columns: 5, stride }, { index: 2000, columns: 9, stride: small });
    assert.equal(rowOf(firstVisibleIndex(to, 9, small), 9), rowOf(2000, 9), `${into}px into the row`);
  }
  // A card left on the first row by an earlier change, at the very top, moving down a row.
  const fromTop = keptOffset(6, { index: 3, columns: 5, stride }, { index: 3, columns: 2, stride });
  assert.equal(scrolledAnchor(3, fromTop, 2, stride), 3);
  // Scrolling within the top row keeps it; scrolling to another row takes that row's first card.
  const at = GRID_PADDING + rowOf(2000, 6) * stride;
  assert.equal(scrolledAnchor(2000, at + stride / 3, 6, stride), 2000);
  assert.equal(scrolledAnchor(2000, at + stride, 6, stride), 2004);
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
