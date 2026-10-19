import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { FontSummary } from "./api";
import { darkPaletteCss, darkPaletteOverride } from "./colorPalette";
import { FaceMemory } from "./fontMemory";
import { parsePreviewPath, previewFilePath, remoteFaceName } from "./googlePreviews";
import { nextLoad } from "./loadOrder";

// Previews load on demand. Each face becomes a page-only FontFace, so previews never depend
// on whether the font is turned on system-wide.
//
// - The face name includes the file's version (mtime + size), so a changed file, or a new
//   font that reuses an old id, never shows a stale preview.
// - Installed macOS fonts are loaded by PostScript name (`local()`), without going through the
//   queue or streaming the file through the app.
// - Other files are fetched from the app (`ff://`), at most MAX_CONCURRENT at a time, newest
//   request first, except that a font page's chosen style goes before everything else
//   (loadOrder.ts). A queued request whose row has scrolled away is dropped.
// - The app answers 503 for an online-only cloud file (it never downloads one for a preview)
//   and 413 for a very large file. Those show as their own states instead of an error.
// - A color font whose palette is all dark (Material Icons Two Tone) gets a light palette for
//   the dark theme, used by elements marked `data-face` (see colorPalette.ts). Only for files
//   fetched from the app; installed fonts loaded by name aren't read here.
// - Loaded faces that no row shows are kept up to KEEP_UNUSED; past that the one unused longest
//   leaves the page and its caches (fontMemory.ts), so scrolling through thousands of tiles
//   never piles up thousands of fonts. It loads again if a row shows it later.
// - Online previews of Google Fonts families (googlePreviews.ts) take the same road: the file
//   Rust keeps in its preview cache comes from `ff://localhost/google/…` (cached files only,
//   never the network), through the same queue, memory and dark palettes, under a name like
//   `gf-inter_2024-01-02_name`. A failed one isn't remembered: the row may ask Rust for the
//   file again first.

export type FaceState = "loading" | "ready" | "error" | "cloud" | "too-large";
type Outcome = Exclude<FaceState, "loading"> | "dropped";

const MAX_CONCURRENT = 6;
/** Loaded faces no row shows that stay loaded (fontMemory.ts). */
const KEEP_UNUSED = 500;
const cache = new Map<string, Promise<Outcome>>();
/** Faces added to the page and ready to draw. */
const loaded = new Set<string>();
/** Each face's dark-theme palette rule, if it has one. */
const paletteRules = new Map<string, Text>();
/** Who shows which face, and which loaded faces to let go. */
const memory = new FaceMemory<FontFace>(KEEP_UNUSED, (name, face) => {
  document.fonts.delete(face);
  loaded.delete(name);
  cache.delete(name);
  paletteRules.get(name)?.remove();
  paletteRules.delete(name);
});
/** Faces shown big on a font page right now (its chosen style), by how many want them. */
const urgentFaces = new Map<string, number>();
const queue: { name: string; start: () => void; drop: () => void }[] = [];
let running = 0;

type FileVersion = Pick<FontSummary, "id" | "mtime" | "fileSize">;

const version = (f: FileVersion) => `${f.mtime.toString(36)}${f.fileSize.toString(36)}`;

/** The page-only font name for this exact version of a font file. */
export const faceName = (f: FileVersion) => `ff-${f.id}-${version(f)}`;

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const [job] = queue.splice(nextLoad(queue, urgentFaces), 1);
    if (memory.usersOf(job.name) === 0) job.drop();
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

/** Fetches a font file from the app (`ff://`) and adds it to the page as `name`. */
async function fromUrl(url: string, name: string): Promise<Outcome> {
  const res = await fetch(url);
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
    const rule = document.createTextNode(darkPaletteCss(name, darkPalette));
    paletteSheet.append(rule);
    paletteRules.set(name, rule);
  }
  loaded.add(name);
  memory.loaded(name, face);
  return "ready";
}

const fromApp = (font: FontSummary, name: string) => fromUrl(`${convertFileSrc(String(font.id), "ff")}?v=${version(font)}`, name);

