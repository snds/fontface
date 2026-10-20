import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Face, Family, Library } from "@/library";
import { autoGroupText, reasonText, squash, type AutoGroup, type AutoSource, type GroupingOptions } from "@/familyGroups";
import type { GroupsFilter, GroupsPageEntry } from "@/nav";
import { Autocomplete, AutocompleteContent, AutocompleteInput, AutocompleteItem, AutocompleteList } from "@/components/ui/autocomplete";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ChoiceGroup } from "@/components/ChoiceGroup";
import { BackButton, useNarrowerThan } from "@/components/fontPage/PageHeader";
import { createTipHandle, Tip, TipHost } from "@/components/Tip";
import { dragRegion, IS_MAC, useTitleBar } from "@/components/TitleBar";
import { keepSeparate, moveFaces, resetChoices, useFamilyChoices } from "@/families/store";
import { familiesText, familyRuleKeys, nameRef, runChange, stylesText, undo, yourEdits } from "@/families/feedback";
import type { Locations } from "@/tags/locations";

export const GROUPS_SEARCH_ID = "family-groups-search";

/** Automatic groups shown at first; "Show more" adds this many again. */
const GROUPS_PAGE = 40;
const FAMILY_ROW = 44;
const STYLE_ROW = 34;

interface Props {
  page: GroupsPageEntry;
  library: Library;
  grouping: GroupingOptions;
  /** What Back returns to, in words. */
  placeName: string;
  locations: Locations;
  onBack: () => void;
  onFilter: (filter: GroupsFilter) => void;
  /** Turns View options › "Group families by name" on or off. */
  onGroupByName: (on: boolean) => void;
  announce: (text: string) => void;
}

/** Changed by you: a rule for its name or a choice for it decided its family. */
const yours = (face: Face) => face.groupedBy === "rule" || face.groupedBy === "choice";
/** Kept out of automatic groups by your rule on the family's own name (familyEdits.familyRuleKey). */
const keptFamily = (family: Family, familyRules: ReadonlySet<string>) => familyRules.has(squash(family.name));
/** The family names its styles carry (more than one: grouped from several). */
const namesIn = (family: Family) => new Set(family.faces.map((f) => f.name)).size;

/**
 * Family groups (opened from View options, a font's More or right-click menu, or Settings ›
 * Library): how families are grouped by name, what was grouped automatically and why, and your
 * changes. Check styles to group them into a family or keep them under their own names; keep
 * any automatic group apart. Nothing asks first: every change has Undo. Everything here is
 * Fontface's own record: font files never change.
 */
