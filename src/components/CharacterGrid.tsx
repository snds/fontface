import { memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, type CharacterBlock, type FontCharacters } from "@/api";
import type { VariationAt } from "@/axisField";
import { blockCount, eagerGroups, uniqueBlocks } from "@/charBlocks";
import { setClosedGroups, useBlockStore } from "@/charBlocksStore";
import { codeLabel, findCharacters, parseCharacterQuery, type CharacterMatch } from "@/characterSearch";
import type { FaceState } from "@/fontLoader";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TIP_DELAY, TIP_INSTANT_WINDOW } from "@/components/Tip";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

// The font page's character grid: every real character of the face (placeholders and empty
// slots left out), in a group per Unicode block picked (fontPage/BlockSelect.tsx), or the ones a
// search asks for. Backed by `font_characters`, worked out on demand.

export type CharactersState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: FontCharacters };

/**
 * Reads a face's characters, once `enabled` (the font page asks only when a tab shows them).
 * What was read stays while the face is the same, so switching tabs doesn't read it again.
 */
export function useFontCharacters(fontId: number, enabled = true): CharactersState {
  const [read, setRead] = useState<{ id: number; state: CharactersState } | null>(null);
  const wanted = enabled || read?.id === fontId;
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    setRead((r) => (r?.id === fontId ? r : { id: fontId, state: { status: "loading" } }));
    api.fontCharacters(fontId).then(
      (data) => live && setRead({ id: fontId, state: { status: "ready", data } }),
      (e) => live && setRead({ id: fontId, state: { status: "error", message: String(e) } }),
    );
    return () => {
      live = false;
    };
  }, [fontId, wanted]);
  return read?.id === fontId ? read.state : { status: "loading" };
}

/** Shown at first, per block; the rest wait for "Show all". */
const FIRST_CELLS = 512;
/** Cell height (and least width) in px, and the room between cells. */
const CELL = 44;
const GAP = 4;
/** Groups from the top are made at once while they hold fewer cells than this; the rest wait
 *  till they come near the screen (all 300 blocks of a big font would be tens of thousands). */
const EAGER_CELLS = 1536;

const hex = codeLabel;

