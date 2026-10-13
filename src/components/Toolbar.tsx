import type { StatusFilter } from "@/library";
import { Icon } from "@/components/ui/icon";
import { ChoiceGroup } from "./ChoiceGroup";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { dragRegion, NO_DRAG, useTitleBar } from "./TitleBar";

interface Props {
  query: string;
  onQuery: (q: string) => void;
  previewText: string;
  onPreviewText: (t: string) => void;
  status: StatusFilter;
  onStatus: (s: StatusFilter) => void;
  variableOnly: boolean;
  onVariableOnly: (on: boolean) => void;
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

export function Toolbar({
  query,
  onQuery,
  previewText,
  onPreviewText,
  status,
  onStatus,
  variableOnly,
  onVariableOnly,
  size,
  onSize,
  familyCount,
  fontCount,
}: Props) {
  const titleBar = useTitleBar();
  return (
    // On macOS this row is also the window's title bar (see TitleBar.tsx). It's often narrow:
    // at the default window size with a font selected it gets about 680px. So it gives way in
    // steps as it narrows (container queries on the width inside its padding): under 960px the
    // count goes (screen readers still hear it); under 880px Variable shows only its icon and the
    // size slider gets shorter; under 620px the preview text box goes, and under 520px the
    // slider. Search always keeps room to type, and nothing paints past the edge into the detail
    // panel.
    <header
      className="@container/toolbar flex h-13 shrink-0 items-center gap-3 overflow-hidden border-b px-4 select-none"
      {...dragRegion(titleBar)}
    >
      {/* All / Active / Inactive and Variable narrow whatever view is selected in the sidebar. */}
      <div className="flex shrink-0 items-center gap-1.5">
        <ChoiceGroup label="Show fonts" value={status} options={STATUS} onChange={onStatus} />
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-pressed={variableOnly}
                onClick={() => onVariableOnly(!variableOnly)}
                className={cn(
                  "flex h-7.5 items-center gap-1 rounded-lg border px-2 text-xs whitespace-nowrap",
                  variableOnly
                    ? "bg-secondary font-medium text-secondary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              />
            }
          >
            <Icon name="line_weight" size={16} />
            {/* The name stays for screen readers when only the icon shows. */}
            <span className="@max-[880px]/toolbar:sr-only">Variable</span>
          </TooltipTrigger>
          <TooltipContent>Show only variable fonts</TooltipContent>
        </Tooltip>
      </div>
      <div className="relative w-56 min-w-36">
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
      <div className="relative min-w-32 flex-1 @max-[880px]/toolbar:min-w-24 @max-[620px]/toolbar:hidden">
        <Icon name="text_fields" size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Type to preview…"
          aria-label="Preview text"
          value={previewText}
          onChange={(e) => onPreviewText(e.target.value)}
          className="pl-8"
        />
      </div>
      {/* Tauri doesn't see a slider as clickable, so keep it from moving the window. */}
      <div
        className="flex w-44 shrink-0 items-center gap-2 @max-[880px]/toolbar:w-32 @max-[520px]/toolbar:hidden"
        {...NO_DRAG}
      >
        <Icon name="format_size" size={16} className="text-muted-foreground" />
        <Slider
          min={10}
          max={128}
          value={[size]}
          onValueChange={(v) => onSize(Array.isArray(v) ? v[0] : v)}
          aria-label="Preview size"
        />
        <span className="w-11 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums">{size}px</span>
      </div>
      <span className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums @max-[960px]/toolbar:sr-only">
        {familyCount.toLocaleString()} fam · {fontCount.toLocaleString()} styles
      </span>
    </header>
  );
}
