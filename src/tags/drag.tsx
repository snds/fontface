import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import type { Face } from "@/library";
import { Icon } from "@/components/ui/icon";
import { colorVar, type Tag } from "./api";
import { buildIndex, fold, GROUP_LABELS, groupOfTag, isWithin, leafOf, parentOf, topOf, type TagGroup } from "./model";
import { followTag } from "./reveal";
import { organizeNow, renameTag, setFaceTags, setTagGroup } from "./store";

/**
 * Dragging in the sidebar: fonts onto a tag to tag them, a tag onto another to nest it, a
 * tag onto "Top level" to un-nest it, or a top-level tag onto the other group's heading (My
 * tags, Built-in) to move it there.
 *
 * Built on pointer events rather than HTML drag and drop, which the Windows web view only
 * allows if the app gives up file drops. Every drag has a menu equivalent (Add to Tag, Move
 * to), so nothing here is the only way to do something.
 */
export type DragPayload = { kind: "fonts"; faces: Face[]; label: string } | { kind: "tag"; tag: Tag };

interface Active {
  payload: DragPayload;
  /** The drop target under the pointer, if it accepts this payload: "tag:<id>", "top", or a
   *  group heading ("group:mine", "group:builtin"). */
  over: string | null;
}

let active: Active | null = null;
let ghost: HTMLElement | null = null;
let at = { x: 0, y: 0 };
const listeners = new Set<() => void>();
/** Cancels the press in progress (see pressToDrag), whether or not it has become a drag yet. */
let cancelPress: (() => void) | null = null;

function set(next: Active | null) {
  active = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The drag in progress. Changes only when the target under the pointer changes. */
export function useDrag(): Active | null {
  return useSyncExternalStore(subscribe, () => active);
}

/** Whether a drag is under way (the pointer moved with the button held). */
export const isDragging = () => active !== null;

/** Cancels the press or drag in progress, as Escape does: nothing is dropped, and letting go
 *  of the button isn't a click. Does nothing when there's none. */
export function cancelDrag() {
  cancelPress?.();
}

const place = () => {
  if (ghost) ghost.style.transform = `translate(${at.x + 14}px, ${at.y + 10}px)`;
};

/** What a font drag is called: the style, the family, or a count. */
export function fontsPayload(faces: Face[]): DragPayload | null {
  if (!faces.length) return null;
  const families = new Set(faces.map((f) => f.primary.family));
  const label =
    faces.length === 1
      ? `${faces[0].primary.family} ${faces[0].primary.subfamily}`
      : families.size === 1
        ? `${[...families][0]} (${faces.length} styles)`
        : `${faces.length.toLocaleString()} styles`;
  return { kind: "fonts", faces, label };
}

function tagById(id: number): Tag | undefined {
  return organizeNow().tags.find((t) => t.id === id);
}

/** The group a "group:<name>" drop target stands for, if it is one. */
const groupTarget = (target: string | null): TagGroup | null =>
  target === "group:mine" ? "mine" : target === "group:builtin" ? "builtin" : null;

/** Whether `target` takes this payload. */
function accepts(payload: DragPayload, target: string): boolean {
  if (target === "top") return payload.kind === "tag" && parentOf(payload.tag.name) !== null;
  // A group heading takes a top-level tag from the other group. A nested tag would have to leave
  // its parent too; "Move to" and the right-click menu do that in clear steps.
  const group = groupTarget(target);
  if (group) return payload.kind === "tag" && parentOf(payload.tag.name) === null && groupOfTag(payload.tag) !== group;
  if (!target.startsWith("tag:")) return false;
  const tag = tagById(Number(target.slice(4)));
  if (!tag) return false;
  if (payload.kind === "fonts") return true;
  const moving = payload.tag;
  // Not onto itself, not inside itself, and not where it already is.
  return tag.id !== moving.id && !isWithin(tag.name, moving.name) && fold(parentOf(moving.name) ?? "") !== fold(tag.name);
}

function targetAt(x: number, y: number, payload: DragPayload): string | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]");
  const target = el?.dataset.drop ?? null;
  return target && accepts(payload, target) ? target : null;
}

const failed = (what: string) => (e: unknown) => toast.error(`Couldn't ${what}`, { description: String(e) });

/** Said when a tag moves into Built-in while the sidebar hides it, so it doesn't just vanish. */
const HIDDEN_NOTE = "Built-in tags are hidden in the sidebar. Settings › Sidebar shows them.";

