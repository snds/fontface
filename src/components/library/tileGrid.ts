/**
 * Tiles' grid: card sizes from the preview size, how many fit across, and where an item sits.
 * Pure (no React, no DOM), so `npm run test:ui` covers it; FontTiles.tsx draws the cards and
 * virtualizes their rows.
 *
 * Cards have a fixed height for a given size, so rows are never measured: a header (name, style
 * count, on/off), one fitted preview line, a footer (places, tags, marks), and padding.
 */

/** Space between cards, and around the grid, px. */
export const TILE_GAP = 12;
export const GRID_PADDING = 16;

const HEADER = 28;
const FOOTER = 24;
const PADDING = 24;

/** The narrowest a card gets: 5.5 × the preview size, within 180–520px. */
export const tileMinWidth = (size: number) => Math.min(520, Math.max(180, Math.round(size * 5.5)));

/** A card's height for this preview size, px. */
export const tileHeight = (size: number) => HEADER + Math.round(size * 1.35) + PADDING + FOOTER;

/** One row of cards plus the gap under it, px. */
export const rowStride = (size: number) => tileHeight(size) + TILE_GAP;

/** How many cards fit across `width` (the grid's width inside its padding): at least one. */
export function tileColumns(width: number, size: number): number {
  const min = tileMinWidth(size);
  return Math.max(1, Math.floor((width + TILE_GAP) / (min + TILE_GAP)));
}

/** Rows of cards for `count` items. */
export const rowCount = (count: number, columns: number) => Math.ceil(count / Math.max(1, columns));

/** The row an item is on. */
export const rowOf = (index: number, columns: number) => Math.floor(index / Math.max(1, columns));

/** The first item on the row showing at the top when scrolled to `scrollTop` (the grid's
 *  top padding included). */
export function firstVisibleIndex(scrollTop: number, columns: number, stride: number): number {
  return Math.max(0, Math.floor(Math.max(0, scrollTop - GRID_PADDING + TILE_GAP / 2) / stride)) * columns;
}

/** The scroll position that puts the row holding `index` at the top: keeps the first visible
 *  family in place when the column count or the card size changes. */
export const offsetFor = (index: number, columns: number, stride: number) => (index > 0 ? GRID_PADDING + rowOf(index, columns) * stride : 0);

/** The grid's full height: its rows of cards, with the padding above and below (no gap under
 *  the last row). The same as the virtualizer's total, but known before it's measured again. */
export const gridHeight = (count: number, columns: number, stride: number) => GRID_PADDING + rowCount(count, columns) * stride + GRID_PADDING - TILE_GAP;

/**
 * The card kept at the top as the grid scrolls: `anchor` stays while its row is still the top
 * one, else the first card of the new top row. So a column change that keeps card 2000 at the
 * top (on a row that starts at 1998) doesn't make it 1998 for the next change, and resizing back
 * and forth doesn't creep.
 */
export function scrolledAnchor(anchor: number, scrollTop: number, columns: number, stride: number): number {
  const first = firstVisibleIndex(scrollTop, columns, stride);
  return rowOf(anchor, columns) === rowOf(first, columns) ? anchor : first;
}

/** After a reload moved the card at the top from index `from` to `to` (cards added or removed
 *  above it), how far to scroll so it stays where it was, px: whole rows, 0 on the same row. */
export const reloadShift = (from: number, to: number, columns: number, stride: number) => (rowOf(to, columns) - rowOf(from, columns)) * stride;

/** Items one Page Up or Page Down moves: the whole rows that fit, at least one row. */
export const pageItems = (viewHeight: number, columns: number, stride: number) => Math.max(1, Math.floor(viewHeight / stride)) * columns;
