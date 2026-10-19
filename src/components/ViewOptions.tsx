import { useId, useRef } from "react";
import type { LibraryLayout, PreviewOptions, SortKey, SortOrder, TableColumnSetting, TableDensity } from "@/api";
import { IS_MAC } from "@/components/TitleBar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverClose, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { directionWords, LAYOUTS, SORTS, sortInfo } from "@/viewOptions";
import { ChoiceGroup } from "./ChoiceGroup";
import { resolveColumns, setShown } from "./library/columns";
import { PreviewOptionsSection } from "./PreviewOptions";
import { Tip } from "./Tip";

const CMD = IS_MAC ? "⌘" : "Ctrl+";

/** What picking each layout does, for its tooltip (the toolbar's switch and View options). */
const LAYOUT_TIPS: Record<LibraryLayout, string> = {
  tiles: "Shows fonts as a grid of cards",
  rows: "Shows one font per line, with a large preview",
  table: "Shows fonts in a table you can sort by any column",
};

/**
 * The toolbar's layout switch: Tiles, Rows, Table (Cmd+1, Cmd+2, Cmd+3). A radio group, so it's
 * one Tab stop and the arrow keys move the choice.
 */
export function LayoutSwitch({ value, onChange, className }: { value: LibraryLayout; onChange: (layout: LibraryLayout) => void; className?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = Math.max(0, LAYOUTS.findIndex((l) => l.id === value));
  const move = (to: number) => {
    const i = (to + LAYOUTS.length) % LAYOUTS.length;
    onChange(LAYOUTS[i].id);
    refs.current[i]?.focus();
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
          move(current + step);
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          move(e.key === "Home" ? 0 : LAYOUTS.length - 1);
        }
      }}
    >
      {LAYOUTS.map((l, i) => {
        const checked = i === current;
        return (
          // Cmd+1, Cmd+2, Cmd+3 (Ctrl on Windows), and View › Tiles, Rows, Table.
          <Tip key={l.id} tip={LAYOUT_TIPS[l.id]} shortcut={`Mod+${l.digit}`}>
            <button
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={l.label}
              tabIndex={checked ? 0 : -1}
              onClick={() => onChange(l.id)}
              className={cn(
                "flex h-6 w-7 items-center justify-center rounded-md",
                checked ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
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
  /** The preview styling, for every layout and the font page. */
  preview: PreviewOptions;
  onPreview: (patch: Partial<PreviewOptions>) => void;
  dark: boolean;
}

/**
 * The View options popover (the tune button): layout, "Group styles into families", "Group
 * families by name", sort, in Table its row height and columns, and the preview styling
 * (PreviewOptions.tsx). Every choice is saved as a setting. Under about 800px the toolbar drops
 * its own layout switch, and this is where the layout is picked.
 */
export function ViewOptions(props: Props) {
  const { layout, onLayout, groupStyles, onGroupStyles, groupByName, onGroupByName, sort, onSort, density, onDensity, columns, onColumns, onFamilyGroups, preview, onPreview, dark } =
    props;
  const id = useId();
  const info = sortInfo(sort.key);
  // The main sorts, plus the current one if it came from a Table header (Format, Source…).
  const keys = SORTS.filter((s) => s.main || s.key === sort.key);
  // With the Preview column, rows are tall enough for it whichever height is picked.
  const previewColumn = resolveColumns(columns).some((c) => c.def.id === "preview" && c.shown);
  const other = info.directions[sort.desc ? 0 : 1];
  return (
    <Popover>
      <Tip tip="Changes the layout, grouping, sort and preview styling">
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
              tip: LAYOUT_TIPS[l.id],
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
          <Tip tip={groupStyles ? "Lists every style on its own" : "Groups styles under their family"}>
            <Switch
              checked={groupStyles}
              onCheckedChange={(on) => onGroupStyles(on)}
              aria-labelledby={`${id}-group`}
              aria-describedby={`${id}-group-desc`}
              className="mt-0.5"
            />
          </Tip>
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
          <Tip tip={groupByName ? "Keeps each font's own family name" : "Joins families whose names differ only by a style word"}>
            <Switch
              checked={groupByName}
              onCheckedChange={(on) => onGroupByName(on)}
              aria-labelledby={`${id}-byname`}
              aria-describedby={`${id}-byname-desc`}
              className="mt-0.5"
            />
          </Tip>
        </label>
        <Tip tip="Opens Family groups, to see and change how styles are grouped">
          <PopoverClose
            render={<Button variant="outline" size="sm" className="self-start" />}
            onClick={onFamilyGroups}
            aria-describedby={`${id}-families-desc`}
          >
            <Icon name="account_tree" size={16} />
            Family groups…
          </PopoverClose>
        </Tip>
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
              <Tip tip="Chooses what the fonts are sorted by">
                <SelectTrigger size="sm" className="min-w-0 flex-1" aria-labelledby={`${id}-sort`}>
                  <SelectValue />
                </SelectTrigger>
              </Tip>
              <SelectContent>
                {keys.map((s) => (
                  <SelectItem key={s.key} value={s.key}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Its name already says what a click does. */}
            <Tip tip={`Reverses the order: ${other}`} describe={false}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onSort({ ...sort, desc: !sort.desc })}
                aria-label={`Order: ${directionWords(sort)}. Change to ${other}`}
              >
                <Icon name={sort.desc ? "arrow_downward" : "arrow_upward"} size={14} />
                {directionWords(sort)}
              </Button>
            </Tip>
          </div>
        </Section>

        {layout === "table" && (
          <>
            <Section label="Row height" id={`${id}-density`}>
              <ChoiceGroup
                labelledBy={`${id}-density`}
                value={density}
                onChange={onDensity}
                options={[
                  {
                    value: "compact",
                    label: "Compact",
                    tip: previewColumn ? "Makes rows shorter once the Preview column is hidden" : "Makes rows shorter, so more fit on screen",
                  },
                  { value: "regular", label: "Regular", tip: "Gives each row a little more room" },
                ]}
              />
            </Section>
            <Section label="Columns" id={`${id}-columns`}>
              <div role="group" aria-labelledby={`${id}-columns`} className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                {resolveColumns(columns)
                  .filter((c) => !c.def.pinned)
                  .map((c) => (
                    <label key={c.def.id} className="flex items-center gap-2 text-sm">
                      <Tip tip={c.shown ? `Hides the ${c.def.label} column` : `Shows the ${c.def.label} column`}>
                        <Checkbox checked={c.shown} onCheckedChange={(on) => onColumns(setShown(columns, c.def.id, on))} />
                      </Tip>
                      {c.def.label}
                    </label>
                  ))}
              </div>
            </Section>
          </>
        )}

        <Separator />
        <PreviewOptionsSection preview={preview} onPreview={onPreview} dark={dark} />

        <p className="text-xs text-muted-foreground">
          Preview size: {CMD}= and {CMD}−. Layouts: {CMD}1, {CMD}2, {CMD}3.
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