/**
 * Said when a tag joins the other group because it moved inside a tag there (whose top-level tag
 * is `top`), since it leaves the group it was shown in: "It's in Built-in now, like “Fun”." A new
 * tag (`created`) wasn't anywhere before: "It's in Built-in, like “Fun”."
 */
export function joinedGroupNote(group: TagGroup, top: string, builtinHidden: boolean, created = false): string {
  const hidden = group === "builtin" && builtinHidden ? ` ${HIDDEN_NOTE}` : "";
  return `It's in ${GROUP_LABELS[group]}${created ? "" : " now"}, like “${top}”.${hidden}`;
}

/** How a move was asked for. */
interface MoveOptions {
  /** Settings › Sidebar hides Built-in, so a move into it says so. */
  builtinHidden?: boolean;
  /** From a menu: focus follows the tag to its new place (see followTag). */
  follow?: boolean;
}

/** Toasts with Undo stay long enough to reach the button. */
const UNDO_MS = 10_000;

/**
 * Moves a tag to `parent` (null: top level), with Undo. Inside a tag of the other group, it
 * joins that group (a nested tag is always in its top-level tag's group); at the top level it
 * keeps its own.
 */
export function moveTag(tag: Tag, parent: Tag | null, { builtinHidden = false, follow = false }: MoveOptions = {}) {
  const name = parent ? `${parent.name}/${leafOf(tag.name)}` : leafOf(tag.name);
  const before = tag.name;
  // Into a tag of the other group: say so, since the tag leaves the group it was shown in.
  const switched = parent && parent.builtin !== tag.builtin ? joinedGroupNote(groupOfTag(parent), topOf(parent.name), builtinHidden) : undefined;
  // Undo renames it back. Back under its old parent it takes that parent's group again; a tag
  // that was at the top level keeps the group it has, so Undo also puts that back.
  const undo = (moved: Tag) =>
    renameTag(moved.id, before)
      .then(() => (switched && !parentOf(before) ? setTagGroup(moved.id, tag.builtin) : undefined))
      .then(() => followTag(moved.id, builtinHidden))
      .catch(failed("undo the move"));
  renameTag(tag.id, name)
    .then((moved) => {
      // The rename is saved before the row moves, so by now the menu has long put focus back on
      // the row; it follows only if the move took the row from under it.
      if (follow) followTag(moved.id, builtinHidden);
      toast.success(parent ? `Moved “${leafOf(before)}” into “${parent.name}”` : `Moved “${leafOf(before)}” to the top level`, {
        description: switched,
        duration: UNDO_MS,
        action: { label: "Undo", onClick: () => undo(moved) },
      });
    })
    .catch(failed("move the tag"));
}

/**
 * Moves a tag's top-level tag, and everything in it, to Built-in or to My tags, with Undo. For
 * a nested tag that's the tag at the top of its branch: a group belongs to a whole branch.
 */
export function moveToGroup(tag: Tag, to: TagGroup, { builtinHidden = false, follow = false }: MoveOptions = {}) {
  const builtin = to === "builtin";
  // Back where it was, and focus with it if it was on the row or the toast.
  const undo = (top: Tag) => {
    const back = setTagGroup(top.id, !builtin);
    followTag(tag.id, builtinHidden);
    back.catch(failed("undo the move"));
  };
  setTagGroup(tag.id, builtin)
    .then((top) =>
      toast.success(`Moved “${top.name}” to ${GROUP_LABELS[to]}`, {
        description:
          [top.id !== tag.id && `“${leafOf(tag.name)}” is inside it, so it moved too.`, builtin && builtinHidden && HIDDEN_NOTE].filter(Boolean).join(" ") ||
          undefined,
        duration: UNDO_MS,
        action: { label: "Undo", onClick: () => undo(top) },
      }),
    )
    .catch(failed("move the tag"));
  // The group shows at once (setTagGroup doesn't wait for the save), so the row has already
  // left the list, taking the menu it was chosen from: focus goes with it.
  if (follow) followTag(tag.id, builtinHidden, true);
}

/** Adds a tag to fonts, with Undo for the ones that didn't have it. */
export function tagFonts(tag: Tag, faces: Face[], label: string) {
  const index = buildIndex(organizeNow().tags, organizeNow().byKey);
  const lacking = faces.filter((f) => !index.tagsOf(f).includes(tag.id));
  if (!lacking.length) {
    toast.info(`${label} already ${faces.length === 1 ? "has" : "have"} “${tag.name}”`);
    return;
  }
  setFaceTags([tag.id], lacking, true)
    .then(() =>
      toast.success(`Added ${faces.length === 1 ? label : `${lacking.length.toLocaleString()} ${lacking.length === 1 ? "style" : "styles"}`} to “${tag.name}”`, {
        duration: UNDO_MS,
        action: { label: "Undo", onClick: () => setFaceTags([tag.id], lacking, false).catch(failed("undo")) },
      }),
    )
    .catch(failed("add the tag"));
}

