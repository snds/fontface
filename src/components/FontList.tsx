import { useLayoutEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FontSummary } from "@/api";
import { activationIds, type Face, type Family } from "@/library";
import { faceName, useFontFace } from "@/fontLoader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ActivationSwitch, InstalledBadge } from "./ActivationSwitch";

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
  onSelect: (id: number) => void;
  onActivate: (ids: number[], active: boolean) => void;
}

export function FontList(props: Props) {
  const { families, expanded, size } = props;
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const family of families) {
      out.push({ kind: "family", family });
      if (expanded.has(family.name)) for (const face of family.faces) out.push({ kind: "face", face });
    }
    return out;
  }, [families, expanded]);

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

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" role="list">
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row.kind === "family" ? <FamilyRow {...props} family={row.family} /> : <FaceRow {...props} face={row.face} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const UNAVAILABLE: Record<string, { icon: string; text: string }> = {
  error: { icon: "error", text: "Preview unavailable" },
  cloud: { icon: "cloud_download", text: "Not downloaded yet: it's online-only in cloud storage" },
  "too-large": { icon: "data_usage", text: "Too large to preview" },
};

function Preview({ font, text, size }: { font: FontSummary; text: string; size: number }) {
  const state = useFontFace(font);
  const unavailable = UNAVAILABLE[state];
  if (unavailable) {
    return (
      <div className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground italic">
        <Icon name={unavailable.icon} size={14} />
        {unavailable.text}
      </div>
    );
  }
  return (
    <div
      className={cn("truncate leading-[1.3] transition-opacity", state === "loading" && "preview-loading")}
      style={{ fontFamily: `"${faceName(font)}"`, fontSize: size }}
    >
      {text || font.fullName || `${font.family} ${font.subfamily}`}
    </div>
  );
}

const rowClass = (selected: boolean) =>
  cn("cursor-default border-b px-4 pt-2.5 pb-3", selected ? "bg-accent" : "hover:bg-muted/50");

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

function FamilyRow({ family, expanded, onToggleExpanded, previewText, size, selectedId, busy, onSelect, onActivate }: Props & { family: Family }) {
  const isOpen = expanded.has(family.name);
  const duplicates = family.faces.some((f) => f.copies.length > 1);
  return (
    <div
      role="listitem"
      className={rowClass(family.faces.some((face) => face.copies.some((c) => c.id === selectedId)))}
      onClick={() => onSelect(family.representative.primary.id)}
    >
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
        <span className="flex flex-1 items-center gap-1.5 text-xs text-muted-foreground">
          {family.faces.length} {family.faces.length === 1 ? "style" : "styles"}
          {family.faces.some((f) => f.primary.variable) && <Badge variant="outline">Variable</Badge>}
          {family.faces.some((f) => f.primary.monospace) && <Badge variant="outline">Mono</Badge>}
          {duplicates && <Badge variant="outline">Duplicates</Badge>}
        </span>
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
        <Preview font={family.representative.primary} text={previewText || family.name} size={size} />
      </div>
    </div>
  );
}

function FaceRow({ face, previewText, size, selectedId, busy, onSelect, onActivate }: Props & { face: Face }) {
  const font = face.primary;
  return (
    <div
      role="listitem"
      className={cn(rowClass(face.copies.some((c) => c.id === selectedId)), "pl-12")}
      onClick={() => onSelect(font.id)}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="truncate text-sm font-medium">
          {font.subfamily}
          {font.variable && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(Variable)</span>}
        </span>
        <span className="flex flex-1 items-center gap-1.5 font-mono text-xs text-muted-foreground">
          {font.weight}
          {font.italic ? " · italic" : ""}
          <CopiesBadge face={face} />
        </span>
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
      <Preview font={font} text={previewText} size={size} />
    </div>
  );
}