function codePoints(b: CharacterBlock): number[] {
  const out: number[] = [];
  for (const [a, z] of b.runs) for (let cp = a; cp <= z; cp++) out.push(cp);
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** One line describing the set, such as "166 characters, all in Private Use Area (U+E000–U+E0A5)". */
export function charactersSummary(d: FontCharacters): string {
  const hidden: string[] = [];
  if (d.placeholders) hidden.push(`${plural(d.placeholders, "slot")} share one placeholder (hidden)`);
  if (d.empty) hidden.push(`${plural(d.empty, "slot")} ${d.empty === 1 ? "is" : "are"} empty (hidden)`);
  const blocks = uniqueBlocks(d.blocks);
  let main: string;
  if (d.total === 0) main = "No characters with a visible shape";
  else if (d.expert) main = `Expert set: ${plural(d.total, "real character")}`;
  else if (blocks.length === 1) {
    const b = blocks[0];
    const first = b.runs[0][0];
    const last = b.runs[b.runs.length - 1][1];
    main = `${plural(d.total, "character")}, all in ${b.name} (${hex(first)}–${hex(last)})`;
  } else main = `${plural(d.total, "character")} in ${blocks.length} Unicode blocks`;
  const symbol = d.lookup === "symbol" ? " This font uses an old symbol encoding, so typing a letter draws whatever is in that letter's slot." : "";
  const limited = d.limited ? " It's too large or damaged to check every character, so some may be missing here." : "";
  return `${[main, ...hidden].join("; ")}.${symbol}${limited}`;
}

/** The info section's "Character set" line. */
export function characterSetLine(d: FontCharacters, label: string | undefined): string {
  const blocks = uniqueBlocks(d.blocks);
  const biggest = [...blocks].sort((a, b) => blockCount(b) - blockCount(a))[0];
  const where = blocks.length > 1 ? `, mostly ${biggest.name}` : biggest ? `, ${biggest.name}` : "";
  return `${label ? `${label} · ` : ""}${plural(d.total, "character")}${where}`;
}

async function copyCharacter(cp: number, name: string) {
  const ok = await copyText(String.fromCodePoint(cp));
  if (ok) toast.success(`Copied ${hex(cp)}`, { description: name ? `Glyph “${name}”` : undefined });
  else toast.error("Couldn't copy that character");
}

interface Props {
  state: CharactersState;
  /** CSS font-family of the loaded face. */
  fontFamily: string;
  /** The page-only face name (fontLoader's `faceName`): marks the grid, so a color font with an
   *  all-dark palette draws light in the dark theme (colorPalette.ts). */
  face?: string;
  /** font-variation-settings for the cells' text size (the font page's axes; optical size may
   *  follow the size). Keep it the same function while the axes are, or every cell redraws. */
  variation?: VariationAt;
  /** Whether the face has loaded: cells stay hidden (and out of the Tab order) while it loads,
   *  and aren't shown at all if it can't load. */
  fontState: FaceState;
  /** A search (see characterSearch.ts): typed characters or U+ codes, looked for in every block.
   *  Empty shows the blocks picked. */
  query?: string;
  /** The face's blocks, each name once (charBlocks.ts's `uniqueBlocks` of `state`'s). */
  blocks: CharacterBlock[];
  /** The blocks picked, in Unicode order: a group each. */
  picked: string[];
}

/** Memoized: the font page re-renders on every keystroke in the preview field, and a block can
 *  hold tens of thousands of cells. */
export const CharacterGrid = memo(function CharacterGrid({ state, fontFamily, face, variation, fontState, query = "", blocks, picked }: Props) {
  const data = state.status === "ready" ? state.data : null;
  const wanted = useMemo(() => parseCharacterQuery(query), [query]);
  const results = useMemo(() => (query.trim() && data ? findCharacters(data.blocks, wanted) : null), [query, data, wanted]);
  const resultsText = results ? searchStatus(wanted, results) : "";
  let body: React.ReactNode;
  if (state.status === "loading") body = <p className="text-xs text-muted-foreground">Reading characters…</p>;
  else if (state.status === "error") body = <p className="text-xs text-muted-foreground italic">{state.message}</p>;
  else if (fontState !== "loading" && fontState !== "ready") {
    // Cells would draw in another font, or not at all.
    body = (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">{charactersSummary(state.data)}</p>
        <p className="text-xs text-muted-foreground italic">The font couldn't be loaded here, so its characters can't be drawn.</p>
      </div>
    );
  } else {
    body = (
      <Grid
        data={state.data}
        blocks={blocks}
        picked={picked}
        fontFamily={fontFamily}
        face={face}
        variation={variation}
        ready={fontState === "ready"}
        query={query}
        results={results}
        resultsText={resultsText}
      />
    );
  }
  return (
    <>
      {/* The search's results, read out as they change. Always present (empty until a search),
          so the first result is read too: a live region that appears with its text is often
          skipped. */}
      <p role="status" className="sr-only">
        {resultsText}
      </p>
      {body}
    </>
  );
});

interface GridProps {
  data: FontCharacters;
  blocks: CharacterBlock[];
  picked: string[];
  fontFamily: string;
  face?: string;
  variation?: VariationAt;
  ready: boolean;
  query: string;
  /** The search's matches, or null when not searching. */
  results: CharacterResults | null;
  /** What the search found, in words (also read out by CharacterGrid's status line). */
  resultsText: string;
}

type CharacterResults = ReturnType<typeof findCharacters>;

/** What a search found, in words: "2 characters found. Not in this font: € (U+20AC)." */
function searchStatus(wanted: number[], results: CharacterResults): string {
  if (!wanted.length) return "Type a character, or a code such as U+00DF.";
  if (!results.found.length) return `Not in this font: ${listCodes(results.missing)}.`;
  return `${plural(results.found.length, "character")} found.${results.missing.length ? ` Not in this font: ${listCodes(results.missing)}.` : ""}`;
}

/** "ß (U+00DF), € (U+20AC) and 3 more". */
function listCodes(cps: number[], max = 12): string {
  const shown = cps.slice(0, max).map((cp) => `${String.fromCodePoint(cp)} (${hex(cp)})`);
  return cps.length > max ? `${shown.join(", ")} and ${(cps.length - max).toLocaleString()} more` : shown.join(", ");
}

function Grid({ data, blocks, picked, fontFamily, face, variation, ready, query, results, resultsText }: GridProps) {
  const { closed } = useBlockStore();
  // State, not a ref: the list comes and goes (a search replaces it), and each new one is watched.
  const [list, setList] = useState<HTMLDivElement | null>(null);

  // Cells fit the ink most characters stay within, centred; outliers may be cut at the edge.
  const tall = data.inkTop + data.inkBottom;
  const size = Math.min(26, tall > 0 ? (CELL - 10) / tall : 26);
  const baseline = CELL / 2 + (size * (data.inkTop - data.inkBottom)) / 2;
  const lineHeight = Math.max(0, 2 * baseline - size * (data.ascent - data.descent));
  const glyphStyle = useMemo<React.CSSProperties>(
    () => ({ height: CELL, fontFamily, fontVariationSettings: variation?.(size), fontSize: size, lineHeight: `${lineHeight}px` }),
    [fontFamily, variation, size, lineHeight],
  );
  const onCopy = useCallback((cp: number, name: string) => void copyCharacter(cp, name), []);
  const common = { face, ready, glyphStyle, onCopy };

  const byName = useMemo(() => new Map(blocks.map((b) => [b.name, b])), [blocks]);
  const groups = useMemo(() => picked.flatMap((n) => byName.get(n) ?? []), [picked, byName]);
  const shut = useMemo(() => new Set(closed), [closed]);
  const eager = useMemo(
    () => eagerGroups(groups.map((b) => ({ name: b.name, cells: shut.has(b.name) ? 0 : Math.min(FIRST_CELLS, blockCount(b)) })), EAGER_CELLS),
    [groups, shut],
  );
  const { near, columns } = useLazyGroups(list, blocks, picked);
  const only = useMemo(() => (blocks.length === 1 ? matchesOf(blocks[0]) : NO_MATCHES), [blocks]);
  const setOpen = useCallback((name: string, open: boolean) => setClosedGroups(open ? closed.filter((n) => n !== name) : [...closed, name]), [closed]);

  if (!blocks.length) return <p className="text-xs text-muted-foreground">{charactersSummary(data)}</p>;
  let body: React.ReactNode;
  if (results) {
    body = <Cells key={query} items={results.found} label={`Characters found for “${query.trim()}”. Arrow keys move; Enter copies.`} {...common} />;
  } else if (blocks.length === 1) {
    // The summary names the one block: no picker, no group.
    body = <Cells items={only} label={`Characters in ${blocks[0].name}. Arrow keys move; Enter copies.`} {...common} />;
  } else if (!groups.length) {
    body = <p className="text-sm text-muted-foreground">No blocks picked. Pick one or more from Unicode blocks above.</p>;
  } else {
    body = (
      <div ref={setList} className="flex flex-col gap-3">
        {groups.map((b) => (
          <BlockGroup
            key={b.name}
            block={b}
            open={!shut.has(b.name)}
            mounted={eager.has(b.name) || near.has(b.name)}
            columns={columns}
            onOpenChange={setOpen}
            {...common}
          />
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {results ? (
        // Screen readers hear this from the status line above the grid (CharacterGrid).
        <p className="text-xs text-muted-foreground" aria-hidden>
          {resultsText}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{charactersSummary(data)}</p>
      )}
      {body}
    </div>
  );
}

/** What every cell grid shares. */
interface CellsCommon {
  face?: string;
  ready: boolean;
  glyphStyle: React.CSSProperties;
  onCopy: (cp: number, name: string) => void;
}

const NO_MATCHES: CharacterMatch[] = [];
const matchesOf = (b: CharacterBlock): CharacterMatch[] => codePoints(b).map((cp, i) => ({ cp, name: b.glyphNames[i] ?? "" }));

/**
 * One picked block: a divider with its name and count, which opens and closes it, then its
 * cells. The cells are made only once the group is `mounted` (near the screen, or among the
 * first groups): till then a box of about their height keeps the scroll bar honest.
 */
function BlockGroup({
  block,
  open,
  mounted,
  columns,
  onOpenChange,
  ...common
}: CellsCommon & {
  block: CharacterBlock;
  open: boolean;
  mounted: boolean;
  /** Cells per row, for the box that stands in for them. */
  columns: number;
  onOpenChange: (name: string, open: boolean) => void;
}) {
  const id = useId();
  const n = blockCount(block);
  const items = useMemo(() => (open && mounted ? matchesOf(block) : NO_MATCHES), [open, mounted, block]);
  return (
    <section data-block={block.name} aria-labelledby={`${id}-head`} className="flex flex-col gap-2">
      <h2 className="flex">
        <button
          id={`${id}-head`}
          type="button"
          aria-label={`${block.name}, ${n.toLocaleString()} ${n === 1 ? "character" : "characters"}`}
          aria-expanded={open}
          aria-controls={open ? `${id}-cells` : undefined}
          onClick={() => onOpenChange(block.name, !open)}
          className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md pr-1 pl-0.5 text-left text-sm outline-none select-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Icon name="chevron_right" size={18} className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <span className="min-w-0 truncate font-medium">{block.name}</span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{n.toLocaleString()}</span>
          <span aria-hidden className="ml-1 h-px min-w-6 flex-1 bg-border" />
        </button>
      </h2>
      {open &&
        (mounted ? (
          <Cells id={`${id}-cells`} items={items} label={`Characters in ${block.name}. Arrow keys move; Enter copies.`} {...common} />
        ) : (
          <div id={`${id}-cells`} aria-hidden style={{ height: placeholderHeight(n, columns) }} />
        ))}
    </section>
  );
}

/** About how tall a group's cells (and its Show all) will be. */
function placeholderHeight(count: number, columns: number): number {
  const rows = Math.ceil(Math.min(count, FIRST_CELLS) / columns);
  return rows * CELL + Math.max(0, rows - 1) * GAP + (count > FIRST_CELLS ? 28 + 8 : 0);
}

/** Groups further than this from the visible part are made once they come this near. */
const NEAR = "800px 0px";

/** The nearest ancestor that scrolls (the tab panel), or null for the window. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === "auto" || overflowY === "scroll") return p;
  }
  return null;
}

const NOTHING_NEAR: ReadonlySet<string> = new Set();

/**
 * Which groups (by block name) have come near the screen for this font, and how many cells fit
 * in a row. A group once near stays made, so scrolling back is instant.
 */
function useLazyGroups(list: HTMLDivElement | null, blocks: CharacterBlock[], picked: string[]) {
  const [near, setNear] = useState<{ blocks: CharacterBlock[]; names: ReadonlySet<string> }>({ blocks, names: NOTHING_NEAR });
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!list) return;
    setWidth(list.clientWidth);
    const io = new IntersectionObserver(
      (entries) =>
        setNear((before) => {
          const had = before.blocks === blocks ? before.names : NOTHING_NEAR;
          const fresh = entries.flatMap((e) => (e.isIntersecting && (e.target as HTMLElement).dataset.block) || []).filter((n) => !had.has(n));
          if (!fresh.length) return before.blocks === blocks ? before : { blocks, names: had };
          return { blocks, names: new Set([...had, ...fresh]) };
        }),
      { root: scrollParent(list), rootMargin: NEAR },
    );
    for (const section of list.querySelectorAll("section[data-block]")) io.observe(section);
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(list);
    return () => {
      io.disconnect();
      ro.disconnect();
    };
  }, [list, blocks, picked]);
  return {
    near: near.blocks === blocks ? near.names : NOTHING_NEAR,
    // As the cells' grid lays them out: columns at least CELL wide, GAP apart.
    columns: Math.max(1, Math.floor((width + GAP) / (CELL + GAP))),
  };
}

/** One grid of cells: the arrow keys move in it, and it's one Tab stop. */
function Cells({ id, items, label, face, ready, glyphStyle, onCopy }: CellsCommon & { id?: string; items: CharacterMatch[]; label: string }) {
  const [showAll, setShowAll] = useState(false);
  const [focus, setFocus] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  // One tooltip for every cell (CellTip).
  const cellTip = useRef<CellTipControl>(null);
  /** "Show all" was used: once the new cells are there, focus the first of them. */
  const focusFirstNew = useRef(false);
  useEffect(() => {
    if (!showAll || !focusFirstNew.current) return;
    focusFirstNew.current = false;
    gridRef.current?.querySelectorAll<HTMLButtonElement>("button[data-cell]")[FIRST_CELLS]?.focus();
  }, [showAll]);

  const shown = showAll ? items : items.slice(0, FIRST_CELLS);
  // Another style of the family may have fewer characters here: the Tab stop stays on a cell.
  const stop = Math.min(focus, shown.length - 1);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const cells = gridRef.current?.querySelectorAll<HTMLButtonElement>("button[data-cell]");
    if (!cells?.length) return;
    // Cells in the first row: how far up and down move.
    let columns = 0;
    while (columns < cells.length && cells[columns].offsetTop === cells[0].offsetTop) columns++;
    const moves: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: columns,
      ArrowUp: -columns,
      Home: -stop,
      End: cells.length - 1 - stop,
    };
    const step = moves[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const next = Math.min(cells.length - 1, Math.max(0, stop + step));
    setFocus(next);
    cells[next].focus();
  };

  return (
    <>
      <div
        ref={gridRef}
        id={id}
        role="group"
        data-face={face}
        aria-label={label}
        // Hidden while the face loads: out of the Tab order too, so focus can't land on it.
        inert={!ready}
        // `relative`: the cells' tooltip is placed over a cell by its offset in the grid.
        className={cn("relative grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-1 transition-opacity", !ready && "preview-loading")}
        onKeyDown={onKeyDown}
        onPointerOver={(e) => e.pointerType !== "touch" && cellTip.current?.hover(cellOf(e.target))}
        onPointerLeave={() => cellTip.current?.hover(null)}
        onPointerDown={() => cellTip.current?.press()}
        onFocus={(e) => {
          // Keyboard focus shows it, as it does for the app's other tooltips; a click's doesn't.
          const cell = cellOf(e.target);
          if (cell?.matches(":focus-visible")) cellTip.current?.focus(cell);
        }}
        onBlur={(e) => !cellOf(e.relatedTarget) && cellTip.current?.focus(null)}
      >
        {shown.map(({ cp, name }, i) => (
          <Cell key={cp} cp={cp} index={i} name={name} tabbable={i === stop} glyphStyle={glyphStyle} onFocusCell={setFocus} onCopy={onCopy} />
        ))}
        <CellTip control={cellTip} />
      </div>
      {!showAll && items.length > FIRST_CELLS && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => {
            // This button goes away; focus moves to the first cell it reveals.
            focusFirstNew.current = true;
            setFocus(FIRST_CELLS);
            setShowAll(true);
          }}
        >
          Show all {items.length.toLocaleString()}
        </Button>
      )}
    </>
  );
}

