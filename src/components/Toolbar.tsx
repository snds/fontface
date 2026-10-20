import type { LibraryLayout } from "@/api";
import type { StatusFilter } from "@/library";
import { Icon } from "@/components/ui/icon";
import { ChoiceGroup } from "./ChoiceGroup";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Tip } from "./Tip";
import { dragRegion, useTitleBar } from "./TitleBar";
import { LayoutSwitch } from "./ViewOptions";

/** The search field's id, so ⌘F can focus it (also from a font page). */
export const LIBRARY_SEARCH_ID = "library-search";

interface Props {
  query: string;
  onQuery: (q: string) => void;
  status: StatusFilter;
  onStatus: (s: StatusFilter) => void;
  /** All / Active / Inactive. Hidden in Active, where it would add nothing. */
  showStatus?: boolean;
  variableOnly: boolean;
  onVariableOnly: (on: boolean) => void;
  layout: LibraryLayout;
  onLayout: (layout: LibraryLayout) => void;
  /** The View options button and its popover (none on the Google Fonts view, which has no
   *  layout choices). */
  viewOptions?: React.ReactNode;
  /** On Purchases: Browse, which opens its own page. */
  browse?: React.ReactNode;
  /** In place of All / Active / Inactive: the Google Fonts view's own filter. */
  filter?: React.ReactNode;
  /** What the search field searches, when it isn't the library: "Search Google Fonts". */
  searchLabel?: string;
  /** Layouts the view can't show, each with why (the layout switch greys them out). */
  unavailableLayouts?: Partial<Record<LibraryLayout, string>>;
}

const STATUS: { value: StatusFilter; label: string; tip: string }[] = [
  { value: "any", label: "All", tip: "Shows every font, on or off" },
  { value: "active", label: "Active", tip: "Shows only fonts that are on" },
  { value: "inactive", label: "Inactive", tip: "Shows only fonts that are off" },
];

/**
 * The list view's top bar: what to show (All / Active / Inactive, or Google Fonts' own filter),
 * Variable, Search, then Browse (Purchases), View options and the layout switch at the right.
 * How previews look (your own text, the size, the styling) is the preview bar's, at the bottom
 * of the list (PreviewBar.tsx), and the counts are in the footer rail (FooterRail.tsx).
 */
export function Toolbar({
  query,
  onQuery,
  status,
  onStatus,
  showStatus = true,
  variableOnly,
  onVariableOnly,
  layout,
  onLayout,
  viewOptions,
  browse,
  filter,
  searchLabel = "Search fonts",
  unavailableLayouts,
}: Props) {
  const titleBar = useTitleBar();
  return (
    // On macOS this row is also the window's title bar (see TitleBar.tsx). It can be narrow (a
    // small window gives it well under 800px), so under 800px (a container query on the width
    // inside its padding) the layout switch folds into View options and search gets narrower.
    // Search always keeps room to type, and nothing paints past the window's edge.
    <header
      className="@container/toolbar flex h-13 shrink-0 items-center gap-3 overflow-hidden border-b px-4 select-none"
      {...dragRegion(titleBar)}
    >
      {/* All / Active / Inactive and Variable narrow whatever view is selected in the sidebar
          (Google Fonts has its own filter instead). */}
      <div className="flex shrink-0 items-center gap-1.5">
        {filter ?? (showStatus && <ChoiceGroup label="Show fonts" value={status} options={STATUS} onChange={onStatus} />)}
        {/* An icon only, the same size on or off, so nothing beside it moves when it's pressed. */}
        <Tip tip={variableOnly ? "Shows every font again, not only variable ones" : "Shows only variable fonts"}>
          <button
            type="button"
            aria-pressed={variableOnly}
            aria-label="Variable fonts only"
            onClick={() => onVariableOnly(!variableOnly)}
            className={cn(
              "flex size-7.5 shrink-0 items-center justify-center rounded-lg border outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
              variableOnly ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon name="line_weight" size={16} filled={variableOnly} />
          </button>
        </Tip>
      </div>
      <div className="relative w-64 min-w-36 @max-[800px]/toolbar:w-48 @max-[800px]/toolbar:min-w-32">
        <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={LIBRARY_SEARCH_ID}
          type="search"
          placeholder={searchLabel}
          aria-label={searchLabel}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          className="pl-8"
        />
      </div>
      <span className="min-w-0 flex-1" />
      {browse}
      {viewOptions}
      <LayoutSwitch value={layout} onChange={onLayout} unavailable={unavailableLayouts} className="@max-[800px]/toolbar:hidden" />
    </header>
  );
}
