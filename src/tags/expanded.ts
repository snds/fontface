import { useSyncExternalStore } from "react";

/**
 * Which tree rows are open in the sidebar (nested tags, subfolders). Remembered on this Mac
 * only, as a convenience; if storage isn't available everything simply starts closed.
 */
const KEY = "fontface.sidebar.open";
let open: Set<string> = load();
const listeners = new Set<() => void>();

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify([...open].slice(-500)));
  } catch {
    // Not saved; it still works for this session.
  }
}

export function toggleOpen(id: string, to?: boolean) {
  const want = to ?? !open.has(id);
  if (want === open.has(id)) return; // already so: nothing to save or redraw
  const next = new Set(open);
  if (want) next.add(id);
  else next.delete(id);
  open = next;
  save();
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useOpenRows(): Set<string> {
  return useSyncExternalStore(subscribe, () => open);
}

/**
 * Whether a row is open, for rows that may start open (the tag group headings). The store
 * remembers only rows that differ from how they start, so a row that starts open is remembered
 * once it's closed.
 */
export const isOpen = (rows: Set<string>, id: string, startsOpen = false) => rows.has(id) !== startsOpen;

/** Opens (`to`) or closes a row that may start open (see `isOpen`). */
export function setOpen(id: string, to: boolean, startsOpen = false) {
  toggleOpen(id, to !== startsOpen);
}
