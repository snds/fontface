import type { FontPageTab } from "./api";
import type { CompareList, PairFonts } from "./compare.ts";
import { keyHandled } from "./tips.ts";

/**
 * Pages over the library list (see docs/ARCHITECTURE.md, Front end). The sidebar picks a place
 * (App's `view` and filters), and pages are pushed on top of it: the font page, the Purchases
 * page (a "catalog" page, opened with Browse from its list), Family groups, Compare and Pair.
 * (Google Fonts' catalog isn't a page: it's that source's own view.) While a page shows, the list stays mounted underneath,
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

/** A service's own page, opened over its list with Browse: the Purchases page (new downloads,
 *  imports, watched folders). Google Fonts' catalog used to be one; it's that source's view now. */
export interface CatalogPageEntry {
  kind: "catalog";
  id: number;
  service: "purchases";
  /** The element (by id) that opened it, focused again on Back: the Browse button. */
  returnTo: string | null;
}

/** Where focus goes back on Back: a list row (by row key) or an element (by id). Null: the list. */
export type PageReturn = { row: string } | { element: string } | null;

/** What the Family groups page lists: every family, what was grouped automatically, or what
 *  you changed. */
export type GroupsFilter = "all" | "automatic" | "changed";

/** The Family groups page (familyGroups.ts): from View options, a font's menus or Settings. */
export interface GroupsPageEntry {
  kind: "groups";
  id: number;
  filter: GroupsFilter;
  /** Faces it opened on (a font's menu): checked, their families open and in view. */
  focus: string[];
  /** Where focus goes back on Back. */
  returnTo: PageReturn;
  /** How many times it was asked for again while on top (Settings › Library, say): the page
   *  focuses its heading each time, since it stays mounted. Set by the stack. */
  opened: number;
}

/** Compare's two ways of showing its fonts: the same line stacked, or paragraphs in columns. */
export type CompareMode = "lines" | "columns";

/** Compare (compare.ts): 2 to 8 fonts, from the selection bar, a font's menus or the Font menu. */
export interface ComparePageEntry extends CompareList {
  kind: "compare";
  id: number;
  mode: CompareMode;
  returnTo: PageReturn;
}

/** Pair (compare.ts): a heading font and a body font, from a font's menus or the Font menu. */
export interface PairPageEntry extends PairFonts {
  kind: "pair";
  id: number;
  returnTo: PageReturn;
}

export type Page = FontPageEntry | CatalogPageEntry | GroupsPageEntry | ComparePageEntry | PairPageEntry;

/** What a new page needs; the stack gives it its id. */
export type NewPage =
  | Omit<FontPageEntry, "id">
  | Omit<CatalogPageEntry, "id">
  | Omit<GroupsPageEntry, "id" | "opened">
  | Omit<ComparePageEntry, "id">
  | Omit<PairPageEntry, "id">;

/** The parts of a page that change while it's open. */
export type PagePatch = Partial<Pick<FontPageEntry, "styleKey" | "tab">> &
  Partial<Pick<GroupsPageEntry, "filter">> &
  Partial<Pick<ComparePageEntry, "faces" | "left" | "mode">> &
  Partial<PairFonts>;

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
      const top = topPage(state);
      // Family groups on top already: it shows what was asked for now, with the same Back, and
      // takes focus again (asked for from Settings, focus has nowhere else to be).
      if (top?.kind === "groups" && action.page.kind === "groups") {
        const next: GroupsPageEntry = { ...top, filter: action.page.filter, focus: action.page.focus, opened: top.opened + 1 };
        return { ...state, pages: [...state.pages.slice(0, -1), next] };
      }
      // The same page already on top (a double-click and a Return, say): nothing new to show.
      if (top && samePage(top, action.page)) return state;
      const page = (action.page.kind === "groups" ? { ...action.page, id: state.nextId, opened: 0 } : { ...action.page, id: state.nextId }) as Page;
      return { pages: [...state.pages, page], nextId: state.nextId + 1 };
    }
    case "back":
      return state.pages.length ? { ...state, pages: state.pages.slice(0, -1) } : state;
    case "clear":
      return state.pages.length ? { ...state, pages: [] } : state;
    case "update": {
      let changed = false;
      const pages = state.pages.map((p): Page => {
        if (p.id !== action.id) return p;
        if (p.kind === "groups") {
          if (!action.patch.filter || action.patch.filter === p.filter) return p;
          changed = true;
          return { ...p, filter: action.patch.filter };
        }
        if (p.kind === "compare") {
          const { faces = p.faces, left = p.left, mode = p.mode } = action.patch;
          if (sameList(faces, p.faces) && left === p.left && mode === p.mode) return p;
          changed = true;
          return { ...p, faces, left, mode };
        }
        if (p.kind === "pair") {
          const { heading = p.heading, body = p.body } = action.patch;
          if (heading === p.heading && body === p.body) return p;
          changed = true;
          return { ...p, heading, body };
        }
        // A service's page has no parts that change.
        if (p.kind !== "font") return p;
        const next = { ...p, styleKey: action.patch.styleKey ?? p.styleKey, tab: action.patch.tab ?? p.tab };
        if (next.styleKey === p.styleKey && next.tab === p.tab) return p;
        changed = true;
        return next;
      });
      return changed ? { ...state, pages } : state;
    }
  }
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

/** The same font on the same style, the same service's page, or the same fonts compared or
 *  paired. (Family groups is never stacked twice: see "open".) */
function samePage(a: Page, b: NewPage): boolean {
  if (a.kind === "font" && b.kind === "font") return a.faceKey === b.faceKey && a.styleKey === b.styleKey;
  if (a.kind === "catalog" && b.kind === "catalog") return a.service === b.service;
  if (a.kind === "compare" && b.kind === "compare") return sameList(a.faces, b.faces);
  if (a.kind === "pair" && b.kind === "pair") return a.heading === b.heading && a.body === b.body;
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

/** Where focus is: a text field, inside a menu, popover or dialog, a disabled button that stays
 *  focusable (Base UI's `focusableWhenDisabled`, which takes every key but Tab without handling
 *  it, Esc included), or anywhere else. */
export type FocusKind = "text" | "popup" | "disabled" | "other";

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
  // A disabled button only blocked it, and a tooltip closing on it doesn't count (tips.ts).
  if ((keyHandled(e) && ctx.focus !== "disabled") || e.isComposing) return null;
  if (ctx.focus === "popup") return null;
  return ctx.focus === "text" ? "leave-field" : "back";
}

/** The mouse's back button (MouseEvent.button 3), where the system passes it on to the page. */
export const MOUSE_BACK_BUTTON = 3;

/**
 * What Cmd+F (Ctrl+F on Windows) does, by the page on top: "list" goes to the toolbar's Search
 * (no page is open; on the Google Fonts view it searches the catalog); "leave" closes the pages,
 * then goes there (a font page, Compare or Pair, which have no search of their own); "page" goes
 * to the page's own search field (Family groups), keeping what's typed and picked there; null
 * does nothing (the Purchases page has no search field, and leaving it would lose its place).
 */
export function findIntent(top: Page | undefined): "list" | "leave" | "page" | null {
  if (!top) return "list";
  if (top.kind === "font" || top.kind === "compare" || top.kind === "pair") return "leave";
  if (top.kind === "groups") return "page";
  return null;
}