interface CellProps {
  cp: number;
  index: number;
  name: string;
  /** The grid's one Tab stop (arrow keys move it). */
  tabbable: boolean;
  glyphStyle: React.CSSProperties;
  onFocusCell: (index: number) => void;
  onCopy: (cp: number, name: string) => void;
}

/** One character. Memoized: moving focus re-renders two cells, not the whole block. Its tooltip's
 *  words (`data-tip`) are shown by the grid's one CellTip. */
const Cell = memo(function Cell({ cp, index, name, tabbable, glyphStyle, onFocusCell, onCopy }: CellProps) {
  return (
    <button
      type="button"
      data-cell
      tabIndex={tabbable ? 0 : -1}
      data-tip={`Copies ${hex(cp)}${name ? ` (glyph “${name}”)` : ""}`}
      aria-label={`${hex(cp)}${name ? `, glyph ${name}` : ""}. Copy`}
      onFocus={() => onFocusCell(index)}
      onClick={() => onCopy(cp, name)}
      className="overflow-hidden rounded-md bg-muted/30 p-0 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
      style={{ height: CELL }}
    >
      {/* A block as tall as the cell, so the button's own centring can't move the baseline
          away from where the line height puts it. */}
      <span aria-hidden className="block text-center whitespace-nowrap" style={glyphStyle}>
        {String.fromCodePoint(cp)}
      </span>
    </button>
  );
});

