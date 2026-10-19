import { useEffect, useId, useRef, useState } from "react";
import { addToCompare, COMPARE_MAX, COMPARE_TEXT, focusAfterMove, moveInCompare, removeFromCompare, replaceInCompare, shownFamilies, type CompareList } from "@/compare";
import { faceName, useFontFace, type FaceState } from "@/fontLoader";
import { isSampleKind, usePreviewProfile } from "@/previewProfiles";
import { sampleFor } from "@/sampleText";
import type { Face, Family } from "@/library";
import type { CompareMode, ComparePageEntry, PagePatch } from "@/nav";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { ChoiceGroup } from "./ChoiceGroup";
import { MissingHint } from "./FacePreview";
import { useFontPicker } from "./FontPicker";
import { BackButton, styleLabel } from "./fontPage/PageHeader";
import { FaceStateMessage } from "./fontPage/parts";
import { dragRegion, NO_DRAG, useTitleBar } from "./TitleBar";

/** A face found by its key, with its whole family (App's `familyOfFace`). */
export interface FaceRef {
  family: Family;
  face: Face;
}

/** The sizes each mode starts at, and its slider's range. */
const SIZES: Record<CompareMode, { start: number; min: number; max: number }> = {
  lines: { start: 40, min: 12, max: 128 },
  columns: { start: 16, min: 10, max: 32 },
};

interface Props {
  page: ComparePageEntry;
  faceOf: (key: string) => FaceRef | undefined;
  /** What Back returns to, in words. */
  placeName: string;
  /** The toolbar's preview text, used until you type text here. */
  previewText: string;
  onBack: () => void;
  onChange: (patch: PagePatch) => void;
  /** Opens a font's page over this one; focus comes back to `returnTo` (an element id). */
  onOpen: (faceKey: string, returnTo: string) => void;
  announce: (text: string) => void;
}

/**
 * Compare (from the selection bar, a font's menus or the Font menu): the same text in 2 to 8
 * fonts. Lines stacks one line per font; Columns sets a paragraph in each, side by side. One
 * text field and one size drive every font, and each has its own style picker, so a family is
 * compared in any of its styles. Fonts can be added (the library search), moved and removed;
 * with more than 8 asked for, the rest are left out and a note says so.
 */
