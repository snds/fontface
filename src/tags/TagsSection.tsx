import { useEffect, useMemo, useState } from "react";
import { viewKey, type Family, type LibraryView } from "@/library";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { colorVar } from "./api";
import { openTagDialog } from "./dialogs";
import { DragLayer, dropTarget, pressToDrag, useDrag } from "./drag";
import { toggleOpen, useOpenRows } from "./expanded";
import { countByTag, flatten, parentOf, useTagIndex, type TagNode } from "./model";
import { CONTEXT, DROPDOWN, openMenuFromKeyboard, TagMenuItems } from "./menus";
import { useOrganize } from "./store";

const n = (v: number) => v.toLocaleString();
const openId = (id: number) => `tag:${id}`;

const rowClass = (selected: boolean, dropping: boolean) =>
  cn(
    "group/item flex h-7 w-full items-center gap-1.5 rounded-md pr-1 text-left text-sm",
    selected ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "hover:bg-sidebar-accent/60",
    dropping && "bg-primary/10 ring-2 ring-primary ring-inset",
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

/** Opens or closes a tag and every tag inside it (Option-click on the arrow, like Finder). */
function setOpenDeep(node: TagNode, to: boolean) {
  for (const n of flatten([node])) if (n.children.length) toggleOpen(openId(n.tag.id), to);
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
  const drag = useDrag();
  const target: LibraryView = { kind: "tag", id: node.tag.id };
  const selected = viewKey(view) === viewKey(target);
  const count = counts.get(node.tag.id) ?? 0;
  const dropping = drag?.over === `tag:${node.tag.id}`;
  const hasChildren = node.children.length > 0;

  // Hovering a closed tag while dragging opens it, so you can reach the tags inside.
  useEffect(() => {
    if (!dropping || open || !hasChildren) return;
    const t = setTimeout(() => toggleOpen(openId(node.tag.id), true), 700);
    return () => clearTimeout(t);
  }, [dropping, open, hasChildren, node.tag.id]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (openMenuFromKeyboard(e)) return;
    // Right opens a tag with tags inside it, Left closes it (or moves to its parent).
    if (e.key === "ArrowRight" && hasChildren && !open) {
      e.preventDefault();
      toggleOpen(openId(node.tag.id), true);
    } else if (e.key === "ArrowLeft") {
      if (hasChildren && open) {
        e.preventDefault();
        toggleOpen(openId(node.tag.id), false);
      } else if (parentOf(node.tag.name)) {
        e.preventDefault();
        const row = (e.currentTarget as HTMLElement).closest("[data-tag-group]")?.parentElement?.querySelector<HTMLElement>(":scope > [data-tag-row] [data-tag-link]");
        row?.focus();
      }
    }
  };

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger
          className={rowClass(selected, dropping)}
          style={{ paddingLeft: 8 + node.depth * 14 }}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => pressToDrag(e, () => ({ kind: "tag", tag: node.tag }))}
          data-tag-row=""
          {...dropTarget(`tag:${node.tag.id}`)}
        >
          {hasChildren ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="-ml-1 size-5 shrink-0"
              aria-label={open ? `Hide tags in ${node.label}` : `Show tags in ${node.label}`}
              aria-expanded={open}
              title="Option-click to open or close every tag inside"
              data-no-drag=""
              onClick={(e) => (e.altKey ? setOpenDeep(node, !open) : toggleOpen(openId(node.tag.id)))}
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
            data-tag-link=""
            onClick={() => onView(target)}
          >
            <Icon name="label" size={18} filled style={{ color: colorVar(node.tag.color) }} />
            <span className="truncate">{node.label}</span>
          </button>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">{n(count)}</span>
          <DropdownMenu open={menu} onOpenChange={setMenu}>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`More for ${node.tag.name}`}
                  data-no-drag=""
                  // Invisible until hover or focus, but always there for keyboard and VoiceOver users.
                  className={cn("opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100", menu && "opacity-100")}
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
      {open && hasChildren && (
        <div role="group" data-tag-group="">
          {node.children.map((c) => (
            <TagRow key={c.tag.id} node={c} counts={counts} view={view} onView={onView} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Shown while a nested tag is dragged: drop here to take it out to the top level. */
function TopLevelTarget() {
  const drag = useDrag();
  if (drag?.payload.kind !== "tag" || !parentOf(drag.payload.tag.name)) return null;
  return (
    <div
      {...dropTarget("top")}
      className={cn(
        "mx-1 mb-1 flex h-7 items-center gap-2 rounded-md border border-dashed px-2 text-xs text-muted-foreground",
        drag.over === "top" && "border-primary bg-primary/10 text-foreground",
      )}
    >
      <Icon name="vertical_align_top" size={16} />
      Move to the top level
    </div>
  );
}

/**
 * The sidebar's Tags section: every tag as a view, nested by "/", with style counts. Tags are
 * loaded, and their dialogs shown, by App (TagDialogHost), so they work while this section is
 * hidden or settings are open.
 */
export function TagsSection({ families, view, onView }: { families: Family[]; view: LibraryView; onView: (v: LibraryView) => void }) {
  const { loaded } = useOrganize();
  const index = useTagIndex();
  const counts = useMemo(() => countByTag(families, index), [families, index]);
  const groups = index.ordered.filter((node) => node.children.length > 0);

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
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="More for tags: import, export, open or close all" />}>
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
              {groups.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => groups.forEach((g) => toggleOpen(openId(g.tag.id), true))}>
                    <Icon name="unfold_more" size={16} />
                    Open all tags
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => groups.forEach((g) => toggleOpen(openId(g.tag.id), false))}>
                    <Icon name="unfold_less" size={16} />
                    Close all tags
                  </DropdownMenuItem>
                </>
              )}
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
      <TopLevelTarget />
      {index.tree.map((node) => (
        <TagRow key={node.tag.id} node={node} counts={counts} view={view} onView={onView} />
      ))}
      <DragLayer />
    </div>
  );
}
