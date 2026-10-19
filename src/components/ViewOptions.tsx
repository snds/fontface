import { useId, useRef } from "react";
import type { LibraryLayout, SortKey, SortOrder, TableColumnSetting, TableDensity } from "@/api";
import { IS_MAC } from "@/components/TitleBar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { directionWords, LAYOUTS, SORTS, sortInfo } from "@/viewOptions";
import { ChoiceGroup } from "./ChoiceGroup";
import { resolveColumns, setShown } from "./library/columns";

const CMD = IS_MAC ? "⌘" : "Ctrl+";

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
          <Tooltip key={l.id}>
            <TooltipTrigger
              render={
                <button
                  ref={(el) => {
                    refs.current[i] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={l.label}
                  aria-keyshortcuts={IS_MAC ? `Meta+${l.digit}` : `Control+${l.digit}`}
                  tabIndex={checked ? 0 : -1}
                  onClick={() => onChange(l.id)}
                  className={cn(
                    "flex h-6 w-7 items-center justify-center rounded-md",
                    checked ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                />
              }
            >
              <Icon name={l.icon} size={16} filled={checked} />
            </TooltipTrigger>
            <TooltipContent>
              {l.label} <span className="text-muted-foreground">{`${CMD}${l.digit}`}</span>
            </TooltipContent>
          </Tooltip>
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
  sort: SortOrder;
  onSort: (sort: SortOrder) => void;
  density: TableDensity;
  onDensity: (density: TableDensity) => void;
  columns: TableColumnSetting[];
  onColumns: (columns: TableColumnSetting[]) => void;
}

/**
 * The View options popover (the tune button): layout, "Group styles into families", sort, and in
 * Table its row height and columns. Every choice is saved as a setting. Under about 800px the
 * toolbar drops its own layout switch, and this is where the layout is picked.
 */
export function ViewOptions(props: Props) {
  const { layout, onLayout, groupStyles, onGroupStyles, sort, onSort, density, onDensity, columns, onColumns } = props;
  const id = useId();
  const info = sortInfo(sort.key);
  // The main sorts, plus the current one if it came from a Table header (Format, Source…).
  const keys = SORTS.filter((s) => s.main || s.key === sort.key);
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger render={<PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label="View options" />} />}>
          <Icon name="tune" size={18} />
        </TooltipTrigger>
        <TooltipContent>View options</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 gap-3.5 p-3.5">
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
              aria-label={`Order: ${directionWords(sort)}. Change to ${info.directions[sort.desc ? 0 : 1]}`}
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
                value={density}
                onChange={onDensity}
                options={[
                  { value: "compact", label: "Compact" },
                  { value: "regular", label: "Regular" },
                ]}
              />
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
