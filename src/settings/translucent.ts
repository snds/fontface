import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type TranslucencyState } from "@/api";

/**
 * The see-through window, on the page's side. The back end decides what shows (the setting, the
 * system, Reduce transparency) and puts the OS's blur behind the window
 * (src-tauri/src/translucency.rs). This puts `data-translucent` (the look) and, for Whole
 * window, `data-translucent-window` on <html> to match; src/index.css does the rest.
 *
 * The web view's own `prefers-reduced-transparency` and `prefers-contrast: more` also make the
 * window solid, where WebKit knows them (an unknown query reads "not all").
 *
 * The last state is kept in localStorage under KEY as "blur", "blur+window", "plain"… so
 * index.html can apply it before the first paint (keep its key and values in step).
 */

const KEY = "fontface.translucent";
const SOLID: TranslucencyState = { look: null, window: false, reduced: false, unsupported: false, nextLaunch: false };

const queries =
  typeof window === "undefined" ? [] : ["(prefers-reduced-transparency: reduce)", "(prefers-contrast: more)"].map((q) => window.matchMedia(q));
const webReduced = () => queries.some((q) => q.media !== "not all" && q.matches);

let fromBackEnd = SOLID;
let current = SOLID;
const listeners = new Set<() => void>();

function paint() {
  const reduced = webReduced();
  current = reduced ? { ...fromBackEnd, look: null, window: false, reduced: true } : fromBackEnd;
  const root = document.documentElement;
  if (current.look) root.dataset.translucent = current.look;
  else delete root.dataset.translucent;
  root.toggleAttribute("data-translucent-window", current.window);
  try {
    localStorage.setItem(KEY, current.look ? `${current.look}${current.window ? "+window" : ""}` : "");
  } catch {
    // Private storage unavailable: the back end's answer still applies once it arrives.
  }
  for (const l of listeners) l();
}

/** Follows the back end from now on. Call once, before rendering. */
export function initTranslucency() {
  let heard = false;
  const show = (next: TranslucencyState) => {
    fromBackEnd = next;
    paint();
  };
  for (const q of queries) q.addEventListener("change", paint);
  try {
    listen<TranslucencyState>("translucency-changed", (e) => {
      heard = true;
      show(e.payload);
    }).catch(() => {});
    api.translucencyGet().then(
      // A change heard first is newer than this answer.
      (t) => heard || show(t),
      () => {},
    );
  } catch {
    // Not running inside the app (e.g. the page opened in a browser): the window stays solid.
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** What the window shows now, for the setting's row. */
export function useTranslucency(): TranslucencyState {
  return useSyncExternalStore(subscribe, () => current);
}