export function ComparePage({ page, faceOf, placeName, previewText, onBack, onChange, onOpen, announce }: Props) {
  const titleBar = useTitleBar();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const base = useId();
  const pick = useFontPicker();
  const [text, setText] = useState("");
  const [sizes, setSizes] = useState<Record<CompareMode, number>>({ lines: SIZES.lines.start, columns: SIZES.columns.start });
  useEffect(() => headingRef.current?.focus({ preventScroll: true }), []);

  const mode = page.mode;
  const size = sizes[mode];
  const list: CompareList = { faces: page.faces, left: page.left };
  const update = (next: CompareList) => onChange({ faces: next.faces, left: next.left });
  // What you typed (here, else in the toolbar) is shown as typed; else each font shows these
  // words, or text it can draw (sampleText.ts).
  const typed = text || previewText;
  const count = page.faces.length;
  const laneName = (ref: FaceRef | undefined) => (ref ? `${ref.family.name} ${styleLabel(ref.face)}` : "A font that's no longer in your library");
  const openId = (i: number) => `${base}-open-${i}`;
  const moveId = (i: number, by: -1 | 1) => `${base}-move-${i}-${by < 0 ? "up" : "down"}`;

  const addFonts = () =>
    pick({
      title: "Add fonts to compare",
      description: `Compare shows up to ${COMPARE_MAX} fonts at once.`,
      multiple: true,
      confirm: "Add",
      // A family adds its usual style: one already shown in that style isn't offered again.
      exclude: shownFamilies(page.faces, faceOf),
      onPick: (families) => {
        const next = addToCompare(list, families.map((f) => f.representative.key));
        update(next);
        const added = next.faces.length - list.faces.length;
        announce(next.left ? `Added ${added}; ${next.left} more didn't fit` : `Added ${added} to Compare`);
      },
    });

  const remove = (key: string, i: number) => {
    const ref = faceOf(key);
    update(removeFromCompare(list, key));
    announce(`Removed ${laneName(ref)}`);
    // Focus goes to the font that took its place, else the one before, else Add Fonts.
    requestAnimationFrame(() => (document.getElementById(openId(i)) ?? document.getElementById(openId(i - 1)) ?? addRef.current)?.focus());
  };

  // Lanes are keyed by place, not by font: choosing another style keeps the lane (and its focused
  // style picker) where it is, and moving one keeps every lane's controls in place, with focus
  // following the moved font (below).
  const lanes = page.faces.map((key, i) => {
    const ref = faceOf(key);
    return (
      <Lane
        key={i}
        mode={mode}
        name={laneName(ref)}
        face={ref}
        openId={openId(i)}
        moveId={(by) => moveId(i, by)}
        typed={typed}
        words={COMPARE_TEXT[mode]}
        size={size}
        first={i === 0}
        last={i === count - 1}
        taken={page.faces}
        onOpen={() => onOpen(key, openId(i))}
        onStyle={(to) => update(replaceInCompare(list, key, to))}
        onMove={(by) => {
          update(moveInCompare(list, key, by));
          announce(`Moved ${laneName(ref)} ${by < 0 ? (mode === "lines" ? "up" : "left") : mode === "lines" ? "down" : "right"}`);
          // Focus goes with the font to its new place (the other Move button once it's at the end).
          const next = focusAfterMove(i, by, count);
          if (next) requestAnimationFrame(() => document.getElementById(moveId(next.lane, next.by))?.focus());
        }}
        onRemove={() => remove(key, i)}
      />
    );
  });

  return (
    <>
      <header className="@container/pagehead flex h-13 shrink-0 items-center gap-2 overflow-hidden border-b px-3 select-none" {...dragRegion(titleBar)}>
        <BackButton placeName={placeName} onBack={onBack} />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h1 ref={headingRef} tabIndex={-1} className="truncate text-base font-semibold outline-none">
            Compare
          </h1>
          <span className="shrink-0 text-xs text-muted-foreground @max-[520px]/pagehead:sr-only">
            {count} {count === 1 ? "font" : "fonts"}
          </span>
        </div>
        <ChoiceGroup<CompareMode>
          label="Show as"
          value={mode}
          onChange={(m) => onChange({ mode: m })}
          options={[
            { value: "lines", label: <span className="flex items-center gap-1"><Icon name="view_agenda" size={14} />Lines</span> },
            { value: "columns", label: <span className="flex items-center gap-1"><Icon name="view_column" size={14} />Columns</span> },
          ]}
        />
        <Button ref={addRef} variant="outline" size="sm" disabled={count >= COMPARE_MAX} onClick={addFonts}>
          <Icon name="add" size={16} />
          <span className="@max-[640px]/pagehead:sr-only">Add Fonts…</span>
        </Button>
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-6 py-2.5">
        <div className="relative min-w-48 flex-1">
          <Icon name="text_fields" size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Text to compare" placeholder={previewText || COMPARE_TEXT[mode]} value={text} onChange={(e) => setText(e.target.value)} className="pl-8" />
        </div>
        <SizeSlider
          label="Size"
          value={size}
          min={SIZES[mode].min}
          max={SIZES[mode].max}
          onChange={(v) => setSizes((s) => ({ ...s, [mode]: v }))}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {page.left > 0 && (
          <p className="mx-6 mt-4 flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm" role="note">
            <Icon name="info" size={16} className="mt-0.5 text-muted-foreground" />
            <span>
              Compare shows up to {COMPARE_MAX} fonts at once, so {page.left.toLocaleString()} of the fonts you chose {page.left === 1 ? "isn't" : "aren't"} shown. Remove one to make room.
            </span>
          </p>
        )}
        {count < 2 && (
          <div className="mx-6 mt-4 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <span>{count === 0 ? "No fonts to compare yet." : "Add another font to compare it with."}</span>
            <Button variant="outline" size="sm" onClick={addFonts}>
              <Icon name="add" size={16} />
              Add Fonts…
            </Button>
          </div>
        )}
        {mode === "lines" ? (
          <div className="flex flex-col pb-10">{lanes}</div>
        ) : (
          <div className="grid gap-x-6 gap-y-8 px-6 pt-5 pb-12" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(16rem, 1fr))" }}>
            {lanes}
          </div>
        )}
      </div>
    </>
  );
}

