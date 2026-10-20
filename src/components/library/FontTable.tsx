import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FontSummary, SortKey } from "@/api";
import {
  addedAt,
  addedDateText,
  designerOf,
  faceAddedAt,
  familySources,
  fileNameOf,
  fileSizeOf,
  formatBytes,
  formatsOf,
  foundryOf,
  shortVersion,
  sourcesOf,
  weightText,
} from "@/familyFacts";
import { stateWords, summarize, type StateSummary } from "@/fontState";
import { activationIds, type Face } from "@/library";
import { usePreviewProfile } from "@/previewProfiles";
import { directionWords, nextSort, sortInfo } from "@/viewOptions";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuLabel, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { LocationDots, TagChips } from "@/tags/TagChips";
import { StateControl, useStateWording } from "../ActivationSwitch";
import { FacePreview, MissingHint, SampleBadge } from "../FacePreview";
import { PREVIEW_BAR_SPACE } from "../PreviewBar";
import { CONTEXT, Tip, TipItem } from "../Tip";
import {
  clampWidth,
  columnDef,
  gridTemplate,
  HEADER_HEIGHT,
  MAX_WIDTH,
  pinnedOffsets,
  resolveColumns,
  setShown,
  setWidth,
  shownColumns,
  tablePreviewSize,
  tableRowHeight,
  totalWidth,
  type Column,
  type ColumnId,
} from "./columns";
import { activeInSight, rowKey, useKeepFocus, type DisplayProps, type ListView, type Row, type TableOptions } from "./LibraryPane";

/** How much Shift+Left or Shift+Right on a column header changes its width, px. */
const RESIZE_STEP = 16;

/**
 * The Table layout: one row per family (styles under an expanded one), in columns that sort,
 * show or hide, and resize. Built from divs with grid roles rather than <table>, since the
 * virtualized rows are absolutely positioned. Rows have a fixed height (columns.ts), so nothing
 * is measured. The header stays at the top, and the on/off and Name columns stay at the left
 * while the table scrolls sideways.
 *
 * It's a treegrid: the grid keeps focus and points at the active row (aria-activedescendant);
 * Right and Left expand and collapse. A row's name is short (name, styles, on/off); what its
 * other columns show is its description ("Foundry: Rasmus Andersson."), since the arrow keys
 * move by row, not into cells. The header row is one Tab stop: Left and Right move between
 * headers, Return or Space sorts (announced), Shift+Left and Shift+Right change the width (also
 * announced). Its right-click menu, and the View options, show and hide columns. The Preview
 * column draws at 12–32px following the preview size; turned off, the table loads no font files.
 *
 * Rows are keyed by family (or style), so a row's controls stay with it when a reload or a new
 * order moves it, and the row at the top stays in place while a scan adds rows above it.
 */
