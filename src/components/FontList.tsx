import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FontSummary, PreviewInfo } from "@/api";
import { activationIds, type Face, type Family } from "@/library";
import { faceName, useFontFace } from "@/fontLoader";
import { isSampleKind, kindFor, missingCharacters, usePreviewProfile, type ProfileState } from "@/previewProfiles";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { fontsPayload, pressToDrag } from "@/tags/drag";
import { FontTagMenuItems } from "@/tags/FontMenu";
import { openMenuFromKeyboard } from "@/tags/menus";
import type { Locations } from "@/tags/locations";
import { uniqueFaces, useTagIndex, type TagIndex } from "@/tags/model";
import { LocationDots, TagChips } from "@/tags/TagChips";
import { TagPicker } from "@/tags/TagPicker";
import { ActivationSwitch, InstalledBadge } from "./ActivationSwitch";
import { PreviewText } from "./PreviewText";

type Row = { kind: "family"; family: Family } | { kind: "face"; face: Face };

interface Props {
  families: Family[];
  expanded: Set<string>;
  onToggleExpanded: (name: string) => void;
  previewText: string;
  size: number;
  selectedId: number | undefined;
  /** Files with an on/off request in progress. */
  busy: Set<string>;
  /** Changes when the view or search changes; the list then scrolls back to the top. */
  resetKey: string;
  /** The whole library, so tagging a family row covers all its styles, not only those shown. */
  allFamilies: Family[];
  locations: Locations;
  onSelect: (id: number) => void;
  onActivate: (ids: number[], active: boolean) => void;
}

/** Presses on these don't start a drag: the row's own buttons, switches and fields. */
const ROW_CONTROLS = "button, input, textarea, a, [role=switch], [data-no-drag]";

const rowKey = (row: Row) => (row.kind === "family" ? `f:${row.family.name}` : `s:${row.face.key}`);

/** What a row-level action works on: the selected rows if this row is one of them, else this row. */
interface RowActions {
  index: TagIndex;
  selection: Set<string>;
  facesOf: (keys: Iterable<string>) => Face[];
  targetsFor: (key: string) => Face[];
  onRowClick: (e: React.MouseEvent, i: number, id: number) => void;
}