export function FamilyGroupsPage({ page, library, grouping, placeName, locations, onBack, onFilter, onGroupByName, announce }: Props) {
  const titleBar = useTitleBar();
  const headerRef = useRef<HTMLElement>(null);
  // Below 640px Undo is an icon only.
  const narrow = useNarrowerThan(headerRef, 640);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const { undo: undoStack } = useFamilyChoices();
  const last = undoStack[undoStack.length - 1];
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<Set<string>>(() => new Set(page.focus));
  const familyRules = useMemo(() => familyRuleKeys(library.families, grouping.rules), [library, grouping.rules]);
  const filter = page.filter;

  // The heading takes focus when the page opens, and when it's asked for again while it's on
  // top (Settings › Library opens it over itself).
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [page.opened]);

  // Opened again on other fonts (a font's menu while the page is open): those are checked.
  const focusKey = page.focus.join("\n");
  const seenFocus = useRef(focusKey);
  useEffect(() => {
    if (seenFocus.current === focusKey) return;
    seenFocus.current = focusKey;
    setChecked(new Set(page.focus));
  }, [focusKey, page.focus]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    const matches = (f: Family) =>
      !q ||
      f.name.toLowerCase().includes(q) ||
      f.faces.some((x) => x.style.toLowerCase().includes(q) || x.name.toLowerCase().includes(q) || x.primary.family.toLowerCase().includes(q) || (x.primary.postscriptName?.toLowerCase().includes(q) ?? false));
    return library.families.filter((f) => (filter !== "changed" || f.faces.some(yours) || keptFamily(f, familyRules)) && matches(f));
  }, [library.families, filter, q, familyRules]);

  const checkedFaces = useMemo(() => {
    const out: Face[] = [];
    for (const f of library.families) for (const face of f.faces) if (checked.has(face.key)) out.push(face);
    return out;
  }, [library.families, checked]);

  // Styles that left the library leave the selection.
  useEffect(() => {
    if (checkedFaces.length === checked.size) return;
    setChecked(new Set(checkedFaces.map((f) => f.key)));
  }, [checkedFaces, checked.size]);

  const done = () => {
    setChecked(new Set());
    requestAnimationFrame(() => (treeRef.current ?? headingRef.current)?.focus({ preventScroll: true }));
  };

  const count = library.auto.length;
  return (
    <>
      <header ref={headerRef} className="@container/pagehead flex h-13 shrink-0 items-center gap-2 overflow-hidden border-b px-3 select-none" {...dragRegion(titleBar)}>
        <BackButton placeName={placeName} onBack={onBack} />
        <h1 ref={headingRef} tabIndex={-1} className="min-w-0 flex-1 truncate text-base font-semibold outline-none">
          Family groups
        </h1>
        <ChoiceGroup<GroupsFilter>
          label="Show"
          value={filter}
          onChange={onFilter}
          options={[
            { value: "all", label: "All" },
            { value: "automatic", label: grouping.byName ? `Automatic (${count.toLocaleString()})` : "Automatic" },
            { value: "changed", label: "Your changes" },
          ]}
        />
        <Input
          id={GROUPS_SEARCH_ID}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search families"
          aria-label="Search families"
          className="w-44 @max-[760px]/pagehead:w-28"
        />
        {/* A tooltip, its name, only while its word is hidden. For screen readers, its name also
            says what it undoes. */}
        <Tip tip="Undo" hide={!narrow}>
          <Button
            variant="ghost"
            size="sm"
            disabled={!last}
            focusableWhenDisabled
            className="aria-disabled:opacity-50"
            onClick={() => void undo()}
            aria-label={last ? `Undo: ${last.label}` : "Undo"}
          >
            <Icon name="undo" size={16} />
            <span className="@max-[640px]/pagehead:hidden">Undo</span>
          </Button>
        </Tip>
      </header>
      <p className="shrink-0 border-b px-6 py-2 text-xs text-muted-foreground">
        {grouping.byName
          ? "Fonts whose names differ only by a style word join one family, wherever their files are. That includes width and size words, like “Arial Narrow” in Arial. Your own choices always win. Font files never change."
          : "Grouping by name is off in View options, so families use the fonts' own names. Your own changes still apply."}
      </p>
      {filter === "automatic" ? (
        <AutoList groups={library.auto} on={grouping.byName} query={q} onGroupByName={onGroupByName} announce={announce} />
      ) : (
        <>
          <FamilyTree
            treeRef={treeRef}
            families={shown}
            filter={filter}
            query={q}
            focus={page.focus}
            checked={checked}
            onChecked={setChecked}
            locations={locations}
            familyRules={familyRules}
          />
          {checkedFaces.length > 0 && (
            <SelectionBar faces={checkedFaces} families={library.families} familyRules={familyRules} onDone={done} onClear={done} announce={announce} />
          )}
          <div className="sr-only" aria-live="polite">
            {checkedFaces.length ? `${stylesText(checkedFaces.length)} selected` : ""}
          </div>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------ the tree

type TreeRow =
  | { kind: "family"; key: string; family: Family; pos: number; size: number }
  | { kind: "face"; key: string; face: Face; family: Family; pos: number; size: number };

/** A check box drawn, not a control (the row is the control, named by its text): checked,
 *  partly or not. */
function Mark({ state, className }: { state: boolean | "mixed"; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input",
        state !== false && "border-primary bg-primary text-primary-foreground",
        className,
      )}
    >
      {state === true && <Icon name="check" size={13} weight={600} />}
      {state === "mixed" && <Icon name="remove" size={13} weight={600} />}
    </span>
  );
}

interface TreeProps {
  treeRef: React.RefObject<HTMLDivElement | null>;
  families: Family[];
  filter: GroupsFilter;
  query: string;
  focus: string[];
  checked: Set<string>;
  onChecked: (next: Set<string>) => void;
  locations: Locations;
  familyRules: ReadonlySet<string>;
}

/**
 * Families and their styles, as a tree of check boxes (WAI-ARIA tree): one Tab stop; Up and
 * Down move, Right and Left open and close a family, Space checks (a family checks all its
 * styles), Enter opens a family or checks a style, Cmd-A checks every style listed and Esc
 * clears. The list keeps focus and points at the current row (aria-activedescendant), since
 * rows are only drawn while they're in view.
 */
function FamilyTree({ treeRef, families, filter, query, focus, checked, onChecked, locations, familyRules }: TreeProps) {
  const base = useId();
  const helpId = `${base}-help`;
  // One tooltip shared by the rows' open buttons, which are icons (rows are drawn as they scroll by).
  const [tips] = useState(createTipHandle);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);

  // What opens by itself: your changes (few), families matched by a style rather than their
  // name, and the families of fonts the page was opened on.
  const focusKey = focus.join("\n");
  useEffect(() => {
    const open = new Set<string>();
    const wanted = new Set(focus);
    for (const f of families) {
      if (filter === "changed" && families.length <= 60) open.add(f.id);
      else if (query && !f.name.toLowerCase().includes(query)) open.add(f.id);
      if (f.faces.some((x) => wanted.has(x.key))) open.add(f.id);
    }
    setExpanded(open);
    // Only when what's listed is asked for differently, not on every regroup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, query, focusKey]);

  const rows = useMemo(() => {
    const out: TreeRow[] = [];
    families.forEach((family, i) => {
      out.push({ kind: "family", key: `f:${family.id}`, family, pos: i + 1, size: families.length });
      if (expanded.has(family.id)) family.faces.forEach((face, j) => out.push({ kind: "face", key: `s:${face.key}`, face, family, pos: j + 1, size: family.faces.length }));
    });
    return out;
  }, [families, expanded]);
  const indexOf = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows]);
  const active = activeKey !== null && indexOf.has(activeKey) ? indexOf.get(activeKey)! : rows.length ? 0 : -1;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => treeRef.current,
    estimateSize: (i) => (rows[i].kind === "family" ? FAMILY_ROW : STYLE_ROW),
    getItemKey: (i) => rows[i].key,
    overscan: 8,
  });

  // Opened on some fonts: their first family comes into view as the current row.
  const revealed = useRef("");
  useEffect(() => {
    if (!focus.length || revealed.current === focusKey) return;
    const wanted = new Set(focus);
    const at = rows.findIndex((r) => r.kind === "family" && r.family.faces.some((x) => wanted.has(x.key)));
    if (at < 0) return;
    revealed.current = focusKey;
    setActiveKey(rows[at].key);
    virtualizer.scrollToIndex(at, { align: "start" });
  }, [rows, focus, focusKey, virtualizer]);

  const facesOf = (row: TreeRow) => (row.kind === "family" ? row.family.faces : [row.face]);
  const stateOf = (row: TreeRow): boolean | "mixed" => {
    const faces = facesOf(row);
    const n = faces.filter((f) => checked.has(f.key)).length;
    return n === 0 ? false : n === faces.length ? true : "mixed";
  };
  const toggle = (row: TreeRow) => {
    const next = new Set(checked);
    const on = stateOf(row) !== true;
    for (const f of facesOf(row)) {
      if (on) next.add(f.key);
      else next.delete(f.key);
    }
    onChecked(next);
  };
  const toggleOpen = (family: Family) => {
    const next = new Set(expanded);
    if (next.has(family.id)) next.delete(family.id);
    else next.add(family.id);
    setExpanded(next);
  };
  const goTo = (i: number) => {
    if (!rows.length) return;
    const at = Math.max(0, Math.min(rows.length - 1, i));
    setActiveKey(rows[at].key);
    virtualizer.scrollToIndex(at, { align: "auto" });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const row = active >= 0 ? rows[active] : undefined;
    const pageSize = Math.max(1, Math.floor((treeRef.current?.clientHeight ?? 400) / STYLE_ROW) - 1);
    const handled = () => e.preventDefault();
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (mod && e.key.toLowerCase() === "a") {
      handled();
      onChecked(new Set([...checked, ...families.flatMap((f) => f.faces.map((x) => x.key))]));
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "ArrowDown":
        handled();
        return goTo(active + 1);
      case "ArrowUp":
        handled();
        return goTo(active - 1);
      case "Home":
        handled();
        return goTo(0);
      case "End":
        handled();
        return goTo(rows.length - 1);
      case "PageDown":
        handled();
        return goTo(active + pageSize);
      case "PageUp":
        handled();
        return goTo(active - pageSize);
      case "ArrowRight":
        if (row?.kind !== "family") return;
        handled();
        if (!expanded.has(row.family.id)) toggleOpen(row.family);
        else goTo(active + 1);
        return;
      case "ArrowLeft":
        if (!row) return;
        handled();
        if (row.kind === "face") goTo(indexOf.get(`f:${row.family.id}`) ?? active);
        else if (expanded.has(row.family.id)) toggleOpen(row.family);
        return;
      case " ":
        if (!row) return;
        handled();
        return toggle(row);
      case "Enter":
        if (!row) return;
        handled();
        if (row.kind === "family") toggleOpen(row.family);
        else toggle(row);
        return;
      case "Escape":
        // With nothing checked, Esc is left for Back.
        if (checked.size) {
          handled();
          onChecked(new Set());
        }
        return;
    }
  };

  const items = virtualizer.getVirtualItems();
  const activeDrawn = active >= 0 && items.some((v) => v.index === active);
  const rowId = (i: number) => `${base}-row-${i}`;

  if (!families.length) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {query
          ? `No families match “${query}”.`
          : filter === "changed"
            ? "You haven't changed any family yet. Check styles under All to group them into a family or keep them under their own names."
            : "No fonts in the library yet."}
      </div>
    );
  }

  return (
    <>
      <p id={helpId} className="sr-only">
        Up and Down arrows move. Space checks a style, or every style of a family. Right and Left open and close a family.
      </p>
      {/* Pointer only: the rows' controls are drawn, and the tree takes the keyboard (above). */}
      <TipHost handle={tips} />
      <div
        ref={treeRef}
        role="tree"
        aria-label="Families and their styles"
        aria-describedby={helpId}
        aria-activedescendant={activeDrawn ? rowId(active) : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={(e) => e.target === e.currentTarget && setFocused(true)}
        onBlur={(e) => e.target === e.currentTarget && setFocused(false)}
        className="relative min-h-0 flex-1 overflow-y-auto outline-none"
      >
        <div style={{ height: virtualizer.getTotalSize() }} className="relative">
          {items.map((v) => {
            const row = rows[v.index];
            const state = stateOf(row);
            const isActive = v.index === active;
            const common = {
              id: rowId(v.index),
              role: "treeitem",
              "aria-level": row.kind === "family" ? 1 : 2,
              "aria-setsize": row.size,
              "aria-posinset": row.pos,
              "aria-checked": state,
              style: { transform: `translateY(${v.start}px)`, height: v.size },
              onClick: () => {
                setActiveKey(row.key);
                toggle(row);
              },
              className: cn(
                "absolute inset-x-0 top-0 flex cursor-default items-center gap-2 border-b border-border/50 pr-4 text-sm select-none hover:bg-muted/40",
                isActive && focused && "bg-muted/60 ring-2 ring-ring/60 ring-inset",
                state !== false && "bg-primary/5",
              ),
            } as const;
            if (row.kind === "family") {
              const open = expanded.has(row.family.id);
              const names = namesIn(row.family);
              const changed = row.family.faces.some(yours);
              const kept = keptFamily(row.family, familyRules);
              return (
                <div
                  key={v.key}
                  {...common}
                  aria-expanded={open}
                  aria-label={`${row.family.name}, ${stylesText(row.family.faces.length)}${names > 1 ? `, grouped from ${names} names` : ""}${kept ? ", kept separate by you" : changed ? ", changed by you" : ""}`}
                  className={cn(common.className, "pl-2")}
                >
                  <Tip handle={tips} tip={open ? "Hide styles" : "Show styles"}>
                    <span
                      aria-hidden
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveKey(row.key);
                        toggleOpen(row.family);
                      }}
                      className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Icon name={open ? "expand_more" : "chevron_right"} size={18} />
                    </span>
                  </Tip>
                  <Mark state={state} />
                  <span className="min-w-0 truncate font-semibold">{row.family.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{stylesText(row.family.faces.length)}</span>
                  {names > 1 && <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">· grouped from {names.toLocaleString()} names</span>}
                  {(changed || kept) && (
                    <Badge variant="outline" className="shrink-0">
                      {kept ? "Kept separate" : "Changed by you"}
                    </Badge>
                  )}
                </div>
              );
            }
            const face = row.face;
            const from = face.name !== row.family.name ? face.name : null;
            const how = face.groupedBy === "choice" ? "moved by you" : face.groupedBy === "rule" ? "by your rule" : face.auto ? "grouped automatically" : from ? "grouped by name" : "";
            const kept = yours(face) && face.kept;
            return (
              <div
                key={v.key}
                {...common}
                aria-label={[face.style, face.primary.postscriptName, from ? `from “${from}”` : "", kept ? "kept under its own name by you" : how].filter(Boolean).join(", ")}
                className={cn(common.className, "pl-10")}
              >
                <Mark state={state} />
                <span className="min-w-0 truncate">{face.style}</span>
                <span className="hidden min-w-0 shrink truncate font-mono text-[11px] text-muted-foreground md:inline">{face.primary.postscriptName}</span>
                <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  {from && <span className="max-w-64 truncate">from “{from}”</span>}
                  {yours(face) && (
                    <Badge variant="outline" className="shrink-0">
                      {kept ? "Kept separate" : "By you"}
                    </Badge>
                  )}
                  <span className="hidden max-w-40 truncate lg:inline">{locations.sourceOf(face.primary)}</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// --------------------------------------------------------------------- the selection bar

function SelectionBar({
  faces,
  families,
  familyRules,
  onDone,
  onClear,
  announce,
}: {
  faces: Face[];
  families: Family[];
  familyRules: ReadonlySet<string>;
  onDone: () => void;
  onClear: () => void;
  announce: (text: string) => void;
}) {
  const inputId = useId();
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const names = useMemo(() => families.map((f) => f.name), [families]);
  const n = faces.length;
  const mine = yourEdits(faces, familyRules);
  const run = async (op: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    try {
      if (await op()) onDone();
    } finally {
      setBusy(false);
    }
  };
  const apply = () =>
    run(async () => {
      const typed = target.trim();
      if (!typed) return false;
      // An existing family, spelled as it is.
      const name = families.find((f) => squash(f.name) === squash(typed))?.name ?? typed;
      const label = `Grouped ${stylesText(n)} into ${name}`;
      const ok = await runChange(() => moveFaces(label, faces.map((f) => f.key), name), "Couldn't group them");
      if (ok) {
        announce(label);
        setTarget("");
      }
      return ok;
    });
  const keep = () =>
    run(async () => {
      const label = `Kept ${stylesText(n)} under ${n === 1 ? "its" : "their"} own family ${n === 1 ? "name" : "names"}`;
      const ok = await runChange(() => keepSeparate(label, [], faces.map((f) => f.key)), "Couldn't keep them separate");
      if (ok) announce(label);
      return ok;
    });
  const clearMine = () =>
    run(async () => {
      const label = `Cleared your choices for ${stylesText(n)}`;
      const ok = await runChange(() => resetChoices(label, mine.faces, mine.nameKeys), "Couldn't clear your choices");
      if (ok) announce(label);
      return ok;
    });
  return (
    <div role="region" aria-label="Selected styles" className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-muted/40 px-4 py-2 text-sm">
      <form
        className="flex min-w-0 flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void apply();
        }}
      >
        <label htmlFor={inputId}>
          Group {stylesText(n)} selected into family:
        </label>
        <Autocomplete items={names} value={target} onValueChange={setTarget} limit={8}>
          <AutocompleteInput id={inputId} placeholder="Type or pick a family" className="w-56" autoComplete="off" />
          <AutocompleteContent>
            <AutocompleteList>
              {(name: string) => (
                <AutocompleteItem key={name} value={name}>
                  <span className="truncate">{name}</span>
                </AutocompleteItem>
              )}
            </AutocompleteList>
          </AutocompleteContent>
        </Autocomplete>
        <Button type="submit" size="sm" disabled={!target.trim() || busy} focusableWhenDisabled className="aria-disabled:opacity-50">
          Apply
        </Button>
      </form>
      <span aria-hidden className="mx-1 h-5 w-px bg-border" />
      <Button size="sm" variant="outline" disabled={busy} focusableWhenDisabled className="aria-disabled:opacity-50" onClick={keep}>
        Keep separate
      </Button>
      {mine.faces.length + mine.nameKeys.length > 0 && (
        <Button size="sm" variant="ghost" disabled={busy} focusableWhenDisabled className="aria-disabled:opacity-50" onClick={clearMine}>
          Clear my choices
        </Button>
      )}
      <div className="flex-1" />
      <Button size="sm" variant="ghost" onClick={onClear}>
        Clear selection
      </Button>
    </div>
  );
}

// ----------------------------------------------------------------------- automatic groups

interface AutoListProps {
  groups: AutoGroup<Family>[];
  /** Grouping by name is on (off: nothing is grouped automatically). */
  on: boolean;
  query: string;
  onGroupByName: (on: boolean) => void;
  announce: (text: string) => void;
}

/** What was grouped automatically, and why. Keep separate puts a family back on its own. */
function AutoList({ groups, on, query, onGroupByName, announce }: AutoListProps) {
  const [limit, setLimit] = useState(GROUPS_PAGE);
  const headRef = useRef<HTMLParagraphElement>(null);
  const shown = useMemo(
    () => (query ? groups.filter((g) => g.into.toLowerCase().includes(query) || g.sources.some((src) => src.family.name.toLowerCase().includes(query))) : groups),
    [groups, query],
  );
  const sources = groups.reduce((n, g) => n + g.sources.length, 0);
  const after = () => requestAnimationFrame(() => headRef.current?.focus({ preventScroll: true }));
  if (!on) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
        <p>Grouping by name is off, so nothing is grouped automatically.</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            onGroupByName(true);
            after();
          }}
        >
          Turn on grouping by name
        </Button>
      </div>
    );
  }
  if (!groups.length) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Nothing was grouped automatically. Families whose names differ only by a width, size or numbered style word show up here.
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-6 py-5">
        <p ref={headRef} tabIndex={-1} className="text-sm text-muted-foreground outline-none">
          {familiesText(sources)} {sources === 1 ? "was" : "were"} grouped into {groups.length.toLocaleString()} {groups.length === 1 ? "family" : "families"}, because
          their names nearly match. Each line says why. If one doesn't belong, choose Keep separate.
        </p>
        {shown.slice(0, limit).map((g) => (
          <AutoCard key={g.id} group={g} announce={announce} onDone={after} />
        ))}
        {shown.length > limit && (
          <Button variant="ghost" className="self-start" onClick={() => setLimit((n) => n + GROUPS_PAGE)}>
            Show more ({(shown.length - limit).toLocaleString()})
          </Button>
        )}
        {!shown.length && <p className="text-sm text-muted-foreground">No automatic groups match “{query}”.</p>}
      </div>
    </div>
  );
}

