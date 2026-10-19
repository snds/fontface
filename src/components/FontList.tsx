import { useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { activationIds, type Face, type Family } from "@/library";
import { usePreviewProfile } from "@/previewProfiles";
import { listKeyCommand } from "@/selection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { fontsPayload, pressToDrag } from "@/tags/drag";
import { FontTagMenuItems } from "@/tags/FontMenu";
import { isMenuKey, openMenuFromKeyboard } from "@/tags/menus";
import type { Locations } from "@/tags/locations";
import { uniqueFaces, useTagIndex, type TagIndex } from "@/tags/model";
import { LocationDots, TagChips } from "@/tags/TagChips";
import { TagPicker } from "@/tags/TagPicker";
import { ActivationSwitch, InstalledBadge } from "./ActivationSwitch";
import { CopiesBadge, FacePreview, MissingHint, SampleBadge, stateWords } from "./FacePreview";
import { IS_MAC } from "./TitleBar";
import { useSelection, type SelectionApi } from "./library/useSelection";

type Row = { kind: "family"; family: Family } | { kind: "face"; face: Face; family: Family };

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

/** What App can ask of the list. */
export interface ListHandle {
  /** Focuses the list with this row active (on Back). False if the row isn't listed any more. */
  focusRow: (rowKey: string | null) => boolean;
}

interface Props {
  families: Family[];
  /** Expanded families, by Family.id. */
  expanded: Set<string>;
  onToggleExpanded: (familyId: string) => void;
  previewText: string;
  size: number;
  /** Files with an on/off request in progress. */
  busy: Set<string>;
  /** Changes when the view or search changes; the list then scrolls back to the top. */
  resetKey: string;
  /** The whole library, so tagging a family row covers all its styles, not only those shown. */
  allFamilies: Family[];
  locations: Locations;
  onActivate: (ids: number[], active: boolean) => void;
  /** Double-click or Return: open the row's font page. */
  onOpen: (request: OpenRequest) => void;
  ref?: React.Ref<ListHandle>;
}

/** Presses on these don't start a drag or open the font: the row's own buttons, switches and fields. */
const ROW_CONTROLS = "button, input, textarea, a, [role=switch], [data-no-drag]";

const rowKey = (row: Row) => (row.kind === "family" ? `f:${row.family.id}` : `s:${row.face.key}`);

function openRequest(row: Row): OpenRequest {
  const face = row.kind === "family" ? row.family.representative : row.face;
  return { faceKey: face.key, styleKey: face.key, rowKey: rowKey(row), name: row.family.name };
}

/** What a row-level action works on: the selected rows if this row is one of them, else this row. */
interface RowActions {
  index: TagIndex;
  selection: SelectionApi["selection"];
  targetsFor: (key: string) => Face[];
  onRowClick: (e: React.MouseEvent, key: string) => void;
  onRowDoubleClick: (e: React.MouseEvent, row: Row) => void;
  /** The list has keyboard focus and shows where it is. */
  ring: boolean;
}

/**
 * The Rows layout: families, with the styles of expanded families under them. Only rows on
 * screen exist (virtualized).
 *
 * It's a listbox: the list itself keeps focus and points at the active row with
 * aria-activedescendant, since the active row may be scrolled out of the page. A click selects;
 * a double-click or Return opens the font page; right-click only selects. Arrow keys, Home/End
 * and Page Up/Down move (Shift extends), Space adds or removes a row, Right and Left expand and
 * collapse, Cmd-A selects all and Esc clears. Only the active row's own controls (expand, tags,
 * switch) are in the Tab order, so Tab leaves the list in one step.
 */
export function FontList({ ref, ...props }: Props) {
  const { families, expanded, size, allFamilies } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const index = useTagIndex();

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const family of families) {
      out.push({ kind: "family", family });
      if (expanded.has(family.id)) for (const face of family.faces) out.push({ kind: "face", face, family });
    }
    return out;
  }, [families, expanded]);
  const order = useMemo(() => rows.map(rowKey), [rows]);
  const indexByKey = useMemo(() => new Map(order.map((k, i) => [k, i])), [order]);

  const sel = useSelection(order, props.resetKey);
  const { selection } = sel;
  // The fonts the right-click menu works on, fixed when it opens (a tag view can lose the row
  // while the menu is still open).
  const [menuFaces, setMenuFaces] = useState<Face[]>([]);
  // Keyboard focus shows as a ring on the active row: after a key press, or focus that didn't
  // come from a click (Tab, or Back from a font page).
  const [focused, setFocused] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  /** When the list was last pressed: focus that arrives right after a press came from it. */
  const pressedAt = useRef(-Infinity);
  /** The next focus change came from the keyboard: scroll it into view. */
  const follow = useRef(false);

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
      follow.current = false;
      sel.click(key, { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey });
    },
    onRowDoubleClick: (e, row) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if ((e.target as HTMLElement).closest(ROW_CONTROLS)) return;
      props.onOpen(openRequest(row));
    },
  };

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => Math.round(size * 1.35) + (rows[i].kind === "family" ? 44 : 32),
    getItemKey: (i) => {
      const row = rows[i];
      return row.kind === "family" ? `f:${row.family.id}` : `s:${row.face.key}:${row.family.id}`;
    },
    // Keep the row at the top of the view in place when rows are added above it, so the list
    // doesn't jump while a scan fills it in.
    anchorTo: "end",
    overscan: 6,
  });

  // A new view or search starts at the top. (Declared after the virtualizer so this runs
  // after its scroll anchoring, and wins.)
  useLayoutEffect(() => {
    virtualizer.scrollToOffset(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.resetKey]);

  const activeIndex = selection.focus === null ? -1 : (indexByKey.get(selection.focus) ?? -1);
  // Keyboard moves bring the active row into view (clicks don't scroll the list).
  useEffect(() => {
    if (!follow.current) return;
    follow.current = false;
    if (activeIndex >= 0) virtualizer.scrollToIndex(activeIndex, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.focus, activeIndex]);

  useImperativeHandle(
    ref,
    () => ({
      focusRow: (key) => {
        const at = key === null ? undefined : indexByKey.get(key);
        if (key !== null && at !== undefined) {
          sel.focus(key, false);
          virtualizer.scrollToIndex(at, { align: "auto" });
        }
        scrollRef.current?.focus({ preventScroll: true });
        return at !== undefined;
      },
    }),
    [indexByKey, sel, virtualizer],
  );

  const optionId = (i: number) => `${listId}-row-${i}`;
  const activeRendered = activeIndex >= 0 && virtualizer.getVirtualItems().some((item) => item.index === activeIndex);

  const pageSize = () => Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / (Math.round(size * 1.35) + 44)));

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Keys from popovers (portaled, but React still passes their events up) and text fields
    // aren't meant for the list.
    const target = e.target as HTMLElement;
    if (!e.currentTarget.contains(target) || target.closest("input, textarea")) return;
    setKeyboard(true);
    const onList = target === e.currentTarget;
    if (isMenuKey(e)) {
      // The list has focus, not a row: open the menu for the active row.
      openMenuFromKeyboard(e, onList && activeRendered ? document.getElementById(optionId(activeIndex)) : null);
      return;
    }
    const command = listKeyCommand(e, IS_MAC);
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
    // The active row's own controls (a switch, the expand button) keep their keys.
    if (!onList) return;
    e.preventDefault();
    const row = activeIndex >= 0 ? rows[activeIndex] : undefined;
    switch (command.kind) {
      case "move":
        follow.current = true;
        sel.move(command.move, { extend: command.extend, pageSize: pageSize() });
        break;
      case "toggle":
        sel.toggle();
        break;
      case "open":
        if (row) props.onOpen(openRequest(row));
        break;
      case "expand":
        if (row?.kind !== "family") break;
        if (!expanded.has(row.family.id)) props.onToggleExpanded(row.family.id);
        else if (row.family.faces.length) {
          // Already open: on to its first style.
          follow.current = true;
          sel.focus(`s:${row.family.faces[0].key}`, true);
        }
        break;
      case "collapse":
        if (row?.kind === "face") {
          follow.current = true;
          sel.focus(`f:${row.family.id}`, true);
        } else if (row && expanded.has(row.family.id)) props.onToggleExpanded(row.family.id);
        break;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {selection.keys.size > 1 && <BulkBar faces={selectedFaces} rows={selection.keys.size} onClear={sel.clear} />}
      {/* Always present, so the first count is announced too. */}
      <div className="sr-only" aria-live="polite">
        {selection.keys.size > 1 ? `${selection.keys.size} rows selected` : ""}
      </div>
      {/* One right-click menu for the whole list; the row under the pointer decides what it covers. */}
      <ContextMenu
        onOpenChange={(open) => {
          if (!open) setMenuFaces([]);
        }}
      >
        <ContextMenuTrigger
          render={
            <div
              ref={scrollRef}
              className="min-h-0 flex-1 overflow-y-auto outline-none"
              role="listbox"
              aria-label="Fonts"
              aria-multiselectable
              aria-activedescendant={focused && activeRendered ? optionId(activeIndex) : undefined}
              tabIndex={0}
              onKeyDown={onKeyDown}
              onMouseDown={() => {
                pressedAt.current = performance.now();
                setKeyboard(false);
              }}
              onFocus={(e) => {
                if (e.target !== e.currentTarget) return;
                setFocused(true);
                setKeyboard(performance.now() - pressedAt.current > 300);
                sel.ensureFocus();
              }}
              onBlur={(e) => {
                if (e.target === e.currentTarget) setFocused(false);
              }}
              onPointerDown={(e) => {
                // Drag rows onto a tag in the sidebar to tag them.
                const key = (e.target as HTMLElement).closest<HTMLElement>("[data-row-key]")?.dataset.rowKey;
                if (key) pressToDrag(e, () => fontsPayload(targetsFor(key)), ROW_CONTROLS);
              }}
              onContextMenuCapture={(e) => {
                // A right-click inside a row's tag popover keeps the normal menu (Paste, say).
                if (!e.currentTarget.contains(e.target as Node)) {
                  e.stopPropagation();
                  return;
                }
                const el = (e.target as HTMLElement).closest<HTMLElement>("[data-row-key]");
                const key = el?.dataset.rowKey ?? null;
                setMenuFaces(key ? targetsFor(key) : []);
                // Right-clicking outside the selection selects that row, like Finder. It never opens the font.
                if (key) sel.selectForMenu(key);
              }}
            />
          }
        >
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              const rowProps = { ...props, actions, row, id: optionId(item.index), position: item.index + 1, count: rows.length };
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  data-row-key={rowKey(row)}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {row.kind === "family" ? <FamilyRow {...rowProps} family={row.family} /> : <FaceRow {...rowProps} face={row.face} />}
                </div>
              );
            })}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="max-h-[min(28rem,var(--available-height))] min-w-56">
          {menuFaces.length ? <FontTagMenuItems faces={menuFaces} index={index} /> : <ContextMenuItem disabled>Right-click a font to tag it</ContextMenuItem>}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

