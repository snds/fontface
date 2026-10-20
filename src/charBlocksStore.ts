import { useSyncExternalStore } from "react";
import { readStoredBlocks, type BlockMemory, type StoredBlocks } from "./charBlocks";

/**
 * The Characters tab's block choice and closed groups, for the whole app (charBlocks.ts says how
 * a choice carries to the next font). Remembered on this Mac only, as a convenience: if storage
 * isn't available it works for this session and starts afresh next time.
 */
const KEY = "fontface.characters.blocks";

let state: StoredBlocks = readStoredBlocks(load());
const listeners = new Set<() => void>();

function load(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function set(next: StoredBlocks) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Not saved; it still works for this session.
  }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useBlockStore = (): StoredBlocks => useSyncExternalStore(subscribe, () => state);
/** For a font page's first look, outside render. */
export const blockMemory = () => state.memory;
export const setBlockMemory = (memory: BlockMemory) => set({ ...state, memory });
export const setClosedGroups = (closed: string[]) => set({ ...state, closed: closed.slice(-500) });
