import { useId, useRef } from "react";
import type { LibraryLayout, SortKey, SortOrder, TableColumnSetting, TableDensity } from "@/api";
import { IS_MAC } from "@/components/TitleBar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverClose, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { directionWords, LAYOUTS, SORTS, sortInfo } from "@/viewOptions";
import { ChoiceGroup } from "./ChoiceGroup";
import { resolveColumns, setShown } from "./library/columns";
import { Tip } from "./Tip";

const CMD = IS_MAC ? "⌘" : "Ctrl+";

/**
 * The toolbar's layout switch: Tiles, Rows, Table (Cmd+1, Cmd+2, Cmd+3). A radio group, so it's
 * one Tab stop and the arrow keys move the choice. Icons only, so each has its name and shortcut
 * as a tooltip. `unavailable`: layouts the view can't show; they're greyed out and the arrow keys
 * pass over them.
 */
export function LayoutSwitch({
  value,
  onChange,
  className,
  unavailable = [],
}: {
  value: LibraryLayout;
  onChange: (layout: LibraryLayout) => void;
  className?: string;
  unavailable?: readonly LibraryLayout[];
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = Math.max(0, LAYOUTS.findIndex((l) => l.id === value));
  const move = (to: number, step = 1) => {
    // The next one along that the view can show (none: stay).
    for (let n = 0; n < LAYOUTS.length; n++) {
      const i = (((to + n * step) % LAYOUTS.length) + LAYOUTS.length) % LAYOUTS.length;
      if (unavailable.includes(LAYOUTS[i].id)) continue;
      onChange(LAYOUTS[i].id);
      refs.current[i]?.focus();
      return;
    }
  };
  return (
    <div
      role="radiogroup"
      aria-label="Layout"
      className={cn("flex shrink-0 rounded-lg border p-0.5", className)}
      onKeyDown={(e) => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (step !== undefined) {
          e.preventDefault();
          move(current + step, step);
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          move(e.key === "Home" ? 0 : LAYOUTS.length - 1, e.key === "Home" ? 1 : -1);
        }
      }}
    >
      {LAYOUTS.map((l, i) => {
        const checked = i === current;
        const off = unavailable.includes(l.id);
        return (
          // Cmd+1, Cmd+2, Cmd+3 (Ctrl on Windows), and View › Tiles, Rows, Table. A layout the view
          // can't show is greyed out but keeps the pointer and focus, so its name still shows.
          <Tip key={l.id} tip={l.label} shortcut={`Mod+${l.digit}`}>
            <button
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={l.label}
              aria-disabled={off || undefined}
              tabIndex={checked ? 0 : -1}
              onClick={() => !off && onChange(l.id)}
              className={cn(
                "flex h-6 w-7 items-center justify-center rounded-md",
                checked ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
                off && "opacity-40 hover:text-muted-foreground",
              )}
            >
              <Icon name={l.icon} size={16} filled={checked} />
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

interface Props {
  layout: LibraryLayout;
  onLayout: (layout: LibraryLayout) => void;
  groupStyles: boolean;
  onGroupStyles: (on: boolean) => void;
  /** "Group families by name" (settings.groupByName), automatic groups included. */
  groupByName: boolean;
  onGroupByName: (on: boolean) => void;
  sort: SortOrder;
  onSort: (sort: SortOrder) => void;
  density: TableDensity;
  onDensity: (density: TableDensity) => void;
  columns: TableColumnSetting[];
  onColumns: (columns: TableColumnSetting[]) => void;
  /** Opens the Family groups page. */
  onFamilyGroups: () => void;
}

/**
 * The View options popover (the tune button): layout, "Group styles into families", "Group
 * families by name", sort, and in Table its row height and columns. How previews look is the
 * preview bar's, at the bottom of the list (PreviewBar.tsx). Every choice is saved as a setting.
 * Under about 800px the toolbar drops its own layout switch, and this is where the layout is
 * picked.
 */
export function ViewOptions(props: Props) {
  const { layout, onLayout, groupStyles, onGroupStyles, groupByName, onGroupByName, sort, onSort, density, onDensity, columns, onColumns, onFamilyGroups } = props;
  const id = useId();
  const info = sortInfo(sort.key);
  // The main sorts, plus the current one if it came from a Table header (Format, Source…).
  const keys = SORTS.filter((s) => s.main || s.key === sort.key);
  // With the Preview column, rows are tall enough for it whichever height is picked (a short
  // note under Row height says so).
  const previewColumn = resolveColumns(columns).some((c) => c.def.id === "preview" && c.shown);
  const other = info.directions[sort.desc ? 0 : 1];
  return (
    <Popover>
      <Tip tip="View options">
        <PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label="View options" />}>
          <Icon name="tune" size={18} />
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="max-h-[min(44rem,var(--available-height))] w-[22rem] gap-3.5 overflow-y-auto p-3.5">
        <PopoverTitle className="sr-only">View options</PopoverTitle>
        <Section label="Layout" id={`${id}-layout`}>
          <ChoiceGroup
            labelledBy={`${id}-layout`}
            value={layout}
            onChange={onLayout}
            options={LAYOUTS.map((l) => ({
              value: l.id,
              label: (
                <span className="flex items-center gap-1">
                  <Icon name={l.icon} size={14} />
                  {l.label}
                </span>
              ),
              shortcut: `Mod+${l.digit}`,
            }))}
          />
        </Section>

        <label className="flex items-start justify-between gap-3">
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium" id={`${id}-group`}>
              Group styles into families
            </span>
            <span className="text-xs text-muted-foreground" id={`${id}-group-desc`}>
              Off: every style is listed on its own.
            </span>
          </span>
          <Switch
            checked={groupStyles}
            onCheckedChange={(on) => onGroupStyles(on)}
            aria-labelledby={`${id}-group`}
            aria-describedby={`${id}-group-desc`}
            className="mt-0.5"
          />
        </label>
        <label className="flex items-start justify-between gap-3">
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium" id={`${id}-byname`}>
              Group families by name
            </span>
            <span className="text-xs text-muted-foreground" id={`${id}-byname-desc`}>
              Joins fonts whose names differ only by a style word, like “AmintaBold” or “Arial Narrow”. Off: each font keeps its own family name.
            </span>
          </span>
          <Switch
            checked={groupByName}
            onCheckedChange={(on) => onGroupByName(on)}
            aria-labelledby={`${id}-byname`}
            aria-describedby={`${id}-byname-desc`}
            className="mt-0.5"
          />
        </label>
        <PopoverClose
          render={<Button variant="outline" size="sm" className="self-start" />}
          onClick={onFamilyGroups}
          aria-describedby={`${id}-families-desc`}
        >
          <Icon name="account_tree" size={16} />
          Family groups…
        </PopoverClose>
        <span id={`${id}-families-desc`} className="-mt-2 text-xs text-muted-foreground">
          See what was grouped and why, and keep any family separate.
        </span>

        <Section label="Sort by" id={`${id}-sort`}>
          <div className="flex items-center gap-2">
            <Select
              value={sort.key}
              onValueChange={(key) => typeof key === "string" && onSort({ key: key as SortKey, desc: sortInfo(key as SortKey).desc })}
              items={keys.map((s) => ({ value: s.key, label: s.label }))}
            >
              <SelectTrigger size="sm" className="min-w-0 flex-1" aria-labelledby={`${id}-sort`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {keys.map((s) => (
                  <SelectItem key={s.key} value={s.key}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onSort({ ...sort, desc: !sort.desc })}
              aria-label={`Order: ${directionWords(sort)}. Change to ${other}`}
            >
              <Icon name={sort.desc ? "arrow_downward" : "arrow_upward"} size={14} />
              {directionWords(sort)}
            </Button>
          </div>
        </Section>

        {layout === "table" && (
          <>
            <Section label="Row height" id={`${id}-density`}>
              <ChoiceGroup
                labelledBy={`${id}-density`}
                describedBy={previewColumn ? `${id}-density-desc` : undefined}
                value={density}
                onChange={onDensity}
                options={[
                  { value: "compact", label: "Compact" },
                  { value: "regular", label: "Regular" },
                ]}
              />
              {previewColumn && (
                <span id={`${id}-density-desc`} className="text-xs text-muted-foreground">
                  Rows stay tall while the Preview column shows.
                </span>
              )}
            </Section>
            <Section label="Columns" id={`${id}-columns`}>
              <div role="group" aria-labelledby={`${id}-columns`} className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                {resolveColumns(columns)
                  .filter((c) => !c.def.pinned)
                  .map((c) => (
                    <label key={c.def.id} className="flex items-center gap-2 text-sm">
                      <Checkbox checked={c.shown} onCheckedChange={(on) => onColumns(setShown(columns, c.def.id, on))} />
                      {c.def.label}
                    </label>
                  ))}
              </div>
            </Section>
          </>
        )}

        <p className="text-xs text-muted-foreground">
          Layouts: {CMD}1, {CMD}2, {CMD}3.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function Section({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span id={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}
