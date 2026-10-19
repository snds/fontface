import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { addedAt, addedDateText, faceAddedAt } from "@/familyFacts";
import { stateWords, summarize } from "@/fontState";
import { activationIds, type Face, type Family } from "@/library";
import { usePreviewProfile } from "@/previewProfiles";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextMenuTrigger } from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { LocationDots, TagChips } from "@/tags/TagChips";
import { StateControl, useStateWording } from "./ActivationSwitch";
import { CopiesBadge, FacePreview, MissingHint, SampleBadge } from "./FacePreview";
import { activeInSight, describedBy, rowKey, RowTagButton, useKeepFocus, type DisplayProps, type ListView, type Row } from "./library/LibraryPane";

/**
 * The Rows layout: families, with the styles of expanded families under them. Only rows on
 * screen exist (virtualized, measured as they draw). It's a listbox: the list itself keeps focus
 * and points at the active row with aria-activedescendant (see LibraryPane, which owns the
 * selection, keyboard and menus for every layout). Only the active row's own controls (expand,
 * tags, switch) are in the Tab order, so Tab leaves the list in one step.
 */
export function FontList({ view, ...display }: DisplayProps & { view: ListView }) {
  const { rows, actions, activeIndex, reveal, focused, optionId, adapter } = view;
  const { size } = display;
  const scrollRef = useRef<HTMLDivElement>(null);

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
  // A focused switch or button whose row scrolls out of the drawn ones hands focus back to the list.
  useKeepFocus(view);

  // A new view or search, or a new order with nothing active, starts at the top. (Declared
  // after the virtualizer so this runs after its scroll anchoring, and wins.)
  useLayoutEffect(() => {
    virtualizer.scrollToOffset(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.resetKey, view.top]);

  // Key commands, keyboard focus and layout switches bring the active row into view (clicks
  // don't scroll the list). Only when asked: later changes to where the row is never scroll by
  // themselves.
  const revealed = useRef(0);
  useEffect(() => {
    revealed.current = reveal;
    if (reveal && activeIndex >= 0) virtualizer.scrollToIndex(activeIndex, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  const activeItem = activeIndex >= 0 ? virtualizer.getVirtualItems().find((item) => item.index === activeIndex) : undefined;
  // Drawn (rows just past the edges are too) and in sight. Up to date whenever the virtualizer
  // renders (its range changes, or a scroll starts or ends).
  const scrollTop = virtualizer.scrollOffset ?? 0;
  const activeOnScreen = activeInSight(activeItem, scrollTop, virtualizer.scrollRect?.height ?? Infinity, reveal !== revealed.current, activeIndex);

  adapter.current = {
    element: scrollRef.current,
    across: 1,
    activeOnScreen,
    pageSize: () => Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / (Math.round(size * 1.35) + 44))),
    firstOnScreen: () => {
      const top = scrollRef.current?.scrollTop ?? 0;
      const item = virtualizer.getVirtualItems().find((i) => i.start + i.size / 2 >= top);
      return item ? rowKey(rows[item.index]) : undefined;
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
          // Keyboard focus shows on the active row; while that row is out of sight, on the list itself.
          className={cn("min-h-0 flex-1 overflow-y-auto", actions.ring && !activeOnScreen ? "outline-2 -outline-offset-2 outline-ring/60" : "outline-none")}
          role="listbox"
          aria-label="Fonts"
          aria-activedescendant={focused && activeItem ? optionId(activeIndex) : undefined}
        />
      }
    >
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          const rowProps = { ...display, actions, row, id: optionId(item.index), position: item.index + 1, count: rows.length };
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

type RowProps = DisplayProps & { actions: ListView["actions"]; row: Row; id: string; position: number; count: number };

/** The option's own attributes and handlers. Its name is short (name, styles, on/off), so the
 *  arrow keys move quickly; the rest of what the row shows is its description. */
function optionProps({ actions, id, position, count, row }: RowProps, label: string, description: string) {
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
      "aria-describedby": description,
      className: rowClass(selected, selected && actions.selection.keys.size > 1, active && actions.ring),
      onClick: (e: React.MouseEvent) => actions.onRowClick(e, key),
      onDoubleClick: (e: React.MouseEvent) => actions.onRowDoubleClick(e, row),
    },
  };
}

function FamilyRow(props: RowProps & { family: Family }) {
  const { family, row, expanded, onToggleExpanded, previewText, size, busy, locations, onActivate, actions, showAdded } = props;
  // "Group styles into families" off: one style on its own, named "Family Style".
  const single = !!family.ungroupedFrom;
  const isOpen = expanded.has(family.id);
  const duplicates = family.faces.some((f) => f.copies.length > 1);
  const key = rowKey(row);
  const copies = useMemo(() => family.faces.flatMap((f) => f.copies), [family]);
  const preview = usePreviewProfile(family.representative.primary);
  const variable = family.faces.some((f) => f.primary.variable);
  const styles = `${family.faces.length} ${family.faces.length === 1 ? "style" : "styles"}`;
  const mono = family.faces.some((f) => f.primary.monospace);
  const state = summarize(family.faces);
  const wording = useStateWording();
  const label = `${family.name}${single ? "" : `, ${styles}`}${variable ? ", variable" : ""}, ${stateWords(state, wording)}`;
  const added = showAdded ? addedDateText(addedAt(family.faces)) : "";
  const marks = [mono && "Monospaced", duplicates && "Has duplicate files", added && `Added ${added}`].filter(Boolean).join(". ");
  const { active, attrs } = optionProps(props, label, describedBy(props.id, ["state", "marks"]));
  const tab = active ? 0 : -1;
  return (
    <div {...attrs}>
      <div className="mb-1 flex items-center gap-2">
        {single ? (
          // Lines the name up with family rows' names.
          <span className="size-6 shrink-0" aria-hidden />
        ) : (
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
        )}
        <span className="truncate text-sm font-semibold">{family.name}</span>
        <LocationDots copies={copies} locations={locations} srId={`${props.id}-places`} />
        <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
          {single ? (
            <span className="shrink-0 font-mono">
              {/* As the Table's Weights column and the Weight sort have it (familyGroups.traitsOf). */}
              {family.representative.traits.weight}
              {family.representative.traits.italic ? " · italic" : ""}
            </span>
          ) : (
            <span className="shrink-0">{styles}</span>
          )}
          {added && (
            <span className="shrink-0" aria-hidden>
              Added {added}
            </span>
          )}
          {variable && <Badge variant="outline">Variable</Badge>}
          {mono && <Badge variant="outline">Mono</Badge>}
          {duplicates && (single ? <CopiesBadge face={family.faces[0]} /> : <Badge variant="outline">Duplicates</Badge>)}
          {marks && (
            <span className="sr-only" id={`${props.id}-marks`}>
              {marks}.
            </span>
          )}
          <SampleBadge profile={preview.profile} row={single ? "full" : "family"} id={`${props.id}-sample`} />
          <MissingHint text={previewText} profile={preview.profile} srId={`${props.id}-missing`} />
          <TagChips faces={family.faces} index={actions.index} srId={`${props.id}-tags`} />
        </span>
        <RowTagButton rowKey={key} actions={actions} label={family.name} tabIndex={tab} />
        <StateControl
          state={state}
          single={single}
          label={`Activate ${family.name}`}
          busy={family.switchable.some((face) => face.copies.some((c) => busy.has(c.path)))}
          tabIndex={tab}
          srId={`${props.id}-state`}
          onSwitch={(on, scope) => onActivate(activationIds(family.switchable, on), on, scope)}
        />
      </div>
      <div className="pl-8">
        <FacePreview font={family.representative.primary} preview={preview} typed={previewText} own={single ? "full" : "family"} size={size} family={family.name} />
      </div>
    </div>
  );
}

function FaceRow(props: RowProps & { face: Face }) {
  const { face, row, previewText, size, busy, locations, onActivate, actions, showAdded } = props;
  const font = face.primary;
  const preview = usePreviewProfile(font);
  const key = rowKey(row);
  // Its style in the family it's listed under (grouping by name may have worked it out).
  const style = `${face.style}${font.variable ? " (Variable)" : ""}`;
  const state = summarize([face]);
  const wording = useStateWording();
  const label = `${style}, ${face.family}, ${stateWords(state, wording)}`;
  const added = showAdded ? addedDateText(faceAddedAt(face)) : "";
  const { active, attrs } = optionProps(props, label, describedBy(props.id, ["state", "copies", "added"]));
  const tab = active ? 0 : -1;
  return (
    <div {...attrs} className={cn(attrs.className, "pl-12")}>
      <div className="mb-1 flex items-center gap-2">
        <span className="truncate text-sm font-medium">
          {face.style}
          {font.variable && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(Variable)</span>}
        </span>
        <LocationDots copies={face.copies} locations={locations} srId={`${props.id}-places`} />
        <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden font-mono text-xs text-muted-foreground">
          <span className="shrink-0">
            {font.weight}
            {font.italic ? " · italic" : ""}
          </span>
          {added && (
            <span className="shrink-0 font-sans" id={`${props.id}-added`}>
              Added {added}
            </span>
          )}
          <CopiesBadge face={face} srId={`${props.id}-copies`} />
          <span className="flex items-center gap-1.5 font-sans">
            <SampleBadge profile={preview.profile} row="full" id={`${props.id}-sample`} />
            <MissingHint text={previewText} profile={preview.profile} srId={`${props.id}-missing`} />
          </span>
          <span className="font-sans">
            <TagChips faces={[face]} index={actions.index} srId={`${props.id}-tags`} />
          </span>
        </span>
        <RowTagButton rowKey={key} actions={actions} label={`${face.family} ${face.style}`} tabIndex={tab} />
        <StateControl
          state={state}
          single
          label={`Activate ${face.family} ${face.style}`}
          busy={face.copies.some((c) => busy.has(c.path))}
          tabIndex={tab}
          srId={`${props.id}-state`}
          onSwitch={(on, scope) => onActivate(activationIds([face], on), on, scope)}
        />
      </div>
      <FacePreview font={font} preview={preview} typed={previewText} own="full" size={size} />
    </div>
  );
}
