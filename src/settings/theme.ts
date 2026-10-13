import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ThemeSetting } from "@/api";

/**
 * Light or dark. shadcn themes key off a `.dark` class on <html>: it follows the Appearance
 * setting, and with "system" it follows the OS live (prefers-color-scheme).
 *
 * The setting lives in the back end, which answers after the first paint. So the last one used
 * is also kept in localStorage under KEY. A small script in index.html applies it before the
 * first paint, so the window doesn't flash the wrong colors at launch (keep its key and values
 * in step with this file); `initTheme` takes over when the app starts. The window's native parts
 * (the close, minimize and zoom buttons) follow through `setTheme` (null = follow the OS), and
 * the back end colors the window behind the page from the setting (src-tauri/src/window.rs).
 */

const KEY = "fontface.theme";
const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

const isSetting = (v: unknown): v is ThemeSetting => v === "system" || v === "light" || v === "dark";

function cached(): ThemeSetting {
  try {
    const v = localStorage.getItem(KEY);
    return isSetting(v) ? v : "system";
  } catch {
    return "system";
  }
}

let setting: ThemeSetting = "system";
let dark = false;
const listeners = new Set<() => void>();

function paint() {
  const next = setting === "system" ? !!media?.matches : setting === "dark";
  document.documentElement.classList.toggle("dark", next);
  if (next === dark) return;
  dark = next;
  for (const l of listeners) l();
}

function tellWindow() {
  try {
    getCurrentWindow()
      .setTheme(setting === "system" ? null : setting)
      .catch(() => {});
  } catch {
    // Not running inside the app (e.g. the page opened in a browser).
  }
}

/** Applies the last Appearance used, and follows OS changes from then on. Call once, before rendering. */
export function initTheme() {
  setting = cached();
  paint();
  media?.addEventListener("change", paint);
  if (setting !== "system") tellWindow();
}

/** Applies an Appearance setting (from the back end, or just chosen) and remembers it for the next launch. */
export function applyTheme(next: ThemeSetting) {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Private storage unavailable: the back end's value still applies once it loads.
  }
  if (next === setting) return;
  setting = next;
  paint();
  tellWindow();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** True while the app is dark (for parts that need it in script, such as toasts). */
export function useDarkTheme(): boolean {
  return useSyncExternalStore(subscribe, () => dark);
}
