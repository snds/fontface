import { createContext, useContext, useSyncExternalStore } from "react";
import { api, type FamilyChange, type NameRef } from "@/api";
import type { Face } from "@/library";
import type { FaceChoice, NameRule } from "@/familyGroups";

/**
 * Your family choices (src-tauri/src/families.rs), shared by everything that groups the library:
 * App groups with them, the Family groups page and the font page change them. One small store,
 * like the tags store. Every change saves first and then reads the truth again, in the order
 * they were made; each returns the change that undoes it, kept here for Undo (this session).
 */
export interface FamilyChoicesState {
  loaded: boolean;
  /** By face key. */
  choices: ReadonlyMap<string, FaceChoice>;
  /** By name key (the family name's squash key). */
  rules: ReadonlyMap<string, NameRule>;
  /** What undoes the changes made this session, newest last, with what each one did in words. */
  undo: readonly UndoEntry[];
}

export interface UndoEntry {
  id: number;
  /** "Merged 3 families into Farnham". */
  label: string;
  change: FamilyChange;
}

let state: FamilyChoicesState = { loaded: false, choices: new Map(), rules: new Map(), undo: [] };
const listeners = new Set<() => void>();
let epoch = 0;
let pending = 0;
let queue: Promise<unknown> = Promise.resolve();
let nextUndo = 1;

function set(next: Partial<FamilyChoicesState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useFamilyChoices(): FamilyChoicesState {
  return useSyncExternalStore(subscribe, () => state);
}

export async function reloadFamilyChoices(): Promise<void> {
  const at = ++epoch;
  const data = await api.familiesGet();
  if (at !== epoch || pending > 0) return;
  set({
    loaded: true,
    choices: new Map(data.choices.map((c) => [c.faceKey, c])),
    rules: new Map(data.rules.map((r) => [r.nameKey, r])),
  });
}

/** Runs a change, keeps its undo, then reads the choices again (also after a failure). */
async function change(label: string, op: () => Promise<FamilyChange>): Promise<UndoEntry> {
  pending++;
  epoch++;
  const run = queue.then(op, op);
  queue = run.catch(() => {});
  try {
    const undo = await run;
    const entry = { id: nextUndo++, label, change: undo };
    set({ undo: [...state.undo, entry].slice(-50) });
    return entry;
  } finally {
    pending--;
    if (pending === 0) await reloadFamilyChoices().catch(() => {});
  }
}

export const mergeNames = (label: string, names: NameRef[], into: string, faces: string[] = []) =>
  change(label, () => api.familiesMerge(names, into, faces));
export const keepSeparate = (label: string, names: NameRef[], faces: string[] = []) =>
  change(label, () => api.familiesKeepSeparate(names, faces));
export const moveFaces = (label: string, faces: string[], family: string, style: string | null = null) =>
  change(label, () => api.familiesMove(faces, family, style));
export const resetChoices = (label: string, faces: string[], nameKeys: string[]) => change(label, () => api.familiesReset(faces, nameKeys));
/** Several changes as one, with one undo ("Merge all suggestions"). */
export const applyChange = (label: string, edits: FamilyChange) => change(label, () => api.familiesApply(edits));

/**
 * Undoes one change (the newest, unless one is named). What it puts back is saved like any
 * change, so it can't arrive before a change still being saved.
 */
export async function undoChange(id?: number): Promise<UndoEntry | null> {
  const entry = id === undefined ? state.undo[state.undo.length - 1] : state.undo.find((u) => u.id === id);
  if (!entry) return null;
  set({ undo: state.undo.filter((u) => u !== entry) });
  pending++;
  epoch++;
  const op = () => api.familiesUndo(entry.change);
  const run = queue.then(op, op);
  queue = run.catch(() => {});
  try {
    await run;
    return entry;
  } catch (e) {
    // Not undone: it can be tried again.
    set({ undo: [...state.undo, entry] });
    throw e;
  } finally {
    pending--;
    if (pending === 0) await reloadFamilyChoices().catch(() => {});
  }
}

/** Opens the Family groups page, on these faces' families (checked) or on everything. */
export type OpenFamilyGroups = (faces?: readonly Face[], options?: { filter?: "all" | "suggested" | "changed"; returnTo?: string | null }) => void;

export const FamilyGroupsContext = createContext<OpenFamilyGroups>(() => {});

export const useOpenFamilyGroups = () => useContext(FamilyGroupsContext);
