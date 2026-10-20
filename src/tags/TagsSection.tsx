import { useEffect, useId, useMemo, useState } from "react";
import { viewKey, type Face, type Family, type LibraryView } from "@/library";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { SectionDivider } from "@/components/SectionDivider";
import { CONTEXT, DROPDOWN, Tip } from "@/components/Tip";
import { IS_MAC } from "@/components/TitleBar";
import { cn } from "@/lib/utils";
import { countClass, countShown, dividerMenu, IMPORT_TAGS_TIP, NEW_TAG_TIP, SECTIONS, stylesSaid, type SidebarCommand } from "@/sidebar";
import { facesByTag, tagSwitchProgress } from "@/tagActions";
import { colorVar } from "./api";
import { openTagDialog } from "./dialogs";
import { DragLayer, dropTarget, pressToDrag, useDrag } from "./drag";
import { toggleOpen, useOpenRows } from "./expanded";
import { flatten, GROUP_LABELS, parentOf, useTagIndex, type TagGroup, type TagNode } from "./model";
import { openMenuFromKeyboard, TagMenuItems } from "./menus";
import { revealTag, tagOpenId as openId } from "./reveal";
import { useOrganize } from "./store";
import { useTagRun } from "./switching";

const n = (v: number) => v.toLocaleString();

const rowClass = (selected: boolean, dropping: boolean) =>
  cn(
    "group/item flex h-7 w-full items-center gap-1.5 rounded-md pr-1 text-left text-sm",
    selected ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "hover:bg-sidebar-accent/60",
    dropping && "bg-primary/10 ring-2 ring-primary ring-inset",
  );

// Design-system tooltips on the section's controls (never the native `title`): components/Tip.tsx.
// The tags and the group headings have none of their own: the (i) on the section's divider
// explains them all once.

/** Option-click on macOS, Alt-click on Windows. */
const ALT_CLICK = IS_MAC ? "Option-click" : "Alt-click";

/** A plain text button (the empty section's links) with a tooltip saying more. */
function TextAction({ tip, onClick, children }: { tip: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tip tip={tip} contentClassName="max-w-64">
      <button className="text-left hover:text-foreground" onClick={onClick}>
        {children}
      </button>
    </Tip>
  );
}

/** Opens or closes a tag and every tag inside it (Option-click on the arrow, like Finder). */
function setOpenDeep(node: TagNode, to: boolean) {
  for (const n of flatten([node])) if (n.children.length) toggleOpen(openId(n.tag.id), to);
}

/** The Tags divider's button, which Left reaches from the top of the section. */
const dividerOf = (el: Element) => el.closest("[data-tags-section]")?.querySelector<HTMLElement>("[data-section-divider] button") ?? null;

/** No fonts: the same empty list for every tag that has none, so rows don't redraw for nothing. */
const NO_FACES: Face[] = [];

