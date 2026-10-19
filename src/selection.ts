/**
 * Which rows of a library list are selected, and which one has keyboard focus. Pure (no React,
 * no DOM), so `npm run test:ui` covers it; `components/library/useSelection.ts` holds it in
 * React state.
 *
 * - A click selects one row. Cmd-click (Ctrl-click on Windows) adds or removes a row,
 *   Shift-click selects a range from the anchor, and Cmd-Shift-click adds that range.
 * - Arrow keys, Home/End and Page Up/Down move the focused row and select it; with Shift they
 *   extend the selection from the anchor instead. Space adds or removes the focused row. In a
 *   grid (Tiles), Left and Right go to the previous and next item and Up and Down a whole line.
 * - Rows are remembered by key, so a reload or an expanded family doesn't shift the selection.
 *   Rows that leave the list leave the selection for good; focus moves to a neighbor. When the
 *   list stops showing style rows at all (Tiles), a selected style becomes its family instead.
 * - Opening (double-click or Return) isn't part of the selection: the list does that.
 */

export interface Selection {
  /** Selected row keys. */
  keys: ReadonlySet<string>;
  /** Where Shift-click and Shift-arrow ranges start. */
  anchor: string | null;
  /** The row keyboard commands act on (the list's active descendant). */
  focus: string | null;
}

export const NO_SELECTION: Selection = { keys: new Set(), anchor: null, focus: null };

export interface ClickMods {
  /** Cmd-click (Ctrl-click on Windows): add or remove this row. */
  toggle: boolean;
  /** Shift-click: a range from the anchor. */
  range: boolean;
}