/** The cell an event happened in, if any. */
const cellOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>("button[data-cell]") : null);

/** What the grid tells its cells' tooltip. */
interface CellTipControl {
  /** The pointer is over this cell; null: over a gap between cells, or gone from the grid. */
  hover: (cell: HTMLElement | null) => void;
  /** Keyboard focus is on this cell; null: it has left the cells. */
  focus: (cell: HTMLElement | null) => void;
  /** A press on the grid: the tooltip closes until the pointer moves to another cell. */
  press: () => void;
}

/**
 * The cells' one tooltip ("Copies U+00DF (glyph “germandbls”)"), on the cell the pointer rests on
 * or keyboard focus is on, with the app's timing (components/Tip.tsx): it opens once the pointer
 * rests for TIP_DELAY, and at once while one is open or has just closed. It's one for the whole
 * grid, not a Tip per cell, because a block can hold tens of thousands of cells (Show all), and
 * every tooltip trigger costs its cell hooks and window listeners: here the grid's own pointer and
 * focus events drive it, and it sits on an empty box moved over the cell (that box only places
 * it). Its words are for sight only: each cell's name already says them.
 */
function CellTip({ control }: { control: React.Ref<CellTipControl> }) {
  const [tip, setTip] = useState<{ open: boolean; text: string; box?: React.CSSProperties }>({ open: false, text: "" });
  const timer = useRef<number | undefined>(undefined);
  const now = useRef({
    /** The cell it's on (or waiting to open on), and what opened it. */
    cell: null as HTMLElement | null,
    by: null as "hover" | "focus" | null,
    /** The cell pressed: no tooltip on it until the pointer leaves it. */
    pressed: null as HTMLElement | null,
    closedAt: -Infinity,
  });
  const openOn = (cell: HTMLElement, by: "hover" | "focus") => {
    window.clearTimeout(timer.current);
    Object.assign(now.current, { cell, by });
    setTip({
      open: true,
      text: cell.dataset.tip ?? "",
      box: { top: cell.offsetTop, left: cell.offsetLeft, width: cell.offsetWidth, height: cell.offsetHeight },
    });
  };
  const close = () => {
    window.clearTimeout(timer.current);
    if (now.current.by) now.current.closedAt = performance.now();
    Object.assign(now.current, { cell: null, by: null });
    setTip((t) => (t.open ? { ...t, open: false } : t));
  };
  useImperativeHandle(
    control,
    () => ({
      hover(cell) {
        const n = now.current;
        if (cell !== n.pressed) n.pressed = null;
        if (cell && (cell === n.pressed || cell === n.cell)) return;
        if (!cell) {
          // Leaving the cells closes one the pointer opened; one keyboard focus opened stays.
          if (n.by !== "focus") close();
          return;
        }
        // While one is open, or just after, the next opens at once (as the app's other tooltips do).
        if (n.by || performance.now() - n.closedAt < TIP_INSTANT_WINDOW) return openOn(cell, "hover");
        window.clearTimeout(timer.current);
        n.cell = cell;
        timer.current = window.setTimeout(() => openOn(cell, "hover"), TIP_DELAY);
      },
      focus(cell) {
        if (cell) openOn(cell, "focus");
        else if (now.current.by === "focus") close();
      },
      press() {
        now.current.pressed = now.current.cell;
        close();
      },
    }),
    [],
  );
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <Tooltip open={tip.open} onOpenChange={(open) => !open && close()}>
      <TooltipTrigger render={<span aria-hidden className="pointer-events-none absolute" style={tip.box} />} />
      <TooltipContent>{tip.text}</TooltipContent>
    </Tooltip>
  );
}