function drop(payload: DragPayload, target: string) {
  if (target === "top" && payload.kind === "tag") return moveTag(payload.tag, null);
  const group = groupTarget(target);
  if (group) return payload.kind === "tag" ? moveToGroup(payload.tag, group) : undefined;
  const tag = tagById(Number(target.slice(4)));
  if (!tag) return;
  if (payload.kind === "fonts") tagFonts(tag, payload.faces, payload.label);
  else moveTag(payload.tag, tag);
}

/** The click a browser sends after a drag ends isn't a click. */
function swallowNextClick() {
  const swallow = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, true), 0);
}

/**
 * Call from a pointerdown. Becomes a drag once the pointer moves a few pixels with the button
 * held; a plain click is left alone. `payload` is asked for only then. Presses on `ignore`
 * (controls inside the row) and in portaled popups are left alone. Escape cancels, and so
 * does `cancelDrag`.
 */
export function pressToDrag(e: React.PointerEvent, payload: () => DragPayload | null, ignore = "input, textarea, select, a, [data-no-drag]") {
  if (e.button !== 0 || e.pointerType === "touch" || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const target = e.target as HTMLElement;
  if (!e.currentTarget.contains(target) || target.closest(ignore)) return;
  // Nowhere to drop (the Tags section is hidden): don't start.
  if (!document.querySelector("[data-drop]")) return;
  const start = { x: e.clientX, y: e.clientY };
  let started: DragPayload | null = null;

  const move = (ev: PointerEvent) => {
    at = { x: ev.clientX, y: ev.clientY };
    if (!started) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
      started = payload();
      if (!started) return end();
      document.documentElement.classList.add("ff-dragging");
      window.getSelection()?.removeAllRanges();
      set({ payload: started, over: null });
    }
    place();
    const over = targetAt(ev.clientX, ev.clientY, started);
    if (over !== active?.over) set({ payload: started, over });
  };
  const up = () => {
    const done = active;
    end();
    if (!started) return;
    swallowNextClick();
    if (done?.over) drop(done.payload, done.over);
  };
  const cancel = () => {
    const wasDragging = !!started;
    end();
    // Letting go of the button after a cancelled drag isn't a click either.
    if (wasDragging) window.addEventListener("pointerup", swallowNextClick, { capture: true, once: true });
  };
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !started) return;
    ev.preventDefault();
    ev.stopPropagation();
    cancel();
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", end);
    window.removeEventListener("keydown", key, true);
    if (cancelPress === cancel) cancelPress = null;
    document.documentElement.classList.remove("ff-dragging");
    if (active) set(null);
  };
  cancelPress = cancel;
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", end);
  window.addEventListener("keydown", key, true);
}

/** Props for an element that takes drops. */
export const dropTarget = (target: string) => ({ "data-drop": target });

/** The label that follows the pointer while dragging. Mount once. */
export function DragLayer() {
  const drag = useDrag();
  if (!drag) return null;
  const { payload, over } = drag;
  const overTag = over?.startsWith("tag:") ? tagById(Number(over.slice(4))) : undefined;
  const overGroup = groupTarget(over);
  const hint =
    payload.kind === "fonts"
      ? overTag
        ? `Add to “${overTag.name}”`
        : "Drop on a tag to add it"
      : over === "top"
        ? "Move to the top level"
        : overGroup
          ? `Move to ${GROUP_LABELS[overGroup]}`
          : overTag
            ? `Move into “${overTag.name}”`
            : "Drop on a tag to nest it";
  return createPortal(
    <div
      ref={(el) => {
        ghost = el;
        place();
      }}
      aria-hidden
      className="pointer-events-none fixed top-0 left-0 z-[100] flex max-w-72 flex-col gap-0.5 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
    >
      <span className="flex items-center gap-1.5 font-medium">
        {payload.kind === "tag" ? (
          <Icon name="label" size={14} filled style={{ color: colorVar(payload.tag.color) }} />
        ) : (
          <Icon name="font_download" size={14} className="text-muted-foreground" />
        )}
        <span className="truncate">{payload.kind === "tag" ? leafOf(payload.tag.name) : payload.label}</span>
      </span>
      <span className="text-muted-foreground">{hint}</span>
    </div>,
    document.body,
  );
}
