// Run with `npm run test:ui`. The page stack over the library list and its Back keys (nav.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { backKeyIntent, EMPTY_NAV, findIntent, isBackShortcut, navReducer, topPage as top, type FontPageEntry, type KeyLike, type NavState, type NewPage, type Page } from "./nav.ts";

/** The top page, as a font page (these tests open font pages unless they say otherwise). */
const topPage = (state: NavState) => top(state) as FontPageEntry | undefined;
const asFont = (p: Page) => p as FontPageEntry;

const page = (faceKey: string, styleKey = faceKey): NewPage => ({ kind: "font", faceKey, styleKey, tab: "specimen", returnTo: `f:${faceKey}` });

const open = (state: NavState, p: NewPage) => navReducer(state, { type: "open", page: p });

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test("opening pushes a page with its own id; Back pops it", () => {
  const one = open(EMPTY_NAV, page("ps:Inter-Regular"));
  assert.equal(one.pages.length, 1);
  assert.equal(topPage(one)?.faceKey, "ps:Inter-Regular");
  assert.equal(topPage(one)?.id, 1);
  const two = open(one, page("ps:Lora-Regular"));
  assert.deepEqual(
    two.pages.map((p) => p.id),
    [1, 2],
  );
  const back = navReducer(two, { type: "back" });
  assert.equal(topPage(back)?.faceKey, "ps:Inter-Regular");
  // Ids are never reused, so a page opened after Back gets a fresh React tree.
  assert.equal(topPage(open(back, page("ps:Lora-Regular")))?.id, 3);
});

test("opening the font already on top changes nothing", () => {
  const one = open(EMPTY_NAV, page("ps:Inter-Regular"));
  assert.equal(open(one, page("ps:Inter-Regular")), one);
  // Another style of it is a new page.
  assert.equal(open(one, page("ps:Inter-Regular", "ps:Inter-Bold")).pages.length, 2);
});

test("Back and clear with nothing open return the same state", () => {
  assert.equal(navReducer(EMPTY_NAV, { type: "back" }), EMPTY_NAV);
  assert.equal(navReducer(EMPTY_NAV, { type: "clear" }), EMPTY_NAV);
});

test("a sidebar click clears every page", () => {
  const two = open(open(EMPTY_NAV, page("a")), page("b"));
  const cleared = navReducer(two, { type: "clear" });
  assert.deepEqual(cleared.pages, []);
  assert.equal(cleared.nextId, two.nextId, "ids keep counting");
});

test("update changes only the named page, and only when something differs", () => {
  const two = open(open(EMPTY_NAV, page("a")), page("b"));
  const styled = navReducer(two, { type: "update", id: 1, patch: { styleKey: "a-bold", tab: "info" } });
  assert.deepEqual(
    styled.pages.map((p) => [asFont(p).styleKey, asFont(p).tab]),
    [
      ["a-bold", "info"],
      ["b", "specimen"],
    ],
  );
  assert.equal(styled.pages[1], two.pages[1], "the other page is untouched");
  assert.equal(navReducer(styled, { type: "update", id: 1, patch: { tab: "info" } }), styled);
  assert.equal(navReducer(styled, { type: "update", id: 99, patch: { tab: "axes" } }), styled);
});

test("Back shortcut: Cmd+[ on macOS, Alt+Left on Windows", () => {
  assert.ok(isBackShortcut(key("[", { metaKey: true }), true));
  // Layouts where "[" needs Option still report the physical key.
  assert.ok(isBackShortcut(key("“", { metaKey: true, code: "BracketLeft" }), true));
  assert.ok(!isBackShortcut(key("[", { metaKey: true, shiftKey: true }), true));
  assert.ok(!isBackShortcut(key("[", { ctrlKey: true }), true));
  assert.ok(!isBackShortcut(key("ArrowLeft", { altKey: true }), true));
  assert.ok(isBackShortcut(key("ArrowLeft", { altKey: true }), false));
  assert.ok(!isBackShortcut(key("[", { metaKey: true }), false));
  assert.ok(!isBackShortcut(key("ArrowLeft"), false));
});