async function fromSystem(font: FontSummary, name: string): Promise<boolean> {
  if (!font.installed || !font.postscriptName) return false;
  try {
    const face = await new FontFace(name, `local("${font.postscriptName.replace(/["\\]/g, "\\$&")}")`).load();
    document.fonts.add(face);
    loaded.add(name);
    memory.loaded(name, face);
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
    // Kept: "ready" (until fontMemory lets the face go), and "error"/"too-large" (that file
    // won't change without a new version, which gets a new name). Retried next time a row
    // shows it: "cloud" (it may have downloaded since) and "dropped".
    pending.then((o) => (o === "cloud" || o === "dropped") && cache.delete(name));
  }
  return pending;
}

/** Loads an online preview file from the preview cache. Only "ready" is kept: anything else
 *  is tried again the next time (the row asks Rust for the file again first). */
function loadRemote(name: string, url: string): Promise<Outcome> {
  let pending = cache.get(name);
  if (!pending) {
    pending = enqueue(name, () => fromUrl(url, name));
    cache.set(name, pending);
    pending.then((o) => o !== "ready" && cache.get(name) === pending && cache.delete(name));
  }
  return pending;
}

/** The face has loaded and was added to the page: text in it draws (and measures) in it. */
export const isFaceLoaded = (name: string) => loaded.has(name);

/** Loaded faces kept on the page, and how many of them no row shows (for checking the limit). */
export const fontMemoryStats = () => ({ kept: memory.size, unused: memory.unused, limit: KEEP_UNUSED });

/**
 * One face's state while a row shows it. The state belongs to the face: when a row starts
 * showing another one, it reads "loading" at once, not the last face's "ready". `attempt`:
 * a new value loads the face again if it failed (an online file asked for again).
 */
function useFace(name: string | undefined, load: () => Promise<Outcome>, urgent: boolean, attempt: number): FaceState {
  const [current, setCurrent] = useState<{ name: string | undefined; state: FaceState }>(() => ({
    name,
    state: name && loaded.has(name) ? "ready" : "loading",
  }));
  useEffect(() => {
    if (!name) return;
    let live = true;
    memory.use(name);
    if (urgent) urgentFaces.set(name, (urgentFaces.get(name) ?? 0) + 1);
    const settle = (state: FaceState) => setCurrent({ name, state });
    settle(loaded.has(name) ? "ready" : "loading");
    // "dropped" means the row left the screen before its turn; if it's back, ask again.
    const run = () => load().then((o) => live && (o === "dropped" ? queueMicrotask(run) : settle(o)));
    run();
    return () => {
      live = false;
      memory.unuse(name);
      if (urgent) {
        const left = (urgentFaces.get(name) ?? 1) - 1;
        if (left > 0) urgentFaces.set(name, left);
        else urgentFaces.delete(name);
      }
    };
    // The face name captures everything that identifies the file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, urgent, attempt]);
  if (current.name === name) return current.state;
  return name && loaded.has(name) ? "ready" : "loading";
}

/**
 * Whether a font's face is ready to draw. The state belongs to one face: when a row starts
 * showing another font (a family's representative changes as you search), it reads "loading"
 * at once, not the last font's "ready", so nothing is shown or measured in the fallback font
 * meanwhile. A face that has already loaded reads "ready" straight away.
 *
 * `urgent`: the face is a font page's chosen style; its file loads before others waiting.
 */
export function useFontFace(font: FontSummary | undefined, urgent = false): FaceState {
  return useFace(font ? faceName(font) : undefined, () => (font ? loadFace(font) : Promise.resolve<Outcome>("error")), urgent, 0);
}

/** The page-only font name of an online preview file (google_preview's `path`), or undefined
 *  for a path that isn't one. */
export function remoteFace(path: string | undefined): string | undefined {
  const file = parsePreviewPath(path);
  return file ? remoteFaceName(file) : undefined;
}

/**
 * Whether an online preview file (google_preview's `path`) is ready to draw, in the face
 * `remoteFace(path)` names. A path that isn't a preview file reads "error". `attempt`: a new
 * value (a new answer for the same file) loads it again after a failure.
 */
export function useRemoteFace(path: string | undefined, attempt = 0): FaceState {
  const file = parsePreviewPath(path);
  const name = file ? remoteFaceName(file) : undefined;
  const state = useFace(name, () => (file && name ? loadRemote(name, convertFileSrc(previewFilePath(file), "ff")) : Promise.resolve<Outcome>("error")), false, attempt);
  return path && !file ? "error" : state;
}
