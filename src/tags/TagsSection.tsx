import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { viewKey, type Family, type LibraryView } from "@/library";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { colorVar } from "./api";
import { openTagDialog } from "./dialogs";
import { toggleOpen, useOpenRows } from "./expanded";
import { countByTag, useTagIndex, type TagNode } from "./model";
import { CONTEXT, DROPDOWN, TagMenuItems } from "./menus";
import { reload, useOrganize } from "./store";
import { TagDialogHost } from "./TagDialogs";

const n = (v: number) => v.toLocaleString();
const openId = (id: number) => `tag:${id}`;

const rowClass = (selected: boolean) =>
  cn(
    "group/item flex h-7 w-full items-center gap-1.5 rounded-md pr-1 text-left text-sm",
    selected ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "hover:bg-sidebar-accent/60",
  );

function HeaderAction({ icon, label, onClick }: { icon: string; label: string; onClick?: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} onClick={onClick} />}>
        <Icon name={icon} size={16} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function TagRow({
  node,
  counts,
  view,
  onView,
}: {
  node: TagNode;
  counts: Map<number, number>;
  view: LibraryView;
  onView: (v: LibraryView) => void;
}) {
  const open = useOpenRows().has(openId(node.tag.id));
  const [menu, setMenu] = useState(false);
  const target: LibraryView = { kind: "tag", id: node.tag.id };
  const selected = viewKey(view) === viewKey(target);
  const count = counts.get(node.tag.id) ?? 0;
  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger className={rowClass(selected)} style={{ paddingLeft: 8 + node.depth * 14 }}>
          {node.children.length > 0 ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="-ml-1 size-5 shrink-0"
              aria-label={open ? `Hide tags in ${node.label}` : `Show tags in ${node.label}`}
              aria-expanded={open}
              onClick={() => toggleOpen(openId(node.tag.id))}
            >
              <Icon name="chevron_right" size={16} className={cn("transition-transform", open && "rotate-90")} />
            </Button>
          ) : (
            <span className="w-4 shrink-0" aria-hidden />
          )}
          <button
            className="flex min-w-0 flex-1 items-center gap-2"
            aria-current={selected ? "page" : undefined}
            title={node.tag.name}
            onClick={() => onView(target)}
          >
            <Icon name="label" size={18} filled style={{ color: colorVar(node.tag.color) }} />
            <span className="truncate">{node.label}</span>
          </button>
          <span
            className={cn(
              "font-mono text-xs text-muted-foreground tabular-nums group-focus-within/item:hidden group-hover/item:hidden",
              menu && "hidden",
            )}
          >
            {n(count)}
          </span>
          <DropdownMenu open={menu} onOpenChange={setMenu}>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`More for ${node.tag.name}`}
                  className={cn("hidden group-focus-within/item:flex group-hover/item:flex", menu && "flex")}
                />
              }
            >
              <Icon name="more_horiz" size={16} />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-auto min-w-44">
              <TagMenuItems kit={DROPDOWN} tag={node.tag} />
            </DropdownMenuContent>
          </DropdownMenu>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          <TagMenuItems kit={CONTEXT} tag={node.tag} />
        </ContextMenuContent>
      </ContextMenu>
      {open && node.children.length > 0 && (
        <div role="group">
          {node.children.map((c) => (
            <TagRow key={c.tag.id} node={c} counts={counts} view={view} onView={onView} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The sidebar's Tags section: every tag as a view, nested by "/", with style counts. */
export function TagsSection({ families, view, onView }: { families: Family[]; view: LibraryView; onView: (v: LibraryView) => void }) {
  const { loaded } = useOrganize();
  const index = useTagIndex();
  const counts = useMemo(() => countByTag(families, index), [families, index]);

  useEffect(() => {
    reload().catch((e) => toast.error("Couldn't load tags", { description: String(e) }));
  }, []);

  // A tag view whose tag is gone (deleted, or merged by a rename elsewhere) goes back to All Fonts.
  useEffect(() => {
    if (loaded && view.kind === "tag" && !index.byId.has(view.id)) onView({ kind: "all" });
  }, [loaded, view, index, onView]);

  return (
    <div>
      <div className="flex items-center justify-between pr-1">
        <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Tags</div>
        <span className="flex items-center">
          <HeaderAction icon="add" label="New tag" onClick={() => openTagDialog({ kind: "create" })} />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Import or export tags" />}>
              <Icon name="more_horiz" size={16} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-48">
              <DropdownMenuItem onClick={() => openTagDialog({ kind: "import" })}>
                <Icon name="download" size={16} />
                Import tags…
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!index.tags.length} onClick={() => openTagDialog({ kind: "export" })}>
                <Icon name="ios_share" size={16} />
                Export tags…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      {loaded && index.tags.length === 0 && (
        <div className="flex flex-col gap-1 px-2 py-1 text-xs text-muted-foreground">
          <button className="text-left hover:text-foreground" onClick={() => openTagDialog({ kind: "create" })}>
            Create a tag…
          </button>
          <button className="text-left hover:text-foreground" onClick={() => openTagDialog({ kind: "import" })}>
            Import from Typeface, Finder or Font Book…
          </button>
        </div>
      )}
      {index.tree.map((node) => (
        <TagRow key={node.tag.id} node={node} counts={counts} view={view} onView={onView} />
      ))}
      <TagDialogHost
        families={families}
        onDeleted={(ids) => {
          if (view.kind === "tag" && ids.includes(view.id)) onView({ kind: "all" });
        }}
      />
    </div>
  );
}
