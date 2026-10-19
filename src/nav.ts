import type { FontPageTab } from "./api";

/**
 * Pages over the library list (see docs/ARCHITECTURE.md, Front end). The sidebar picks a place
 * (App's `view` and filters), and pages are pushed on top of it: the font page, and the Google
 * Fonts and Purchases pages ("catalog" pages, opened with Browse from those sources' lists);
 * later Compare, Pair and Family groups. While a page shows, the list stays mounted underneath,
 * hidden and inert, so it keeps its scroll position, selection and loaded previews.
 *
 * - Back (the header button, Cmd+[ or Alt+Left on Windows, the mouse's back button, Esc outside
 *   a text field, menu or popover) closes the top page.
 * - A sidebar click replaces the place and clears every page. Back never steps through earlier
 *   places, so it stays predictable.
 * - A font page finds its family by face key, not by family name, so it survives regrouping.
 *
 * Everything here is pure (no React, no DOM), so `npm run test:ui` covers it. The window
 * listeners live in useNav.ts.
 */

export interface FontPageEntry {
  kind: "font";
  /** Unique for the session; keys the page's React tree. */
  id: number;
  /** The face the page was opened from. Finds the family if the chosen style is gone. */
  faceKey: string;
  /** The chosen style (a face key). Opening from a Variable-only list picks a variable style. */
  styleKey: string;
  tab: FontPageTab;
  /** The list row that opened the page (a row key), focused again on Back. */
  returnTo: string | null;
}

/** A service's own page, opened over its list with Browse: the Google Fonts catalog, or the
 *  Purchases page (new downloads, imports, watched folders). */
export interface CatalogPageEntry {
  kind: "catalog";
  id: number;
  service: "google" | "purchases";
  /** The element (by id) that opened it, focused again on Back: the Browse button. */
  returnTo: string | null;
}

export type Page = FontPageEntry | CatalogPageEntry;

/** What a new page needs; the stack gives it its id. */
export type NewPage = Omit<FontPageEntry, "id"> | Omit<CatalogPageEntry, "id">;

/** The parts of a page that change while it's open. */
export type PagePatch = Partial<Pick<FontPageEntry, "styleKey" | "tab">>;

export interface NavState {
  pages: Page[];
  nextId: number;
}

export type NavAction =
  | { type: "open"; page: NewPage }
  | { type: "back" }
  | { type: "clear" }
  | { type: "update"; id: number; patch: PagePatch };

export const EMPTY_NAV: NavState = { pages: [], nextId: 1 };

/** The page on top, if any. */
export const topPage = (state: NavState): Page | undefined => state.pages[state.pages.length - 1];

export function navReducer(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case "open": {
      // The same page already on top (a double-click and a Return, say): nothing new to show.
      const top = topPage(state);
      if (top && samePage(top, action.page)) return state;
      return { pages: [...state.pages, { ...action.page, id: state.nextId } as Page], nextId: state.nextId + 1 };
    }
    case "back":
      return state.pages.length ? { ...state, pages: state.pages.slice(0, -1) } : state;
    case "clear":
      return state.pages.length ? { ...state, pages: [] } : state;
    case "update": {
      let changed = false;
      const pages = state.pages.map((p) => {
        // Only a font page has parts that change.
        if (p.id !== action.id || p.kind !== "font") return p;
        const next = { ...p, ...action.patch };
        if (next.styleKey === p.styleKey && next.tab === p.tab) return p;
        changed = true;
        return next;
      });
      return changed ? { ...state, pages } : state;
    }
  }
}

/** The same font on the same style, or the same service's page. */
function samePage(a: Page, b: NewPage): boolean {
  if (a.kind === "font" && b.kind === "font") return a.faceKey === b.faceKey && a.styleKey === b.styleKey;
  if (a.kind === "catalog" && b.kind === "catalog") return a.service === b.service;
  return false;
}

// ------------------------------------------------------------------------------- Back keys

/** The parts of a keyboard event the Back keys look at. */
export interface KeyLike {
  key: string;
  /** The physical key, so Cmd+[ works on layouts where "[" needs Option. */
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented?: boolean;
  /** Typing with an input method (Japanese, say): Esc belongs to it. */
  isComposing?: boolean;
}

/** Where focus is: a text field, inside a menu, popover or dialog, or anywhere else. */
export type FocusKind = "text" | "popup" | "other";

export interface BackContext {
  mac: boolean;
  focus: FocusKind;
  /** Back is off for now: settings cover the page, a dialog or menu is open, or a drag is under way. */
  blocked: boolean;
}

/** Cmd+[ on macOS; Alt+Left on Windows. */
export function isBackShortcut(e: KeyLike, mac: boolean): boolean {
  if (e.shiftKey) return false;
  if (mac) return e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "[" || e.code === "BracketLeft");
  return e.altKey && !e.ctrlKey && !e.metaKey && e.key === "ArrowLeft";
}

/**
 * What a key press means while a page is open: "back" closes the page; "leave-field" takes
 * focus out of a text field (Esc there leaves the field first, so a second Esc goes back);
 * null leaves the key alone.
 */
export function backKeyIntent(e: KeyLike, ctx: BackContext): "back" | "leave-field" | null {
  if (ctx.blocked) return null;
  if (isBackShortcut(e, ctx.mac)) return ctx.focus === "popup" ? null : "back";
  if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  // Something already handled this Esc (a popover closing, a search box clearing its text).
  if (e.defaultPrevented || e.isComposing) return null;
  if (ctx.focus === "popup") return null;
  return ctx.focus === "text" ? "leave-field" : "back";
}

/** The mouse's back button (MouseEvent.button 3), where the system passes it on to the page. */
export const MOUSE_BACK_BUTTON = 3;