test("Esc goes back outside text fields, menus and popovers", () => {
  const mac = { mac: true, blocked: false };
  assert.equal(backKeyIntent(key("Escape"), { ...mac, focus: "other" }), "back");
  // In a text field Esc first leaves the field; the next Esc goes back.
  assert.equal(backKeyIntent(key("Escape"), { ...mac, focus: "text" }), "leave-field");
  assert.equal(backKeyIntent(key("Escape"), { ...mac, focus: "popup" }), null);
  // Already handled: a popover closing, or a search box clearing its text.
  assert.equal(backKeyIntent(key("Escape", { defaultPrevented: true }), { ...mac, focus: "other" }), null);
  assert.equal(backKeyIntent(key("Escape", { isComposing: true }), { ...mac, focus: "other" }), null);
  // A disabled button that keeps focus (Reset with nothing to reset) takes every key without
  // handling it: Esc still goes back.
  assert.equal(backKeyIntent(key("Escape", { defaultPrevented: true }), { ...mac, focus: "disabled" }), "back");
  assert.equal(backKeyIntent(key("[", { metaKey: true }), { ...mac, focus: "disabled" }), "back");
  assert.equal(backKeyIntent(key("Escape", { shiftKey: true }), { ...mac, focus: "other" }), null);
  assert.equal(backKeyIntent(key("x"), { ...mac, focus: "other" }), null);
});

test("Cmd+[ works from a text field, but not from a menu, and nothing works while blocked", () => {
  const cmd = key("[", { metaKey: true });
  assert.equal(backKeyIntent(cmd, { mac: true, focus: "text", blocked: false }), "back");
  assert.equal(backKeyIntent(cmd, { mac: true, focus: "popup", blocked: false }), null);
  // Settings over the page, a dialog open, or a drag under way.
  assert.equal(backKeyIntent(cmd, { mac: true, focus: "other", blocked: true }), null);
  assert.equal(backKeyIntent(key("Escape"), { mac: true, focus: "other", blocked: true }), null);
});

test("a service's page opens over its list once, and Back closes it like any page", () => {
  const catalog = { kind: "catalog", service: "google", returnTo: "browse" } as const;
  const one = open(EMPTY_NAV, catalog);
  assert.equal(top(one)?.kind, "catalog");
  assert.equal(open(one, catalog), one, "Browse twice: still one page");
  const purchases = open(one, { ...catalog, service: "purchases" });
  assert.equal(purchases.pages.length, 2, "another service's page is a new page");
  // A font page over a catalog, then Back to the catalog.
  const font = open(one, page("ps:Inter-Regular"));
  assert.equal(top(navReducer(font, { type: "back" }))?.kind, "catalog");
  // Font-page changes never touch a catalog page.
  assert.equal(navReducer(one, { type: "update", id: top(one)!.id, patch: { tab: "info" } }), one);
});

test("Cmd+F: the list's Search, leaving a font page, or the Google catalog's own search", () => {
  assert.equal(findIntent(top(EMPTY_NAV)), "list");
  const font = open(EMPTY_NAV, page("ps:Inter-Regular"));
  assert.equal(findIntent(top(font)), "leave");
  // The catalog keeps its query, filters and scroll: Cmd+F searches it instead.
  const google = open(EMPTY_NAV, { kind: "catalog", service: "google", returnTo: "browse" });
  assert.equal(findIntent(top(google)), "page");
  // The Purchases page has no search field: Cmd+F leaves it as it is.
  const purchases = open(EMPTY_NAV, { kind: "catalog", service: "purchases", returnTo: "browse" });
  assert.equal(findIntent(top(purchases)), null);
  // A font page opened over the catalog goes back to the list's Search.
  assert.equal(findIntent(top(open(google, page("ps:Inter-Regular")))), "leave");
});

test("Family groups: one page at a time, its filter changes in place, and Cmd+F goes to its search", () => {
  const groups: NewPage = { kind: "groups", filter: "all", focus: [], returnTo: null };
  const one = navReducer(EMPTY_NAV, { type: "open", page: groups });
  const again = navReducer(one, { type: "open", page: groups });
  assert.equal(again.pages.length, 1, "the same page again: still one page");
  assert.equal(top(again)!.id, top(one)!.id, "the same page, so it keeps its state");
  assert.equal((top(again) as { opened: number }).opened, (top(one) as { opened: number }).opened + 1, "asked for again: its heading takes focus (from Settings, say)");
  const focused = navReducer(one, { type: "open", page: { kind: "groups", filter: "suggested", focus: ["ps:A|static|r"], returnTo: null } });
  assert.equal(focused.pages.length, 1, "opened again from elsewhere, it shows that instead of stacking");
  assert.deepEqual([top(focused)!.id, (top(focused) as { filter: string }).filter], [top(one)!.id, "suggested"]);
  const filtered = navReducer(one, { type: "update", id: top(one)!.id, patch: { filter: "changed" } });
  assert.equal((top(filtered) as { filter: string }).filter, "changed");
  assert.equal(navReducer(filtered, { type: "update", id: top(one)!.id, patch: { filter: "changed" } }), filtered);
  assert.equal(findIntent(top(one)), "page");
});