/** One automatic group: the families that joined `into`, each with its reason and Keep separate. */
function AutoCard({ group: g, announce, onDone }: { group: AutoGroup<Family>; announce: (text: string) => void; onDone: () => void }) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const keep = async (list: AutoSource<Family>[]) => {
    if (busy) return;
    const label = list.length === 1 ? `Kept “${list[0].family.name}” separate from ${g.into}` : `Kept ${familiesText(list.length)} separate from ${g.into}`;
    setBusy(true);
    try {
      if (await runChange(() => keepSeparate(label, list.map((src) => nameRef(src.family.name))), "Couldn't keep them separate")) {
        announce(label);
        onDone();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-col gap-0.5">
        <h2 id={`${id}-title`} className="text-sm font-semibold">
          {autoGroupText(g)}
        </h2>
        {!g.existing && <p className="text-xs text-muted-foreground">No font is named {g.into} alone, so this family is new.</p>}
      </div>
      <ul className="flex flex-col gap-1.5">
        {g.sources.map((src) => (
          <li key={src.family.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-medium">{src.family.name}</span>
            <span className="text-muted-foreground">
              {stylesText(src.family.faces.length)} · {reasonText(src)}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7 aria-disabled:opacity-50"
              disabled={busy}
              focusableWhenDisabled
              onClick={() => void keep([src])}
              aria-label={`Keep “${src.family.name}” separate from ${g.into}`}
            >
              Keep separate
            </Button>
          </li>
        ))}
      </ul>
      {g.sources.length > 1 && (
        <Button
          size="sm"
          variant="outline"
          className="self-start aria-disabled:opacity-50"
          disabled={busy}
          focusableWhenDisabled
          onClick={() => void keep(g.sources)}
        >
          Keep all {g.sources.length.toLocaleString()} separate
        </Button>
      )}
    </section>
  );
}
