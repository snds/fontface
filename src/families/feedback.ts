import { toast } from "sonner";
import { undoChange, type UndoEntry } from "./store";

/** Says what a change did, with Undo (toasts are read out by screen readers too). */
export function undoToast(entry: UndoEntry) {
  toast.success(entry.label, {
    action: {
      label: "Undo",
      onClick: () => void undo(entry.id),
    },
  });
}

/** Undoes a change (the newest, unless one is named), and says so. */
export async function undo(id?: number): Promise<void> {
  try {
    const entry = await undoChange(id);
    if (entry) toast.success(`Undone: ${entry.label}`);
  } catch (e) {
    toast.error("Couldn't undo that", { description: String(e) });
  }
}

/** Runs a family change, then shows what it did with Undo, or why it failed. True if it worked. */
export async function runChange(op: () => Promise<UndoEntry>, failure: string): Promise<boolean> {
  try {
    undoToast(await op());
    return true;
  } catch (e) {
    toast.error(failure, { description: String(e) });
    return false;
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
export const stylesText = (n: number) => plural(n, "style");
export const familiesText = (n: number) => plural(n, "family", "families");

// The changes themselves are worked out in familyEdits.ts (pure, tested).
export { familyRuleKey, familyRuleKeys, mergeChange, mergeEdits, nameRef, yourEdits } from "@/familyEdits";
