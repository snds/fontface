import type { LibraryLayout } from "@/api";
import type { StatusFilter } from "@/library";
import { Icon } from "@/components/ui/icon";
import { ChoiceGroup } from "./ChoiceGroup";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { dragRegion, NO_DRAG, useTitleBar } from "./TitleBar";
import { LayoutSwitch } from "./ViewOptions";

/** The search field's id, so ⌘F can focus it (also from a font page). */
export const LIBRARY_SEARCH_ID = "library-search";

interface Props {
  query: string;
  onQuery: (q: string) => void;
  previewText: string;
  onPreviewText: (t: string) => void;
  status: StatusFilter;
  onStatus: (s: StatusFilter) => void;
  /** All / Active / Inactive. Hidden in Active, where it would add nothing. */
  showStatus?: boolean;
  variableOnly: boolean;
  onVariableOnly: (on: boolean) => void;
  size: number;
  onSize: (s: number) => void;
  familyCount: number;
  fontCount: number;
  layout: LibraryLayout;
  onLayout: (layout: LibraryLayout) => void;
  /** The View options button and its popover. */
  viewOptions: React.ReactNode;
  /** On Google Fonts and Purchases: Browse, which opens the service's own page. */
  browse?: React.ReactNode;
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
  showStatus = true,
  variableOnly,
  onVariableOnly,
  size,
  onSize,
  familyCount,
  fontCount,
  layout,
  onLayout,
  viewOptions,
  browse,
}: Props) {
  const titleBar = useTitleBar();
  return (
    // On macOS this row is also the window's title bar (see TitleBar.tsx). It can be narrow (a
    // small window gives it well under 800px). So it gives way in steps as it narrows (container
    // queries on the width inside its padding): under 1120px the size slider and the preview
    // text box get shorter; under 990px the count goes (screen readers still hear it; on Google
    // Fonts and Purchases, with Browse, under 1180px); under 960px Variable shows only its icon
    // (Browse already does under 1000px); under 800px the layout switch folds into View options
    // and search gets narrower; under 620px the preview text box goes, and under 520px the
    // slider. Search always keeps room to type, and nothing paints past the window's edge.
    <header
      className="@container/toolbar flex h-13 shrink-0 items-center gap-3 overflow-hidden border-b px-4 select-none"
      {...dragRegion(titleBar)}
    >
      {/* All / Active / Inactive and Variable narrow whatever view is selected in the sidebar. */}
      <div className="flex shrink-0 items-center gap-1.5">
        {showStatus && <ChoiceGroup label="Show fonts" value={status} options={STATUS} onChange={onStatus} />}
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
            <span className="@max-[960px]/toolbar:sr-only">Variable</span>
          </TooltipTrigger>
          <TooltipContent>Show only variable fonts</TooltipContent>
        </Tooltip>
      </div>
      <div className="relative w-56 min-w-36 @max-[800px]/toolbar:min-w-32">
        <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={LIBRARY_SEARCH_ID}
          type="search"
          placeholder="Search fonts"
          aria-label="Search fonts"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          className="pl-8"
        />
      </div>
      <div className="relative min-w-32 flex-1 @max-[1120px]/toolbar:min-w-24 @max-[800px]/toolbar:min-w-20 @max-[620px]/toolbar:hidden">
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
        className="flex w-44 shrink-0 items-center gap-2 @max-[1120px]/toolbar:w-32 @max-[520px]/toolbar:hidden"
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
      {browse}
      {viewOptions}
      <LayoutSwitch value={layout} onChange={onLayout} className="@max-[800px]/toolbar:hidden" />
      {/* Google Fonts and Purchases have one more control (Browse): their count goes sooner. */}
      <span
        className={cn(
          "font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums @max-[990px]/toolbar:sr-only",
          browse && "@max-[1180px]/toolbar:sr-only",
        )}
      >
        {familyCount.toLocaleString()} fam · {fontCount.toLocaleString()} styles
      </span>
    </header>
  );
}
