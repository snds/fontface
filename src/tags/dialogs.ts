import { useSyncExternalStore } from "react";
import type { Face } from "@/library";
import type { Tag } from "./api";

/** Which tag dialog is open. One host (in the sidebar) shows it, so any menu can ask for one. */
export type TagDialog =
  | { kind: "create"; parent?: Tag; faces?: Face[] }
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

export function useTagDialog(): TagDialog | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
