import type { SortKey, TableColumnSetting, TableDensity } from "../../api";

/**
 * The Table's columns: which there are, which show, how wide they are, and the row height. Pure
 * (no React, no DOM), so `npm run test:ui` covers it; FontTable.tsx draws them.
 *
 * The choices are saved as the `tableColumns` setting: the columns in the order shown, each with
 * whether it shows and, once dragged, its width. An empty list means the defaults below. Ids
 * this version doesn't know are ignored (the setting keeps them for the version that does), and
 * columns added since the list was saved take their default place and default on/off.
 */

export type ColumnId =
  | "state"
  | "name"
  | "preview"
  | "styles"
  | "weights"
  | "foundry"
  | "format"
  | "source"
  | "added"
  | "tags"
  | "version"
  | "designer"
  | "file"
  | "size"
  | "glyphs";

export interface ColumnDef {
  id: ColumnId;
  /** The header's text. */
  label: string;
  /** What screen readers call it, when the header shows no text. */
  srLabel?: string;
  /** Default and smallest width, px. */
  width: number;
  min: number;
  /** Clicking the header sorts by this. */
  sort?: SortKey;
  /** Shown by default. */
  shown: boolean;
  /** Always shown, and pinned to the left while the table scrolls sideways. */
  pinned?: boolean;
  /** Numbers line up on the right. */
  numeric?: boolean;
}

export const COLUMNS: readonly ColumnDef[] = [
  { id: "state", label: "", srLabel: "On or off", width: 52, min: 44, sort: "active", shown: true, pinned: true },
  { id: "name", label: "Name", width: 240, min: 120, sort: "name", shown: true, pinned: true },
  { id: "preview", label: "Preview", width: 280, min: 120, shown: true },
  { id: "styles", label: "Styles", width: 72, min: 56, sort: "styles", shown: true, numeric: true },
  { id: "weights", label: "Weights", width: 150, min: 80, sort: "weight", shown: true },
  { id: "foundry", label: "Foundry", width: 160, min: 80, sort: "foundry", shown: true },
  { id: "format", label: "Format", width: 130, min: 72, sort: "format", shown: true },
  { id: "source", label: "Source", width: 170, min: 80, sort: "source", shown: true },
  { id: "added", label: "Added", width: 112, min: 80, sort: "added", shown: true },
  { id: "tags", label: "Tags", width: 200, min: 80, shown: true },
  { id: "version", label: "Version", width: 96, min: 60, sort: "version", shown: false },
  { id: "designer", label: "Designer", width: 170, min: 80, sort: "designer", shown: false },
  { id: "file", label: "File", width: 220, min: 80, sort: "file", shown: false },
  { id: "size", label: "Size", width: 88, min: 64, sort: "size", shown: false, numeric: true },
  { id: "glyphs", label: "Glyphs", width: 84, min: 60, sort: "glyphs", shown: false, numeric: true },
];

/** The widest a column can be dragged, px (settings.rs keeps widths within 32–1200 too). */
export const MAX_WIDTH = 1200;

const byId = new Map(COLUMNS.map((c) => [c.id, c]));
export const columnDef = (id: string): ColumnDef | undefined => byId.get(id as ColumnId);

export interface Column {
  def: ColumnDef;
  width: number;
  shown: boolean;
}

/**
 * The columns in the order shown, from the saved setting: pinned ones first (always shown), then
 * the saved order, with unknown ids dropped, repeats ignored and widths kept within range. A
 * known column missing from the saved list goes after the column it follows by default.
 */
export function resolveColumns(saved: readonly TableColumnSetting[] = []): Column[] {
  const chosen = new Map<ColumnId, Column>();
  for (const s of saved) {
    const def = columnDef(s.id);
    if (!def || chosen.has(def.id)) continue;
    chosen.set(def.id, { def, width: clampWidth(def, s.width ?? def.width), shown: def.pinned ? true : s.shown });
  }
  const order: Column[] = [...chosen.values()].filter((c) => !c.def.pinned);
  for (const [at, def] of COLUMNS.entries()) {
    if (def.pinned || chosen.has(def.id)) continue;
    // After the nearest column before it (by default order) that's already placed.
    let after = -1;
    for (let i = at - 1; i >= 0 && after < 0; i--) after = order.findIndex((c) => c.def.id === COLUMNS[i].id);
    order.splice(after + 1, 0, { def, width: def.width, shown: def.shown });
  }
  const pinned = COLUMNS.filter((d) => d.pinned).map((def) => chosen.get(def.id) ?? { def, width: def.width, shown: true });
  return [...pinned, ...order];
}

/** A width kept between the column's smallest and MAX_WIDTH, in whole pixels. */
export const clampWidth = (def: ColumnDef, width: number) => Math.round(Math.min(MAX_WIDTH, Math.max(def.min, width)));

/** The setting for these columns: every known column, in order, with its width once changed. */
export function toSetting(columns: readonly Column[], saved: readonly TableColumnSetting[] = []): TableColumnSetting[] {
  const out: TableColumnSetting[] = columns.map((c) => (c.width === c.def.width ? { id: c.def.id, shown: c.shown } : { id: c.def.id, shown: c.shown, width: c.width }));
  // Columns from a newer Fontface stay, at the end.
  for (const s of saved) if (!columnDef(s.id) && !out.some((o) => o.id === s.id)) out.push(s);
  return out;
}

/** Shows or hides a column. Pinned columns always show. */
export function setShown(saved: readonly TableColumnSetting[], id: ColumnId, shown: boolean): TableColumnSetting[] {
  const columns = resolveColumns(saved).map((c) => (c.def.id === id && !c.def.pinned ? { ...c, shown } : c));
  return toSetting(columns, saved);
}

/** A column dragged to `width` (kept between its smallest and MAX_WIDTH). */
export function setWidth(saved: readonly TableColumnSetting[], id: ColumnId, width: number): TableColumnSetting[] {
  const columns = resolveColumns(saved).map((c) => (c.def.id === id ? { ...c, width: clampWidth(c.def, width) } : c));
  return toSetting(columns, saved);
}

/** The shown columns. */
export const shownColumns = (columns: readonly Column[]) => columns.filter((c) => c.shown);

/** CSS grid-template-columns for the shown columns. */
export const gridTemplate = (columns: readonly Column[]) => shownColumns(columns).map((c) => `${c.width}px`).join(" ");

/** The table's full width, px. */
export const totalWidth = (columns: readonly Column[]) => shownColumns(columns).reduce((w, c) => w + c.width, 0);

/** Where each pinned column sits from the left edge, px (they stay put while the table scrolls sideways). */
export function pinnedOffsets(columns: readonly Column[]): Map<ColumnId, number> {
  const out = new Map<ColumnId, number>();
  let left = 0;
  for (const c of shownColumns(columns)) {
    if (!c.def.pinned) break;
    out.set(c.def.id, left);
    left += c.width;
  }
  return out;
}

/** The Preview column's text size: 18px at the default 32px preview size, following the size
 *  slider within 12–32px. */
export const tablePreviewSize = (size: number) => Math.min(32, Math.max(12, Math.round((size * 18) / 32)));

/** Row height, px: 28 compact, 32 regular; with the Preview column, at least 40 and tall enough
 *  for its text (a list preview is 1.3 em). Fixed for a given size, so rows are never measured. */
export function tableRowHeight(density: TableDensity, previewShown: boolean, previewSize: number): number {
  const base = density === "compact" ? 28 : 32;
  if (!previewShown) return base;
  return Math.max(base, 40, Math.ceil(previewSize * 1.3) + 8);
}

/** The header row's height, px. */
export const HEADER_HEIGHT = 30;
