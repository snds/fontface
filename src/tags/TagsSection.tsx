import { useEffect, useId, useMemo, useState } from "react";
import { viewKey, type Face, type Family, type LibraryView } from "@/library";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { BUILTIN_HINT, facesByTag, tagSwitchProgress } from "@/tagActions";
import { colorVar } from "./api";
import { openTagDialog } from "./dialogs";
import { DragLayer, dropTarget, pressToDrag, useDrag } from "./drag";
import { isOpen, setOpen, toggleOpen, useOpenRows } from "./expanded";
import { flatten, GROUP_LABELS, parentOf, useTagIndex, type TagGroup, type TagNode } from "./model";
import { CONTEXT, DROPDOWN, openMenuFromKeyboard, TagMenuItems, TipItem } from "./menus";
import { GROUP_ROWS, revealTag, tagOpenId as openId } from "./reveal";
import { useOrganize } from "./store";
import { useTagRun } from "./switching";
import { TagSwitch } from "./TagSwitch";

const n = (v: number) => v.toLocaleString();

const rowClass = (selected: boolean, dropping: boolean) =>
  cn(
    "group/item flex h-7 w-full items-center gap-1.5 rounded-md pr-1 text-left text-sm",
    selected ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "hover:bg-sidebar-accent/60",
    dropping && "bg-primary/10 ring-2 ring-primary ring-inset",
  );

/** Design-system tooltips on the section's controls (never the native `title`). */
const TIP_DELAY = 600;

