import { useId, useMemo, useState } from "react";
import type { Folder } from "@/api";
import type { Family } from "@/library";
import { ancestorsOf, searchRows, sourceTree, treeRows, type TreeRow } from "@/subfolders";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { colorVar } from "@/tags/api";
import type { Locations } from "@/tags/locations";
import { isMenuKey, LocationsMenu, openMenuFromKeyboard } from "@/tags/menus";

const n = (v: number) => v.toLocaleString();
/** Search results shown at most; typing more narrows them. */
const MAX_RESULTS = 200;

interface Props {
  /** The source's name ("Font Book", a folder's name), for "All of …". */
  sourceLabel: string;
  /** The source's library folders (Font Book has three). */
  roots: Folder[];
  /** The whole library: the tree is worked out from where its fonts are, while the picker is open. */
  families: Family[];
  /** The folder the list is narrowed to, or null for the whole source. */
  selected: string | null;
  locations: Locations;
  /** A folder (by path), or null for the whole source. */
  onPick: (path: string | null) => void;
}

/**
 * The toolbar's subfolder picker, on a source's view (Font Book, Google Fonts, Purchases, one of
 * your folders): narrows the list to a folder inside the source, where the sidebar used to show
 * folder trees. A popover with a search field and the folders as a tree, each with its style
 * count and location color. The field keeps focus: Up and Down move through the folders, Right
 * and Left open and close one (while the field is empty), Return picks, Esc closes, and Shift-F10
 * opens the folder's menu to change its color (or right-click it).
 */
