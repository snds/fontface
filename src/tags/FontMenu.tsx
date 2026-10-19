import { focusBack } from "@/focusReturn";
import type { Face } from "@/library";
import { ContextMenuGroup, ContextMenuLabel, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent } from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { colorVar } from "./api";
import { openTagDialog } from "./dialogs";
import { CONTEXT, TipItem } from "./menus";
import { tagCoverage, type TagIndex } from "./model";
import { applyTags } from "./TagPicker";

const subContent = "max-h-[min(26rem,var(--available-height))] min-w-52 overflow-y-auto shadow-lg";
// Greyed out, but still under the pointer, so its tooltip can say why.
const disabledTrigger = "data-disabled:opacity-50";

/** "Sci-Fi/Star Trek" as "Sci-Fi › Star Trek", for lists that don't show the tree. */
const pathLabel = (name: string) => name.split("/").join(" › ");

/** What a menu is about: one style by name, else a count. */
export function describeFaces(faces: Face[]): string {
  if (faces.length === 1) return `${faces[0].family} ${faces[0].style}`;
  const families = new Set(faces.map((f) => f.family));
  return families.size === 1 ? `${[...families][0]}, ${faces.length} styles` : `${faces.length.toLocaleString()} styles`;
}

/** What a font's right-click menu is about: one style by name, else a count. */
export function FontMenuLabel({ faces }: { faces: Face[] }) {
  return (
    <ContextMenuGroup>
      <ContextMenuLabel className="max-w-72 truncate">{describeFaces(faces)}</ContextMenuLabel>
    </ContextMenuGroup>
  );
}

/**
 * Add to tag (the tag tree, Find a tag…, New tag…) and Remove from tag (the tags they have), for
 * a font's right-click menu (list rows, a selection, the font page). Menus also jump to an item
 * when you type the first letters of its name. Only your own tags are listed: built-in tags are
 * read-only (src/tagActions.ts), so fonts aren't added to them or taken off them by hand.
 */
export function TagSubmenus({ faces, index }: { faces: Face[]; index: TagIndex }) {
  const coverage = tagCoverage(faces, index);
  const count = (id: number) => coverage.get(id) ?? 0;
  const own = index.byGroup.filter((g) => g.group === "mine");
  const has = index.ordered.filter((node) => !node.tag.builtin && count(node.tag.id) > 0);
  const lockedOn = index.ordered.some((node) => node.tag.builtin && count(node.tag.id) > 0);
  const these = faces.length === 1 ? "this font" : "these fonts";
  return (
    <>
      <ContextMenuSub>
        <TipItem kit={CONTEXT} as="SubTrigger" tip={`Add ${these} to one of your tags.`}>
          <Icon name="new_label" size={16} />
          Add to tag
        </TipItem>
        <ContextMenuSubContent className={subContent}>
          <TipItem kit={CONTEXT} tip="Find a tag by typing its name." onClick={() => openTagDialog({ kind: "pick", faces, returnFocus: focusBack() })}>
            <Icon name="search" size={16} />
            Find a tag…
          </TipItem>
          <TipItem kit={CONTEXT} tip={`Make a new tag and add ${these} to it.`} onClick={() => openTagDialog({ kind: "create", faces })}>
            <Icon name="add" size={16} />
            New tag…
          </TipItem>
          {own.length > 0 && <ContextMenuSeparator />}
          {own.flatMap((g) =>
            g.nodes.map((node) => {
              const all = count(node.tag.id) === faces.length;
              return (
                <TipItem
                  kit={CONTEXT}
                  key={node.tag.id}
                  disabled={all}
                  tip={all ? `Already in “${node.tag.name}”.` : `Add ${these} to “${node.tag.name}”.`}
                  style={{ paddingLeft: 6 + node.depth * 14 }}
                  onClick={() => applyTags([node.tag.id], faces, true)}
                >
                  <Icon name="label" size={16} filled style={{ color: colorVar(node.tag.color) }} />
                  <span className="flex-1 truncate">{node.label}</span>
                  {all && <Icon name="check" size={16} aria-label="already added" />}
                </TipItem>
              );
            }),
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSub>
        <TipItem
          kit={CONTEXT}
          as="SubTrigger"
          disabled={!has.length}
          className={disabledTrigger}
          tip={has.length ? `Take ${these} off one of your tags.` : lockedOn ? `${faces.length === 1 ? "It's" : "They're"} only in built-in tags, which can't be changed by hand.` : `${faces.length === 1 ? "It isn't" : "They aren't"} in any of your tags.`}
        >
          <Icon name="label_off" size={16} />
          Remove from tag
        </TipItem>
        <ContextMenuSubContent className={subContent}>
          {has.map((node) => {
            const n = count(node.tag.id);
            return (
              <TipItem kit={CONTEXT} key={node.tag.id} tip={`Take ${these} off “${node.tag.name}”.`} onClick={() => applyTags([node.tag.id], faces, false)}>
                <Icon name="label" size={16} filled style={{ color: colorVar(node.tag.color) }} />
                <span className="flex-1 truncate">{pathLabel(node.tag.name)}</span>
                {n < faces.length && (
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums" aria-label={`on ${n} of ${faces.length}`}>
                    {n}/{faces.length}
                  </span>
                )}
              </TipItem>
            );
          })}
          {has.length > 1 && (
            <>
              <ContextMenuSeparator />
              <TipItem
                kit={CONTEXT}
                tip={`Take ${these} off all your tags.${lockedOn ? " Built-in tags stay." : ""}`}
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
              </TipItem>
            </>
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  );
}
