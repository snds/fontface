import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import type { Face } from "@/library";
import { Icon } from "@/components/ui/icon";
import { colorVar, type Tag } from "./api";
import { buildIndex, fold, isWithin, leafOf, parentOf } from "./model";
import { organizeNow, renameTag, setFaceTags } from "./store";

/**
 * Dragging in the sidebar: fonts onto a tag to tag them, a tag onto another to nest it, or a
 * tag onto "Top level" to un-nest it.
 *
 * Built on pointer events rather than HTML drag and drop, which the Windows web view only
 * allows if the app gives up file drops. Every drag has a menu equivalent (Add to Tag, Move
 * to), so nothing here is the only way to do something.
 */
export type DragPayload = { kind: "fonts"; faces: Face[]; label: string } | { kind: "tag"; tag: Tag };

interface Active {
  payload: DragPayload;
  /** The drop target under the pointer, if it accepts this payload: "tag:<id>" or "top". */
  over: string | null;
}

let active: Active | null = null;
let ghost: HTMLElement | null = null;
let at = { x: 0, y: 0 };
const listeners = new Set<() => void>();

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

/** Whether `target` takes this payload. */
function accepts(payload: DragPayload, target: string): boolean {
  if (target === "top") return payload.kind === "tag" && parentOf(payload.tag.name) !== null;
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

/** Toasts with Undo stay long enough to reach the button. */
const UNDO_MS = 10_000;

/** Moves a tag to `parent` (null: top level), with Undo. */
export function moveTag(tag: Tag, parent: Tag | null) {
  const name = parent ? `${parent.name}/${leafOf(tag.name)}` : leafOf(tag.name);
  const before = tag.name;
  renameTag(tag.id, name)
    .then((moved) =>
      toast.success(parent ? `Moved “${leafOf(before)}” into “${parent.name}”` : `Moved “${leafOf(before)}” to the top level`, {
        duration: UNDO_MS,
        action: { label: "Undo", onClick: () => renameTag(moved.id, before).catch(failed("undo the move")) },
      }),
    )
    .catch(failed("move the tag"));
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
 * (controls inside the row) and in portaled popups are left alone. Escape cancels.
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
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !started) return;
    ev.preventDefault();
    ev.stopPropagation();
    swallowNextClick();
    end();
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", end);
    window.removeEventListener("keydown", key, true);
    document.documentElement.classList.remove("ff-dragging");
    if (active) set(null);
  };
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
  const hint =
    payload.kind === "fonts"
      ? overTag
        ? `Add to “${overTag.name}”`
        : "Drop on a tag to add it"
      : over === "top"
        ? "Move to the top level"
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
