import { useEffect, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type AppSettings, type GooglePreview, type GooglePreviewKind } from "./api";
import { answerKey, keepAnswerUntil, RETRY_OFFLINE_MS } from "./googlePreviews";
import { TaskPool } from "./previewQueue";

// Answers from `google_preview`, for online previews in the Google Fonts catalog:
// - asked for only while a row shows the family: at most 6 calls at once (Rust fetches at most
//   6 from Google at once too), newest rows first, rows that scrolled away before their turn
//   dropped (previewQueue.ts's TaskPool);
// - kept for the session per family, catalog version and kind. "offline" and other answers that
//   aren't final are asked again after a while (googlePreviews.ts, keepAnswerUntil), by rows
//   still showing the family; "off" in a moment, and at once when Rust says the switch is saved
//   (`listenForPreviewSetting`);
// - a file that was ready but then wouldn't load as a font (the cache may have let it go since)
//   is asked for once more.
// Rows read them with `useGooglePreview`, which re-renders them when an answer arrives.

const MAX_CONCURRENT = 6;

interface Entry {
  answer: GooglePreview;
  /** Ask again after this time (ms since the epoch); Infinity: kept for the session. */
  until: number;
  /** Counts up with every answer stored, so a row knows a new answer came for the same file. */
  generation: number;
}

export interface PreviewRequest {
  id: string;
  /** The catalog's lastModified for the family. */
  token: string;
  kind: GooglePreviewKind;
}

const answers = new Map<string, Entry>();
/** Asked, no answer yet. */
const inFlight = new Set<string>();
/** Asked for again once already after its file wouldn't load. */
const retried = new Set<string>();
let generations = 0;
/** When an answer last said Google couldn't be reached (ms since the epoch). */
let lastOffline = 0;

const listeners = new Set<() => void>();

function changed() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

async function ask(key: string, { id, kind }: PreviewRequest): Promise<void> {
  inFlight.add(key);
  let answer: GooglePreview | null = null;
  try {
    answer = await api.googlePreview(id, kind);
  } catch {
    // The call itself failed: no preview for now, asked again later (keepAnswerUntil).
  }
  inFlight.delete(key);
  const now = Date.now();
  if (answer?.state === "offline") lastOffline = now;
  answers.set(key, { answer: answer ?? { state: "unavailable" }, until: keepAnswerUntil(answer, now), generation: ++generations });
  changed();
}

const pool = new TaskPool<PreviewRequest>(ask, MAX_CONCURRENT);

export interface PreviewAnswerState {
  /** The latest answer, kept while a new one is asked for. Undefined until the first. */
  answer: GooglePreview | undefined;
  /** Changes with each new answer (for the face loader to try again). */
  generation: number;
}

/**
 * The online preview of one family, asked for while the row is mounted. `request` undefined:
 * nothing is asked (the row previews from a local font, or online previews are off).
 */
export function useGooglePreview(request: PreviewRequest | undefined): PreviewAnswerState {
  const key = request ? answerKey(request.id, request.token, request.kind) : "";
  // Re-renders only when this row's own answer changes.
  const entry = useSyncExternalStore(subscribe, () => (key ? answers.get(key) : undefined));
  const fresh = !!entry && entry.until > Date.now();
  // An answer kept only for a while: when it runs out, the row (if still there) asks again.
  const [, setExpired] = useState(0);
  useEffect(() => {
    if (!request || !entry || !Number.isFinite(entry.until)) return;
    const timer = setTimeout(() => setExpired((n) => n + 1), Math.max(0, entry.until - Date.now()) + 50);
    return () => clearTimeout(timer);
    // The entry is replaced (a new object) whenever its answer changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, key]);
  useEffect(() => {
    if (!request || fresh || inFlight.has(key)) return;
    // Dropped from the pool if the row unmounts before its turn.
    return pool.want(key, request);
    // The key captures the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fresh]);
  return { answer: entry?.answer, generation: entry?.generation ?? 0 };
}

/** A ready file wouldn't load as a font: forget its answer so the row asks once more (Rust
 *  downloads it again if its cache let it go). Does nothing the second time. */
export function retryGooglePreview(request: PreviewRequest): void {
  const key = answerKey(request.id, request.token, request.kind);
  if (retried.has(key) || inFlight.has(key)) return;
  retried.add(key);
  answers.delete(key);
  changed();
}

/**
 * Asks again for everything that wasn't a file: after the setting is switched (answers of "off"
 * go) or the cache is cleared. Files already answered stay: a font already loaded keeps drawing,
 * and one that no longer loads (its file was cleared) is asked for again.
 */
export function refreshGooglePreviews(): void {
  for (const [key, entry] of answers) if (entry.answer.state !== "ready") answers.delete(key);
  retried.clear();
  lastOffline = 0;
  changed();
}

/**
 * Listens for "settings-changed", which Rust sends once a settings change is saved. The switch
 * for online previews shows at once and saves a moment later, so rows on the Google Fonts page
 * (still there under Settings) can ask before Rust has the new setting, and hear "off". Once
 * previews are saved as on, those rows ask again. Returns the unlisten function.
 */
export function listenForPreviewSetting(): () => void {
  const unlisten = listen<AppSettings>("settings-changed", (e) => {
    if (!e.payload.googlePreviews) return;
    let dropped = false;
    for (const [key, entry] of answers) {
      if (entry.answer.state !== "off") continue;
      answers.delete(key);
      dropped = true;
    }
    if (dropped) changed();
  });
  return () => {
    unlisten.then((fn) => fn()).catch(() => {});
  };
}

/** Counts the answers heard this session: it changes whenever a row hears back, which is when
 *  the preview cache may have grown (Settings reads its size again). */
export function useGooglePreviewAnswers(): number {
  return useSyncExternalStore(subscribe, () => generations);
}

/** Whether a family couldn't reach Google lately (for the page's one-line note). It clears
 *  `RETRY_OFFLINE_MS` after the last such answer: by then rows still on screen have asked again. */
export function useGoogleOffline(): boolean {
  const last = useSyncExternalStore(subscribe, () => lastOffline);
  const left = last + RETRY_OFFLINE_MS - Date.now();
  const [, setLapsed] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setLapsed((n) => n + 1), left + 50);
    return () => clearTimeout(timer);
  }, [left > 0, last]);
  return left > 0;
}
