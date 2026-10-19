import { useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LibraryLayout, SortOrder, TableColumnSetting, TableDensity } from "@/api";
import type { Face, Family } from "@/library";
import { listKeyCommand, type Selection } from "@/selection";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fontsPayload, pressToDrag } from "@/tags/drag";
import { FontTagMenuItems } from "@/tags/FontMenu";
import { isMenuKey, openMenuFromKeyboard } from "@/tags/menus";
import type { Locations } from "@/tags/locations";
import { uniqueFaces, useTagIndex, type TagIndex } from "@/tags/model";
import { TagPicker } from "@/tags/TagPicker";
import { FontList } from "../FontList";
import { IS_MAC } from "../TitleBar";
import { FontTable } from "./FontTable";
import { FontTiles } from "./FontTiles";
import { useSelection } from "./useSelection";

// The library list, in whichever layout is picked (Tiles, Rows or Table). What all three share
// lives here: the rows and their selection, the keyboard, opening, the right-click menu,
// dragging fonts onto tags, the selection bar, and focus. Each layout draws its own virtualized
// scroll element and tells the pane about it (LayoutAdapter); see docs/ARCHITECTURE.md.

export type Row = { kind: "family"; family: Family } | { kind: "face"; face: Face; family: Family };

export const rowKey = (row: Row) => (row.kind === "family" ? `f:${row.family.id}` : `s:${row.face.key}`);

/** What opening a row asks for: its family's page, showing this style first. */
export interface OpenRequest {
  /** The face the page is opened from (finds the family, also after regrouping). */
  faceKey: string;
  /** The style shown first. A family row narrowed by Variable shows its variable style. */
  styleKey: string;
  /** The row, focused again on Back. */
  rowKey: string;
  /** The family's name, for the announcement. */
  name: string;
}

export function openRequest(row: Row): OpenRequest {
  const face = row.kind === "family" ? row.family.representative : row.face;
  return { faceKey: face.key, styleKey: face.key, rowKey: rowKey(row), name: row.family.ungroupedFrom ?? row.family.name };
}

/** What App can ask of the list. */
export interface ListHandle {
  /** Focuses the list with this row active (on Back). False if the row isn't listed any more. */
  focusRow: (rowKey: string | null) => boolean;
}

/** Presses on these don't start a drag or open the font: an item's own buttons, switches and fields. */
export const ROW_CONTROLS = "button, input, textarea, a, [role=switch], [data-no-drag]";

/** What a row-level action works on: the selected rows if this row is one of them, else this row. */
export interface RowActions {
  index: TagIndex;
  selection: Selection;
  targetsFor: (key: string) => Face[];
  onRowClick: (e: React.MouseEvent, key: string) => void;
  onRowDoubleClick: (e: React.MouseEvent, row: Row) => void;
  /** The list has keyboard focus and shows where it is. */
  ring: boolean;
}

/** What a layout tells the pane about itself, on every render. */
export interface LayoutAdapter {
  /** The scroll element, which keeps keyboard focus. */
  element: HTMLElement | null;
  /** Items one Page Up or Page Down moves. */
  pageSize: () => number;
  /** Items on one line: Up and Down move this many (the column count in Tiles; 1 elsewhere). */
  across: number;
  /** The active item is drawn and in sight, or about to be. */
  activeOnScreen: boolean;
  /** The first item showing at the top. */
  firstOnScreen: () => string | undefined;
}

const NO_ADAPTER: LayoutAdapter = { element: null, pageSize: () => 1, across: 1, activeOnScreen: false, firstOnScreen: () => undefined };

/** What rows, cards and table cells draw. */
export interface DisplayProps {
  /** Expanded families, by Family.id (Rows and Table). */
  expanded: Set<string>;
  onToggleExpanded: (familyId: string) => void;
  previewText: string;
  size: number;
  /** Files with an on/off request in progress. */
  busy: Set<string>;
  locations: Locations;
  onActivate: (ids: number[], active: boolean) => void;
  /** Recently Added: Rows and Tiles say when each item was added. */
  showAdded?: boolean;
}