export function FontTable({ view, sort, onSort, columns: saved, onColumns, density, ...display }: DisplayProps & TableOptions & { view: ListView }) {
  const { rows, actions, activeIndex, reveal, focused, optionId, adapter } = view;
  const { size } = display;
  const scrollRef = useRef<HTMLDivElement>(null);
  // A column being dragged: its width shows live and is saved on release.
  const [dragging, setDragging] = useState<{ id: ColumnId; width: number } | null>(null);
  const resolved = useMemo(() => resolveColumns(saved), [saved]);
  const columns = useMemo(
    () => (dragging ? resolved.map((c) => (c.def.id === dragging.id ? { ...c, width: dragging.width } : c)) : resolved),
    [resolved, dragging],
  );
  const shown = shownColumns(columns);
  const template = gridTemplate(columns);
  const width = totalWidth(columns);
  const offsets = pinnedOffsets(columns);
  const previewShown = shown.some((c) => c.def.id === "preview");
  const previewSize = tablePreviewSize(size);
  const rowHeight = tableRowHeight(density, previewShown, previewSize);

  // Changes only with the rows, so the virtualizer works out positions only then.
  const itemKey = useCallback((i: number) => rowKey(rows[i]), [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    // Each row's DOM moves with its family, so a focused switch or chevron keeps acting on the
    // family it names after a reload or a re-sort.
    getItemKey: itemKey,
    // Keep the row at the top of the view in place when rows are added above it, so the table
    // doesn't move under the pointer while a scan fills it in (as Rows does).
    anchorTo: "end",
    // The header sits above the rows inside the scroll area, and covers the top of the view.
    scrollMargin: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
    // Room under the last row, and when a row is scrolled into view, for the preview bar.
    paddingEnd: PREVIEW_BAR_SPACE,
    scrollPaddingEnd: PREVIEW_BAR_SPACE,
    overscan: 8,
  });
  useKeepFocus(view);
  useLayoutEffect(() => {
    virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowHeight]);

  // A new view or search starts at the top. (Declared after the virtualizer so this runs after
  // its scroll anchoring, and wins.)
  useLayoutEffect(() => {
    virtualizer.scrollToOffset(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.resetKey, view.top]);

  const revealed = useRef(0);
  useEffect(() => {
    revealed.current = reveal;
    if (reveal && activeIndex >= 0) virtualizer.scrollToIndex(activeIndex, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  const activeItem = activeIndex >= 0 ? virtualizer.getVirtualItems().find((item) => item.index === activeIndex) : undefined;
  const scrollTop = (virtualizer.scrollOffset ?? 0) + HEADER_HEIGHT;
  const viewHeight = (virtualizer.scrollRect?.height ?? Infinity) - HEADER_HEIGHT;
  const activeOnScreen = activeInSight(activeItem, scrollTop, viewHeight, reveal !== revealed.current, activeIndex);

  adapter.current = {
    element: scrollRef.current,
    across: 1,
    activeOnScreen,
    pageSize: () => Math.max(1, Math.floor(((scrollRef.current?.clientHeight ?? 0) - HEADER_HEIGHT) / rowHeight)),
    firstOnScreen: () => {
      const top = (scrollRef.current?.scrollTop ?? 0) + HEADER_HEIGHT;
      const item = virtualizer.getVirtualItems().find((i) => i.start + i.size / 2 >= top);
      return item ? rowKey(rows[item.index]) : undefined;
    },
  };

  const sortBy = (key: SortKey) => onSort(nextSort(sort, key));
  const hintId = useId();
  const pinStyle = (id: ColumnId): React.CSSProperties | undefined => (offsets.has(id) ? { position: "sticky", left: offsets.get(id), zIndex: 1 } : undefined);
  // A column's new width after Shift+Left or Shift+Right, said aloud.
  const [resized, setResized] = useState("");

  return (
    <>
    {/* What the column headers' keys do (their description); outside the grid, which holds only rows. */}
    <span id={`${hintId}-sorts`} hidden>
      Return sorts by this column. Shift with the Left or Right arrow changes its width. Right-click to show or hide columns.
    </span>
    <span id={`${hintId}-fixed`} hidden>
      This column doesn&rsquo;t sort. Shift with the Left or Right arrow changes its width. Right-click to show or hide columns.
    </span>
    <div className="sr-only" aria-live="polite">
      {resized}
    </div>
    <ContextMenuTrigger
      render={
        <div
          ref={(el) => {
            scrollRef.current = el;
            adapter.current.element = el;
          }}
          {...view.container}
          className={cn("min-h-0 flex-1 overflow-auto", actions.ring && !activeOnScreen ? "outline-2 -outline-offset-2 outline-ring/60" : "outline-none")}
          role="treegrid"
          aria-label="Fonts"
          aria-rowcount={rows.length + 1}
          aria-colcount={shown.length}
          aria-activedescendant={focused && activeItem ? optionId(activeIndex) : undefined}
        />
      }
    >
      <HeaderRow
        hintId={hintId}
        columns={columns}
        template={template}
        width={width}
        sort={sort}
        pinStyle={pinStyle}
        onSort={sortBy}
        onToggle={(id, on) => onColumns(setShown(saved, id, on))}
        onDrag={(id, w) => setDragging({ id, width: w })}
        onResized={(id, w, byKey) => {
          setDragging(null);
          onColumns(setWidth(saved, id, w));
          // The same words again (another press at the narrowest) still change the region, so they're read.
          if (byKey) setResized((said) => (said === widthWords(id, w) ? `${said}\u00A0` : widthWords(id, w)));
        }}
      />
      <div className="relative" style={{ height: virtualizer.getTotalSize(), width, minWidth: "100%" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          return (
            <TableRow
              key={item.key}
              {...display}
              row={row}
              actions={actions}
              id={optionId(item.index)}
              rowIndex={item.index + 2}
              columns={shown}
              template={template}
              height={rowHeight}
              top={item.start - HEADER_HEIGHT}
              previewSize={previewSize}
              pinStyle={pinStyle}
            />
          );
        })}
      </div>
    </ContextMenuTrigger>
    </>
  );
}

interface HeaderProps {
  hintId: string;
  columns: Column[];
  template: string;
  width: number;
  sort: TableOptions["sort"];
  pinStyle: (id: ColumnId) => React.CSSProperties | undefined;
  onSort: (key: SortKey) => void;
  onToggle: (id: ColumnId, shown: boolean) => void;
  onDrag: (id: ColumnId, width: number) => void;
  /** `byKey`: Shift+Left or Shift+Right, so the new width is announced. */
  onResized: (id: ColumnId, width: number, byKey?: boolean) => void;
}

/** "Foundry column, 176 pixels wide", after a keyboard resize (at either end, it says so). */
function widthWords(id: ColumnId, asked: number): string {
  const def = columnDef(id);
  if (!def) return "";
  const width = clampWidth(def, asked);
  const end = width === def.min ? ", as narrow as it goes" : width === MAX_WIDTH ? ", as wide as it goes" : "";
  return `${def.label || def.srLabel} column, ${width} pixels wide${end}`;
}

/** What clicking a sortable column's header does, in its tooltip: sorts by it the usual way
 *  ("Sorts by Date added, newest first", as the announcement says it), or, when it's the sort
 *  already, reverses the order. */
function headerTip(key: SortKey, sort: TableOptions["sort"]): string {
  const words = directionWords(nextSort(sort, key));
  // "A to Z" keeps its capitals; "Newest first" reads on in lowercase.
  const inSentence = /^[A-Z][a-z]/.test(words) ? words.charAt(0).toLowerCase() + words.slice(1) : words;
  return sort.key === key ? `Reverses the order: ${inSentence}` : `Sorts by ${sortInfo(key).label}, ${inSentence}`;
}

/** The header row: sort buttons, resize edges, and a right-click menu to show or hide columns. */
function HeaderRow({ hintId, columns, template, width, sort, pinStyle, onSort, onToggle, onDrag, onResized }: HeaderProps) {
  const shown = shownColumns(columns);
  const rowRef = useRef<HTMLDivElement>(null);
  // The one header in the Tab order: the sorted column's, else Name's.
  const current = shown.find((c) => c.def.sort === sort.key)?.def.id ?? "name";
  const [roving, setRoving] = useState<ColumnId>(current);
  const tabStop = shown.some((c) => c.def.id === roving) ? roving : current;

  const headers = () => [...(rowRef.current?.querySelectorAll<HTMLElement>("[data-header]") ?? [])];
  const onKeyDown = (e: React.KeyboardEvent, column: Column) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        onResized(column.def.id, column.width + (e.key === "ArrowLeft" ? -RESIZE_STEP : RESIZE_STEP), true);
        return;
      }
      const all = headers();
      const at = all.indexOf(e.currentTarget as HTMLElement);
      const next = all[Math.min(all.length - 1, Math.max(0, at + (e.key === "ArrowLeft" ? -1 : 1)))];
      next?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      const all = headers();
      (e.key === "Home" ? all[0] : all[all.length - 1])?.focus();
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            ref={rowRef}
            role="row"
            aria-rowindex={1}
            className="sticky top-0 z-10 grid border-b bg-background text-xs font-medium text-muted-foreground"
            style={{ gridTemplateColumns: template, width, minWidth: "100%", height: HEADER_HEIGHT }}
          />
        }
      >
        {shown.map((column) => {
          const { def } = column;
          const sorted = def.sort !== undefined && def.sort === sort.key;
          return (
            <div
              key={def.id}
              role="columnheader"
              aria-sort={sorted ? (sort.desc ? "descending" : "ascending") : undefined}
              className={cn("relative flex min-w-0 items-center bg-background", def.numeric && "justify-end")}
              style={pinStyle(def.id)}
            >
              {/* A column that doesn't sort says so; its description already does. */}
              <Tip tip={def.sort ? headerTip(def.sort, sort) : "The list can't be sorted by this column"} describe={!!def.sort}>
                <button
                  type="button"
                  data-header
                  tabIndex={def.id === tabStop ? 0 : -1}
                  aria-describedby={def.sort ? `${hintId}-sorts` : `${hintId}-fixed`}
                  aria-label={def.label ? undefined : def.srLabel}
                  onFocus={() => setRoving(def.id)}
                  onClick={() => def.sort && onSort(def.sort)}
                  onKeyDown={(e) => onKeyDown(e, column)}
                  className={cn(
                    "flex h-full min-w-0 flex-1 items-center gap-1 rounded-sm px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
                    def.numeric && "justify-end text-right",
                    def.sort ? "hover:text-foreground" : "cursor-default",
                    sorted && "text-foreground",
                  )}
                >
                  <span className="truncate">{def.label}</span>
                  {sorted && <Icon name={sort.desc ? "arrow_downward" : "arrow_upward"} size={14} />}
                </button>
              </Tip>
              <ResizeEdge column={column} onDrag={onDrag} onResized={onResized} />
            </div>
          );
        })}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <ContextMenuGroup>
          <ContextMenuLabel>Columns</ContextMenuLabel>
          {columns
            .filter((c) => !c.def.pinned)
            .map((c) => (
              <TipItem
                kit={CONTEXT}
                as="CheckboxItem"
                key={c.def.id}
                tip={c.shown ? `Hides the ${c.def.label} column` : `Shows the ${c.def.label} column`}
                checked={c.shown}
                onCheckedChange={(on: boolean) => onToggle(c.def.id, on)}
              >
                {c.def.label}
              </TipItem>
            ))}
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A column's right edge: drag it to change the width. (From the keyboard: Shift with Left or
 *  Right on the header, which its description says.) */
function ResizeEdge({ column, onDrag, onResized }: { column: Column; onDrag: HeaderProps["onDrag"]; onResized: HeaderProps["onResized"] }) {
  return (
    // Hidden from screen readers, like the edge itself: the header says how to resize.
    <Tip tip="Changes this column's width as you drag it" describe={false}>
      <div
        aria-hidden
        className="absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-ring/40"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          const from = e.clientX;
          const start = column.width;
          const at = (x: number) => Math.max(column.def.min, start + x - from);
          const target = e.currentTarget;
          target.setPointerCapture(e.pointerId);
          const move = (ev: PointerEvent) => onDrag(column.def.id, at(ev.clientX));
          const up = (ev: PointerEvent) => {
            target.removeEventListener("pointermove", move);
            target.removeEventListener("pointerup", up);
            target.removeEventListener("pointercancel", up);
            onResized(column.def.id, at(ev.clientX));
          };
          target.addEventListener("pointermove", move);
          target.addEventListener("pointerup", up);
          target.addEventListener("pointercancel", up);
        }}
      />
    </Tip>
  );
}

