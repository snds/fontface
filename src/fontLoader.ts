import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { FontSummary } from "./api";
import { darkPaletteCss, darkPaletteOverride } from "./colorPalette";

// Previews load on demand. Each face becomes a page-only FontFace, so previews never depend
// on whether the font is turned on system-wide.
//
// - The face name includes the file's version (mtime + size), so a changed file, or a new
//   font that reuses an old id, never shows a stale preview.
// - Installed macOS fonts are loaded by PostScript name (`local()`), without going through the
//   queue or streaming the file through the app.
// - Other files are fetched from the app (`ff://`), at most MAX_CONCURRENT at a time, newest
//   request first. A queued request whose row has scrolled away is dropped.
// - The app answers 503 for an online-only cloud file (it never downloads one for a preview)
//   and 413 for a very large file. Those show as their own states instead of an error.
// - A color font whose palette is all dark (Material Icons Two Tone) gets a light palette for
//   the dark theme, used by elements marked `data-face` (see colorPalette.ts). Only for files
//   fetched from the app; installed fonts loaded by name aren't read here.

export type FaceState = "loading" | "ready" | "error" | "cloud" | "too-large";
type Outcome = Exclude<FaceState, "loading"> | "dropped";

const MAX_CONCURRENT = 6;
const cache = new Map<string, Promise<Outcome>>();
/** Faces added to the page and ready to draw. */
const loaded = new Set<string>();
const users = new Map<string, number>();
const queue: { name: string; start: () => void; drop: () => void }[] = [];
let running = 0;

type FileVersion = Pick<FontSummary, "id" | "mtime" | "fileSize">;

const version = (f: FileVersion) => `${f.mtime.toString(36)}${f.fileSize.toString(36)}`;

/** The page-only font name for this exact version of a font file. */
export const faceName = (f: FileVersion) => `ff-${f.id}-${version(f)}`;

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.pop()!; // newest first: rows on screen now beat rows scrolled past
    if ((users.get(job.name) ?? 0) === 0) job.drop();
    else job.start();
  }
}

function enqueue(name: string, task: () => Promise<Outcome>): Promise<Outcome> {
  return new Promise((resolve) => {
    queue.push({
      name,
      drop: () => resolve("dropped"),
      start: () => {
        running++;
        task()
          .then(resolve, () => resolve("error"))
          .finally(() => {
            running--;
            pump();
          });
      },
    });
    pump();
  });
}

/** Holds the dark-theme palettes of faces that need one. */
let paletteSheet: HTMLStyleElement | null = null;

async function fromApp(font: FontSummary, name: string): Promise<Outcome> {
  const res = await fetch(`${convertFileSrc(String(font.id), "ff")}?v=${version(font)}`);
  if (res.status === 503) return "cloud";
  if (res.status === 413) return "too-large";
  if (!res.ok) return "error";
  const data = await res.arrayBuffer();
  // Read before the FontFace takes the bytes.
  const darkPalette = darkPaletteOverride(data);
  const face = await new FontFace(name, data).load();
  document.fonts.add(face);
  if (darkPalette) {
    paletteSheet ??= document.head.appendChild(document.createElement("style"));
    paletteSheet.append(darkPaletteCss(name, darkPalette));
  }
  loaded.add(name);
  return "ready";
}

async function fromSystem(font: FontSummary, name: string): Promise<boolean> {
  if (!font.installed || !font.postscriptName) return false;
  try {
    const face = await new FontFace(name, `local("${font.postscriptName.replace(/["\\]/g, "\\$&")}")`).load();
    document.fonts.add(face);
    loaded.add(name);
    return true;
  } catch {
    return false; // e.g. WebKit doesn't expose this installed font by name
  }
}

function loadFace(font: FontSummary): Promise<Outcome> {
  const name = faceName(font);
  let pending = cache.get(name);
  if (!pending) {
    pending = fromSystem(font, name).then((ok) => (ok ? "ready" : enqueue(name, () => fromApp(font, name))));
    cache.set(name, pending);
    // Kept for the session: "ready", and "error"/"too-large" (that file won't change without
    // a new version, which gets a new name). Retried next time a row shows it: "cloud" (it may
    // have downloaded since) and "dropped".
    pending.then((o) => (o === "cloud" || o === "dropped") && cache.delete(name));
  }
  return pending;
}

/** The face has loaded and was added to the page: text in it draws (and measures) in it. */
export const isFaceLoaded = (name: string) => loaded.has(name);

/**
 * Whether a font's face is ready to draw. The state belongs to one face: when a row starts
 * showing another font (a family's representative changes as you search), it reads "loading"
 * at once, not the last font's "ready", so nothing is shown or measured in the fallback font
 * meanwhile. A face that has already loaded reads "ready" straight away.
 */
export function useFontFace(font: FontSummary | undefined): FaceState {
  const name = font ? faceName(font) : undefined;
  const [current, setCurrent] = useState<{ name: string | undefined; state: FaceState }>(() => ({
    name,
    state: name && loaded.has(name) ? "ready" : "loading",
  }));
  useEffect(() => {
    if (!font || !name) return;
    let live = true;
    users.set(name, (users.get(name) ?? 0) + 1);
    const settle = (state: FaceState) => setCurrent({ name, state });
    settle(loaded.has(name) ? "ready" : "loading");
    // "dropped" means the row left the screen before its turn; if it's back, ask again.
    const run = () => loadFace(font).then((o) => live && (o === "dropped" ? queueMicrotask(run) : settle(o)));
    run();
    return () => {
      live = false;
      users.set(name, (users.get(name) ?? 1) - 1);
    };
    // The face name captures everything that identifies the file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);
  if (current.name === name) return current.state;
  return name && loaded.has(name) ? "ready" : "loading";
}
