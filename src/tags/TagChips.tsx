import type { FontSummary } from "@/api";
import type { Face } from "@/library";
import { CutShort, Tip, type TipHandle } from "@/components/Tip";
import { cn } from "@/lib/utils";
import { colorVar, type Tag } from "./api";
import type { Locations } from "./locations";
import { leafOf, type TagIndex } from "./model";

/**
 * A tag as a small pill: a dot in its color, then its name. Text stays in the body color. A
 * nested tag shows only its own part of the name; its whole name (and how many styles have it,
 * for a dashed one) is the tooltip on its words. `tipHandle`: a list's shared tooltip.
 */
export function TagChip({ tag, partial, className, tipHandle }: { tag: Tag; partial?: string; className?: string; tipHandle?: TipHandle }) {
  const leaf = leafOf(tag.name);
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-40 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] leading-none text-foreground",
        partial && "border border-dashed",
        className,
      )}
      style={{
        background: `color-mix(in oklch, ${colorVar(tag.color)} var(--tag-tint), transparent)`,
        borderColor: partial ? colorVar(tag.color) : undefined,
      }}
    >
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: colorVar(tag.color) }} aria-hidden />
      <CutShort tip={partial ? `${tag.name}: ${partial}` : tag.name} more={!!partial || leaf !== tag.name} handle={tipHandle}>
        <span className="truncate" aria-hidden>
          {leaf}
        </span>
      </CutShort>
    </span>
  );
}

/**
 * The tags on some faces (one style, or a family's styles). A tag only some of them have is
 * drawn dashed. Shows at most `max`, then "+n". `srId` goes on the screen-reader text ("Tags:
 * …", every tag), so a list row can point its description at it.
 */
export function TagChips({ faces, index, max = 3, srId, tipHandle }: { faces: Face[]; index: TagIndex; max?: number; srId?: string; tipHandle?: TipHandle }) {
  const counts = new Map<number, number>();
  for (const face of faces) for (const id of index.tagsOf(face)) counts.set(id, (counts.get(id) ?? 0) + 1);
  if (!counts.size) return null;
  const ordered = index.ordered.filter((n) => counts.has(n.tag.id)).map((n) => n.tag);
  const shown = ordered.slice(0, max);
  const rest = ordered.slice(max);
  const label = ordered
    .map((t) => (counts.get(t.id)! < faces.length ? `${t.name} (on ${counts.get(t.id)} of ${faces.length} styles)` : t.name))
    .join(", ");
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="sr-only" id={srId}>
        Tags: {label}.
      </span>
      {shown.map((t) => {
        const n = counts.get(t.id)!;
        return <TagChip key={t.id} tag={t} partial={n < faces.length ? `${n} of ${faces.length} styles` : undefined} tipHandle={tipHandle} />;
      })}
      {rest.length > 0 && (
        // The names it stands for, as a tooltip.
        <Tip tip={rest.map((t) => t.name).join(", ")} handle={tipHandle} contentClassName="max-w-md">
          <span className="shrink-0 text-[11px] text-muted-foreground" aria-hidden>
            +{rest.length}
          </span>
        </Tip>
      )}
    </span>
  );
}

/**
 * The tags on some faces as colored dots (Tiles' card footer): at most `max`, then "+n". A tag
 * only some of them have is a ring instead of a dot. Every name is in the tooltip (the dots have
 * no words) and in the screen-reader text ("Tags: …", on `srId`), so the color is never the only
 * sign. `tipHandle`: a list's shared tooltip.
 */
export function TagDots({ faces, index, max = 4, srId, tipHandle }: { faces: Face[]; index: TagIndex; max?: number; srId?: string; tipHandle?: TipHandle }) {
  const counts = new Map<number, number>();
  for (const face of faces) for (const id of index.tagsOf(face)) counts.set(id, (counts.get(id) ?? 0) + 1);
  if (!counts.size) return null;
  const ordered = index.ordered.filter((n) => counts.has(n.tag.id)).map((n) => n.tag);
  const partial = (t: Tag) => counts.get(t.id)! < faces.length;
  const label = ordered.map((t) => (partial(t) ? `${t.name} (on ${counts.get(t.id)} of ${faces.length} styles)` : t.name)).join(", ");
  const rest = ordered.length - max;
  return (
    <Tip tip={ordered.map((t) => t.name).join(", ")} handle={tipHandle} contentClassName="max-w-md">
      <span className="flex shrink-0 items-center gap-1">
        <span className="sr-only" id={srId}>
          Tags: {label}.
        </span>
        {ordered.slice(0, max).map((t) => (
          <span
            key={t.id}
            aria-hidden
            className="size-2 rounded-full"
            style={partial(t) ? { boxShadow: `inset 0 0 0 1.5px ${colorVar(t.color)}` } : { background: colorVar(t.color) }}
          />
        ))}
        {rest > 0 && (
          <span className="text-[11px] text-muted-foreground" aria-hidden>
            +{rest}
          </span>
        )}
      </span>
    </Tip>
  );
}

/**
 * Small dots in the colors of the places these copies live. Several dots when copies are in
 * differently colored places. Hover lists the places. `srId` goes on the screen-reader text
 * ("In …").
 */
export function LocationDots({
  copies,
  locations,
  max = 3,
  srId,
  tipHandle,
}: {
  copies: FontSummary[];
  locations: Locations;
  max?: number;
  srId?: string;
  /** A list's shared tooltip, so each row doesn't mount one of its own. */
  tipHandle?: TipHandle;
}) {
  const byColor = new Map<string, Set<string>>();
  for (const c of copies) {
    const color = locations.colorOfCopy(c);
    let places = byColor.get(color);
    if (!places) byColor.set(color, (places = new Set()));
    places.add(locations.describeCopy(c));
  }
  if (!byColor.size) return null;
  const places = [...new Set([...byColor.values()].flatMap((s) => [...s]))];
  // Screen readers hear the places in the dots' own words (srId), so the tooltip adds none.
  return (
    <Tip
      tip={
        // One place per line.
        <div className="flex min-w-0 flex-col">
          {places.slice(0, 8).map((p) => (
            <div key={p} className="truncate">
              {p}
            </div>
          ))}
          {places.length > 8 && <div className="text-background/70">and {places.length - 8} more</div>}
        </div>
      }
      contentClassName="max-w-md"
      handle={tipHandle}
    >
      <span onClick={(e) => e.stopPropagation()} className="flex shrink-0 items-center gap-0.5">
        <span className="sr-only" id={srId}>
          In {places.join("; ")}.
        </span>
        {[...byColor.keys()].slice(0, max).map((color) => (
          <span key={color} className="size-2 rounded-full" style={{ background: colorVar(color) }} />
        ))}
      </span>
    </Tip>
  );
}