type RowProps = DisplayProps & {
  row: Row;
  actions: ListView["actions"];
  id: string;
  rowIndex: number;
  columns: Column[];
  template: string;
  height: number;
  top: number;
  previewSize: number;
  pinStyle: (id: ColumnId) => React.CSSProperties | undefined;
};

/** One family or style row. */
function TableRow(props: RowProps) {
  const { row, actions, id, rowIndex, columns, template, height, top, pinStyle, expanded } = props;
  const family = row.family;
  const face = row.kind === "face" ? row.face : undefined;
  const faces = face ? [face] : family.faces;
  const key = rowKey(row);
  const selected = actions.selection.keys.has(key);
  const several = selected && actions.selection.keys.size > 1;
  const active = actions.selection.focus === key;
  const single = !!family.ungroupedFrom;
  const expandable = !face && !single;
  const font = face ? face.primary : family.representative.primary;
  const variable = family.faces.some((f) => f.primary.variable);
  const state = summarize(faces);
  const wording = useStateWording();
  const words = stateWords(state, wording);
  const label = face
    ? `${face.style}${font.variable ? " (Variable)" : ""}, ${face.family}, ${words}`
    : `${family.name}${single ? "" : `, ${family.faces.length} ${family.faces.length === 1 ? "style" : "styles"}`}${variable ? ", variable" : ""}, ${words}`;
  return (
    <div
      id={id}
      role="row"
      aria-rowindex={rowIndex}
      aria-level={face ? 2 : 1}
      aria-expanded={expandable ? expanded.has(family.id) : undefined}
      aria-selected={selected}
      aria-label={label}
      aria-describedby={describedIds(id, columns)}
      data-row-key={key}
      onClick={(e) => actions.onRowClick(e, key)}
      onDoubleClick={(e) => actions.onRowDoubleClick(e, row)}
      className={cn("group/row absolute left-0 grid cursor-default border-b text-sm", selected ? "bg-accent" : "bg-background hover:bg-muted")}
      style={{ transform: `translateY(${top}px)`, height, gridTemplateColumns: template, width: "100%" }}
    >
      {columns.map((c) => (
        <div
          key={c.def.id}
          role="gridcell"
          className={cn(
            "flex min-w-0 items-center overflow-hidden px-2",
            c.def.numeric && "justify-end font-mono text-xs tabular-nums",
            // Pinned cells cover what scrolls under them, in the row's own color.
            c.def.pinned && "bg-inherit",
            // Several rows selected: a bar at the left edge, on the on/off cell, which stays at
            // the left while the table scrolls sideways (and would cover a bar on the row).
            several && c.def.id === "state" && "shadow-[inset_3px_0_0_var(--primary)]",
            // A style row: a rail under its family's chevron, as in Rows.
            face && c.def.id === "name" && "relative before:absolute before:inset-y-0 before:left-5 before:w-px before:bg-border",
          )}
          style={pinStyle(c.def.id)}
        >
          <Cell column={c.def.id} {...props} faces={faces} face={face} font={font} expandable={expandable} active={active} state={state} />
        </div>
      ))}
      {/* The keyboard ring, drawn over the pinned cells (which would cover a ring on the row). */}
      {active && actions.ring && <div aria-hidden className="pointer-events-none absolute inset-0 z-2 outline-2 -outline-offset-2 outline-ring/60" />}
    </div>
  );
}

