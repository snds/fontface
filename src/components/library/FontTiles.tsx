import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { addedAt, addedDateText } from "@/familyFacts";
import { stateWords, summarize } from "@/fontState";
import { activationIds, type Family } from "@/library";
import { usePreviewProfile } from "@/previewProfiles";
import { Badge } from "@/components/ui/badge";
import { ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { LocationDots, TagDots } from "@/tags/TagChips";
import { StateControl } from "../ActivationSwitch";
import { FacePreview, MissingHint, SampleBadge } from "../FacePreview";
import { activeInSight, describedBy, rowKey, useKeepFocus, type DisplayProps, type ListView, type Row } from "./LibraryPane";
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
} from "./tileGrid";

/**
 * The Tiles layout: a grid of cards, one per family (or per style, with grouping off). Rows of
 * cards are virtualized with a fixed height for the preview size (tileGrid.ts), so nothing is
 * measured; two extra rows are drawn above and below. The column count follows the width, and
 * when it changes (or the size does) the first family showing stays at the top. When a reload
 * adds or removes cards above it (a scan filling the library in), the grid scrolls by whole rows
 * so it stays where it was, as Rows and Table do.
 *
 * It's a grid (role="grid", one Tab stop): the grid keeps focus and points at the active card
 * with aria-activedescendant. Left and Right go card by card, Up and Down by line; everything
 * else (selection, opening, menus, drag to tags) is LibraryPane's, as in the other layouts.
 */