export function SubfolderPicker({ sourceLabel, roots, families, selected, locations, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const label = selected ? (roots.find((r) => r.path === selected)?.label || selected.split("/").pop() || selected) : null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant={selected ? "secondary" : "ghost"}
                  size="sm"
                  className="max-w-48 min-w-0 shrink-0"
                  aria-label={selected ? `Folder: ${label}. Choose another folder in ${sourceLabel}` : `Choose a folder in ${sourceLabel}`}
                />
              }
            />
          }
        >
          <Icon name="account_tree" size={16} />
          <span className="truncate @max-[1180px]/toolbar:hidden">{label ?? "All folders"}</span>
          <Icon name="expand_more" size={14} className="text-muted-foreground" />
        </TooltipTrigger>
        <TooltipContent>{selected ? `Showing ${label}` : `Show one folder in ${sourceLabel}`}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 gap-2 p-2">
        <PopoverTitle className="sr-only">Folders in {sourceLabel}</PopoverTitle>
        {open && (
          <PickerBody
            sourceLabel={sourceLabel}
            roots={roots}
            families={families}
            selected={selected}
            locations={locations}
            onPick={(path) => {
              onPick(path);
              setOpen(false);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

/** "All of" the source, then the folders. */
type Line = { kind: "all" } | ({ kind: "folder" } & TreeRow);

function PickerBody({ sourceLabel, roots, families, selected, locations, onPick }: Props) {
  const id = useId();
  const tree = useMemo(() => sourceTree(roots, families), [roots, families]);
  const [query, setQuery] = useState("");
  // The selected folder starts in sight: the folders above it open.
  const [openRows, setOpenRows] = useState<Set<string>>(() => new Set(selected ? ancestorsOf(tree, selected) : []));
  const searching = query.trim().length > 0;
  const found = useMemo(() => (searching ? searchRows(tree, query, MAX_RESULTS) : null), [tree, query, searching]);
  const lines: Line[] = useMemo(
    () => (found ? found.rows.map((r) => ({ kind: "folder" as const, ...r })) : [{ kind: "all" as const }, ...treeRows(tree, openRows).map((r) => ({ kind: "folder" as const, ...r }))]),
    [found, tree, openRows],
  );
  const keyOf = (line: Line) => (line.kind === "all" ? "" : line.node.path);
  const [activeKey, setActiveKey] = useState<string>(selected ?? "");
  const activeIndex = Math.max(0, lines.findIndex((l) => keyOf(l) === activeKey));
  const optionId = (i: number) => `${id}-folder-${i}`;

  const setActive = (i: number) => {
    const line = lines[Math.min(lines.length - 1, Math.max(0, i))];
    if (!line) return;
    setActiveKey(keyOf(line));
    document.getElementById(optionId(lines.indexOf(line)))?.scrollIntoView({ block: "nearest" });
  };
  const toggle = (path: string, to?: boolean) =>
    setOpenRows((rows) => {
      const next = new Set(rows);
      if (to ?? !next.has(path)) next.add(path);
      else next.delete(path);
      return next;
    });
  const pick = (line: Line | undefined) => line && onPick(line.kind === "all" ? null : line.node.path);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const line = lines[activeIndex];
    if (isMenuKey(e)) {
      // The active folder's color menu.
      const el = document.getElementById(optionId(activeIndex));
      if (line?.kind === "folder" && el) openMenuFromKeyboard(e, el);
      else e.preventDefault();
      return;
    }
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        setActive(activeIndex + (e.key === "ArrowDown" ? 1 : -1));
        break;
      case "PageDown":
      case "PageUp":
        e.preventDefault();
        setActive(activeIndex + (e.key === "PageDown" ? 10 : -10));
        break;
      case "ArrowRight":
        // In an empty field the caret has nowhere to go: open the folder, or go into it.
        if (searching || line?.kind !== "folder" || !line.expandable) return;
        e.preventDefault();
        if (!line.open) toggle(line.node.path, true);
        else setActive(activeIndex + 1);
        break;
      case "ArrowLeft": {
        if (searching || line?.kind !== "folder") return;
        e.preventDefault();
        if (line.open) toggle(line.node.path, false);
        else {
          // Up to the folder it's in.
          const above = ancestorsOf(tree, line.node.path).pop();
          if (above) setActiveKey(above);
        }
        break;
      }
      case "Enter":
        e.preventDefault();
        pick(line);
        break;
    }
  };

  const activeLine = lines[activeIndex];
  const total = found?.total ?? 0;
  return (
    <>
      <div className="relative">
        <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          type="search"
          placeholder="Find a folder"
          aria-label={`Find a folder in ${sourceLabel}`}
          role="combobox"
          aria-expanded
          aria-controls={`${id}-tree`}
          aria-autocomplete="list"
          aria-activedescendant={activeLine ? optionId(activeIndex) : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveKey(e.target.value.trim() ? "\u0000" : (selected ?? ""));
          }}
          onKeyDown={onKeyDown}
          className="pl-8"
        />
      </div>
      <LocationsMenu locations={locations}>
        <div
          id={`${id}-tree`}
          role="tree"
          aria-label={`Folders in ${sourceLabel}`}
          className="flex max-h-80 flex-col overflow-y-auto"
        >
          {lines.map((line, i) => {
            const active = i === activeIndex;
            if (line.kind === "all") {
              return (
                <div
                  key="all"
                  id={optionId(i)}
                  role="treeitem"
                  aria-level={1}
                  aria-selected={selected === null}
                  className={cn("flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-sm", active ? "bg-accent text-accent-foreground" : "hover:bg-muted")}
                  onMouseMove={() => !active && setActiveKey("")}
                  onClick={() => pick(line)}
                >
                  <Icon name="select_all" size={16} className="text-muted-foreground" />
                  <span className="flex-1 truncate">All of {sourceLabel}</span>
                  {selected === null && <Icon name="check" size={16} aria-hidden />}
                </div>
              );
            }
            const { node, depth, expandable, open, within } = line;
            const isSelected = selected === node.path;
            return (
              <div
                key={node.path}
                id={optionId(i)}
                role="treeitem"
                aria-level={depth + 1}
                aria-expanded={expandable ? open : undefined}
                aria-selected={isSelected}
                aria-label={`${node.name}${within ? `, in ${within}` : ""}, ${n(node.count)} ${node.count === 1 ? "style" : "styles"}`}
                data-location={node.path}
                title={node.path}
                className={cn(
                  "flex min-h-7 shrink-0 cursor-default items-center gap-1.5 rounded-md pr-2 text-sm",
                  within && "py-0.5",
                  active ? "bg-accent text-accent-foreground" : "hover:bg-muted",
                )}
                style={{ paddingLeft: 4 + depth * 14 }}
                onMouseMove={() => !active && setActiveKey(node.path)}
                onClick={() => pick(line)}
              >
                {expandable ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden
                    className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(node.path);
                    }}
                  >
                    <Icon name="chevron_right" size={16} className={cn("transition-transform", open && "rotate-90")} />
                  </button>
                ) : (
                  <span className="w-5 shrink-0" aria-hidden />
                )}
                <Icon name="folder" size={16} filled style={{ color: colorVar(locations.colorOf(node.path)) }} />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate">{node.name}</span>
                  {within && <span className="truncate text-[11px] text-muted-foreground">{within}</span>}
                </span>
                {isSelected && <Icon name="check" size={16} aria-hidden />}
                <span aria-hidden className="font-mono text-xs text-muted-foreground tabular-nums">
                  {n(node.count)}
                </span>
              </div>
            );
          })}
          {found && found.rows.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No folder here is called “{query.trim()}”.</p>}
        </div>
      </LocationsMenu>
      <p className="px-1 text-[11px] text-muted-foreground" role="status">
        {found
          ? total > found.rows.length
            ? `Showing ${n(found.rows.length)} of ${n(total)} folders. Type more to narrow them.`
            : total > 0
              ? `${n(total)} ${total === 1 ? "folder" : "folders"} found.`
              : ""
          : "Right-click a folder, or press Shift-F10, to change its color."}
      </p>
    </>
  );
}
