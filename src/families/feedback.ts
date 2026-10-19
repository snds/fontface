import { toast } from "sonner";
import { squash } from "@/familyGroups";
import type { Face, Family } from "@/library";
import type { FamilyChange, NameRef } from "@/api";
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

/**
 * What merging some families into another writes: a rule for each family name their styles
 * carry (fonts that arrive later follow it), and for styles you'd moved into one of them by
 * hand, a choice that moves them along.
 */
export function mergeEdits(families: readonly Family[]): { names: NameRef[]; faces: string[] } {
  const names = new Map<string, NameRef>();
  const faces: string[] = [];
  for (const family of families)
    for (const face of family.faces) {
      if (face.groupedBy === "choice") faces.push(face.key);
      else names.set(squash(face.primary.family), { nameKey: squash(face.primary.family), name: face.primary.family });
    }
  return { names: [...names.values()], faces };
}

/** `mergeEdits` as a change, for several merges in one ("Merge all suggestions"). */
export function mergeChange(merges: readonly { families: readonly Family[]; into: string }[]): FamilyChange {
  const change: FamilyChange = { faces: [], names: [] };
  for (const { families, into } of merges) {
    const { names, faces } = mergeEdits(families);
    for (const n of names) change.names.push({ nameKey: n.nameKey, set: { name: n.name, decision: "merge", into } });
    for (const key of faces) change.faces.push({ faceKey: key, set: { family: into, style: null } });
  }
  return change;
}

/** The rule key and spelling for keeping a family name separate. */
export const nameRef = (name: string): NameRef => ({ nameKey: squash(name), name });

/** Faces you changed by a rule or a choice, and the rules behind them: what "Clear my choices" forgets. */
export function yourEdits(faces: readonly Face[]): { faces: string[]; nameKeys: string[] } {
  const keys: string[] = [];
  const names = new Set<string>();
  for (const f of faces) {
    if (f.groupedBy === "choice") keys.push(f.key);
    if (f.groupedBy === "rule") names.add(squash(f.primary.family));
  }
  return { faces: keys, nameKeys: [...names] };
}
