import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  clearSelection,
  clickRow,
  ensureFocus,
  focusRow,
  moveFocus,
  NO_SELECTION,
  prune,
  selectAll,
  toggleFocused,
  type ClickMods,
  type MoveCommand,
  type MoveOptions,
  type Selection,
} from "@/selection";

export interface SelectionApi {
  selection: Selection;
  click: (key: string, mods: ClickMods) => void;
  move: (move: MoveCommand, options: MoveOptions) => void;
  /** Space: adds the focused row to the selection, or takes it out. */
  toggle: () => void;
  selectAll: () => void;
  clear: () => void;
  /** Moves focus to a row; `select` makes it the only selected row. */
  focus: (key: string, select: boolean) => void;
  /** The list got focus: give it a focused row if it has none. */
  ensureFocus: () => void;
  /** Right-click: a row outside the selection becomes the selection (like Finder), without opening. */
  selectForMenu: (key: string) => void;
}

/**
 * The selection of a library list (see selection.ts), kept by row key. `order` is the rows in
 * list order. Rows that leave it leave the selection; a new `resetKey` (another view or search)
 * starts with nothing selected.
 */
export function useSelection(order: readonly string[], resetKey: string): SelectionApi {
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  const orderRef = useRef(order);
  orderRef.current = order;
  const present = useMemo(() => new Set(order), [order]);

  useEffect(() => {
    setSelection((s) => prune(s, present));
  }, [present]);
  useLayoutEffect(() => {
    setSelection(NO_SELECTION);
  }, [resetKey]);

  return useMemo<SelectionApi>(
    () => ({
      selection,
      click: (key, mods) => setSelection((s) => clickRow(s, orderRef.current, key, mods)),
      move: (move, options) => setSelection((s) => moveFocus(s, orderRef.current, move, options)),
      toggle: () => setSelection(toggleFocused),
      selectAll: () => setSelection((s) => selectAll(s, orderRef.current)),
      clear: () => setSelection(clearSelection),
      focus: (key, select) => setSelection((s) => focusRow(s, key, select)),
      ensureFocus: () => setSelection((s) => ensureFocus(s, orderRef.current)),
      selectForMenu: (key) => setSelection((s) => (s.keys.has(key) ? s : clickRow(s, orderRef.current, key, { toggle: false, range: false }))),
    }),
    [selection],
  );
}
