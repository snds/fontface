import type { FontSummary } from "@/api";
import type { Face } from "@/library";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { colorVar, type Tag } from "./api";
import type { Locations } from "./locations";
import { leafOf, type TagIndex } from "./model";

/** A tag as a small pill: a dot in its color, then its name. Text stays in the body color. */
export function TagChip({ tag, partial, className }: { tag: Tag; partial?: string; className?: string }) {
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
      title={partial ? `${tag.name}: ${partial}` : tag.name}
    >
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: colorVar(tag.color) }} aria-hidden />
      <span className="truncate" aria-hidden>
        {leafOf(tag.name)}
      </span>
    </span>
  );
}

/**
 * The tags on some faces (one style, or a family's styles). A tag only some of them have is
 * drawn dashed. Shows at most `max`, then "+n".
 */
export function TagChips({ faces, index, max = 3 }: { faces: Face[]; index: TagIndex; max?: number }) {
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
      <span className="sr-only">Tags: {label}.</span>
      {shown.map((t) => {
        const n = counts.get(t.id)!;
        return <TagChip key={t.id} tag={t} partial={n < faces.length ? `${n} of ${faces.length} styles` : undefined} />;
      })}
      {rest.length > 0 && (
        <span className="shrink-0 text-[11px] text-muted-foreground" title={rest.map((t) => t.name).join(", ")}>
          +{rest.length}
        </span>
      )}
    </span>
  );
}

/**
 * Small dots in the colors of the places these copies live. Several dots when copies are in
 * differently colored places. Hover lists the places.
 */
export function LocationDots({ copies, locations, max = 3 }: { copies: FontSummary[]; locations: Locations; max?: number }) {
  const byColor = new Map<string, Set<string>>();
  for (const c of copies) {
    const color = locations.colorOfCopy(c);
    let places = byColor.get(color);
    if (!places) byColor.set(color, (places = new Set()));
    places.add(locations.describeCopy(c));
  }
  if (!byColor.size) return null;
  const places = [...new Set([...byColor.values()].flatMap((s) => [...s]))];
  return (
    <Tooltip>
      <TooltipTrigger render={<span onClick={(e) => e.stopPropagation()} />} className="flex shrink-0 items-center gap-0.5">
        <span className="sr-only">In {places.join("; ")}.</span>
        {[...byColor.keys()].slice(0, max).map((color) => (
          <span key={color} className="size-2 rounded-full" style={{ background: colorVar(color) }} />
        ))}
      </TooltipTrigger>
      <TooltipContent className="max-w-md">
        {places.slice(0, 8).map((p) => (
          <div key={p} className="truncate">
            {p}
          </div>
        ))}
        {places.length > 8 && <div className="text-muted-foreground">and {places.length - 8} more</div>}
      </TooltipContent>
    </Tooltip>
  );
}
