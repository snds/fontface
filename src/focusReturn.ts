/**
 * Where focus goes back to when a dialog opened from code closes: the font picker (Compare
 * With…, Pair With…, Add Fonts…, Choose another), the tag picker (Cmd+T on the selection, Tags…)
 * and Remove from Library's question.
 *
 * Such a dialog has no trigger, and its search field takes focus as it mounts, before Base UI
 * notes what had focus. Left to itself, Base UI then hands focus back to the dialog's own field,
 * which is gone by then, so focus fell to the page's body: the list lost its place and the arrow
 * keys stopped working. Instead, what had focus is noted when the dialog is asked for
 * (`focusBack`), and the dialog's `finalFocus` asks for it back.
 *
 * The choice is pure (`firstFocusable`, `canTakeFocus`, `openerOf` take any element-like
 * object), so `npm run test:ui` covers it; `focusBack` and `byIdOnTop` read the page.
 */

/** The library list's scroll element (Rows, Tiles or Table) carries this attribute. */
export const LIBRARY_LIST_ATTR = "data-library-list";

/** The parts of an element the choice looks at (an HTMLElement in the app). */
export interface FocusCandidate {
  isConnected: boolean;
  closest(selector: string): unknown;
  matches(selector: string): boolean;
  getClientRects(): { length: number };
}

/** It can take focus now: still in the page, not on a covered layer (`inert`: the list under a
 *  page, a page under another), not disabled, and drawn. */
export function canTakeFocus(el: FocusCandidate): boolean {
  return el.isConnected && !el.closest("[inert]") && !el.matches(":disabled, [aria-disabled='true']") && el.getClientRects().length > 0;
}

type Candidate<T> = T | null | undefined | (() => T | null | undefined);

/** The first candidate that can take focus. A candidate can be a function, asked only if the
 *  ones before it can't. */
export function firstFocusable<T extends FocusCandidate>(candidates: readonly Candidate<T>[], can: (el: T) => boolean = canTakeFocus): T | null {
  for (const c of candidates) {
    const el = typeof c === "function" ? c() : c;
    if (el && can(el)) return el;
  }
  return null;
}

/** What had focus, worth giving it back to: not the page's body, and not something outside the
 *  app's root (a menu's item: menus are drawn outside it, and go away as they close). */
export function openerOf<T>(active: T | null, root: { contains(node: T): boolean } | null, body: T | null): T | null {
  if (!active || active === body || !root?.contains(active)) return null;
  return active;
}

/** An element by id, on the top page first: a font page covered by another (under Compare, say)
 *  has the same ids as the one on top. */
export function byIdOnTop(id: string): HTMLElement | null {
  const top = document.querySelector("[data-page-top]");
  return top?.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ?? document.getElementById(id);
}

/**
 * Notes what has focus now, as a dialog is asked for from code, and returns what to focus when
 * it closes: that element, if it can still take focus; else `returnTo` (an element id: the
 * button a font action came from, such as the font page's More); else the top page's heading;
 * else the library list (which puts its active row back in view). Null leaves it to the dialog.
 */
export function focusBack(returnTo?: string): () => HTMLElement | null {
  const opener = openerOf<Element>(document.activeElement, document.getElementById("root"), document.body);
  const noted = opener instanceof HTMLElement ? opener : null;
  return () =>
    firstFocusable<HTMLElement>([
      noted,
      returnTo ? () => byIdOnTop(returnTo) : null,
      () => document.querySelector<HTMLElement>("[data-page-top] h1"),
      () => document.querySelector<HTMLElement>(`[${LIBRARY_LIST_ATTR}]`),
    ]);
}
