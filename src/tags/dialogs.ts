import { useSyncExternalStore } from "react";
import type { Face } from "@/library";
import type { Tag } from "./api";

/** Which tag dialog is open. One host (mounted once, near the app's root) shows it, so any menu can ask for one. */
export type TagDialog =
  | { kind: "create"; parent?: Tag; faces?: Face[] }
  /** Find tags for some fonts, by typing (the right-click menu's "Find a Tag…"). */
  | { kind: "pick"; faces: Face[] }
  | { kind: "rename"; tag: Tag }
  | { kind: "delete"; tag: Tag }
  | { kind: "import" }
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