function HeaderAction({ icon, label, tip, onClick }: { icon: string; label: string; tip: string; onClick?: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} onClick={onClick} />}>
        <Icon name={icon} size={16} />
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/** A plain text button (the empty section's links) with a tooltip saying more. */
function TextAction({ tip, onClick, children }: { tip: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger delay={TIP_DELAY} render={<button className="text-left hover:text-foreground" onClick={onClick} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{tip}</TooltipContent>
    </Tooltip>
  );
}

/** Opens or closes a tag and every tag inside it (Option-click on the arrow, like Finder). */
function setOpenDeep(node: TagNode, to: boolean) {
  for (const n of flatten([node])) if (n.children.length) toggleOpen(openId(n.tag.id), to);
}

/** No fonts: the same empty list for every tag that has none, so rows don't redraw for nothing. */
const NO_FACES: Face[] = [];

/**
 * One tag in the sidebar: open/close (if tags are inside it), its name (shows its fonts), how many
 * fonts it covers, its switch (TagSwitch), and its "…" menu (also on right-click). A built-in tag
 * is quieter: an outlined label, dimmer text, and a read-only menu.
 */
function TagRow({
  node,
  sets,
  view,
  onView,
}: {
  node: TagNode;
  /** Each tag's fonts, its nested tags' included (tagActions.facesByTag). */
  sets: Map<number, Face[]>;
  view: LibraryView;
  onView: (v: LibraryView) => void;
}) {
  const open = useOpenRows().has(openId(node.tag.id));
  const [menu, setMenu] = useState(false);
  const drag = useDrag();
  const run = useTagRun(node.tag.id);
  const target: LibraryView = { kind: "tag", id: node.tag.id };
  const selected = viewKey(view) === viewKey(target);
  const set = sets.get(node.tag.id) ?? NO_FACES;
  const count = set.length;
  const dropping = drag?.over === `tag:${node.tag.id}`;
  const hasChildren = node.children.length > 0;
  const builtin = node.tag.builtin;
  const path = node.tag.name.split("/").join(" › ");

  // Hovering a closed tag while dragging opens it, so you can reach the tags inside.
  useEffect(() => {
    if (!dropping || open || !hasChildren) return;
    const t = setTimeout(() => toggleOpen(openId(node.tag.id), true), 700);
    return () => clearTimeout(t);
  }, [dropping, open, hasChildren, node.tag.id]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Keys from the "…" menu reach here too (React passes them up from the portal): they're the
    // menu's, not the row's.
    if (!(e.currentTarget as HTMLElement).contains(e.target as Node)) return;
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
      } else {
        // A top-level tag: up to its group's heading, if the groups have headings.
        const heading = (e.currentTarget as HTMLElement).closest("[data-tags-group]")?.querySelector<HTMLElement>("[data-group-heading]");
        if (heading) {
          e.preventDefault();
          heading.focus();
        }
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
          // Built-in tags don't move, so they don't drag either.
          onPointerDown={(e) => pressToDrag(e, () => (builtin ? null : { kind: "tag", tag: node.tag }))}
          data-tag-row=""
          data-tag-id={node.tag.id}
          data-builtin={builtin ? "" : undefined}
          {...dropTarget(`tag:${node.tag.id}`)}
        >
          {hasChildren ? (
            <Tooltip>
              <TooltipTrigger
                delay={TIP_DELAY}
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="-ml-1 size-5 shrink-0"
                    aria-label={open ? `Hide tags in ${node.label}` : `Show tags in ${node.label}`}
                    aria-expanded={open}
                    data-no-drag=""
                    onClick={(e) => (e.altKey ? setOpenDeep(node, !open) : toggleOpen(openId(node.tag.id)))}
                  />
                }
              >
                <Icon name="chevron_right" size={16} className={cn("transition-transform", open && "rotate-90")} />
              </TooltipTrigger>
              <TooltipContent className="max-w-64">
                {open ? `Hide the tags inside “${node.label}”.` : `Show the tags inside “${node.label}”.`} Option-click to {open ? "close" : "open"} every level.
              </TooltipContent>
            </Tooltip>
          ) : (
            <span className="w-4 shrink-0" aria-hidden />
          )}
          <Tooltip>
            <TooltipTrigger
              delay={800}
              render={
                <button
                  className={cn("flex min-w-0 flex-1 items-center gap-2", builtin && !selected && "text-muted-foreground")}
                  aria-current={selected ? "page" : undefined}
                  aria-description={builtin ? "Built-in, read-only" : undefined}
                  data-tag-link=""
                  onClick={() => onView(target)}
                />
              }
            >
              {/* Built-in: an outlined label, so it reads as not yours at a glance. */}
              <Icon name="label" size={18} filled={!builtin} style={{ color: colorVar(node.tag.color) }} />
              <span className="truncate">{node.label}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              Show the fonts in “{path}”.{builtin && " Built-in, read-only."}
            </TooltipContent>
          </Tooltip>
          {run ? (
            // Short, so the name keeps its room; the toast has the full count.
            <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground tabular-nums" aria-hidden>
              <Icon name="progress_activity" size={14} className="animate-spin" />
              {Math.floor((run.done / Math.max(1, run.total)) * 100)}%
            </span>
          ) : (
            <span className="font-mono text-xs text-muted-foreground tabular-nums">{n(count)}</span>
          )}
          {run && <span className="sr-only">{tagSwitchProgress(node.tag.name, run.on, run.done, run.total).detail}</span>}
          <TagSwitch tag={node.tag} set={set} />
          <DropdownMenu open={menu} onOpenChange={setMenu}>
            <Tooltip>
              <TooltipTrigger
                delay={TIP_DELAY}
                render={
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
                  />
                }
              >
                <Icon name="more_horiz" size={16} />
              </TooltipTrigger>
              <TooltipContent>More for “{node.label}”: turn on or off, {builtin ? "export" : "rename, move, delete"}…</TooltipContent>
            </Tooltip>
            <DropdownMenuContent className="w-auto min-w-44">
              <TagMenuItems kit={DROPDOWN} tag={node.tag} set={set} />
            </DropdownMenuContent>
          </DropdownMenu>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          <TagMenuItems kit={CONTEXT} tag={node.tag} set={set} />
        </ContextMenuContent>
      </ContextMenu>
      {open && hasChildren && (
        <div role="group" data-tag-group="">
          {node.children.map((c) => (
            <TagRow key={c.tag.id} node={c} sets={sets} view={view} onView={onView} />
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

/** The two groups' headings: open-state ids in the expanded-rows store, and how each starts. */
const GROUPS: Record<TagGroup, { openId: string; startsOpen: boolean; hint: string }> = {
  mine: { ...GROUP_ROWS.mine, hint: "Tags you made, here or in another app. You can change them in any way." },
  builtin: { ...GROUP_ROWS.builtin, hint: BUILTIN_HINT },
};

/**
 * One group of top-level tags (My tags or Built-in) under a small heading that opens and closes
 * it. Without a heading (`labelled` false) it's just the rows: Built-in always has its heading,
 * with a lock, so its tags never pass for yours; My tags has one only when Built-in is there too.
 */
function TagGroupList({
  group,
  nodes,
  labelled,
  sets,
  view,
  onView,
}: {
  group: TagGroup;
  nodes: TagNode[];
  labelled: boolean;
  sets: Map<number, Face[]>;
  view: LibraryView;
  onView: (v: LibraryView) => void;
}) {
  const { openId, startsOpen, hint } = GROUPS[group];
  const open = isOpen(useOpenRows(), openId, startsOpen);
  const drag = useDrag();
  const dragging = !!drag;
  const [hovered, setHovered] = useState(false);
  const listId = useId();
  const hintId = useId();
  const total = useMemo(() => flatten(nodes).length, [nodes]);

  // Hovering a closed heading while dragging opens it, so the tags inside can be reached.
  useEffect(() => {
    if (!labelled || open || !dragging || !hovered) return;
    const t = setTimeout(() => setOpen(openId, true, startsOpen), 700);
    return () => clearTimeout(t);
  }, [labelled, open, dragging, hovered, openId, startsOpen]);

  const rows = nodes.map((node) => <TagRow key={node.tag.id} node={node} sets={sets} view={view} onView={onView} />);
  if (!labelled) return <>{rows}</>;

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    // Like a tree: Right opens (or goes to the first tag), Left closes.
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (!open) setOpen(openId, true, startsOpen);
      else document.getElementById(listId)?.querySelector<HTMLElement>("[data-tag-link]")?.focus();
    } else if (e.key === "ArrowLeft" && open) {
      e.preventDefault();
      setOpen(openId, false, startsOpen);
    }
  };

  return (
    <div data-tags-group={group}>
      <Tooltip>
        <TooltipTrigger
          delay={TIP_DELAY}
          render={
            <button
              type="button"
              className="flex h-6 w-full items-center gap-1 rounded-md pr-1 pl-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              aria-describedby={hintId}
              data-group-heading=""
              onClick={() => setOpen(openId, !open, startsOpen)}
              onKeyDown={onKeyDown}
              onPointerEnter={() => setHovered(true)}
              onPointerLeave={() => setHovered(false)}
            />
          }
        >
          <Icon name="chevron_right" size={16} className={cn("transition-transform", open && "rotate-90")} />
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <span className="truncate">{GROUP_LABELS[group]}</span>
            {group === "builtin" && <Icon name="lock" size={12} aria-hidden />}
          </span>
          <span className="text-[11px] font-normal tabular-nums" aria-hidden>
            {n(total)}
          </span>
          <span className="sr-only">, {total === 1 ? "1 tag" : `${n(total)} tags`}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">{hint}</TooltipContent>
      </Tooltip>
      {/* The heading's description, read once. Outside the button so it isn't part of the name
          too; `hidden` still lets aria-describedby read it. */}
      <span id={hintId} hidden>
        {hint}
      </span>
      {open && (
        <div id={listId} role="group" aria-label={GROUP_LABELS[group]}>
          {rows}
        </div>
      )}
    </div>
  );
}

/**
 * The sidebar's Tags section: every tag as a view, nested by "/", with style counts and a switch
 * that turns the whole tag on or off. Tags are loaded, and their dialogs shown, by App
 * (TagDialogHost), so they work while this section is hidden or settings are open.
 *
 * Tags come in two groups: My tags, then Built-in (from Font Book and Typeface, read-only), each
 * under a heading that opens and closes it. Built-in always has its heading, with a lock; My
 * tags has one only when Built-in is there too. `showBuiltin` (Settings › Sidebar) hides Built-in
 * here only: those tags still exist, still show on fonts, and still appear in the tag search.
 */
export function TagsSection({
  families,
  view,
  onView,
  onFallback = onView,
  showBuiltin = true,
}: {
  families: Family[];
  view: LibraryView;
  /** A click on a tag. */
  onView: (v: LibraryView) => void;
  /** The tag being viewed went away (below): back to All Fonts, without the side effects of a
   *  click (App keeps an open font page). */
  onFallback?: (v: LibraryView) => void;
  showBuiltin?: boolean;
}) {
  const { loaded } = useOrganize();
  const index = useTagIndex();
  // Each tag's fonts, its nested tags' included: the counts, the switches and Turn on/off.
  const sets = useMemo(() => facesByTag(families, index), [families, index]);
  const groups = index.ordered.filter((node) => node.children.length > 0);
  const mine = index.roots.mine;
  const builtin = showBuiltin ? index.roots.builtin : [];
  // Built-in always has its heading (and lock); My tags only when Built-in is there too.
  const labelled = builtin.length > 0;
  const hiddenBuiltin = showBuiltin ? 0 : index.tags.filter((t) => index.groupOf(t.id) === "builtin").length;

  // A tag view whose tag is gone (deleted, or merged by a rename elsewhere), or is now hidden
  // with Built-in, goes back to All Fonts.
  useEffect(() => {
    if (!loaded || view.kind !== "tag") return;
    if (!index.byId.has(view.id) || (!showBuiltin && index.groupOf(view.id) === "builtin")) onFallback({ kind: "all" });
  }, [loaded, view, index, onFallback, showBuiltin]);

  // The current tag view's row is in sight: its group and the tags above it open, for example
  // when it's restored at launch inside the closed Built-in group. Once each time the view
  // changes or its row moves (another group, another parent, headings shown or not), so they
  // can be closed again.
  const viewTag = loaded && view.kind === "tag" && index.byId.has(view.id) ? view.id : null;
  const viewPlace = viewTag === null ? null : [viewTag, index.groupOf(viewTag), labelled, mine.length > 0, index.lineage.get(viewTag)?.join("/")].join(" ");
  useEffect(() => {
    if (viewTag !== null) revealTag(viewTag, !showBuiltin);
    // Only when the view or its place changes, not each time a row opens or closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewPlace]);

  return (
    <div data-tags-section="">
      <div className="flex items-center justify-between pr-1">
        <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Tags</div>
        <span className="flex items-center">
          <HeaderAction icon="add" label="New tag" tip="Make a new tag" onClick={() => openTagDialog({ kind: "create" })} />
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger
                delay={TIP_DELAY}
                render={<DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="More for tags: import, export, open or close all" />} />}
              >
                <Icon name="more_horiz" size={16} />
              </TooltipTrigger>
              <TooltipContent>More for tags: import, export, open or close all</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-auto min-w-48">
              <TipItem kit={DROPDOWN} tip="Bring in tags from Finder, this Mac's font collections, another font manager's backup, or a Fontface tags file." onClick={() => openTagDialog({ kind: "import" })}>
                <Icon name="download" size={16} />
                Import tags…
              </TipItem>
              <TipItem
                kit={DROPDOWN}
                tip={index.tags.length ? "Save all your tags to a file, or to Finder tags or Font Book." : "There are no tags to export yet."}
                disabled={!index.tags.length}
                onClick={() => openTagDialog({ kind: "export" })}
              >
                <Icon name="ios_share" size={16} />
                Export tags…
              </TipItem>
              {groups.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <TipItem
                    kit={DROPDOWN}
                    tip="Show the tags inside every tag."
                    onClick={() => {
                      groups.forEach((g) => toggleOpen(openId(g.tag.id), true));
                      // Open the group headings too, so every tag is in sight. (Close all leaves
                      // them, so the lists stay in place.)
                      for (const g of Object.values(GROUPS)) setOpen(g.openId, true, g.startsOpen);
                    }}
                  >
                    <Icon name="unfold_more" size={16} />
                    Open all tags
                  </TipItem>
                  <TipItem kit={DROPDOWN} tip="Hide the tags inside other tags." onClick={() => groups.forEach((g) => toggleOpen(openId(g.tag.id), false))}>
                    <Icon name="unfold_less" size={16} />
                    Close all tags
                  </TipItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      {loaded && index.tags.length === 0 && (
        <div className="flex flex-col gap-1 px-2 py-1 text-xs text-muted-foreground">
          <TextAction tip="Make your first tag. Then drag fonts onto it, or use a font's right-click menu." onClick={() => openTagDialog({ kind: "create" })}>
            Create a tag…
          </TextAction>
          <TextAction tip="Bring in tags from Finder, this Mac's font collections, or another font manager's backup." onClick={() => openTagDialog({ kind: "import" })}>
            Import tags…
          </TextAction>
        </div>
      )}
      {loaded && mine.length === 0 && hiddenBuiltin > 0 && (
        <div className="flex flex-col gap-1 px-2 py-1 text-xs text-muted-foreground">
          <TextAction tip="Make your own tag. Then drag fonts onto it, or use a font's right-click menu." onClick={() => openTagDialog({ kind: "create" })}>
            Create a tag…
          </TextAction>
          <p>
            {hiddenBuiltin === 1 ? "1 built-in tag is" : `${n(hiddenBuiltin)} built-in tags are`} hidden. Settings › Sidebar shows them.
          </p>
        </div>
      )}
      <TopLevelTarget />
      <TagGroupList group="mine" nodes={mine} labelled={labelled && mine.length > 0} sets={sets} view={view} onView={onView} />
      <TagGroupList group="builtin" nodes={builtin} labelled={labelled} sets={sets} view={view} onView={onView} />
      <DragLayer />
    </div>
  );
}
