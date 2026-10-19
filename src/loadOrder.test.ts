// Run with `npm run test:ui`. The order font files load in (loadOrder.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextLoad } from "./loadOrder.ts";

const jobs = (...names: string[]) => names.map((name) => ({ name }));

test("the newest request loads first", () => {
  assert.equal(nextLoad(jobs("a", "b", "c"), new Set()), 2);
  assert.equal(nextLoad([], new Set()), -1);
});

test("a font page's chosen style goes before the rest, even if it was asked for first", () => {
  // "All styles" asked for every style, the chosen one ("b") among them, before the page's own
  // waterfall did.
  assert.equal(nextLoad(jobs("a", "b", "c", "d"), new Set(["b"])), 1);
  assert.equal(nextLoad(jobs("a", "b", "c"), new Set(["zz"])), 2, "an urgent face that isn't queued changes nothing");
  assert.equal(nextLoad(jobs("a", "b", "c"), new Set(["a", "b"])), 1, "the newest urgent one first");
});
