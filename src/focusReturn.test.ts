// Run with `npm run test:ui`. Where focus goes back to when a dialog opened from code closes
// (focusReturn.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { canTakeFocus, firstFocusable, openerOf, type FocusCandidate } from "./focusReturn.ts";

/** An element-like object: in the page unless `gone`, under an inert layer if `covered`. */
function el(name: string, { gone = false, covered = false, disabled = false, hidden = false } = {}): FocusCandidate & { name: string } {
  return {
    name,
    isConnected: !gone,
    closest: (selector: string) => (selector === "[inert]" && covered ? {} : null),
    matches: (selector: string) => disabled && selector.includes(":disabled"),
    getClientRects: () => ({ length: hidden ? 0 : 1 }),
  };
}

test("an element can take focus while it's in the page, uncovered, enabled and drawn", () => {
  assert.ok(canTakeFocus(el("button")));
  assert.ok(!canTakeFocus(el("menu item", { gone: true })), "removed as its menu closed");
  assert.ok(!canTakeFocus(el("More on a covered font page", { covered: true })));
  assert.ok(!canTakeFocus(el("Add Fonts with 8 fonts shown", { disabled: true })));
  assert.ok(!canTakeFocus(el("hidden", { hidden: true })));
});

test("focus goes back to the opener, else the button named, else the page's heading, else the list", () => {
  const opener = el("Choose another");
  const more = el("More");
  const heading = el("h1");
  const list = el("list");
  assert.equal(firstFocusable([opener, () => more, () => heading, () => list]), opener);
  assert.equal(firstFocusable([el("menu item", { gone: true }), () => more, () => heading]), more, "a menu's item: the menu's button");
  assert.equal(firstFocusable([el("Add Fonts…", { disabled: true }), null, () => heading]), heading);
  assert.equal(firstFocusable([null, null, () => null, () => list]), list, "no page open: the list");
  assert.equal(firstFocusable([null, () => el("covered list", { covered: true })]), null, "nothing: the dialog's own choice");
});

test("a later fallback is only looked for when the earlier ones can't take focus", () => {
  let asked = 0;
  firstFocusable([el("opener"), () => (asked++, el("fallback"))]);
  assert.equal(asked, 0);
});

test("the opener is what had focus inside the app: not the body, not a menu drawn outside it", () => {
  const body = { id: "body" };
  const row = { id: "list" };
  const menuItem = { id: "menu item" };
  const root = { contains: (n: { id: string }) => n === row };
  assert.equal(openerOf(row, root, body), row);
  assert.equal(openerOf(menuItem, root, body), null);
  assert.equal(openerOf(body, root, body), null);
  assert.equal(openerOf(null, root, body), null);
});
