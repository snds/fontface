import { useSyncExternalStore } from "react";
import type { Face } from "@/library";
import { tagsApi, type Tag, type TagColor } from "./api";

/**
 * Tags and location colors, shared by every component that shows them. One small store
 * instead of props threaded through App: the sidebar, the list and the detail panel all read
 * it, and changes show everywhere at once.
 */
export interface OrganizeState {
  loaded: boolean;
  tags: Tag[];
  /** Face key (or `ps:<name>` kept from an import) → tag ids. */
  byKey: Map<string, number[]>;
  /** Locations whose color the user picked. */
  locationColors: Map<string, TagColor>;
}

let state: OrganizeState = { loaded: false, tags: [], byKey: new Map(), locationColors: new Map() };
const listeners = new Set<() => void>();
// A reload's result is dropped if something changed while it was in flight, and while any
// change is still being saved (the last one to finish reloads).
let epoch = 0;
let pending = 0;
// Saves run one after another, in the order they were made, so a quick "add then remove"
// can't reach the database the other way round.
let queue: Promise<unknown> = Promise.resolve();

function set(next: Partial<OrganizeState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useOrganize(): OrganizeState {
  return useSyncExternalStore(subscribe, () => state);
}

export function organizeNow(): OrganizeState {
  return state;
}

export async function reload(): Promise<void> {
  const at = ++epoch;
  const data = await tagsApi.list();
  if (at !== epoch || pending > 0) return;
  set({
    loaded: true,
    tags: data.tags,
    byKey: new Map(Object.entries(data.assignments)),
    locationColors: new Map(Object.entries(data.locationColors)),
  });
}

/** Runs a change, then re-reads the truth from the database (also after a failure). */
async function change<T>(op: () => Promise<T>): Promise<T> {
  pending++;
  epoch++;
  const run = queue.then(op, op);
  queue = run.catch(() => {});
  try {
    return await run;
  } finally {
    pending--;
    if (pending === 0) await reload().catch(() => {});
  }
}

export const createTag = (name: string, color?: TagColor) => change(() => tagsApi.create(name, color));
export const renameTag = (id: number, name: string) => change(() => tagsApi.rename(id, name));
export const deleteTag = (id: number) => change(() => tagsApi.remove(id));

export function recolorTag(id: number, color: TagColor) {
  set({ tags: state.tags.map((t) => (t.id === id ? { ...t, color } : t)) });
  return change(() => tagsApi.recolor(id, color));
}

export function setLocationColor(location: string, color: TagColor | null) {
  const next = new Map(state.locationColors);
  if (color) next.set(location, color);
  else next.delete(location);
  set({ locationColors: next });
  return change(() => tagsApi.setLocationColor(location, color));
}

/** The loose key (`ps:<name>`) that may also carry a face's tags, if it has a PostScript name. */
export const looseKey = (face: Face) => (face.key.startsWith("ps:") ? `ps:${face.primary.postscriptName}` : null);

/**
 * Adds (`on`) or removes tags on faces. Shows the change at once, then saves it. Removing also
 * clears a tag kept from an import (the loose key), as the back end does.
 */
export function setFaceTags(tagIds: number[], faces: Face[], on: boolean): Promise<number> {
  if (!tagIds.length || !faces.length) return Promise.resolve(0);
  const byKey = new Map(state.byKey);
  const edit = (key: string) => {
    const current = new Set(byKey.get(key) ?? []);
    for (const id of tagIds) {
      if (on) current.add(id);
      else current.delete(id);
    }
    if (current.size) byKey.set(key, [...current]);
    else byKey.delete(key);
  };
  for (const face of faces) {
    edit(face.key);
    const loose = looseKey(face);
    if (!on && loose) edit(loose);
  }
  set({ byKey });
  const keys = [...new Set(faces.map((f) => f.key))];
  return change(() => tagsApi.assign(tagIds, keys, on));
}