export function FontList(props: Props) {
  const { families, expanded, size, allFamilies } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const index = useTagIndex();

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const family of families) {
      out.push({ kind: "family", family });
      if (expanded.has(family.name)) for (const face of family.faces) out.push({ kind: "face", face });
    }
    return out;
  }, [families, expanded]);

  // ---------------------------------------------------------------- selection
  // Click selects one row; Cmd/Ctrl-click adds or removes a row; Shift-click selects a range.
  // Rows are remembered by key, so expanding a family or a reload doesn't shift the selection.
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  // The fonts the right-click menu works on, fixed when it opens (a tag view can lose the row
  // while the menu is still open).
  const [menuFaces, setMenuFaces] = useState<Face[]>([]);

  const fullFamily = useMemo(() => new Map(allFamilies.map((f) => [f.name, f])), [allFamilies]);
  const rowByKey = useMemo(() => new Map(rows.map((r) => [rowKey(r), r])), [rows]);
  // Rows that leave the list (a new filter, a collapsed family) leave the selection for good.
  useEffect(() => {
    setSelection((s) => {
      const next = new Set([...s].filter((k) => rowByKey.has(k)));
      return next.size === s.size ? s : next;
    });
  }, [rowByKey]);
  const live = selection;
  const facesOf = (keys: Iterable<string>): Face[] => {
    const out: Face[] = [];
    for (const key of keys) {
      const row = rowByKey.get(key);
      if (!row) continue;
      if (row.kind === "face") out.push(row.face);
      else out.push(...(fullFamily.get(row.family.name) ?? row.family).faces);
    }
    return uniqueFaces(out);
  };
  const targetsFor = (key: string) => facesOf(live.has(key) && live.size > 1 ? live : [key]);

  /** Rows highlighted because their font is open in the detail panel. */
  const shownKeys = () =>
    props.selectedId === undefined
      ? []
      : rows
          .filter((r) => (r.kind === "family" ? r.family.faces : [r.face]).some((f) => f.copies.some((c) => c.id === props.selectedId)))
          .map(rowKey);

  const onRowClick = (e: React.MouseEvent, i: number, id: number) => {
    const key = rowKey(rows[i]);
    if (e.metaKey || e.ctrlKey) {
      // Start from what looks selected, including the row shown in the detail panel.
      setSelection((s) => {
        const next = new Set(s.size ? s : shownKeys());
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      anchor.current = key;
      return;
    }
    const from = anchor.current === null ? -1 : rows.findIndex((r) => rowKey(r) === anchor.current);
    if (e.shiftKey && from >= 0) {
      setSelection(new Set(rows.slice(Math.min(from, i), Math.max(from, i) + 1).map(rowKey)));
      return;
    }
    setSelection(new Set([key]));
    anchor.current = key;
    props.onSelect(id);
  };

  // A new view or search starts with nothing selected.
  useLayoutEffect(() => {
    setSelection(new Set());
    anchor.current = null;
  }, [props.resetKey]);
  const selectedFaces = useMemo(() => (live.size > 1 ? facesOf(live) : []), [live, rowByKey, fullFamily]); // eslint-disable-line react-hooks/exhaustive-deps

  const actions: RowActions = { index, selection: live, facesOf, targetsFor, onRowClick };

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => Math.round(size * 1.35) + (rows[i].kind === "family" ? 44 : 32),
    getItemKey: (i) => {
      const row = rows[i];
      return row.kind === "family" ? `f:${row.family.name}` : `s:${row.face.key}:${row.face.primary.family}`;
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

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Keys from popovers (portaled, but React still passes their events up) and text fields
    // aren't meant for the list.
    const target = e.target as HTMLElement;
    if (!e.currentTarget.contains(target) || target.closest("input, textarea")) return;
    if (openMenuFromKeyboard(e)) return;
    if (e.key === "Escape" && live.size) {
      e.preventDefault();
      setSelection(new Set());
    } else if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setSelection(new Set(rows.map(rowKey)));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {live.size > 1 && <BulkBar faces={selectedFaces} rows={live.size} onClear={() => setSelection(new Set())} />}
      {/* Always present, so the first count is announced too. */}
      <div className="sr-only" aria-live="polite">
        {live.size > 1 ? `${live.size} rows selected` : ""}
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
              className="min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
              role="list"
              aria-label="Fonts"
              tabIndex={0}
              onKeyDown={onKeyDown}
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
                // Right-clicking outside the selection selects that row, like Finder.
                if (key && !live.has(key)) {
                  setSelection(new Set([key]));
                  anchor.current = key;
                  const row = rowByKey.get(key);
                  if (row) props.onSelect(row.kind === "family" ? row.family.representative.primary.id : row.face.primary.id);
                }
              }}
            />
          }
        >
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  data-row-key={rowKey(row)}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {row.kind === "family" ? (
                    <FamilyRow {...props} actions={actions} rowIndex={item.index} family={row.family} />
                  ) : (
                    <FaceRow {...props} actions={actions} rowIndex={item.index} face={row.face} />
                  )}
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
function RowTagButton({ rowKey: key, actions, label }: { rowKey: string; actions: RowActions; label: string }) {
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

const UNAVAILABLE: Record<string, { icon: string; text: string }> = {
  error: { icon: "error", text: "Preview unavailable" },
  cloud: { icon: "cloud_download", text: "Not downloaded yet: it's online-only in cloud storage" },
  "too-large": { icon: "data_usage", text: "Too large to preview" },
};

/** How long a preview waits for its profile before drawing the name anyway. */
const PROFILE_WAIT_MS = 300;

/**
 * A row's preview: the typed text, else the profile's text (the name, tidied, or a sample of
 * the font's real characters), else the name. Hidden until the font has loaded and the profile
 * is known (or 300 ms have passed), then fitted so nothing is clipped.
 */
function Preview({ font, preview, typed, own, size }: { font: FontSummary; preview: ProfileState; typed: string; own: "family" | "full"; size: number }) {
  const state = useFontFace(font);
  const { profile, pending } = preview;
  const face = faceName(font);
  // The wait belongs to one face: a row that starts showing another font waits afresh.
  const [waitedFor, setWaitedFor] = useState<string>();
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setWaitedFor(face), PROFILE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [pending, face]);
  const waited = waitedFor === face;
  const unavailable = UNAVAILABLE[state];
  if (unavailable) {
    return (
      <div className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground italic">
        <Icon name={unavailable.icon} size={14} />
        {unavailable.text}
      </div>
    );
  }
  const name = own === "family" ? font.family : font.fullName || `${font.family} ${font.subfamily}`;
  const profileText = own === "family" ? profile?.familyText : profile?.fullText;
  return (
    <PreviewText
      fontFamily={`"${face}"`}
      face={face}
      text={typed || profileText || name}
      size={size}
      ready={state === "ready" && (!pending || waited)}
      profile={profile}
      ownText={!typed && !!profile}
      sample={!typed && isSampleKind(profile, own)}
    />
  );
}

