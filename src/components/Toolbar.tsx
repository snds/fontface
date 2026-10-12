import type { StatusFilter } from "@/library";
import { Icon } from "@/components/ui/icon";
import { ChoiceGroup } from "./ChoiceGroup";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";

interface Props {
  query: string;
  onQuery: (q: string) => void;
  previewText: string;
  onPreviewText: (t: string) => void;
  status: StatusFilter;
  onStatus: (s: StatusFilter) => void;
  size: number;
  onSize: (s: number) => void;
  familyCount: number;
  fontCount: number;
}

const STATUS: { value: StatusFilter; label: string }[] = [
  { value: "any", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

export function Toolbar({ query, onQuery, previewText, onPreviewText, status, onStatus, size, onSize, familyCount, fontCount }: Props) {
  return (
    <header className="flex h-13 shrink-0 items-center gap-3 border-b px-4">
      {/* All / Active / Inactive narrows whatever view is selected in the sidebar. */}
      <ChoiceGroup label="Show fonts" value={status} options={STATUS} onChange={onStatus} />
      <div className="relative w-56">
        <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Search fonts"
          aria-label="Search fonts"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          className="pl-8"
        />
      </div>
      <div className="relative min-w-32 flex-1">
        <Icon name="text_fields" size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Type to preview…"
          aria-label="Preview text"
          value={previewText}
          onChange={(e) => onPreviewText(e.target.value)}
          className="pl-8"
        />
      </div>
      <div className="flex w-44 items-center gap-2">
        <Icon name="format_size" size={16} className="text-muted-foreground" />
        <Slider
          min={10}
          max={128}
          value={[size]}
          onValueChange={(v) => onSize(Array.isArray(v) ? v[0] : v)}
          aria-label="Preview size"
        />
        <span className="w-11 text-right font-mono text-xs text-muted-foreground tabular-nums">{size}px</span>
      </div>
      <span className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">
        {familyCount.toLocaleString()} fam · {fontCount.toLocaleString()} styles
      </span>
    </header>
  );
}
