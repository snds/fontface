import { useEffect, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type FontSummary, type PreviewBatch, type PreviewInfo, type PreviewKind } from "./api";
import { faceName } from "./fontLoader";
import { RequestQueue } from "./previewQueue";

// Preview profiles that arrive after the font list (src-tauri/src/preview):
// - from the launch backfill's "preview-profiles" events, and
// - for rows on screen whose list entry had none: one call at a time, at most 64 ids, newest
//   rows first, rows that scrolled away dropped (see previewQueue.ts). Rust reads those files on
//   its own reader threads, so this never ties up the commands the switches use. A call that
//   takes longer than 3 s stops holding the queue: its rows draw their names (and take the
//   profile if the answer still comes), and the next call goes. Rust then skips the old call if
//   it hasn't started.
// Keyed by face name (id plus file version), so a changed file never gets an old profile.

/** Profiles known since the list loaded. null: the file can't be profiled (don't ask again). */
const known = new Map<string, PreviewInfo | null>();
/** Sent, no answer yet: the number of the call that carries it. */
const inFlight = new Map<string, number>();
/** Couldn't be read just now (online-only, changed since its scan, or the call took too long):
 *  ask again after this time. */
const retryAt = new Map<string, number>();
const RETRY_AFTER_MS = 30_000;
const MAX_IDS = 64;
/** How long one call may hold the queue before its rows draw their names and the next call goes. */
const CALL_TIMEOUT_MS = 3_000;
let calls = 0;
/** Each batch's call number, for the timeout. */
const callOf = new WeakMap<FontSummary[], number>();

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

function send(batch: FontSummary[]): Promise<void> {
  const call = ++calls;
  callOf.set(batch, call);
  for (const f of batch) inFlight.set(faceName(f), call);
  // Also runs for an answer that comes after the timeout: a profile still counts then.
  const settle = (answer: (f: FontSummary) => PreviewInfo | null | "retry") => {
    for (const f of batch) {
      const key = faceName(f);
      const carrier = inFlight.get(key);
      if (carrier !== undefined && carrier !== call) continue; // a newer call asks for it
      inFlight.delete(key);
      const a = answer(f);
      if (a === "retry") {
        retryAt.set(key, Date.now() + RETRY_AFTER_MS);
      } else if (a || !known.get(key)) {
        known.set(key, a);
        retryAt.delete(key);
      }
    }
    changed();
  };
  return api.previewProfiles(batch.map((f) => f.id)).then(
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

/** A call that ran out of time: its rows stop waiting and draw their names for now. */
function timedOut(batch: FontSummary[]) {
  const call = callOf.get(batch);
  for (const f of batch) {
    const key = faceName(f);
    if (inFlight.get(key) !== call) continue;
    inFlight.delete(key);
    retryAt.set(key, Date.now() + RETRY_AFTER_MS);
  }
  changed();
}

const queue = new RequestQueue<FontSummary>(send, (run) => requestAnimationFrame(run), MAX_IDS, {
  ms: CALL_TIMEOUT_MS,
  timedOut,
});

/** The profile for a font, from the list or from what arrived since. */
export function previewOf(font: FontSummary): PreviewInfo | undefined {
  return font.preview ?? known.get(faceName(font)) ?? undefined;
}

export interface ProfileState {
  profile: PreviewInfo | undefined;
  /** No answer yet: the preview waits (briefly, `useProfileWait`) so it doesn't switch text
   *  after appearing. */
  pending: boolean;
}

/** How long a preview waits for its profile before drawing the name anyway. */
export const PROFILE_WAIT_MS = 300;

/** Whether a pending preview of `face` has waited long enough (300 ms) to draw the name anyway.
 *  The wait belongs to one face: a row that starts showing another font waits afresh. */
export function useProfileWait(pending: boolean, face: string): boolean {
  const [waitedFor, setWaitedFor] = useState<string>();
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setWaitedFor(face), PROFILE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [pending, face]);
  return waitedFor === face;
}

/** A font's preview profile. Asks Rust for one when the list had none, while the row is mounted. */
export function usePreviewProfile(font: FontSummary | undefined): ProfileState {
  useSyncExternalStore(subscribe, () => version);
  const key = font ? faceName(font) : "";
  const settled = !font || font.preview != null || known.has(key);
  useEffect(() => {
    if (!font || settled || inFlight.has(key) || (retryAt.get(key) ?? 0) > Date.now()) return;
    // Dropped from the queue if the row unmounts before its turn.
    return queue.want(key, font);
    // The key captures the font's identity and version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, settled]);
  const waiting = !settled && (inFlight.has(key) || queue.has(key));
  return { profile: font ? previewOf(font) : undefined, pending: !settled && (waiting || !retryAt.has(key)) };
}

/** Listens for the backfill's batches. `onDone` runs once it has finished, if it saved any
 *  profile (so the library can regroup with them in place). Returns the unlisten function. */
export function listenForProfiles(onDone: () => void): () => void {
  const unlisten = listen<PreviewBatch>("preview-profiles", (e) => {
    for (const p of e.payload.profiles) known.set(faceName(p), p.preview);
    if (e.payload.profiles.length) changed();
    if (e.payload.done && e.payload.written > 0) onDone();
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

/** What a row draws: the family row uses the profile's `kind`, a style row its `fullKind`
 *  when that differs (its full name can't be drawn, though the family name can). */
export const kindFor = (profile: PreviewInfo | undefined, row: "family" | "full"): PreviewKind | undefined =>
  profile && (row === "full" ? (profile.fullKind ?? profile.kind) : profile.kind);

/** Profile kinds that draw a sample of characters, not the name. Pass `"full"` for a style row. */
export const isSampleKind = (profile: PreviewInfo | undefined, row: "family" | "full" = "family") => {
  const kind = kindFor(profile, row);
  return kind === "script" || kind === "symbols" || kind === "expert" || kind === "partial";
};

/** Kinds whose preview still reads as the font's name. */
export const drawsName = (profile: PreviewInfo | null | undefined) =>
  !profile || profile.kind === "name" || profile.kind === "trim" || profile.kind === "case";