/**
 * What a row's shown columns say to a screen reader, as ids for its description, in column
 * order: more about its state (on until logout, a lock's reason…), each column's text
 * ("Foundry: Rasmus Andersson."), where its files are, the preview's sample badge and missing
 * characters, and its tags. On or off, Name and Styles are already in the row's name.
 */
function describedIds(id: string, columns: readonly Column[]): string {
  return columns
    .flatMap((c) => {
      switch (c.def.id) {
        case "state":
          return [`${id}-state`];
        case "name":
        case "styles":
          return [];
        case "preview":
          return [`${id}-sample`, `${id}-missing`];
        case "source":
          return [`${id}-places`];
        case "tags":
          return [`${id}-tags`];
        default:
          return [`${id}-${c.def.id}`];
      }
    })
    .join(" ");
}

/** A column's text, with its column's name for screen readers (read as part of the row's
 *  description: "Foundry: Rasmus Andersson."). Nothing when there's no text. */
function Fact({ id, column, text, className, title }: { id: string; column: ColumnId; text: string; className?: string; title?: string }) {
  if (!text) return null;
  return (
    <span id={`${id}-${column}`} className={className} title={title}>
      <span className="sr-only">{columnDef(column)?.label}: </span>
      {text}
      <span className="sr-only">.</span>
    </span>
  );
}