/** "Symbols", "Expert set", a script name or "Partial set", for rows previewed by a sample.
 *  `row`: a family row goes by the family name, a style row by its full name. */
function SampleBadge({ profile, row }: { profile: PreviewInfo | undefined; row: "family" | "full" }) {
  if (!isSampleKind(profile, row) || !profile?.label) return null;
  const why =
    kindFor(profile, row) === "expert"
      ? "An expert set: extra characters (fractions, ligatures, small capitals and the like) that go with another font. This shows the characters it has."
      : "This font can't draw its name, so this shows characters it does have.";
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="shrink-0" onClick={(e) => e.stopPropagation()} />}>
        <Badge variant="outline" className="text-muted-foreground">
          {profile.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{why}</TooltipContent>
    </Tooltip>
  );
}

/** Shown when the typed preview text uses characters this font doesn't have. */
function MissingHint({ text, profile }: { text: string; profile: PreviewInfo | undefined }) {
  const missing = missingCharacters(text, profile);
  if (!missing.length) return null;
  const list = missing.join(" ");
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0 items-center text-muted-foreground" onClick={(e) => e.stopPropagation()} />}>
        <Icon name="font_download_off" size={14} />
        <span className="sr-only">Not in this font: {list}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        Not in this font: {list}. Those characters show in another font, or as boxes or blanks.
      </TooltipContent>
    </Tooltip>
  );
}

const rowClass = (selected: boolean, inSelection = false) =>
  cn(
    "group/row cursor-default border-b px-4 pt-2.5 pb-3",
    selected ? "bg-accent" : "hover:bg-muted/50",
    // Several rows selected: a bar at the left edge, since the highlight alone is faint.
    inSelection && "shadow-[inset_3px_0_0_var(--primary)]",
  );

