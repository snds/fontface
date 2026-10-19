import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { FontSummary } from "./api";
import { darkPaletteCss, darkPaletteOverride } from "./colorPalette";
import { FaceMemory } from "./fontMemory";
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
    const rule = document.createTextNode(darkPaletteCss(name, darkPalette));
    paletteSheet.append(rule);
    paletteRules.set(name, rule);
  }
  loaded.add(name);
  memory.loaded(name, face);
  return "ready";
}

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

/** The face has loaded and was added to the page: text in it draws (and measures) in it. */
export const isFaceLoaded = (name: string) => loaded.has(name);

/** Loaded faces kept on the page, and how many of them no row shows (for checking the limit). */
export const fontMemoryStats = () => ({ kept: memory.size, unused: memory.unused, limit: KEEP_UNUSED });

/**
 * Whether a font's face is ready to draw. The state belongs to one face: when a row starts
 * showing another font (a family's representative changes as you search), it reads "loading"
 * at once, not the last font's "ready", so nothing is shown or measured in the fallback font
 * meanwhile. A face that has already loaded reads "ready" straight away.
 *
 * `urgent`: the face is a font page's chosen style; its file loads before others waiting.
 */
export function useFontFace(font: FontSummary | undefined, urgent = false): FaceState {
  const name = font ? faceName(font) : undefined;
  const [current, setCurrent] = useState<{ name: string | undefined; state: FaceState }>(() => ({
    name,
    state: name && loaded.has(name) ? "ready" : "loading",
  }));
  useEffect(() => {
    if (!font || !name) return;
    let live = true;
    memory.use(name);
    if (urgent) urgentFaces.set(name, (urgentFaces.get(name) ?? 0) + 1);
    const settle = (state: FaceState) => setCurrent({ name, state });
    settle(loaded.has(name) ? "ready" : "loading");
    // "dropped" means the row left the screen before its turn; if it's back, ask again.
    const run = () => loadFace(font).then((o) => live && (o === "dropped" ? queueMicrotask(run) : settle(o)));
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
  }, [name, urgent]);
  if (current.name === name) return current.state;
  return name && loaded.has(name) ? "ready" : "loading";
}