/** One font in Compare: its name (opens its page), its style picker, Move and Remove, and the text. */
function Lane({
  mode,
  name,
  face,
  openId,
  moveId,
  typed,
  words,
  size,
  first,
  last,
  taken,
  onOpen,
  onStyle,
  onMove,
  onRemove,
}: {
  mode: CompareMode;
  name: string;
  face: FaceRef | undefined;
  openId: string;
  /** The Move buttons' ids (focus follows a moved font). */
  moveId: (by: -1 | 1) => string;
  /** Text you typed, shown as typed; else `words`, or text the font can draw. */
  typed: string;
  words: string;
  size: number;
  first: boolean;
  last: boolean;
  /** Face keys shown in any lane: not offered again in this lane's style picker. */
  taken: readonly string[];
  onOpen: () => void;
  onStyle: (faceKey: string) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const lines = mode === "lines";
  const { profile } = usePreviewProfile(face?.face.primary);
  return (
    <section aria-label={name} className={cn("flex min-w-0 flex-col gap-2", lines ? "border-b px-6 py-4" : "")}>
      <div className="flex min-w-0 items-center gap-2">
        {face ? (
          <>
            <Button id={openId} variant="link" size="sm" className="h-auto min-w-0 px-0 text-sm font-semibold text-foreground" onClick={onOpen} aria-label={`Open ${face.family.name}`}>
              <span className="truncate">{face.family.name}</span>
            </Button>
            <StylePicker face={face} taken={taken} onChange={onStyle} />
            {/* Typed text this font can't draw: those characters show in another font. */}
            {typed && <MissingHint text={typed} profile={profile} />}
          </>
        ) : (
          <span id={openId} tabIndex={-1} className="truncate text-sm text-muted-foreground italic outline-none">
            This font isn't in your library anymore.
          </span>
        )}
        <span className="flex-1" />
        <Button id={moveId(-1)} variant="ghost" size="icon-xs" disabled={first} aria-label={`Move ${name} ${lines ? "up" : "left"}`} onClick={() => onMove(-1)}>
          <Icon name={lines ? "arrow_upward" : "arrow_back"} size={16} />
        </Button>
        <Button id={moveId(1)} variant="ghost" size="icon-xs" disabled={last} aria-label={`Move ${name} ${lines ? "down" : "right"}`} onClick={() => onMove(1)}>
          <Icon name={lines ? "arrow_downward" : "arrow_forward"} size={16} />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label={`Remove ${name} from Compare`} onClick={onRemove}>
          <Icon name="close" size={16} />
        </Button>
      </div>
      {face && <FaceSample face={face.face} typed={typed} words={words} size={size} lineHeight={lines ? 1.2 : 1.5} />}
    </section>
  );
}

/** A style picker for one font: the other styles of its family. */
export function StylePicker({ face, taken = [], label = "Style", onChange }: { face: FaceRef; taken?: readonly string[]; label?: string; onChange: (faceKey: string) => void }) {
  if (face.family.faces.length < 2) return <span className="truncate text-xs text-muted-foreground">{styleLabel(face.face)}</span>;
  return (
    <Select
      value={face.face.key}
      onValueChange={(key) => typeof key === "string" && onChange(key)}
      items={face.family.faces.map((f) => ({ value: f.key, label: styleLabel(f) }))}
    >
      <SelectTrigger size="sm" aria-label={`${label} of ${face.family.name}`} className="max-w-56 min-w-24">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-80">
        {face.family.faces.map((f) => (
          <SelectItem key={f.key} value={f.key} disabled={f.key !== face.face.key && taken.includes(f.key)}>
            <span className="truncate">{styleLabel(f)}</span>
            <span className="ml-auto pl-3 font-mono text-xs text-muted-foreground">{f.traits.weight}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A labelled size slider with its value in px. It doesn't move the window (title bar). */
export function SizeSlider({ label, value, min, max, step = 1, unit = "px", onChange }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <div className="flex w-52 shrink-0 items-center gap-2" {...NO_DRAG}>
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <Slider min={min} max={max} step={step} value={[value]} onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)} aria-label={label} />
      <span className="w-12 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums">
        {value}
        {unit}
      </span>
    </div>
  );
}

/**
 * Text set in one style, wrapping: what you typed, else `words` if the font can draw them, else
 * text it can (sampleText.ts), so a caps-only, symbol or non-Latin font never shows another
 * font's letters under its own name. A sample of the font's characters (not words) is hidden from
 * screen readers. Hidden while its font loads; a font that can't be drawn says why.
 */
export function FaceSample({
  face,
  typed = "",
  words,
  size,
  lineHeight,
  className,
  style,
}: {
  face: Face;
  typed?: string;
  words: string;
  size: number;
  lineHeight: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const state: FaceState = useFontFace(face.primary, true);
  const { profile } = usePreviewProfile(face.primary);
  if (state !== "loading" && state !== "ready") return <FaceStateMessage state={state} />;
  const name = faceName(face.primary);
  const text = sampleFor(typed, words, profile, face.primary.family);
  const sample = !typed && text === profile?.familyText && isSampleKind(profile);
  return (
    <div
      dir="ltr"
      data-face={name}
      aria-hidden={sample || undefined}
      className={cn("break-words transition-opacity", state === "loading" && "preview-loading", className)}
      style={{ ...style, fontFamily: `"${name}"`, fontSize: size, lineHeight }}
    >
      {text}
    </div>
  );
}
