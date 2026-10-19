// Run with `npm run test:ui`. Compare's and Pair's fonts, and the library search (compare.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addToCompare,
  COMPARE_MAX,
  compareList,
  focusAfterMove,
  moveInCompare,
  removeFromCompare,
  replaceInCompare,
  searchFamilies,
  shownFamilies,
  swapPair,
} from "./compare.ts";
import type { Family } from "./library.ts";
import { EMPTY_NAV, findIntent, navReducer, topPage, type ComparePageEntry, type NavState, type NewPage, type PairPageEntry } from "./nav.ts";

const keys = (n: number) => Array.from({ length: n }, (_, i) => `k${i + 1}`);

test("Compare shows 2 to 8 fonts; more than 8 are left out and counted", () => {
  assert.equal(COMPARE_MAX, 8);
  assert.deepEqual(compareList(["a", "b"]), { faces: ["a", "b"], left: 0 });
  assert.deepEqual(compareList(["a", "b", "a"]), { faces: ["a", "b"], left: 0 }, "each font once");
  const twelve = compareList(keys(12));
  assert.deepEqual(twelve.faces, keys(8));
  assert.equal(twelve.left, 4);
});

test("adding fills the free places; what doesn't fit is counted", () => {
  const two = compareList(["a", "b"]);
  assert.deepEqual(addToCompare(two, ["b", "c"]), { faces: ["a", "b", "c"], left: 0 }, "a font already shown isn't added twice");
  const full = compareList(keys(8));
  assert.deepEqual(addToCompare(full, ["x", "y"]), { faces: keys(8), left: 2 });
  const seven = compareList(keys(7));
  assert.deepEqual(addToCompare(seven, ["x", "y", "z"]), { faces: [...keys(7), "x"], left: 2 });
});

test("removing a font clears the note: there's room now", () => {
  const twelve = compareList(keys(12));
  const fewer = removeFromCompare(twelve, "k3");
  assert.deepEqual(fewer.faces, ["k1", "k2", "k4", "k5", "k6", "k7", "k8"]);
  assert.equal(fewer.left, 0);
  assert.equal(removeFromCompare(fewer, "nope"), fewer);
});

test("a lane's style picker swaps its font in place, never showing one twice", () => {
  const list = compareList(["inter-regular", "lora-regular"]);
  assert.deepEqual(replaceInCompare(list, "inter-regular", "inter-bold").faces, ["inter-bold", "lora-regular"]);
  assert.equal(replaceInCompare(list, "inter-regular", "lora-regular"), list, "already in another lane");
  assert.equal(replaceInCompare(list, "missing", "x"), list);
});

test("lanes move up and down, stopping at the ends", () => {
  const list = compareList(["a", "b", "c"]);
  assert.deepEqual(moveInCompare(list, "b", -1).faces, ["b", "a", "c"]);
  assert.deepEqual(moveInCompare(list, "b", 1).faces, ["a", "c", "b"]);
  assert.equal(moveInCompare(list, "a", -1), list);
  assert.equal(moveInCompare(list, "c", 1), list);
});

test("Pair swaps its two fonts", () => {
  assert.deepEqual(swapPair({ heading: "a", body: "b" }), { heading: "b", body: "a" });
  assert.deepEqual(swapPair(swapPair({ heading: "a", body: "b" })), { heading: "a", body: "b" });
});

const family = (name: string): Family => ({ id: `n:${name}`, name }) as Family;

test("the library search: names starting with it, then words, then anywhere", () => {
  const list = ["Approach Pro", "Bodoni", "Inter", "Pro Gothic", "Source Sans Pro", "Sprocket", "Fútura", "AauxPro"].map(family);
  assert.deepEqual(
    searchFamilies(list, "pro").map((f) => f.name),
    ["Pro Gothic", "Approach Pro", "Source Sans Pro", "AauxPro", "Sprocket"],
  );
  assert.deepEqual(searchFamilies(list, "futura").map((f) => f.name), ["Fútura"], "accents don't matter");
  assert.deepEqual(searchFamilies(list, "  ").map((f) => f.name), list.map((f) => f.name), "nothing typed: everything, in order");
  assert.equal(searchFamilies(list, "", 3).length, 3);
  assert.deepEqual(searchFamilies(list, "zzz"), []);
});