/** The keys from index a to index b, both included, in list order. */
function span(order: readonly string[], a: number, b: number): string[] {
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

export function clickRow(sel: Selection, order: readonly string[], key: string, mods: ClickMods): Selection {
  const at = order.indexOf(key);
  if (at < 0) return sel;
  const from = sel.anchor === null ? -1 : order.indexOf(sel.anchor);
  if (mods.range && from >= 0) {
    const range = span(order, from, at);
    return { keys: new Set(mods.toggle ? [...sel.keys, ...range] : range), anchor: sel.anchor, focus: key };
  }
  if (mods.toggle) {
    const keys = new Set(sel.keys);
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    return { keys, anchor: key, focus: key };
  }
  return { keys: new Set([key]), anchor: key, focus: key };
}

/** Space: adds the focused row to the selection, or takes it out. */
export function toggleFocused(sel: Selection): Selection {
  if (sel.focus === null) return sel;
  const keys = new Set(sel.keys);
  if (keys.has(sel.focus)) keys.delete(sel.focus);
  else keys.add(sel.focus);
  return { keys, anchor: sel.focus, focus: sel.focus };
}

export function selectAll(sel: Selection, order: readonly string[]): Selection {
  return { ...sel, keys: new Set(order) };
}

/** Esc: nothing selected. Focus stays where it is, so the arrow keys carry on from there. */
export function clearSelection(sel: Selection): Selection {
  return sel.keys.size ? { ...sel, keys: new Set() } : sel;
}

export interface PruneOptions {
  /** The list before it changed (row keys in order): where a focused row that left used to be. */
  before?: readonly string[];
  /** A row's parent row (a style row's family row), tried first when the row leaves. */
  parentOf?: (key: string) => string | null | undefined;
  /** Selected rows that leave become their parent row, when it's listed, instead of leaving the
   *  selection (the anchor too). For a list that stops showing style rows (Tiles), so a selected
   *  style becomes its family; a family collapsed in Rows still lets its styles go. */
  toParent?: boolean;
}

/**
 * Where focus goes when its row leaves the list, so the keyboard and screen readers carry on
 * from about the same place: the row's parent if it's still listed (a style row's family, when
 * the family is collapsed), else the next row after it that's still listed (the one that took
 * its place), else the nearest one before it. Null when nothing is left, or the old place is
 * unknown.
 */
export function focusAfterRemoval(key: string, present: ReadonlySet<string>, { before, parentOf }: PruneOptions = {}): string | null {
  const parent = parentOf?.(key);
  if (parent != null && present.has(parent)) return parent;
  const at = before ? before.indexOf(key) : -1;
  if (!before || at < 0) return null;
  for (let i = at + 1; i < before.length; i++) if (present.has(before[i])) return before[i];
  for (let i = at - 1; i >= 0; i--) if (present.has(before[i])) return before[i];
  return null;
}

/**
 * Drops rows that are no longer listed. The same object comes back when nothing changed.
 *
 * A focused row that leaves hands focus to a neighbor (see focusAfterRemoval). If it was the
 * only selected row, the neighbor is selected too, so a row stays selected, as in Mail. With
 * `toParent`, selected rows that leave become their parent row (each parent once).
 */
export function prune(sel: Selection, present: ReadonlySet<string>, options: PruneOptions = {}): Selection {
  const { parentOf, toParent = false } = options;
  /** What a row stays as: itself if listed, else (with toParent) its parent if that's listed. */
  const kept = (k: string): string | null => {
    if (present.has(k)) return k;
    if (!toParent) return null;
    const parent = parentOf?.(k);
    return parent != null && present.has(parent) ? parent : null;
  };
  const keys = [...new Set([...sel.keys].map(kept).filter((k): k is string => k !== null))];
  let anchor = sel.anchor === null ? null : kept(sel.anchor);
  let focus = sel.focus;
  if (focus !== null && !present.has(focus)) {
    const wasOnlySelected = sel.keys.size === 1 && sel.keys.has(focus);
    focus = focusAfterRemoval(focus, present, options);
    if (focus !== null && wasOnlySelected && !keys.length) {
      keys.push(focus);
      anchor = focus;
    }
  }
  if (keys.length === sel.keys.size && anchor === sel.anchor && focus === sel.focus && keys.every((k) => sel.keys.has(k))) return sel;
  return { keys: new Set(keys), anchor, focus };
}

/** Where keyboard commands start: the focused row, else the first selected one (in list order). */
function currentIndex(sel: Selection, order: readonly string[]): number {
  if (sel.focus !== null) {
    const at = order.indexOf(sel.focus);
    if (at >= 0) return at;
  }
  return order.findIndex((k) => sel.keys.has(k));
}

/**
 * Gives the list a focused row when it gets focus without one: the first selected row, else
 * `preferred` (the first row on screen, so focus doesn't jump to the top of a scrolled list),
 * else the first row. The selection itself doesn't change.
 */
export function ensureFocus(sel: Selection, order: readonly string[], preferred?: string): Selection {
  if (!order.length) return sel;
  if (sel.focus !== null && order.includes(sel.focus)) return sel;
  const at = currentIndex(sel, order);
  if (at >= 0) return { ...sel, focus: order[at] };
  return { ...sel, focus: preferred !== undefined && order.includes(preferred) ? preferred : order[0] };
}

/** Moves focus to a row. `select`: it becomes the only selected row (an arrow key without Shift). */
export function focusRow(sel: Selection, key: string, select: boolean): Selection {
  if (!select) return sel.focus === key ? sel : { ...sel, focus: key };
  return { keys: new Set([key]), anchor: key, focus: key };
}

export type MoveCommand = "up" | "down" | "prev" | "next" | "home" | "end" | "pageUp" | "pageDown";

export interface MoveOptions {
  /** Shift: extend the selection from the anchor instead of selecting one row. */
  extend: boolean;
  /** Items on one screen, for Page Up and Page Down. */
  pageSize: number;
  /** Items on one line: Up and Down move this many (a grid's columns). 1 in a list. */
  across?: number;
}

export function moveFocus(sel: Selection, order: readonly string[], move: MoveCommand, { extend, pageSize, across = 1 }: MoveOptions): Selection {
  const n = order.length;
  if (!n) return sel;
  const cur = currentIndex(sel, order);
  const page = Math.max(1, pageSize);
  const line = Math.max(1, across);
  let to: number;
  switch (move) {
    case "up":
      // The top line stays where it is.
      to = cur < 0 ? 0 : cur - line >= 0 ? cur - line : cur;
      break;
    case "down":
      // Below the end of a grid's last full line, the last item (as in Finder); on the last line, stay.
      to = cur < 0 ? 0 : cur + line < n ? cur + line : Math.floor((n - 1) / line) > Math.floor(cur / line) ? n - 1 : cur;
      break;
    case "prev":
      to = cur < 0 ? 0 : cur - 1;
      break;
    case "next":
      to = cur + 1;
      break;
    case "pageUp":
      to = cur < 0 ? 0 : cur - page;
      break;
    case "pageDown":
      to = cur < 0 ? 0 : cur + page;
      break;
    case "home":
      to = 0;
      break;
    case "end":
      to = n - 1;
      break;
  }
  to = Math.min(n - 1, Math.max(0, to));
  const key = order[to];
  if (!extend) return { keys: new Set([key]), anchor: key, focus: key };
  const anchorAt = sel.anchor === null ? -1 : order.indexOf(sel.anchor);
  const from = anchorAt >= 0 ? anchorAt : Math.max(0, cur);
  return { keys: new Set(span(order, from, to)), anchor: order[from], focus: key };
}

// ------------------------------------------------------------------------------ keyboard

export type ListCommand =
  | { kind: "move"; move: MoveCommand; extend: boolean }
  | { kind: "open" }
  | { kind: "toggle" }
  | { kind: "selectAll" }
  | { kind: "clear" }
  | { kind: "expand" }
  | { kind: "collapse" };

/** The parts of a keyboard event the list looks at. */
export interface ListKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const MOVES: Record<string, MoveCommand> = {
  ArrowUp: "up",
  ArrowDown: "down",
  Home: "home",
  End: "end",
  PageUp: "pageUp",
  PageDown: "pageDown",
};

/**
 * What a key does in a library list. `mac`: Cmd is the command key (Ctrl on Windows), and
 * Cmd-Up/Down go to the first and last row, as in Finder. `grid`: Left and Right move to the
 * previous and next item (Tiles, where nothing expands) instead of collapsing and expanding.
 */
export function listKeyCommand(e: ListKey, mac: boolean, { grid = false }: { grid?: boolean } = {}): ListCommand | null {
  const command = mac ? e.metaKey : e.ctrlKey;
  const other = mac ? e.ctrlKey : e.metaKey;
  if (e.altKey || other) return null;
  if (command) {
    if (e.key.toLowerCase() === "a" && !e.shiftKey) return { kind: "selectAll" };
    if (mac && e.key === "ArrowUp") return { kind: "move", move: "home", extend: e.shiftKey };
    if (mac && e.key === "ArrowDown") return { kind: "move", move: "end", extend: e.shiftKey };
    return null;
  }
  const move = MOVES[e.key];
  if (move) return { kind: "move", move, extend: e.shiftKey };
  if (grid && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return { kind: "move", move: e.key === "ArrowLeft" ? "prev" : "next", extend: e.shiftKey };
  if (e.shiftKey) return null;
  switch (e.key) {
    case "Enter":
      return { kind: "open" };
    case " ":
      return { kind: "toggle" };
    case "Escape":
      return { kind: "clear" };
    case "ArrowRight":
      return { kind: "expand" };
    case "ArrowLeft":
      return { kind: "collapse" };
    default:
      return null;
  }
}
