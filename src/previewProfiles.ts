import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type FontSummary, type PreviewBatch, type PreviewInfo } from "./api";
import { faceName } from "./fontLoader";

// Preview profiles that arrive after the font list (src-tauri/src/preview):
// - from the launch backfill's "preview-profiles" events, and
// - for rows on screen whose list entry had none, asked for in batches of at most 64 ids,
//   once per animation frame.
// Keyed by face name (id plus file version), so a changed file never gets an old profile.

/** Profiles known since the list loaded. null: the file can't be profiled (don't ask again). */
const known = new Map<string, PreviewInfo | null>();
/** Asked for, no answer yet. */
const inFlight = new Set<string>();
/** Couldn't be read just now (online-only, changed since its scan): ask again after this time. */
const retryAt = new Map<string, number>();
const RETRY_AFTER_MS = 30_000;
const MAX_IDS = 64;

const queue = new Map<number, FontSummary>();
let frame = 0;
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version++;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function flush() {
  frame = 0;
  const batch = [...queue.values()].slice(0, MAX_IDS);
  for (const f of batch) queue.delete(f.id);
  if (queue.size) frame = requestAnimationFrame(flush);
  if (!batch.length) return;
  const settle = (answer: (f: FontSummary) => PreviewInfo | null | "retry") => {
    for (const f of batch) {
      const key = faceName(f);
      inFlight.delete(key);
      const a = answer(f);
      if (a === "retry") retryAt.set(key, Date.now() + RETRY_AFTER_MS);
      else known.set(key, a);
    }
    changed();
  };
  api.previewProfiles(batch.map((f) => f.id)).then(
    (answers) => {
      const byId = new Map(answers.map((a) => [a.id, a]));
      settle((f) => {
        const a = byId.get(f.id);
        if (a?.preview) return a.preview;
        return a?.retry ? "retry" : null;
      });
    },
    () => settle(() => "retry"),
  );
}

function request(font: FontSummary) {
  const key = faceName(font);
  if (known.has(key) || inFlight.has(key) || (retryAt.get(key) ?? 0) > Date.now()) return;
  inFlight.add(key);
  queue.set(font.id, font);
  if (!frame) frame = requestAnimationFrame(flush);
}

/** The profile for a font, from the list or from what arrived since. */
export function previewOf(font: FontSummary): PreviewInfo | undefined {
  return font.preview ?? known.get(faceName(font)) ?? undefined;
}

export interface ProfileState {
  profile: PreviewInfo | undefined;
  /** No answer yet: the preview waits (briefly) so it doesn't switch text after appearing. */
  pending: boolean;
}

/** A font's preview profile. Asks Rust for one when the list had none. */
export function usePreviewProfile(font: FontSummary | undefined): ProfileState {
  useSyncExternalStore(subscribe, () => version);
  const key = font ? faceName(font) : "";
  const settled = !font || font.preview != null || known.has(key);
  useEffect(() => {
    if (font && !settled) request(font);
    // The key captures the font's identity and version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, settled]);
  const waiting = !settled && inFlight.has(key);
  return { profile: font ? previewOf(font) : undefined, pending: !settled && (waiting || !retryAt.has(key)) };
}

/** Listens for the backfill's batches; `onDone` runs when it has finished (so the library can
 *  regroup with every profile in place). Returns the unlisten function. */
export function listenForProfiles(onDone: () => void): () => void {
  const unlisten = listen<PreviewBatch>("preview-profiles", (e) => {
    for (const p of e.payload.profiles) known.set(faceName(p), p.preview);
    if (e.payload.profiles.length) changed();
    if (e.payload.done) onDone();
  });
  return () => {
    unlisten.then((fn) => fn()).catch(() => {});
  };
}

/** Printable ASCII characters of `text` that the face can't draw, each once, in order. */
export function missingCharacters(text: string, profile: PreviewInfo | undefined): string[] {
  const missing = profile?.asciiMissing;
  if (!missing || !text) return [];
  const out: string[] = [];
  for (const c of text) if (missing.includes(c) && !out.includes(c)) out.push(c);
  return out;
}

/** Profile kinds that draw a sample of characters, not the name. */
export const isSampleKind = (profile: PreviewInfo | undefined) =>
  !!profile && (profile.kind === "script" || profile.kind === "symbols" || profile.kind === "expert" || profile.kind === "partial");

/** Kinds whose preview still reads as the font's name. */
export const drawsName = (profile: PreviewInfo | null | undefined) =>
  !profile || profile.kind === "name" || profile.kind === "trim" || profile.kind === "case";