/**
 * One tag in the sidebar: open/close (if tags are inside it), its name (shows its fonts), how many
 * fonts it covers, and its "…" menu (also on right-click), which turns its fonts on or off among
 * other things. The count shows only while the row is hovered, has keyboard focus or is viewed
 * (sidebar.ts, countShown); screen readers always hear it, with the name. A built-in tag is
 * quieter: an outlined label, dimmer text, and a read-only menu.
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
        // A top-level tag: up to the Tags divider (the group headings aren't controls).
        const up = dividerOf(e.currentTarget as HTMLElement);
        if (up) {
          e.preventDefault();
          up.focus();
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
            // Right opens the row and Left closes it (onKeyDown above), from anywhere in the row.
            <Tip
              tip={`${open ? "Hides" : "Shows"} the tags inside “${node.label}”. ${ALT_CLICK} to ${open ? "close" : "open"} every level.`}
              shortcut={open ? "Left" : "Right"}
              contentClassName="max-w-64"
            >
              <Button
                variant="ghost"
                size="icon-xs"
                className="-ml-1 size-5 shrink-0"
                aria-label={open ? `Hide tags in ${node.label}` : `Show tags in ${node.label}`}
                aria-expanded={open}
                data-no-drag=""
                onClick={(e) => (e.altKey ? setOpenDeep(node, !open) : toggleOpen(openId(node.tag.id)))}
              >
                <Icon name="chevron_right" size={16} className={cn("transition-transform", open && "rotate-90")} />
              </Button>
            </Tip>
          ) : (
            <span className="w-4 shrink-0" aria-hidden />
          )}
          {/* Fonts drop on the row and the row drags (pressToDrag above); built-in tags do
              neither. The (i) on the Tags divider says so, rather than a tooltip on every tag. */}
          <button
            className={cn("flex min-w-0 flex-1 items-center gap-2", builtin && !selected && "text-muted-foreground")}
            aria-current={selected ? "page" : undefined}
            data-tag-link=""
            onClick={() => onView(target)}
          >
            {/* Built-in: an outlined label, so it reads as not yours at a glance. */}
            <Icon name="label" size={18} filled={!builtin} style={{ color: colorVar(node.tag.color) }} />
            <span className="truncate">{node.label}</span>
            <span className="sr-only">
              , {stylesSaid(count)}
              {builtin ? ", built-in" : ""}
            </span>
          </button>
          {run ? (
            // Short, so the name keeps its room; the toast has the full count.
            <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground tabular-nums" aria-hidden>
              <Icon name="progress_activity" size={14} className="animate-spin" />
              {Math.floor((run.done / Math.max(1, run.total)) * 100)}%
            </span>
          ) : (
            <span aria-hidden className={cn("font-mono text-xs text-muted-foreground tabular-nums", countClass(countShown("tag", selected), false))}>
              {n(count)}
            </span>
          )}
          {run && <span className="sr-only">{tagSwitchProgress(node.tag.name, run.on, run.done, run.total).detail}</span>}
          <DropdownMenu open={menu} onOpenChange={setMenu}>
            <Tip tip={`Opens the menu for “${node.label}”: turn on or off, ${builtin ? "export" : "rename, move, delete"}…`} contentClassName="max-w-64">
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
            </Tip>
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
  const total = useMemo(() => flatten(nodes).length, [nodes]);
  const rows = nodes.map((node) => <TagRow key={node.tag.id} node={node} sets={sets} view={view} onView={onView} />);
  if (!labelled) return <>{rows}</>;
  const labelId = `tags-group-${group}`;
  // A heading, not a control: the groups are always open.
  return (
    <div data-tags-group={group} role="group" aria-labelledby={labelId}>
      <div className="flex h-6 w-full items-center gap-1 pr-1 pl-2 text-xs font-medium text-muted-foreground">
        <span id={labelId} className="flex min-w-0 flex-1 items-center gap-1">
          <span className="truncate">{GROUP_LABELS[group]}</span>
          {group === "builtin" && <Icon name="lock" size={12} aria-hidden />}
          <span className="sr-only">
            , {total === 1 ? "1 tag" : `${n(total)} tags`}
            {group === "builtin" ? ", read-only" : ""}
          </span>
        </span>
        {/* Always shown (sidebar.ts, countShown "group"): how many tags, not fonts. */}
        <span className="text-[11px] font-normal tabular-nums" aria-hidden>
          {n(total)}
        </span>
      </div>
      {rows}
    </div>
  );
}

/**
 * The sidebar's Tags section: a divider (a tag icon, then an (i) that explains tags), then every
 * tag as a view, nested by "/", with style counts on hover. The divider collapses the section, and
 * its right-click menu has New Tag…, Import Tags…, Export Tags…, Open and Close All Tags and
 * Collapse Section (SectionDivider, sidebar.ts). Tags are loaded, and their dialogs shown, by App
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

  const contentId = useId();

  /** The divider menu's commands. */
  const run = (id: SidebarCommand) => {
    if (id === "newTag") openTagDialog({ kind: "create" });
    else if (id === "importTags") openTagDialog({ kind: "import" });
    else if (id === "exportTags") openTagDialog({ kind: "export" });
    else if (id === "openAllTags") {
      groups.forEach((g) => toggleOpen(openId(g.tag.id), true));
    } else if (id === "closeAllTags") groups.forEach((g) => toggleOpen(openId(g.tag.id), false));
  };

  return (
    <div data-tags-section="">
      <SectionDivider
        section="tags"
        open
        onOpenChange={() => {}}
        contentId={contentId}
        collapsible={false}
        menu={dividerMenu("tags", { open: true, anyTags: index.tags.length > 0, anyNested: groups.length > 0 })}
        run={run}
      />
      {
        <div id={contentId} role="group" aria-label={SECTIONS.tags.label}>
          {loaded && index.tags.length === 0 && (
            <div className="flex flex-col gap-1 px-2 py-1 text-xs text-muted-foreground" data-tags-empty="">
              <TextAction tip={NEW_TAG_TIP} onClick={() => openTagDialog({ kind: "create" })}>
                Create a tag…
              </TextAction>
              <TextAction tip={IMPORT_TAGS_TIP} onClick={() => openTagDialog({ kind: "import" })}>
                Import tags…
              </TextAction>
            </div>
          )}
          {loaded && mine.length === 0 && hiddenBuiltin > 0 && (
            <div className="flex flex-col gap-1 px-2 py-1 text-xs text-muted-foreground" data-tags-empty="">
              <TextAction tip={NEW_TAG_TIP} onClick={() => openTagDialog({ kind: "create" })}>
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
        </div>
      }
      <DragLayer />
    </div>
  );
}
