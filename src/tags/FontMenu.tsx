import type { Face } from "@/library";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { colorVar } from "./api";
import { openTagDialog } from "./dialogs";
import { CONTEXT, GroupedTags, openMenuFromKeyboard } from "./menus";
import { tagCoverage, useTagIndex, type TagIndex } from "./model";
import { applyTags } from "./TagPicker";

const subContent = "max-h-[min(26rem,var(--available-height))] min-w-52 overflow-y-auto shadow-lg";
const disabledTrigger = "data-disabled:pointer-events-none data-disabled:opacity-50";

/** "Sci-Fi/Star Trek" as "Sci-Fi › Star Trek", for lists that don't show the tree. */
const pathLabel = (name: string) => name.split("/").join(" › ");

/** What a menu is about: one style by name, else a count. */
export function describeFaces(faces: Face[]): string {
  if (faces.length === 1) return `${faces[0].primary.family} ${faces[0].primary.subfamily}`;
  const families = new Set(faces.map((f) => f.primary.family));
  return families.size === 1 ? `${[...families][0]}, ${faces.length} styles` : `${faces.length.toLocaleString()} styles`;
}

/**
 * The tag part of a font's right-click menu (list rows, a selection, the detail panel):
 * Add to tag (the tag tree, Find a tag…, New tag…) and Remove from tag (the tags they have).
 * Menus also jump to an item when you type the first letters of its name.
 */
export function FontTagMenuItems({ faces, index }: { faces: Face[]; index: TagIndex }) {
  const coverage = tagCoverage(faces, index);
  const has = index.ordered.filter((node) => (coverage.get(node.tag.id) ?? 0) > 0);
  const count = (id: number) => coverage.get(id) ?? 0;
  return (
    <>
      <ContextMenuGroup>
        <ContextMenuLabel className="max-w-72 truncate">{describeFaces(faces)}</ContextMenuLabel>
      </ContextMenuGroup>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Icon name="new_label" size={16} />
          Add to tag
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className={subContent}>
          <ContextMenuItem onClick={() => openTagDialog({ kind: "pick", faces })}>
            <Icon name="search" size={16} />
            Find a tag…
          </ContextMenuItem>
          <ContextMenuItem onClick={() => openTagDialog({ kind: "create", faces })}>
            <Icon name="add" size={16} />
            New tag…
          </ContextMenuItem>
          {index.ordered.length > 0 && <ContextMenuSeparator />}
          {/* My tags first, then Built-in, as the sidebar lists them. */}
          <GroupedTags
            kit={CONTEXT}
            groups={index.byGroup}
            item={(node) => {
              const all = count(node.tag.id) === faces.length;
              return (
                <ContextMenuItem
                  key={node.tag.id}
                  disabled={all}
                  title={all ? `${node.tag.name}: already on ${faces.length === 1 ? "this style" : "all of them"}` : node.tag.name}
                  style={{ paddingLeft: 6 + node.depth * 14 }}
                  onClick={() => applyTags([node.tag.id], faces, true)}
                >
                  <Icon name="label" size={16} filled style={{ color: colorVar(node.tag.color) }} />
                  <span className="flex-1 truncate">{node.label}</span>
                  {all && <Icon name="check" size={16} aria-label="already added" />}
                </ContextMenuItem>
              );
            }}
          />
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSub>
        <ContextMenuSubTrigger disabled={!has.length} className={disabledTrigger}>
          <Icon name="label_off" size={16} />
          Remove from tag
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className={subContent}>
          {has.map((node) => {
            const n = count(node.tag.id);
            return (
              <ContextMenuItem key={node.tag.id} title={node.tag.name} onClick={() => applyTags([node.tag.id], faces, false)}>
                <Icon name="label" size={16} filled style={{ color: colorVar(node.tag.color) }} />
                <span className="flex-1 truncate">{pathLabel(node.tag.name)}</span>
                {n < faces.length && (
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums" aria-label={`on ${n} of ${faces.length}`}>
                    {n}/{faces.length}
                  </span>
                )}
              </ContextMenuItem>
            );
          })}
          {has.length > 1 && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() =>
                  applyTags(
                    has.map((node) => node.tag.id),
                    faces,
                    false,
                  )
                }
              >
                <Icon name="clear_all" size={16} />
                Remove all tags
              </ContextMenuItem>
            </>
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  );
}

/** Right-clicking selected text or a field keeps the normal menu (Copy, Paste). */
function keepNativeMenu(e: React.MouseEvent) {
  const selection = window.getSelection();
  const target = e.target as HTMLElement;
  if ((selection && !selection.isCollapsed && selection.toString().trim()) || target.closest("input, textarea, [role=slider]")) {
    e.stopPropagation();
  }
}

/**
 * Right-click anywhere in `render` (or focus it and press Shift-F10) for the tag menu of
 * `faces`. Used by the detail panel.
 */
export function FontContextMenu({ faces, render, children }: { faces: Face[]; render: React.ReactElement; children: React.ReactNode }) {
  const index = useTagIndex();
  return (
    <ContextMenu>
      <ContextMenuTrigger render={render} onContextMenuCapture={keepNativeMenu} onKeyDown={(e) => openMenuFromKeyboard(e)}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-56">
        <FontTagMenuItems faces={faces} index={index} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
