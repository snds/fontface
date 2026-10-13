import { setOpen, toggleOpen } from "./expanded";
import { buildIndex, type TagGroup } from "./model";
import { organizeNow } from "./store";

/** The open-state id (see expanded.ts) of a tag row with tags inside it. */
export const tagOpenId = (id: number) => `tag:${id}`;

/** The two group headings in the sidebar: their open-state ids, and how each starts. */
export const GROUP_ROWS: Record<TagGroup, { openId: string; startsOpen: boolean }> = {
  mine: { openId: "tags-group:mine", startsOpen: true },
  builtin: { openId: "tags-group:builtin", startsOpen: false },
};

/**
 * Brings a tag's row into sight in the sidebar: opens its group's heading (when the groups have
 * headings) and the tags above it. Does nothing for a tag in Built-in while Settings › Sidebar
 * hides that group (`builtinHidden`).
 */
export function revealTag(id: number, builtinHidden: boolean) {
  const { tags, byKey } = organizeNow();
  const index = buildIndex(tags, byKey);
  if (!index.byId.has(id)) return;
  const group = index.groupOf(id);
  if (group === "builtin" && builtinHidden) return;
  // The headings show only when both groups have tags in the sidebar (see TagsSection).
  const other: TagGroup = group === "mine" ? "builtin" : "mine";
  if (index.roots[other].length > 0 && !(other === "builtin" && builtinHidden)) {
    setOpen(GROUP_ROWS[group].openId, true, GROUP_ROWS[group].startsOpen);
  }
  for (const above of index.lineage.get(id)?.slice(1) ?? []) toggleOpen(tagOpenId(above), true);
}

/** Focus is nowhere (its element went away), or on a toast that is about to go. */
function focusLost(): boolean {
  const el = document.activeElement;
  return !el || el === document.body || !!el.closest("[data-sonner-toast]");
}

/**
 * After a tag moved: brings its row into sight and, once it's drawn, puts keyboard focus on it.
 * The row it was in, and a menu opened from there, are gone, so focus would otherwise drop to
 * the top of the window. With `force` unset, only if focus was lost like that, so a slow move or
 * an Undo doesn't pull focus from wherever the user has gone since. If the row isn't shown
 * (it's in Built-in and that's hidden), focus goes to the Tags section instead.
 */
export function followTag(id: number, builtinHidden: boolean, force = false) {
  revealTag(id, builtinHidden);
  // A frame later: the row is drawn, and a closing menu has already put focus where it could.
  requestAnimationFrame(() => {
    if (!force && !focusLost()) return;
    const section = document.querySelector("[data-tags-section]");
    const to =
      document.querySelector<HTMLElement>(`[data-tag-id="${id}"] [data-tag-link]`) ??
      section?.querySelector<HTMLElement>("[data-group-heading], [data-tag-link]") ??
      section?.querySelector<HTMLElement>("button");
    to?.focus();
  });
}