/** Shown while several rows are selected: tag them all at once. */
function BulkBar({ faces, rows, onClear }: { faces: Face[]; rows: number; onClear: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-sm" role="region" aria-label="Selection">
      <span className="flex-1">
        {rows.toLocaleString()} rows selected · {faces.length.toLocaleString()} {faces.length === 1 ? "style" : "styles"}
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

/** The tag button on a row (shown on hover or focus): tags the row, or the selection it's in. */
function RowTagButton({ rowKey: key, actions, label, tabIndex }: { rowKey: string; actions: RowActions; label: string; tabIndex: number }) {
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
            className={cn("opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100", open && "opacity-100")}
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

const rowClass = (selected: boolean, inSelection: boolean, ring: boolean) =>
  cn(
    "group/row cursor-default border-b px-4 pt-2.5 pb-3",
    selected ? "bg-accent" : "hover:bg-muted/50",
    // Several rows selected: a bar at the left edge, since the highlight alone is faint.
    inSelection && "shadow-[inset_3px_0_0_var(--primary)]",
    ring && "outline-2 -outline-offset-2 outline-ring/60",
  );

type RowProps = Omit<Props, "ref"> & { actions: RowActions; id: string; position: number; count: number };

/** The option's own attributes and handlers. */
function optionProps({ actions, id, position, count }: RowProps, row: Row, label: string) {
  const key = rowKey(row);
  const selected = actions.selection.keys.has(key);
  const active = actions.selection.focus === key;
  return {
    selected,
    active,
    attrs: {
      id,
      role: "option" as const,
      "aria-selected": selected,
      "aria-setsize": count,
      "aria-posinset": position,
      "aria-label": label,
      className: rowClass(selected, selected && actions.selection.keys.size > 1, active && actions.ring),
      onClick: (e: React.MouseEvent) => actions.onRowClick(e, key),
      onDoubleClick: (e: React.MouseEvent) => actions.onRowDoubleClick(e, row),
    },
  };
}

function FamilyRow(props: RowProps & { family: Family; row: Row }) {
  const { family, row, expanded, onToggleExpanded, previewText, size, busy, locations, onActivate, actions } = props;
  const isOpen = expanded.has(family.id);
  const duplicates = family.faces.some((f) => f.copies.length > 1);
  const key = rowKey(row);
  const copies = useMemo(() => family.faces.flatMap((f) => f.copies), [family]);
  const preview = usePreviewProfile(family.representative.primary);
  const variable = family.faces.some((f) => f.primary.variable);
  const styles = `${family.faces.length} ${family.faces.length === 1 ? "style" : "styles"}`;
  const label = `${family.name}, ${styles}${variable ? ", variable" : ""}, ${stateWords(family.activeCount, family.switchable.length, family.faces.length)}`;
  const { active, attrs } = optionProps(props, row, label);
  const tab = active ? 0 : -1;
  return (
    <div {...attrs}>
      <div className="mb-1 flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={isOpen ? `Collapse ${family.name}` : `Expand ${family.name}`}
          aria-expanded={isOpen}
          tabIndex={tab}
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpanded(family.id);
          }}
        >
          <Icon name="chevron_right" size={18} className={cn("transition-transform", isOpen && "rotate-90")} />
        </Button>
        <span className="truncate text-sm font-semibold">{family.name}</span>
        <LocationDots copies={copies} locations={locations} />
        <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
          <span className="shrink-0">{styles}</span>
          {variable && <Badge variant="outline">Variable</Badge>}
          {family.faces.some((f) => f.primary.monospace) && <Badge variant="outline">Mono</Badge>}
          {duplicates && <Badge variant="outline">Duplicates</Badge>}
          <SampleBadge profile={preview.profile} row="family" />
          <MissingHint text={previewText} profile={preview.profile} />
          <TagChips faces={family.faces} index={actions.index} />
        </span>
        <RowTagButton rowKey={key} actions={actions} label={family.name} tabIndex={tab} />
        {family.switchable.length === 0 ? (
          <InstalledBadge />
        ) : (
          <ActivationSwitch
            active={family.activeCount}
            total={family.switchable.length}
            label={`Activate ${family.name}`}
            busy={family.switchable.some((face) => face.copies.some((c) => busy.has(c.path)))}
            tabIndex={tab}
            onChange={(on) => onActivate(activationIds(family.switchable, on), on)}
          />
        )}
      </div>
      <div className="pl-8">
        <FacePreview font={family.representative.primary} preview={preview} typed={previewText} own="family" size={size} />
      </div>
    </div>
  );
}

function FaceRow(props: RowProps & { face: Face; row: Row }) {
  const { face, row, previewText, size, busy, locations, onActivate, actions } = props;
  const font = face.primary;
  const preview = usePreviewProfile(font);
  const key = rowKey(row);
  const style = `${font.subfamily}${font.variable ? " (Variable)" : ""}`;
  const label = `${style}, ${font.family}, ${face.installed ? "always on (installed)" : face.active ? "on" : "off"}`;
  const { active, attrs } = optionProps(props, row, label);
  const tab = active ? 0 : -1;
  return (
    <div {...attrs} className={cn(attrs.className, "pl-12")}>
      <div className="mb-1 flex items-center gap-2">
        <span className="truncate text-sm font-medium">
          {font.subfamily}
          {font.variable && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(Variable)</span>}
        </span>
        <LocationDots copies={face.copies} locations={locations} />
        <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden font-mono text-xs text-muted-foreground">
          <span className="shrink-0">
            {font.weight}
            {font.italic ? " · italic" : ""}
          </span>
          <CopiesBadge face={face} />
          <span className="flex items-center gap-1.5 font-sans">
            <SampleBadge profile={preview.profile} row="full" />
            <MissingHint text={previewText} profile={preview.profile} />
          </span>
          <span className="font-sans">
            <TagChips faces={[face]} index={actions.index} />
          </span>
        </span>
        <RowTagButton rowKey={key} actions={actions} label={`${font.family} ${font.subfamily}`} tabIndex={tab} />
        {face.installed ? (
          <InstalledBadge />
        ) : (
          <ActivationSwitch
            active={face.active ? 1 : 0}
            total={1}
            label={`Activate ${font.family} ${font.subfamily}`}
            busy={face.copies.some((c) => busy.has(c.path))}
            tabIndex={tab}
            onChange={(on) => onActivate(activationIds([face], on), on)}
          />
        )}
      </div>
      <FacePreview font={font} preview={preview} typed={previewText} own="full" size={size} />
    </div>
  );
}