export function FontTiles({ view, ...display }: DisplayProps & { view: ListView }) {
  const { rows, actions, activeIndex, reveal, focused, optionId, adapter } = view;
  const { size } = display;
  const scrollRef = useRef<HTMLDivElement>(null);
  // The grid's width inside its padding; null until measured.
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(0, el.clientWidth - 2 * GRID_PADDING));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const columns = tileColumns(width ?? 0, size);
  const stride = rowStride(size);
  const height = tileHeight(size);
  const virtualizer = useVirtualizer({
    count: rowCount(rows.length, columns),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => stride,
    paddingStart: GRID_PADDING,
    paddingEnd: GRID_PADDING - TILE_GAP,
    overscan: 2,
  });
  useKeepFocus(view);

  // The card at the top, by index and by key, kept up to date as the grid scrolls (see
  // scrolledAnchor). It stays at the top when the column count or the card size changes, and
  // where it was when a reload adds or removes cards above it.
  const anchor = useRef<{ index: number; key: string | undefined }>({ index: 0, key: undefined });
  const keyAt = (i: number) => (rows[i] ? rowKey(rows[i]) : undefined);
  const reset = `${view.resetKey}\u0000${view.top}`;
  const shown = useRef({ rows, columns, stride, reset });
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = { rows, columns, stride, reset };
    const resized = before.columns !== columns || before.stride !== stride;
    // Cards have a new height: positions from now on use it.
    if (resized) virtualizer.measure();
    // A new view, search or order goes to the top instead (below).
    if (before.reset !== reset) return;
    const was = anchor.current.index;
    if (before.rows !== rows) {
      const { key } = anchor.current;
      const at = key === undefined ? -1 : rows.findIndex((r) => rowKey(r) === key);
      // Gone: whichever card took its place.
      const index = at >= 0 ? at : Math.min(was, Math.max(0, rows.length - 1));
      anchor.current = { index, key: keyAt(index) };
    }
    if (resized) virtualizer.scrollToOffset(offsetFor(anchor.current.index, columns, stride));
    else if (before.rows !== rows) {
      const shift = reloadShift(was, anchor.current.index, columns, stride);
      if (shift) virtualizer.scrollToOffset((scrollRef.current?.scrollTop ?? 0) + shift);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, columns, stride, reset]);

  // A new view or search starts at the top. (Declared after the effect above, so it wins.)
  useLayoutEffect(() => {
    anchor.current = { index: 0, key: keyAt(0) };
    virtualizer.scrollToOffset(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.resetKey, view.top]);

  // Key commands, keyboard focus and layout switches bring the active card into view, once the
  // grid knows how many cards fit across.
  const revealed = useRef(0);
  const measured = width !== null;
  useEffect(() => {
    if (!measured) return;
    revealed.current = reveal;
    if (reveal && activeIndex >= 0) virtualizer.scrollToIndex(rowOf(activeIndex, columns), { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, measured]);

  const activeRow = activeIndex >= 0 ? rowOf(activeIndex, columns) : -1;
  const activeItem = activeRow >= 0 ? virtualizer.getVirtualItems().find((item) => item.index === activeRow) : undefined;
  const scrollTop = virtualizer.scrollOffset ?? 0;
  const activeOnScreen = activeInSight(activeItem, scrollTop, virtualizer.scrollRect?.height ?? Infinity, reveal !== revealed.current, activeIndex);

  adapter.current = {
    element: scrollRef.current,
    across: columns,
    activeOnScreen,
    pageSize: () => pageItems(scrollRef.current?.clientHeight ?? 0, columns, stride),
    firstOnScreen: () => {
      const first = firstVisibleIndex(scrollRef.current?.scrollTop ?? 0, columns, stride);
      return rows[first] ? rowKey(rows[first]) : undefined;
    },
  };

  return (
    <ContextMenuTrigger
      render={
        <div
          ref={(el) => {
            scrollRef.current = el;
            adapter.current.element = el;
          }}
          {...view.container}
          onScroll={(e) => {
            // Also the scroll a column change makes: the anchor stays while its row is the top one.
            const index = scrolledAnchor(anchor.current.index, e.currentTarget.scrollTop, columns, stride);
            if (index !== anchor.current.index) anchor.current = { index, key: keyAt(index) };
          }}
          className={cn("min-h-0 flex-1 overflow-y-auto", actions.ring && !activeOnScreen ? "outline-2 -outline-offset-2 outline-ring/60" : "outline-none")}
          role="grid"
          aria-label="Fonts"
          aria-rowcount={rowCount(rows.length, columns)}
          aria-colcount={columns}
          aria-activedescendant={focused && activeItem ? optionId(activeIndex) : undefined}
        />
      }
    >
      {/* The height is worked out here rather than asked of the virtualizer, which only learns a
          new card height after this render: a scroll to keep the top card in place would stop
          short at the old height. */}
      <div className="relative" style={{ height: gridHeight(rows.length, columns, stride) }}>
        {measured &&
          virtualizer.getVirtualItems().map((item) => {
            const start = item.index * columns;
            return (
              <div
                key={item.key}
                role="row"
                aria-rowindex={item.index + 1}
                className="absolute top-0 left-0 grid w-full"
                style={{
                  transform: `translateY(${item.start}px)`,
                  height,
                  gap: TILE_GAP,
                  paddingInline: GRID_PADDING,
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                }}
              >
                {rows.slice(start, start + columns).map((row, i) => (
                  <Tile key={rowKey(row)} {...display} actions={actions} row={row} id={optionId(start + i)} column={i + 1} height={height} />
                ))}
              </div>
            );
          })}
      </div>
    </ContextMenuTrigger>
  );
}

type TileProps = DisplayProps & { actions: ListView["actions"]; row: Row; id: string; column: number; height: number };

/** One card: name, style count and on/off; one fitted preview line; places, tags and marks. */
function Tile({ row, actions, id, column, height, previewText, size, busy, locations, onActivate, showAdded }: TileProps) {
  const family: Family = row.family;
  const single = !!family.ungroupedFrom;
  const key = rowKey(row);
  const selected = actions.selection.keys.has(key);
  const active = actions.selection.focus === key;
  const tab = active ? 0 : -1;
  const preview = usePreviewProfile(family.representative.primary);
  const copies = useMemo(() => family.faces.flatMap((f) => f.copies), [family]);
  const variable = family.faces.some((f) => f.primary.variable);
  const mono = family.faces.some((f) => f.primary.monospace);
  const count = family.faces.length;
  const styles = `${count} ${count === 1 ? "style" : "styles"}`;
  const state = summarize(family.faces);
  const label = `${family.name}${single ? "" : `, ${styles}`}${variable ? ", variable" : ""}, ${stateWords(state)}`;
  const added = showAdded ? addedDateText(addedAt(family.faces)) : "";
  const marks = [mono && "Monospaced", family.faces.some((f) => f.copies.length > 1) && "Has duplicate files", added && `Added ${added}`].filter(Boolean).join(". ");
  return (
    <div
      id={id}
      role="gridcell"
      aria-colindex={column}
      aria-selected={selected}
      aria-label={label}
      aria-describedby={describedBy(id, ["state", "marks"])}
      data-row-key={key}
      onClick={(e) => actions.onRowClick(e, key)}
      onDoubleClick={(e) => actions.onRowDoubleClick(e, row)}
      style={{ height }}
      className={cn(
        "group/row flex min-w-0 cursor-default flex-col rounded-lg border px-3 py-3",
        selected ? "border-primary/30 bg-accent" : "bg-card hover:bg-muted/50",
        // Several selected: a stronger edge, since the fill alone is faint.
        selected && actions.selection.keys.size > 1 && "ring-2 ring-primary/70",
        active && actions.ring && "outline-2 outline-offset-2 outline-ring/60",
      )}
    >
      <div className="flex h-7 shrink-0 items-center gap-2">
        <span className="min-w-0 truncate text-sm font-semibold" title={family.name}>
          {family.name}
        </span>
        {!single && <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{count}</span>}
        <span className="flex-1" />
        {/* No tag button on a card (there's no room): tag from the right-click menu (Shift-F10),
            the selection bar, or by dragging onto a tag. */}
        <StateControl
          compact
          state={state}
          single={single}
          label={`Activate ${family.name}`}
          busy={family.switchable.some((face) => face.copies.some((c) => busy.has(c.path)))}
          tabIndex={tab}
          srId={`${id}-state`}
          onSwitch={(on) => onActivate(activationIds(family.switchable, on), on)}
        />
      </div>
      <div className="flex min-h-0 flex-1 items-center overflow-hidden">
        <div className="min-w-0 flex-1">
          <FacePreview font={family.representative.primary} preview={preview} typed={previewText} own={single ? "full" : "family"} size={size} />
        </div>
      </div>
      <div className="flex h-6 shrink-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
        <LocationDots copies={copies} locations={locations} srId={`${id}-places`} />
        <TagDots faces={family.faces} index={actions.index} srId={`${id}-tags`} />
        <span className="flex-1" />
        {added && (
          <span className="shrink-0 truncate" aria-hidden>
            Added {added}
          </span>
        )}
        {variable && <Badge variant="outline">Variable</Badge>}
        {mono && <Badge variant="outline">Mono</Badge>}
        {marks && (
          <span className="sr-only" id={`${id}-marks`}>
            {marks}.
          </span>
        )}
        <SampleBadge profile={preview.profile} row={single ? "full" : "family"} id={`${id}-sample`} />
        <MissingHint text={previewText} profile={preview.profile} srId={`${id}-missing`} />
      </div>
    </div>
  );
}
