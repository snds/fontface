import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, type CharacterBlock, type FontCharacters } from "@/api";
import type { FaceState } from "@/fontLoader";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The detail panel's character grid: every real character of the face (placeholders and empty
// slots left out), by Unicode block. Backed by `font_characters`, worked out on demand.

export type CharactersState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: FontCharacters };

/** Reads a face's characters when the panel opens it. */
export function useFontCharacters(fontId: number): CharactersState {
  const [state, setState] = useState<CharactersState>({ status: "loading" });
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    api.fontCharacters(fontId).then(
      (data) => live && setState({ status: "ready", data }),
      (e) => live && setState({ status: "error", message: String(e) }),
    );
    return () => {
      live = false;
    };
  }, [fontId]);
  return state;
}

/** Shown at first, per block; the rest wait for "Show all". */
const FIRST_CELLS = 512;
/** Cell height in px. */
const CELL = 44;

const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

const count = (b: CharacterBlock) => b.runs.reduce((n, [a, z]) => n + z - a + 1, 0);

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
  let main: string;
  if (d.total === 0) main = "No characters with a visible shape";
  else if (d.expert) main = `Expert set: ${plural(d.total, "real character")}`;
  else if (d.blocks.length === 1) {
    const b = d.blocks[0];
    const first = b.runs[0][0];
    const last = b.runs[b.runs.length - 1][1];
    main = `${plural(d.total, "character")}, all in ${b.name} (${hex(first)}–${hex(last)})`;
  } else main = `${plural(d.total, "character")} in ${d.blocks.length} Unicode blocks`;
  const symbol = d.lookup === "symbol" ? " This font uses an old symbol encoding, so typing a letter draws whatever is in that letter's slot." : "";
  const limited = d.limited ? " It's too large or damaged to check every character, so some may be missing here." : "";
  return `${[main, ...hidden].join("; ")}.${symbol}${limited}`;
}

/** The info section's "Character set" line. */
export function characterSetLine(d: FontCharacters, label: string | undefined): string {
  const biggest = [...d.blocks].sort((a, b) => count(b) - count(a))[0];
  const where = d.blocks.length > 1 ? `, mostly ${biggest.name}` : biggest ? `, ${biggest.name}` : "";
  return `${label ? `${label} · ` : ""}${plural(d.total, "character")}${where}`;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older engines: copy through a hidden text field.
    const field = document.createElement("textarea");
    field.value = text;
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand("copy");
    field.remove();
    return ok;
  }
}

async function copyCharacter(cp: number, name: string) {
  const ok = await copy(String.fromCodePoint(cp));
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
  fontVariationSettings?: string;
  /** Whether the face has loaded: cells stay hidden (and out of the Tab order) while it loads,
   *  and aren't shown at all if it can't load. */
  fontState: FaceState;
}

/** Memoized: the detail panel re-renders on every keystroke in the preview field, and a block
 *  can hold tens of thousands of cells. */
export const CharacterGrid = memo(function CharacterGrid({ state, fontFamily, face, fontVariationSettings, fontState }: Props) {
  if (state.status === "loading") return <p className="text-xs text-muted-foreground">Reading characters…</p>;
  if (state.status === "error") return <p className="text-xs text-muted-foreground italic">{state.message}</p>;
  if (fontState !== "loading" && fontState !== "ready") {
    // Cells would draw in another font, or not at all.
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">{charactersSummary(state.data)}</p>
        <p className="text-xs text-muted-foreground italic">The font couldn't be loaded here, so its characters can't be drawn.</p>
      </div>
    );
  }
  return (
    <Grid data={state.data} fontFamily={fontFamily} face={face} fontVariationSettings={fontVariationSettings} ready={fontState === "ready"} />
  );
});

interface GridProps {
  data: FontCharacters;
  fontFamily: string;
  face?: string;
  fontVariationSettings?: string;
  ready: boolean;
}