type CellProps = RowProps & { column: ColumnId; faces: Face[]; face: Face | undefined; font: FontSummary; expandable: boolean; active: boolean; state: StateSummary };

function Cell({ column, row, faces, face, font, expandable, active, state, actions, id, previewText, previewSize, busy, locations, onActivate, expanded, onToggleExpanded }: CellProps) {
  const family = row.family;
  const tab = active ? 0 : -1;
  const muted = "truncate text-xs text-muted-foreground";
  const fact = { id, column };
  switch (column) {
    case "state": {
      const switchable = face ? (face.installed ? [] : [face]) : family.switchable;
      return (
        <StateControl
          compact
          state={state}
          single={!!face || !!family.ungroupedFrom}
          label={`Activate ${face ? `${face.family} ${face.style}` : family.name}`}
          busy={switchable.some((f) => f.copies.some((c) => busy.has(c.path)))}
          tabIndex={tab}
          srId={`${id}-state`}
          tipHandle={actions.tips}
          onSwitch={(next, scope) => onActivate(activationIds(switchable, next), next, scope)}
        />
      );
    }
    case "name":
      return (
        // A style's name sits one step (the chevron and its gap) past its family's.
        <span className={cn("flex min-w-0 items-center gap-1", face && "pl-14")}>
          {expandable ? (
            <Tip handle={actions.tips} tip={expanded.has(family.id) ? "Hides this family's styles" : "Lists this family's styles under it"}>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={expanded.has(family.id) ? `Collapse ${family.name}` : `Expand ${family.name}`}
                aria-expanded={expanded.has(family.id)}
                tabIndex={tab}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleExpanded(family.id);
                }}
              >
                <Icon name="chevron_right" size={16} className={cn("transition-transform", expanded.has(family.id) && "rotate-90")} />
              </Button>
            </Tip>
          ) : (
            !face && <span className="size-6 shrink-0" aria-hidden />
          )}
          <span className={cn("truncate", face ? "font-medium" : "font-semibold")} title={face ? face.style : family.name}>
            {face ? face.style : family.name}
          </span>
          {font.variable && face && <span className="shrink-0 text-xs text-muted-foreground">(Variable)</span>}
        </span>
      );
    case "preview":
      return <PreviewCell font={font} own={face || family.ungroupedFrom ? "full" : "family"} family={family.name} typed={previewText} size={previewSize} id={id} />;
    case "styles":
      return face || family.ungroupedFrom ? null : <span>{family.faces.length}</span>;
    case "weights":
      return <Fact {...fact} text={weightText(faces)} className="truncate font-mono text-xs" />;
    case "foundry": {
      const text = face ? (font.manufacturer ?? "") : foundryOf(family);
      return <Fact {...fact} text={text} className={muted} title={text} />;
    }
    case "format":
      return <Fact {...fact} text={formatsOf(faces)} className={muted} />;
    case "source": {
      const copies = faces.flatMap((f) => f.copies);
      // The same places, in the same order, as the Source sort goes by (familySources).
      const names = face ? sourcesOf([face], locations.sourceOf) : familySources(family, locations.sourceOf);
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <LocationDots copies={copies} locations={locations} max={2} srId={`${id}-places`} />
          <span className={muted} title={names.join(", ")}>
            {names[0] ?? ""}
            {names.length > 1 ? ` +${names.length - 1}` : ""}
          </span>
        </span>
      );
    }
    case "added":
      return <Fact {...fact} text={addedDateText(face ? faceAddedAt(face) : addedAt(family.faces))} className={muted} />;
    case "tags":
      return <TagChips faces={faces} index={actions.index} max={2} srId={`${id}-tags`} />;
    case "version": {
      const full = font.version ?? "";
      return <Fact {...fact} text={shortVersion(full)} className={cn(muted, "font-mono")} title={full} />;
    }
    case "designer": {
      const text = face ? (font.designer ?? "") : designerOf(family);
      return <Fact {...fact} text={text} className={muted} title={text} />;
    }
    case "file":
      return <Fact {...fact} text={fileNameOf(font)} className={cn(muted, "font-mono")} title={font.path} />;
    case "size":
      return <Fact {...fact} text={formatBytes(fileSizeOf(faces))} />;
    case "glyphs":
      return <Fact {...fact} text={font.glyphCount.toLocaleString()} />;
  }
}

/** The Preview column: the fitted preview, with the sample badge and "not in this font" hint. */
function PreviewCell({ font, own, family, typed, size, id }: { font: FontSummary; own: "family" | "full"; family: string; typed: string; size: number; id: string }) {
  const preview = usePreviewProfile(font);
  return (
    <span className="flex w-full min-w-0 items-center gap-1.5">
      <span className="min-w-0 flex-1">
        <FacePreview font={font} preview={preview} typed={typed} own={own} size={size} family={family} />
      </span>
      <MissingHint text={typed} profile={preview.profile} srId={`${id}-missing`} />
      <SampleBadge profile={preview.profile} row={own} id={`${id}-sample`} />
    </span>
  );
}