/** What the pane hands its layout. */
export interface ListView {
  rows: Row[];
  actions: RowActions;
  /** The active row's index, or -1. */
  activeIndex: number;
  /** Bumped to bring the active item into view after the next render: a key command, keyboard
   *  focus, Back, or a layout switch. A count rather than a flag, so a request is never left over
   *  for a later change (a scan adding rows above, say) to act on. */
  reveal: number;
  /** The scroll element has focus. */
  focused: boolean;
  /** The element id of the item at an index (the active descendant). */
  optionId: (index: number) => string;
  /** Spread on the layout's scroll element, with its own role, ref and class. */
  container: React.HTMLAttributes<HTMLDivElement> & { tabIndex: number };
  adapter: React.RefObject<LayoutAdapter>;
  /** Changes when the view or search changes; the layout then scrolls back to the top. */
  resetKey: string;
  /** Bumped when the order changed (sort, grouping) with no active item: back to the top. */
  top: number;
  /** Call after every render of the layout (useKeepFocus): if an item's own control had
   *  keyboard focus and went away with its row, focus goes back to the list. */
  keepFocus: () => void;
}

/** Runs `view.keepFocus` after every render of a layout, once its rows are in the page. */
export function useKeepFocus(view: ListView) {
  useLayoutEffect(() => view.keepFocus());
}

/** The parts of the Table the pane passes through. */
export interface TableOptions {
  sort: SortOrder;
  onSort: (sort: SortOrder) => void;
  columns: TableColumnSetting[];
  onColumns: (columns: TableColumnSetting[]) => void;
  density: TableDensity;
}

interface Props extends DisplayProps {
  layout: LibraryLayout;
  families: Family[];
  /** The whole library, so tagging a family covers all its styles, not only those shown. */
  allFamilies: Family[];
  resetKey: string;
  /** Changes with the sort and grouping: the active item comes into view (else the top). */
  orderKey: string;
  /** Double-click or Return: open the item's font page. */
  onOpen: (request: OpenRequest) => void;
  table: TableOptions;
  ref?: React.Ref<ListHandle>;
}

/**
 * The library list. A click selects; a double-click or Return opens the font page; right-click
 * only selects. Arrow keys, Home/End and Page Up/Down move (Shift extends; in Tiles, Left and
 * Right go item by item and Up and Down by line), Space adds or removes, Right and Left expand
 * and collapse a family (Rows, Table), Cmd-A selects all and Esc clears. The scroll element
 * keeps focus and points at the active item with aria-activedescendant, since the active item
 * may be scrolled out of the page; only its own controls are in the Tab order.
 *
 * The selection lives here, keyed by row key, so it carries over when the layout changes
 * (Tiles has no style rows: a selected style becomes its family).
 */
