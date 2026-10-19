import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { IS_MAC } from "@/components/TitleBar";
import { backKeyIntent, EMPTY_NAV, isBackShortcut, MOUSE_BACK_BUTTON, navReducer, topPage, type FocusKind, type NavState, type NewPage, type Page, type PagePatch } from "@/nav";

const TEXT_INPUTS = new Set(["text", "search", "number", "email", "url", "tel", "password"]);
/** Menus, popovers, dialogs and select lists: they handle their own Esc. */
const POPUPS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/** Where focus is, for the Back keys (see backKeyIntent). */
export function focusKind(el: EventTarget | null): FocusKind {
  if (!(el instanceof HTMLElement)) return "other";
  if (el.closest(POPUPS)) return "popup";
  if (el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return "text";
  if (el instanceof HTMLInputElement && TEXT_INPUTS.has(el.type)) return "text";
  return "other";
}

/** A menu, popover, dialog or select list (the font page's style picker) is open. They're
 *  portaled out of the app's root; the library list (a listbox) stays inside it. A closed
 *  Select keeps its list in the page, hidden, so only popups that are drawn count. Shortcuts
 *  that would cover or close the page underneath (Back, Cmd+, and Cmd+F) wait while one is. */
export function popupOpen(): boolean {
  const root = document.getElementById("root");
  return [...document.querySelectorAll(POPUPS)].some((el) => !root?.contains(el) && el.getClientRects().length > 0);
}

export interface Nav {
  pages: Page[];
  open: (page: NewPage) => void;
  /** Closes the top page. */
  back: () => void;
  /** Closes the top page if it's still this one (by id), as the stack is now, not as it was
   *  when the caller last rendered: an await later, Back may already have closed it. */
  backFrom: (id: number) => void;
  /** A sidebar click: every page closes. */
  clear: () => void;
  update: (id: number, patch: PagePatch) => void;
}

interface Options {
  /** True while Back must wait: settings cover the page, or a drag is under way. */
  blocked: () => boolean;
  /** Called after Back closed a page, with the pages left. */
  onBack?: (closed: Page, remaining: Page[]) => void;
  /** Asked before Cmd+[ goes back: false drops it. The View menu's Back has the same key, and
   *  App's shortcut guard (fontActions.createShortcutGuard) keeps one press from going back twice. */
  allowKeyBack?: () => boolean;
}

/**
 * The page stack (nav.ts) and its Back keys: Cmd+[ (Alt+Left on Windows), the mouse's back
 * button, and Esc when focus isn't in a text field, menu or popover. They listen only while a
 * page is open, and do nothing while a dialog or menu is open.
 */
export function useNav({ blocked, onBack, allowKeyBack }: Options): Nav {
  const [state, dispatch] = useReducer(navReducer, EMPTY_NAV);
  // Read by Back right away, so two Backs before the next render close two pages, not one twice.
  const current = useRef<NavState>(state);
  current.current = state;
  const options = useRef({ blocked, onBack, allowKeyBack });
  options.current = { blocked, onBack, allowKeyBack };

  const back = useCallback(() => {
    const before = current.current;
    const closed = before.pages[before.pages.length - 1];
    if (!closed) return;
    current.current = navReducer(before, { type: "back" });
    dispatch({ type: "back" });
    options.current.onBack?.(closed, current.current.pages);
  }, []);

  const backFrom = useCallback((id: number) => {
    if (topPage(current.current)?.id === id) back();
  }, [back]);

  const open = useCallback((page: NewPage) => dispatch({ type: "open", page }), []);
  const clear = useCallback(() => dispatch({ type: "clear" }), []);
  const update = useCallback((id: number, patch: PagePatch) => dispatch({ type: "update", id, patch }), []);

  const anyOpen = state.pages.length > 0;
  useEffect(() => {
    if (!anyOpen) return;
    const isBlocked = () => options.current.blocked() || popupOpen();
    const onKey = (e: KeyboardEvent) => {
      const intent = backKeyIntent(e, { mac: IS_MAC, focus: focusKind(e.target), blocked: isBlocked() });
      if (!intent) return;
      e.preventDefault();
      if (intent === "leave-field") (e.target as HTMLElement).blur();
      // Esc has no menu item; only Cmd+[ can reach the View menu's Back too.
      else if (!isBackShortcut(e, IS_MAC) || (options.current.allowKeyBack?.() ?? true)) back();
    };
    // The mouse's back button. Its press is taken too, so the web view never treats it as its own.
    const onMouse = (e: MouseEvent) => {
      if (e.button !== MOUSE_BACK_BUTTON) return;
      e.preventDefault();
      if (e.type === "mouseup" && !isBlocked()) back();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouse);
    window.addEventListener("mouseup", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouse);
      window.removeEventListener("mouseup", onMouse);
    };
  }, [anyOpen, back]);

  return useMemo(() => ({ pages: state.pages, open, back, backFrom, clear, update }), [state.pages, open, back, backFrom, clear, update]);
}
