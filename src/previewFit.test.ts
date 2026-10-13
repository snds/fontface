// Run with `npm run test:ui` (node --test; Node runs TypeScript directly, no extra packages).
// Font numbers come from the real files (src-tauri/src/preview/tests.rs prints them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseMetrics, fitRow, fitStyle, fitWaterfall, LruCache, padding, type Fit, type Ink, type LineMetrics } from "./previewFit.ts";

const near = (actual: number, expected: number, what: string, tolerance = 0.002) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} isn't ${expected}`);

/** Where the ink lands in the box, in em from the top, for a fit (the box is what's visible). */
function inkSpan(fit: Fit, ink: Ink): [number, number] {
  return [fit.baseline - fit.scale * ink.top, fit.baseline + fit.scale * ink.bottom];
}

/** The baseline WebKit draws at for a line height and metrics, at the fit's scale. */
const webkitBaseline = (fit: Fit, m: LineMetrics) => (fit.lineHeight + fit.scale * (m.ascent - m.descent)) / 2;

const OPEN_SANS: LineMetrics = { ascent: 1.069, descent: 0.293 };
/** Big enough that the padding is 0.03 em (at 32 px, 1 px is a little more). */
const SIZE = 48;

test("standard metrics keep the size and put the baseline 1 em down", () => {
  const ink = { top: 0.725, bottom: 0.24 };
  const fit = fitRow(OPEN_SANS, ink, SIZE);
  assert.equal(fit.scale, 1);
  near(fit.baseline, 1.0, "baseline");
  near(fit.lineHeight, 1.224, "line height");
  assert.equal(fit.height, 1.3);
  near(webkitBaseline(fit, OPEN_SANS), fit.baseline, "WebKit's baseline");
});

test("LI Glyphs: icons twice the em tall shrink to fit", () => {
  const m = { ascent: 2.048, descent: 0.02 };
  const ink = { top: 2.048, bottom: 0 };
  const fit = fitRow(m, ink, SIZE);
  near(fit.scale, 0.605, "scale");
  near(fit.baseline, 1.27, "baseline");
  near(fit.lineHeight, 1.31, "line height", 0.005);
  const [top, bottom] = inkSpan(fit, ink);
  assert.ok(top >= padding(SIZE) - 1e-9 && bottom <= 1.3 - padding(SIZE) + 1e-9, `ink ${top}..${bottom} inside the box`);
});

test("Christiana: tall ascenders move the baseline down instead of clipping", () => {
  const m = { ascent: 0.75, descent: 0.17 };
  const ink = { top: 1.124, bottom: 0 };
  const fit = fitRow(m, ink, SIZE);
  assert.equal(fit.scale, 1);
  near(fit.baseline, 1.154, "baseline");
  near(fit.lineHeight, 1.728, "line height");
  near(inkSpan(fit, ink)[0], 0.03, "ink starts at the padding");
});

test("Zapfino stops shrinking at half size and centres what's left", () => {
  const m = { ascent: 1.875, descent: 1.503 };
  const ink = { top: 1.8625, bottom: 1.515 };
  const fit = fitRow(m, ink, SIZE);
  assert.equal(fit.scale, 0.5);
  near(fit.baseline, 0.737, "baseline", 0.003);
  const [top, bottom] = inkSpan(fit, ink);
  near((top + bottom) / 2, 0.65, "the ink is centred in the 1.3 em box", 0.003);
});

test("text without ink keeps the natural line", () => {
  const fit = fitRow(OPEN_SANS, null, SIZE);
  assert.equal(fit.scale, 1);
  assert.equal(fit.baseline, 1);
  near(fit.lineHeight, 2 - (1.069 - 0.293), "line height");
  assert.deepEqual(fitRow(OPEN_SANS, { top: 0, bottom: 0 }, SIZE), fit);
});

test("the line height never goes below zero (STIXSizeThreeSym)", () => {
  const m = { ascent: 2.604, descent: 0.51 };
  const fit = fitRow(m, { top: 0.842, bottom: 0.283 }, SIZE);
  assert.equal(fit.lineHeight, 0);
  near(fit.baseline, 0.987, "the baseline it aimed for");
});

test("padding is at least one pixel", () => {
  near(padding(12), 1 / 12, "12 px");
  assert.equal(padding(64), 0.03);
});

test("waterfall rows never shrink; they grow to fit the ink", () => {
  const plain = fitWaterfall(OPEN_SANS, { top: 0.725, bottom: 0.24 }, 24);
  assert.equal(plain.scale, 1);
  assert.equal(plain.height, 1.5);
  near(plain.baseline, (1.5 + 1.069 - 0.293) / 2, "normal fonts keep the natural baseline");
  const zapfino = fitWaterfall({ ascent: 1.875, descent: 1.503 }, { top: 1.8625, bottom: 1.515 }, 48);
  assert.equal(zapfino.scale, 1);
  near(zapfino.height, 1.8625 + 1.515 + 0.06, "height");
  const [top, bottom] = inkSpan(zapfino, { top: 1.8625, bottom: 1.515 });
  assert.ok(top >= 0.03 - 1e-9 && bottom <= zapfino.height - 0.03 + 1e-9, "ink inside");
});

test("fitStyle gives pixels", () => {
  const style = fitStyle({ scale: 0.5, baseline: 1, lineHeight: 1.2, height: 1.3 }, 40);
  assert.deepEqual(style, { fontSize: 20, lineHeight: "48px", height: 52 });
});

test("canvas line metrics are trusted only when they match the font file", () => {
  const measured = { ink: { top: 0.7, bottom: 0.2 }, line: { ascent: 0.9, descent: 0.141 } };
  const file = { ascent: 0.9, descent: 0.141 };
  assert.deepEqual(chooseMetrics(file, measured), { line: measured.line, ink: measured.ink });
  const off = { ink: measured.ink, line: { ascent: 0.8, descent: 0.2 } };
  assert.deepEqual(chooseMetrics(file, off), { line: file, ink: measured.ink }, "the file's metrics, the canvas's ink");
  assert.deepEqual(chooseMetrics(undefined, off), { line: off.line, ink: off.ink });
  assert.deepEqual(chooseMetrics(file, undefined), { line: file, ink: null });
  assert.equal(chooseMetrics(undefined, undefined), undefined);
  // An engine that doesn't report line metrics: the file's, or no fit at all.
  assert.deepEqual(chooseMetrics(file, { ink: measured.ink }), { line: file, ink: measured.ink });
  assert.equal(chooseMetrics(undefined, { ink: measured.ink }), undefined);
});

test("the cache forgets the least recently used entry", () => {
  const cache = new LruCache<number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.size, 2);
});