export function LibraryPane({ ref, layout, families, allFamilies, resetKey, orderKey, onOpen, table, ...display }: Props) {
  const { expanded, onToggleExpanded } = display;
  const listId = useId();
  const index = useTagIndex();
  const tiles = layout === "tiles";

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const family of families) {
      out.push({ kind: "family", family });
      // Tiles don't expand; a single style (grouping off) has nothing to expand.
      if (!tiles && !family.ungroupedFrom && expanded.has(family.id)) for (const face of family.faces) out.push({ kind: "face", face, family });
    }
    return out;
  }, [families, expanded, tiles]);
  const order = useMemo(() => rows.map(rowKey), [rows]);
  const indexByKey = useMemo(() => new Map(order.map((k, i) => [k, i])), [order]);
  // A style row's family row: where focus goes when the family is collapsed under it.
  const familyRowOfFace = useMemo(() => new Map(families.flatMap((f) => f.faces.map((face) => [face.key, `f:${f.id}`] as const))), [families]);
  const parentOf = (key: string) => (key.startsWith("s:") ? familyRowOfFace.get(key.slice(2)) : undefined);

  // Tiles list no styles: a selected style (and the anchor) becomes its family there.
  const sel = useSelection(order, resetKey, parentOf, { toParent: tiles });
  const { selection } = sel;
  // The fonts the right-click menu works on, fixed when it opens (a tag view can lose the row
  // while the menu is still open).
  const [menuFaces, setMenuFaces] = useState<Face[]>([]);
  // Keyboard focus shows as a ring on the active item: after a key press, or focus that didn't
  // come from a click (Tab, or Back from a font page).
  const [focused, setFocused] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  /** When the list was last pressed: focus that arrives right after a press came from it. */
  const pressedAt = useRef(-Infinity);
  const [reveal, setReveal] = useState(0);
  const revealActive = () => setReveal((n) => n + 1);
  /** Set while Shift-F10 opens the menu from the list itself: the menu covers the active item,
   *  even when it's scrolled away and the event lands on the list. */
  const menuOnActive = useRef(false);
  const adapter = useRef<LayoutAdapter>(NO_ADAPTER);

  // An item's own control (a switch, the expand button) with keyboard focus. Virtualized rows
  // come and go: one scrolled out of the drawn ones takes its control with it, and a reload can
  // draw a card again elsewhere. Focus would fall to the page; keepFocus (run after each of the
  // layout's renders) puts it back on the list, whose active item then speaks for it, or on the
  // same control if it's still there.
  const innerFocus = useRef<HTMLElement | null>(null);
  /** Set while keepFocus moves focus, so the list's focus handler leaves the scroll alone. */
  const recovering = useRef(false);
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const list = adapter.current.element;
      const target = e.target;
      innerFocus.current = list && target instanceof HTMLElement && target !== list && list.contains(target) ? target : null;
    };
    // A press outside the list moves focus on purpose (to the page, if it's on nothing that
    // takes focus). One inside either focuses something there or is on the scroll bar.
    const onPointerDown = (e: PointerEvent) => {
      if (!adapter.current.element?.contains(e.target as Node)) innerFocus.current = null;
    };
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);
  const keepFocus = () => {
    const was = innerFocus.current;
    if (!was) return;
    const now = document.activeElement;
    if (now !== null && now !== document.body) return;
    innerFocus.current = null;
    const list = adapter.current.element;
    if (!list?.isConnected) return;
    recovering.current = true;
    try {
      (was.isConnected && list.contains(was) ? was : list).focus({ preventScroll: true });
    } finally {
      recovering.current = false;
    }
  };

  const fullFamily = useMemo(() => new Map(allFamilies.map((f) => [f.id, f])), [allFamilies]);
  const facesOf = (keys: Iterable<string>): Face[] => {
    const out: Face[] = [];
    for (const key of keys) {
      const at = indexByKey.get(key);
      if (at === undefined) continue;
      const row = rows[at];
      if (row.kind === "face") out.push(row.face);
      else out.push(...(fullFamily.get(row.family.id) ?? row.family).faces);
    }
    return uniqueFaces(out);
  };
  const targetsFor = (key: string) => facesOf(selection.keys.has(key) && selection.keys.size > 1 ? selection.keys : [key]);
  const selectedFaces = useMemo(() => (selection.keys.size > 1 ? facesOf(selection.keys) : []), [selection.keys, indexByKey, fullFamily]); // eslint-disable-line react-hooks/exhaustive-deps

  const actions: RowActions = {
    index,
    selection,
    targetsFor,
    ring: focused && keyboard,
    onRowClick: (e, key) => {
      sel.click(key, { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey });
    },
    onRowDoubleClick: (e, row) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if ((e.target as HTMLElement).closest(ROW_CONTROLS)) return;
      onOpen(openRequest(row));
    },
  };

  const activeIndex = selection.focus === null ? -1 : (indexByKey.get(selection.focus) ?? -1);
  const optionId = (i: number) => `${listId}-item-${i}`;

  // While the list has focus it always has an active item, also after its rows were replaced
  // (another filter or view) or the focused row left with nothing near it.
  useEffect(() => {
    if (focused && selection.focus === null && order.length) sel.ensureFocus(adapter.current.firstOnScreen());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, selection.focus, order.length]);

  // Another layout: the selection stays, comes into view, and keeps keyboard focus if the list had it.
  const shownLayout = useRef(layout);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  useEffect(() => {
    if (shownLayout.current === layout) return;
    shownLayout.current = layout;
    if (focusedRef.current) adapter.current.element?.focus({ preventScroll: true });
    revealActive();
  }, [layout]);

  // Sorted another way, or grouped: the active item stays in view; with none, back to the top.
  // Grouping on or off replaces every item, so the active one is found again by the face it
  // stands for (a family by its preview style): the style's family, or the family's style.
  const [top, setTop] = useState(0);
  const shownOrder = useRef(orderKey);
  const focusKey = useRef(selection.focus);
  focusKey.current = selection.focus;
  const activeFace = useRef<string | null>(null);
  const activeRow = activeIndex >= 0 ? rows[activeIndex] : undefined;
  if (activeRow) activeFace.current = activeRow.kind === "face" ? activeRow.face.key : activeRow.family.representative.key;
  useEffect(() => {
    if (shownOrder.current === orderKey) return;
    shownOrder.current = orderKey;
    const focus = focusKey.current;
    if (focus !== null && indexByKey.has(focus)) return revealActive();
    const found = focus !== null && activeFace.current !== null ? familyRowOfFace.get(activeFace.current) : undefined;
    if (found) {
      sel.focus(found, true);
      revealActive();
    } else setTop((n) => n + 1);
    // The rows of this render are the new order's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey]);

  useImperativeHandle(
    ref,
    () => ({
      focusRow: (key) => {
        const listed = key !== null && indexByKey.has(key);
        // A row that has left the list already handed focus to a neighbor (its family, or the
        // row that took its place; see selection.ts), so that's the one shown instead.
        if (listed) sel.focus(key, false);
        revealActive();
        adapter.current.element?.focus({ preventScroll: true });
        return listed;
      },
    }),
    [indexByKey, sel],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Keys from popovers (portaled, but React still passes their events up) and text fields
    // aren't meant for the list.
    const target = e.target as HTMLElement;
    if (!e.currentTarget.contains(target) || target.closest("input, textarea")) return;
    setKeyboard(true);
    const onList = target === e.currentTarget;
    const layoutNow = adapter.current;
    if (isMenuKey(e)) {
      // The list has focus, not an item: open the menu for the active item. If it's scrolled
      // away, it comes back into view, and the menu (opened on the list) still covers it.
      if (onList) revealActive();
      menuOnActive.current = onList;
      openMenuFromKeyboard(e, onList && layoutNow.activeOnScreen ? document.getElementById(optionId(activeIndex)) : null);
      menuOnActive.current = false;
      return;
    }
    const command = listKeyCommand(e, IS_MAC, { grid: tiles });
    if (!command) return;
    if (command.kind === "selectAll") {
      e.preventDefault();
      sel.selectAll();
      return;
    }
    if (command.kind === "clear") {
      // With nothing selected, Esc is left to whatever comes next.
      if (selection.keys.size) {
        e.preventDefault();
        sel.clear();
      }
      return;
    }
    // The active item's own controls (a switch, the expand button, a column header) keep their keys.
    if (!onList) return;
    e.preventDefault();
    // Whatever the key does, it's to the active item: show it (it may have been scrolled away).
    revealActive();
    const row = activeIndex >= 0 ? rows[activeIndex] : undefined;
    switch (command.kind) {
      case "move":
        sel.move(command.move, { extend: command.extend, pageSize: layoutNow.pageSize(), across: layoutNow.across });
        break;
      case "toggle":
        sel.toggle();
        break;
      case "open":
        if (row) onOpen(openRequest(row));
        break;
      case "expand":
        if (row?.kind !== "family" || row.family.ungroupedFrom) break;
        if (!expanded.has(row.family.id)) onToggleExpanded(row.family.id);
        else if (row.family.faces.length) {
          // Already open: on to its first style.
          sel.focus(`s:${row.family.faces[0].key}`, true);
        }
        break;
      case "collapse":
        if (row?.kind === "face") {
          sel.focus(`f:${row.family.id}`, true);
        } else if (row && expanded.has(row.family.id)) onToggleExpanded(row.family.id);
        break;
    }
  };

  const container: ListView["container"] = {
    tabIndex: 0,
    "aria-multiselectable": true,
    onKeyDown,
    onMouseDown: () => {
      pressedAt.current = performance.now();
      setKeyboard(false);
    },
    onFocus: (e) => {
      if (e.target !== e.currentTarget) return;
      if (recovering.current) {
        // Back from an item's control that went away (see keepFocus): the ring and the scroll
        // stay as they were.
        setFocused(true);
        sel.ensureFocus(adapter.current.firstOnScreen());
        return;
      }
      const fromKeyboard = performance.now() - pressedAt.current > 300;
      setFocused(true);
      setKeyboard(fromKeyboard);
      sel.ensureFocus(adapter.current.firstOnScreen());
      // Tab (or Back) into the list: its active item comes into view, so the ring, the active
      // descendant and Space all have an item you can see. Focus coming back from a menu or
      // dialog the list opened (or from another window) leaves the scroll where it was: the
      // user was working there.
      const from = e.relatedTarget as HTMLElement | null;
      const fromPopup = !from || !!from.closest('[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]');
      if (fromKeyboard && !fromPopup) revealActive();
    },
    onBlur: (e) => {
      if (e.target === e.currentTarget) setFocused(false);
    },
    onPointerDown: (e) => {
      // Drag items onto a tag in the sidebar to tag them.
      const key = (e.target as HTMLElement).closest<HTMLElement>("[data-row-key]")?.dataset.rowKey;
      if (key) pressToDrag(e, () => fontsPayload(targetsFor(key)), ROW_CONTROLS);
    },
    onContextMenuCapture: (e) => {
      // A right-click inside an item's tag popover keeps the normal menu (Paste, say).
      if (!e.currentTarget.contains(e.target as Node)) {
        e.stopPropagation();
        return;
      }
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-row-key]");
      const key = el?.dataset.rowKey ?? (menuOnActive.current ? selection.focus : null);
      setMenuFaces(key ? targetsFor(key) : []);
      // Right-clicking outside the selection selects that item, like Finder. It never opens the font.
      if (key) sel.selectForMenu(key);
    },
  };

  const view: ListView = { rows, actions, activeIndex, reveal, focused, optionId, container, adapter, resetKey, top, keepFocus };
  const count = selection.keys.size;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {count > 1 && <BulkBar faces={selectedFaces} rows={count} onClear={sel.clear} />}
      {/* Always present, so the first count is announced too. */}
      <div className="sr-only" aria-live="polite">
        {count > 1 ? `${count} ${tiles ? "items" : "rows"} selected` : ""}
      </div>
      {/* One right-click menu for the whole list; the item under the pointer decides what it covers. */}
      <ContextMenu
        onOpenChange={(open) => {
          if (!open) setMenuFaces([]);
        }}
      >
        {layout === "tiles" ? (
          <FontTiles view={view} {...display} />
        ) : layout === "table" ? (
          <FontTable view={view} {...display} {...table} />
        ) : (
          <FontList view={view} {...display} />
        )}
        <ContextMenuContent className="max-h-[min(28rem,var(--available-height))] min-w-56">
          {menuFaces.length ? <FontTagMenuItems faces={menuFaces} index={index} /> : <ContextMenuItem disabled>Right-click a font to tag it</ContextMenuItem>}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

/** Shown while several items are selected: tag them all at once. */
function BulkBar({ faces, rows, onClear }: { faces: Face[]; rows: number; onClear: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-sm" role="region" aria-label="Selection">
      <span className="flex-1">
        {rows.toLocaleString()} selected · {faces.length.toLocaleString()} {faces.length === 1 ? "style" : "styles"}
      </span>
      <Popover>
        <PopoverTrigger render={<Button variant="outline" size="sm" />}>
          <Icon name="sell" size={16} />
          Tags…
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80">
          <TagPicker faces={faces} />
        </PopoverContent>
      </Popover>
      <Button variant="ghost" size="sm" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}

/** The tag button on a row or card (shown on hover or focus): tags it, or the selection it's in. */
export function RowTagButton({ rowKey: key, actions, label, tabIndex }: { rowKey: string; actions: RowActions; label: string; tabIndex: number }) {
  const [open, setOpen] = useState(false);
  const faces = open ? actions.targetsFor(key) : [];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Tags for ${label}`}
            tabIndex={tabIndex}
            onClick={(e) => e.stopPropagation()}
            className={open ? "opacity-100" : "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"}
          />
        }
      >
        <Icon name="sell" size={16} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80" onClick={(e) => e.stopPropagation()}>
        {open && <TagPicker faces={faces} />}
      </PopoverContent>
    </Popover>
  );
}

/** Where the active item is relative to what's drawn, for a layout's adapter. `revealPending`:
 *  a reveal is on its way, so it's about to be in sight (the list doesn't flash its own ring). */
export function activeInSight(item: { start: number; end: number } | undefined, scrollTop: number, viewHeight: number, revealPending: boolean, activeIndex: number) {
  return activeIndex >= 0 && (revealPending || (item !== undefined && item.end > scrollTop && item.start < scrollTop + viewHeight));
}

/** Ids of an item's screen-reader texts, read after its name as its description: where its
 *  copies are, marks (more about its state, Mono, duplicates, copies, a sample preview, when it
 *  was added), missing characters and tags. */
export const describedBy = (id: string, marks: string[]) => [`${id}-places`, ...marks.map((m) => `${id}-${m}`), `${id}-sample`, `${id}-missing`, `${id}-tags`].join(" ");
