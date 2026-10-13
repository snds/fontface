import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "@/api";
import { Icon } from "@/components/ui/icon";

/**
 * On macOS the window has no separate title bar (see src-tauri/tauri.macos.conf.json). The
 * close, minimize and zoom buttons sit in the sidebar's top strip, and the app's 52px top row
 * (sidebar strip, toolbar or page header, detail header) works as the title bar: drag it to move
 * the window, double-click it to zoom or minimize, as macOS's own setting says
 * (watchTitleBarDoubleClick). While a dialog is open, a strip over its backdrop keeps the top
 * row working (DialogDragStrip). Windows keeps its native frame and the plain layout.
 */
export const IS_MAC = typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent);

// Full screen hides the window buttons, and there's no window to move. The window reports a
// resize when it enters or leaves full screen, so it's checked again after each resize settles.
let fullscreen = false;
let watching = false;
const listeners = new Set<() => void>();

function watchFullscreen() {
  if (watching || !IS_MAC) return;
  watching = true;
  try {
    const win = getCurrentWindow();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () =>
      win.isFullscreen().then(
        (now) => {
          if (now === fullscreen) return;
          fullscreen = now;
          for (const notify of listeners) notify();
        },
        () => {},
      );
    check();
    win
      .onResized(() => {
        clearTimeout(timer);
        timer = setTimeout(check, 100);
      })
      .catch(() => {});
  } catch {
    // Not running inside the app (e.g. the page opened in a browser): no window to watch.
  }
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  watchFullscreen();
  return () => {
    listeners.delete(onChange);
  };
}

/** True while the app's top row is the window's title bar: on macOS, outside full screen. */
export function useTitleBar(): boolean {
  return useSyncExternalStore(subscribe, () => IS_MAC && !fullscreen);
}

/**
 * Spread on a title bar surface. Pressing anywhere inside it moves the window, and a double-click
 * zooms or minimizes it. Tauri leaves buttons, links, inputs, labels and elements with an
 * interactive role alone; mark any other control with NO_DRAG. Adds nothing when `on` is false.
 */
export const dragRegion = (on: boolean) => (on ? { "data-tauri-drag-region": "deep" } : {});

/** For controls Tauri doesn't recognize as clickable (a slider's track and thumb), so pressing them never moves the window. */
export const NO_DRAG = { "data-tauri-drag-region": "false" } as const;

// The same test as Tauri's drag script (tauri 2.12, src/window/scripts/drag.js), so a
// double-click is taken over exactly where Tauri would act on it.
const DRAG_ATTR = "data-tauri-drag-region";
const CLICKABLE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY"]);
const INTERACTIVE_ROLES = new Set(["button", "link", "menuitem", "tab", "checkbox", "radio", "switch", "option"]);

const isClickable = (el: HTMLElement) =>
  CLICKABLE_TAGS.has(el.tagName) ||
  (el.hasAttribute("contenteditable") && el.getAttribute("contenteditable") !== "false") ||
  (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") ||
  INTERACTIVE_ROLES.has(el.getAttribute("role") ?? "");

function isDragRegion(path: EventTarget[]): boolean {
  for (const el of path) {
    if (!(el instanceof HTMLElement)) continue;
    const attr = el.getAttribute(DRAG_ATTR);
    if (attr === null) {
      if (isClickable(el)) return false;
      continue;
    }
    if (attr === "false") return false;
    if (attr === "deep") return true;
    if (attr === "" || attr === "true") return el === path[0];
  }
  return false;
}

/**
 * macOS: a double-click on the top row does what System Settings › Desktop & Dock › "Double-click
 * a window's title bar to" says (zoom, minimize or nothing), like a native title bar. Tauri's
 * drag script would always zoom: it acts on the second click's mouseup, on the document, so
 * this catches that mouseup first (on the window, while capturing), stops it, and asks the back
 * end instead. Like Tauri, it only counts if the mouse didn't move between the second press and
 * release. Call once, at startup.
 */
export function watchTitleBarDoubleClick() {
  if (!IS_MAC) return;
  let pressX = 0;
  let pressY = 0;
  window.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0 || e.detail !== 2) return;
      pressX = e.clientX;
      pressY = e.clientY;
    },
    true,
  );
  window.addEventListener(
    "mouseup",
    (e) => {
      if (e.button !== 0 || e.detail !== 2 || e.clientX !== pressX || e.clientY !== pressY) return;
      if (!isDragRegion(e.composedPath())) return;
      e.stopImmediatePropagation();
      api.titleBarDoubleClick().catch(() => {});
    },
    true,
  );
}

/**
 * Inside a dialog's portal, between its backdrop and the dialog itself: the top 52px stay a title
 * bar while the backdrop covers the window, so it can still be moved. Pressing the strip doesn't
 * close the dialog (only a press on the backdrop itself does).
 */
export function DialogDragStrip() {
  const titleBar = useTitleBar();
  if (!titleBar) return null;
  return <div aria-hidden className="fixed inset-x-0 top-0 z-50 h-13" {...dragRegion(true)} />;
}

/**
 * The first row of a page in the main column. It's exactly as tall as the library toolbar and
 * the sidebar's top strip (52px), so they line up into one bar. Longer explanations go below it.
 */
export function PageHeader({ icon, title, children }: { icon: string; title: string; children?: React.ReactNode }) {
  const titleBar = useTitleBar();
  return (
    <header className="flex h-13 shrink-0 items-center gap-3 border-b px-4 select-none" {...dragRegion(titleBar)}>
      <Icon name={icon} size={22} className="text-muted-foreground" />
      <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h2>
      {children}
    </header>
  );
}
