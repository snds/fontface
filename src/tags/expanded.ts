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
  const next = new Set(open);
  if (to ?? !next.has(id)) next.add(id);
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
