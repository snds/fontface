// Run with `npm run test:ui`. The footer rail's counts (footerCounts.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogCountText, libraryCountText } from "./footerCounts.ts";

test("the library's count says every family and style, in full words", () => {
  assert.equal(libraryCountText(2514, 11047), "2,514 families · 11,047 styles");
  assert.equal(libraryCountText(1, 1), "1 family · 1 style");
  assert.equal(libraryCountText(1, 12), "1 family · 12 styles");
  assert.equal(libraryCountText(0, 0), "0 families · 0 styles");
  assert.equal(libraryCountText(1234567, 1234567), "1,234,567 families · 1,234,567 styles", "never shortened");
});

test("a catalog's count says how many families, of how many, and how many you have", () => {
  assert.equal(catalogCountText(1918, 1918, 644), "1,918 families · 644 installed");
  assert.equal(catalogCountText(312, 1918, 644), "312 of 1,918 families · 644 installed");
  assert.equal(catalogCountText(1, 1, 0), "1 family · 0 installed");
  assert.equal(catalogCountText(0, 1918, 1), "0 of 1,918 families · 1 installed");
});
