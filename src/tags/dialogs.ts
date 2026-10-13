import { useSyncExternalStore } from "react";
import type { Face } from "@/library";
import type { ImportSource, Tag } from "./api";

/** Which tag dialog is open. One host (in App) shows it, so any menu can ask for one. An import
 *  can start from a given file instead of asking for one. A tag backup (from settings) also
 *  gives when it was made (Unix ms): the dialog then restores, and can replace the tags. */
export type TagDialog =
  | { kind: "create"; parent?: Tag; faces?: Face[] }
  /** Find tags for some fonts, by typing (the right-click menu's "Find a Tag…"). */
  | { kind: "pick"; faces: Face[] }
  | { kind: "rename"; tag: Tag }
  | { kind: "delete"; tag: Tag }
  | { kind: "import"; source?: ImportSource; backupMadeAt?: number }
  | { kind: "export"; tag?: Tag };

let current: TagDialog | null = null;
const listeners = new Set<() => void>();

export function openTagDialog(d: TagDialog | null) {
  current = d;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useTagDialog(): TagDialog | null {
  return useSyncExternalStore(subscribe, () => current);
}
