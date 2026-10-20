import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type Translucency } from "@/api";

/**
 * The see-through sidebar, on the page's side. The back end decides what shows (the setting, the
 * system, Reduce transparency) and puts the OS's blur behind the window
 * (src-tauri/src/translucency.rs). This puts `data-translucent` on <html> to match, and
 * src/index.css makes the sidebars see-through from there; everything else keeps its solid
 * background.
 *
 * The web view's own `prefers-reduced-transparency` also turns it off, where WebKit knows it
 * (unknown, the query reads "not all").
 *
 * The last look is kept in localStorage under KEY, so index.html can apply it before the first
 * paint (keep its key and values in step with this file).
 */

const KEY = "fontface.translucent";
const SOLID: Translucency = { look: null, reduced: false, unsupported: false, nextLaunch: false };

const reduceQuery = typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-transparency: reduce)") : null;
const webReduced = () => !!reduceQuery && reduceQuery.media !== "not all" && reduceQuery.matches;

let fromBackEnd = SOLID;
let current = SOLID;
const listeners = new Set<() => void>();

function paint() {
  const reduced = webReduced();
  current = reduced ? { ...fromBackEnd, look: null, reduced: true } : fromBackEnd;
  const root = document.documentElement;
  if (current.look) root.dataset.translucent = current.look;
  else delete root.dataset.translucent;
  try {
    localStorage.setItem(KEY, current.look ?? "");
  } catch {
    // Private storage unavailable: the back end's answer still applies once it arrives.
  }
  for (const l of listeners) l();
}

/** Follows the back end from now on. Call once, before rendering. */
export function initTranslucency() {
  let heard = false;
  const show = (next: Translucency) => {
    fromBackEnd = next;
    paint();
  };
  reduceQuery?.addEventListener("change", paint);
  try {
    listen<Translucency>("translucency-changed", (e) => {
      heard = true;
      show(e.payload);
    }).catch(() => {});
    api.translucencyGet().then(
      // A change heard first is newer than this answer.
      (t) => heard || show(t),
      () => {},
    );
  } catch {
    // Not running inside the app (e.g. the page opened in a browser): the sidebar stays solid.
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** What the sidebar does now, for the setting's row. */
export function useTranslucency(): Translucency {
  return useSyncExternalStore(subscribe, () => current);
}