/** "×3" badge for a face that exists as several files; hover lists where. */
function CopiesBadge({ face }: { face: Face }) {
  if (face.copies.length < 2) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span onClick={(e) => e.stopPropagation()} />}>
        <Badge variant="outline" className="font-mono">×{face.copies.length}</Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-md">
        <div className="mb-1 font-medium">{face.copies.length} copies of this font</div>
        {face.copies.map((c) => (
          <div key={c.id} className="truncate font-mono text-[11px]">{c.path}</div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

type RowProps = Props & { actions: RowActions; rowIndex: number };

/** Selected rows: the selection when there is one, otherwise the row shown in the detail panel. */
function isSelected(key: string, actions: RowActions, fallback: boolean) {
  return actions.selection.size > 0 ? actions.selection.has(key) : fallback;
}

function FamilyRow({ family, expanded, onToggleExpanded, previewText, size, selectedId, busy, locations, onActivate, actions, rowIndex }: RowProps & { family: Family }) {
  const isOpen = expanded.has(family.name);
  const duplicates = family.faces.some((f) => f.copies.length > 1);
  const key = `f:${family.name}`;
  const selected = isSelected(key, actions, family.faces.some((face) => face.copies.some((c) => c.id === selectedId)));
  const copies = useMemo(() => family.faces.flatMap((f) => f.copies), [family]);
  const preview = usePreviewProfile(family.representative.primary);
  return (
    <div
      role="listitem"
      className={rowClass(selected, selected && actions.selection.size > 1)}
      onClick={(e) => actions.onRowClick(e, rowIndex, family.representative.primary.id)}
    >
      {selected && actions.selection.size > 1 && <span className="sr-only">Selected.</span>}
      <div className="mb-1 flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={isOpen ? `Collapse ${family.name}` : `Expand ${family.name}`}
          aria-expanded={isOpen}
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpanded(family.name);
          }}
        >
          <Icon name="chevron_right" size={18} className={cn("transition-transform", isOpen && "rotate-90")} />
        </Button>
        <span className="truncate text-sm font-semibold">{family.name}</span>
        <LocationDots copies={copies} locations={locations} />
        <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
          <span className="shrink-0">
            {family.faces.length} {family.faces.length === 1 ? "style" : "styles"}
          </span>
          {family.faces.some((f) => f.primary.variable) && <Badge variant="outline">Variable</Badge>}
          {family.faces.some((f) => f.primary.monospace) && <Badge variant="outline">Mono</Badge>}
          {duplicates && <Badge variant="outline">Duplicates</Badge>}
          <SampleBadge profile={preview.profile} row="family" />
          <MissingHint text={previewText} profile={preview.profile} />
          <TagChips faces={family.faces} index={actions.index} />
        </span>
        <RowTagButton rowKey={key} actions={actions} label={family.name} />
        {family.switchable.length === 0 ? (
          <InstalledBadge />
        ) : (
          <ActivationSwitch
            active={family.activeCount}
            total={family.switchable.length}
            label={`Activate ${family.name}`}
            busy={family.switchable.some((face) => face.copies.some((c) => busy.has(c.path)))}
            onChange={(on) => onActivate(activationIds(family.switchable, on), on)}
          />
        )}
      </div>
      <div className="pl-8">
        <Preview font={family.representative.primary} preview={preview} typed={previewText} own="family" size={size} />
      </div>
    </div>
  );
}

function FaceRow({ face, previewText, size, selectedId, busy, locations, onActivate, actions, rowIndex }: RowProps & { face: Face }) {
  const font = face.primary;
  const preview = usePreviewProfile(font);
  const key = `s:${face.key}`;
  const selected = isSelected(key, actions, face.copies.some((c) => c.id === selectedId));
  return (
    <div
      role="listitem"
      className={cn(rowClass(selected, selected && actions.selection.size > 1), "pl-12")}
      onClick={(e) => actions.onRowClick(e, rowIndex, font.id)}
    >
      {selected && actions.selection.size > 1 && <span className="sr-only">Selected.</span>}
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
        <RowTagButton rowKey={key} actions={actions} label={`${font.family} ${font.subfamily}`} />
        {face.installed ? (
          <InstalledBadge />
        ) : (
          <ActivationSwitch
            active={face.active ? 1 : 0}
            total={1}
            label={`Activate ${font.family} ${font.subfamily}`}
            busy={face.copies.some((c) => busy.has(c.path))}
            onChange={(on) => onActivate(activationIds([face], on), on)}
          />
        )}
      </div>
      <Preview font={font} preview={preview} typed={previewText} own="full" size={size} />
    </div>
  );
}
