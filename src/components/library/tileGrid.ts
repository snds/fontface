/**
 * Tiles' grid: card sizes from the preview size, how many fit across, and where an item sits.
 * Pure (no React, no DOM), so `npm run test:ui` covers it; FontTiles.tsx draws the cards and
 * virtualizes their rows.
 *
 * The column count follows the grid's width at every width: as many cards as fit at their
 * narrowest, never fewer than two, and the cards stretch to fill the row exactly. Cards have a
 * fixed height for a given size, so rows are never measured: a header (name, style count,
 * on/off), one fitted preview line, a footer (places, tags, marks), padding and the border.
 */

/** Space between cards, and around the grid, px. */
export const TILE_GAP = 12;
export const GRID_PADDING = 16;

/** Never fewer cards across than this, however narrow the window: two narrower cards read
 *  better than one very wide one. */
export const MIN_COLUMNS = 2;

const HEADER = 28;
const FOOTER = 24;
const PADDING = 24;
const BORDER = 2;

/** A card's narrowest width: 64px plus 3.5 × the preview size (about six letters at that size,
 *  and the card's padding), and never under 180px, where the header still has room for some of
 *  the name beside the style count and switch. So bigger previews make fewer, wider cards and
 *  smaller ones fit more across. */
const TILE_BASE = 64;
const TILE_PER_PX = 3.5;
const TILE_FLOOR = 180;
export const tileMinWidth = (size: number) => Math.max(TILE_FLOOR, Math.round(TILE_BASE + TILE_PER_PX * size));

/** A card's height for this preview size, px. The preview's share (1.35 × the size) is more
 *  than the fitted line's 1.3 em (previewFit.ts), so a preview is never clipped above or below. */
export const tileHeight = (size: number) => HEADER + Math.round(size * 1.35) + PADDING + BORDER + FOOTER;

/** One row of cards plus the gap under it, px. */
export const rowStride = (size: number) => tileHeight(size) + TILE_GAP;

/** How many cards fit across `width` (the grid's width inside its padding) at their narrowest:
 *  at least MIN_COLUMNS, where the cards get narrower than that instead. */
export function tileColumns(width: number, size: number): number {
  const min = tileMinWidth(size);
  return Math.max(MIN_COLUMNS, Math.floor((width + TILE_GAP) / (min + TILE_GAP)));
}

/** Each card's width with `columns` across `width`: they share what the gaps leave, so a row
 *  fills the width exactly. (FontTiles leaves this to the grid's equal columns.) */
export const tileWidth = (width: number, columns: number) => Math.max(0, (width - (columns - 1) * TILE_GAP) / Math.max(1, columns));

/** Rows of cards for `count` items. */
export const rowCount = (count: number, columns: number) => Math.ceil(count / Math.max(1, columns));

/** The row an item is on. */
export const rowOf = (index: number, columns: number) => Math.floor(index / Math.max(1, columns));

/** The first item on the row showing at the top when scrolled to `scrollTop` (the grid's
 *  top padding included). */
export function firstVisibleIndex(scrollTop: number, columns: number, stride: number): number {
  return Math.max(0, Math.floor(Math.max(0, scrollTop - GRID_PADDING + TILE_GAP / 2) / stride)) * columns;
}

/** The card at the top, in one shape of the grid (its column count and card size). */
export interface TopCard {
  index: number;
  columns: number;
  stride: number;
}

/** Where the row holding the card starts, px from the top of the scroll area. */
const rowTop = ({ index, columns, stride }: TopCard) => GRID_PADDING + rowOf(index, columns) * stride;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The scroll position that keeps the card at the top in place when the column count or the card
 * size changes (`from` before, `to` after: its index too, if a reload moved it at the same time):
 * its row stays the top one, scrolled as far into it as before (in proportion, when the cards got
 * taller or shorter). So a resize moves nothing on screen but the cards that change rows, and the
 * top stays the top. Never so far that another row becomes the top one (firstVisibleIndex), which
 * would make the card at the top creep.
 */
export function keptOffset(scrollTop: number, from: TopCard, to: TopCard): number {
  const into = scrollTop - rowTop(from);
  // The space above the first row doesn't stretch with the cards.
  const kept = into > 0 ? (into * to.stride) / from.stride : into;
  const lowest = rowOf(to.index, to.columns) > 0 ? -TILE_GAP / 2 : -GRID_PADDING;
  return Math.max(0, rowTop(to) + clamp(kept, lowest, to.stride - TILE_GAP));
}

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