// ------------------------------------------------------------------------- page stack

const open = (state: NavState, page: NewPage) => navReducer(state, { type: "open", page });
const compare = (faces: string[]): NewPage => ({ kind: "compare", ...compareList(faces), mode: "lines", returnTo: { row: "f:n:Inter" } });

test("Compare and Pair are pages with Back; the same fonts aren't stacked twice", () => {
  const one = open(EMPTY_NAV, compare(["a", "b"]));
  assert.equal(topPage(one)?.kind, "compare");
  assert.equal(open(one, compare(["a", "b"])), one, "the same fonts again: nothing new");
  const pair = open(one, { kind: "pair", heading: "a", body: "b", returnTo: null });
  assert.equal(pair.pages.length, 2);
  assert.equal(open(pair, { kind: "pair", heading: "a", body: "b", returnTo: null }), pair);
  assert.equal(navReducer(pair, { type: "back" }).pages.length, 1);
  assert.equal(findIntent(topPage(one)), "leave", "Cmd+F leaves Compare for Search");
  assert.equal(findIntent(topPage(pair)), "leave");
});

test("Compare and Pair keep their changes in their stack entries", () => {
  const one = open(EMPTY_NAV, compare(keys(10)));
  const id = topPage(one)!.id;
  const fewer = navReducer(one, { type: "update", id, patch: { ...removeFromCompare(topPage(one) as ComparePageEntry, "k1"), mode: "columns" } });
  const entry = topPage(fewer) as ComparePageEntry;
  assert.deepEqual(entry.faces, keys(8).slice(1));
  assert.equal(entry.left, 0);
  assert.equal(entry.mode, "columns");
  assert.equal(navReducer(fewer, { type: "update", id, patch: { mode: "columns" } }), fewer, "no change: the same state");

  const pair = open(EMPTY_NAV, { kind: "pair", heading: "a", body: "b", returnTo: null });
  const pid = topPage(pair)!.id;
  const swapped = navReducer(pair, { type: "update", id: pid, patch: swapPair(topPage(pair) as PairPageEntry) });
  assert.deepEqual([(topPage(swapped) as PairPageEntry).heading, (topPage(swapped) as PairPageEntry).body], ["b", "a"]);
  assert.equal(navReducer(swapped, { type: "update", id: pid, patch: { heading: "b" } }), swapped);
});

test("after a move, focus stays with the moved font: the button pressed, or the other at the end", () => {
  assert.deepEqual(focusAfterMove(1, 1, 4), { lane: 2, by: 1 }, "Move down again moves it on");
  assert.deepEqual(focusAfterMove(2, 1, 4), { lane: 3, by: -1 }, "now last: Move down is off, so Move up");
  assert.deepEqual(focusAfterMove(2, -1, 4), { lane: 1, by: -1 });
  assert.deepEqual(focusAfterMove(1, -1, 4), { lane: 0, by: 1 }, "now first: Move up is off, so Move down");
  assert.deepEqual(focusAfterMove(0, 1, 2), { lane: 1, by: -1 }, "two fonts: they swap");
  assert.equal(focusAfterMove(0, -1, 3), null, "the first can't move up");
  assert.equal(focusAfterMove(2, 1, 3), null, "the last can't move down");
});

test("Add Fonts… leaves out families already shown in the style it would add", () => {
  const fam = (id: string, faces: string[]) => ({ id, representative: { key: faces[0] }, faces: faces.map((key) => ({ key })) }) as unknown as Family;
  const inter = fam("inter", ["inter-regular", "inter-bold"]);
  const lora = fam("lora", ["lora-regular"]);
  const familyOf = (key: string) => [inter, lora].map((family) => ({ family })).find((r) => r.family.faces.some((f) => f.key === key));
  assert.deepEqual(shownFamilies(["inter-regular", "lora-regular"], familyOf), ["inter", "lora"]);
  assert.deepEqual(shownFamilies(["inter-bold", "lora-regular"], familyOf), ["lora"], "Inter shown in Bold: adding it adds Regular");
  assert.deepEqual(shownFamilies(["gone", "inter-regular", "inter-regular"], familyOf), ["inter"], "a font that left the library, and each family once");
});