function Grid({ data, fontFamily, face, fontVariationSettings, ready }: GridProps) {
  const dominant = useMemo(() => [...data.blocks].sort((a, b) => count(b) - count(a))[0]?.name ?? "", [data]);
  const [blockName, setBlockName] = useState(dominant);
  const [showAll, setShowAll] = useState(false);
  const [focus, setFocus] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  /** "Show all" was used: once the new cells are there, focus the first of them. */
  const focusFirstNew = useRef(false);
  useEffect(() => {
    setBlockName(dominant);
  }, [dominant]);
  useEffect(() => {
    setShowAll(false);
    setFocus(0);
  }, [blockName]);
  useEffect(() => {
    if (!showAll || !focusFirstNew.current) return;
    focusFirstNew.current = false;
    gridRef.current?.querySelectorAll<HTMLButtonElement>("button[data-cell]")[FIRST_CELLS]?.focus();
  }, [showAll]);

  const block = data.blocks.find((b) => b.name === blockName) ?? data.blocks[0];
  const all = useMemo(() => (block ? codePoints(block) : []), [block]);
  const shown = showAll ? all : all.slice(0, FIRST_CELLS);

  // Cells fit the ink most characters stay within, centred; outliers may be cut at the edge.
  const tall = data.inkTop + data.inkBottom;
  const size = Math.min(26, tall > 0 ? (CELL - 10) / tall : 26);
  const baseline = CELL / 2 + (size * (data.inkTop - data.inkBottom)) / 2;
  const lineHeight = Math.max(0, 2 * baseline - size * (data.ascent - data.descent));
  const glyphStyle = useMemo<React.CSSProperties>(
    () => ({ height: CELL, fontFamily, fontVariationSettings, fontSize: size, lineHeight: `${lineHeight}px` }),
    [fontFamily, fontVariationSettings, size, lineHeight],
  );
  const onCopy = useCallback((cp: number, name: string) => void copyCharacter(cp, name), []);

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
      Home: -focus,
      End: cells.length - 1 - focus,
    };
    const step = moves[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const next = Math.min(cells.length - 1, Math.max(0, focus + step));
    setFocus(next);
    cells[next].focus();
  };

  if (!block) return <p className="text-xs text-muted-foreground">{charactersSummary(data)}</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{charactersSummary(data)}</p>
      {data.blocks.length > 1 && (
        <div role="group" aria-label="Unicode blocks" className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
          {data.blocks.map((b) => (
            <Button
              key={b.name}
              size="xs"
              variant={b.name === block.name ? "secondary" : "ghost"}
              aria-pressed={b.name === block.name}
              onClick={() => setBlockName(b.name)}
            >
              {b.name}
              <span className="font-mono text-muted-foreground tabular-nums">{count(b).toLocaleString()}</span>
            </Button>
          ))}
        </div>
      )}
      <div
        ref={gridRef}
        role="group"
        data-face={face}
        aria-label={`Characters in ${block.name}. Arrow keys move; Enter copies.`}
        // Hidden while the face loads: out of the Tab order too, so focus can't land on it.
        inert={!ready}
        className={cn("grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-1 transition-opacity", !ready && "preview-loading")}
        onKeyDown={onKeyDown}
      >
        {shown.map((cp, i) => (
          <Cell key={cp} cp={cp} index={i} name={block.glyphNames[i] ?? ""} tabbable={i === focus} glyphStyle={glyphStyle} onFocusCell={setFocus} onCopy={onCopy} />
        ))}
      </div>
      {!showAll && all.length > FIRST_CELLS && (
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
          Show all {all.length.toLocaleString()}
        </Button>
      )}
    </div>
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

/** One character. Memoized: moving focus re-renders two cells, not the whole block. */
const Cell = memo(function Cell({ cp, index, name, tabbable, glyphStyle, onFocusCell, onCopy }: CellProps) {
  return (
    <button
      type="button"
      data-cell
      tabIndex={tabbable ? 0 : -1}
      title={`${hex(cp)}${name ? ` · ${name}` : ""}`}
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
