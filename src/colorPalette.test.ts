// Run with `npm run test:ui`. Fonts are built here, table by table; the numbers for Material
// Icons Two Tone come from its real file (one palette: five black entries, alphas 51, 76, 222,
// 230 and 255).
import { test } from "node:test";
import assert from "node:assert/strict";
import { darkPaletteCss, darkPaletteOverride } from "./colorPalette.ts";

type Rgba = [number, number, number, number];

/** A CPAL table (version 0): palettes of `entries` colors each, given as RGBA. */
function cpal(palettes: Rgba[][]): Uint8Array {
  const entries = palettes[0].length;
  const recordsAt = 12 + 2 * palettes.length;
  const bytes = new Uint8Array(recordsAt + 4 * entries * palettes.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(2, entries);
  view.setUint16(4, palettes.length);
  view.setUint16(6, entries * palettes.length);
  view.setUint32(8, recordsAt);
  palettes.forEach((palette, p) => {
    view.setUint16(12 + 2 * p, p * entries);
    palette.forEach(([r, g, b, a], i) => bytes.set([b, g, r, a], recordsAt + 4 * (p * entries + i)));
  });
  return bytes;
}

/** A font file holding just these tables (enough for the table directory). */
function sfnt(tables: Record<string, Uint8Array>, version = 0x00010000): Uint8Array {
  const tags = Object.keys(tables);
  let offset = 12 + 16 * tags.length;
  const size = tags.reduce((n, t) => n + tables[t].length, offset);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, version);
  view.setUint16(4, tags.length);
  tags.forEach((tag, i) => {
    const at = 12 + 16 * i;
    for (let k = 0; k < 4; k++) view.setUint8(at + k, tag.charCodeAt(k));
    view.setUint32(at + 8, offset);
    view.setUint32(at + 12, tables[tag].length);
    bytes.set(tables[tag], offset);
    offset += tables[tag].length;
  });
  return bytes;
}

/** A collection whose first font is `font`. */
function collection(font: Uint8Array): Uint8Array {
  const header = 16;
  const bytes = new Uint8Array(header + font.length);
  const view = new DataView(bytes.buffer);
  bytes.set([0x74, 0x74, 0x63, 0x66]); // "ttcf"
  view.setUint32(4, 0x00010000);
  view.setUint32(8, 1);
  view.setUint32(12, header);
  bytes.set(font, header);
  // Table offsets in a collection count from the start of the file.
  const inner = new DataView(bytes.buffer, header);
  const count = inner.getUint16(4);
  for (let i = 0; i < count; i++) inner.setUint32(12 + 16 * i + 8, inner.getUint32(12 + 16 * i + 8) + header);
  return bytes;
}

const buffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const COLR = new Uint8Array(14);
const TWO_TONE: Rgba[] = [51, 76, 222, 230, 255].map((a) => [0, 0, 0, a]);

test("a palette of black shades is redrawn in the dark theme's text color, opacity kept", () => {
  const font = sfnt({ COLR, CPAL: cpal([TWO_TONE]) });
  assert.equal(
    darkPaletteOverride(buffer(font)),
    "0 rgb(250 250 250 / 0.2), 1 rgb(250 250 250 / 0.298), 2 rgb(250 250 250 / 0.871), 3 rgb(250 250 250 / 0.902), 4 rgb(250 250 250 / 1)",
  );
  // OpenType (CFF) fonts and collections too.
  assert.ok(darkPaletteOverride(buffer(sfnt({ COLR, CPAL: cpal([TWO_TONE]) }, 0x4f54544f))));
  assert.ok(darkPaletteOverride(buffer(collection(font))));
  // Near-black counts as dark.
  assert.ok(darkPaletteOverride(buffer(sfnt({ COLR, CPAL: cpal([[[0x40, 0x20, 0x00, 255]]]) }))));
});

test("only the first palette is read", () => {
  const font = sfnt({ COLR, CPAL: cpal([TWO_TONE, TWO_TONE.map(([, , , a]) => [255, 0, 0, a] as Rgba)]) });
  assert.ok(darkPaletteOverride(buffer(font))?.startsWith("0 rgb(250 250 250 / 0.2), "));
});

test("colorful palettes, fonts without color layers and other data are left alone", () => {
  const colorful = cpal([[[0, 0, 0, 255], [0xd0, 0x30, 0x30, 255]]]);
  assert.equal(darkPaletteOverride(buffer(sfnt({ COLR, CPAL: colorful }))), null, "one entry isn't dark");
  assert.equal(darkPaletteOverride(buffer(sfnt({ CPAL: cpal([TWO_TONE]) }))), null, "a palette without COLR layers");
  assert.equal(darkPaletteOverride(buffer(sfnt({ COLR }))), null, "no palette");
  assert.equal(darkPaletteOverride(buffer(sfnt({ glyf: new Uint8Array(8) }))), null, "a plain font");
  assert.equal(darkPaletteOverride(new TextEncoder().encode("wOF2 a web font").buffer as ArrayBuffer), null);
  assert.equal(darkPaletteOverride(new ArrayBuffer(0)), null);
  const huge = Array.from({ length: 300 }, (): Rgba => [0, 0, 0, 255]);
  assert.equal(darkPaletteOverride(buffer(sfnt({ COLR, CPAL: cpal([huge]) }))), null, "too many entries");
});

test("damaged tables are refused, never read past", () => {
  const good = sfnt({ COLR, CPAL: cpal([TWO_TONE]) });
  // Cut off partway through the color records.
  assert.equal(darkPaletteOverride(buffer(good.slice(0, good.length - 3))), null);
  // A palette that claims more records than the table holds.
  const lying = cpal([TWO_TONE]);
  new DataView(lying.buffer).setUint16(2, 40);
  assert.equal(darkPaletteOverride(buffer(sfnt({ COLR, CPAL: lying }))), null);
  // A first record index past the end.
  const shifted = cpal([TWO_TONE]);
  new DataView(shifted.buffer).setUint16(12, 3);
  assert.equal(darkPaletteOverride(buffer(sfnt({ COLR, CPAL: shifted }))), null);
});

test("the CSS names the face's own palette and uses it only in the dark theme", () => {
  const css = darkPaletteCss("ff-12-abc", "0 rgb(250 250 250 / 0.2)");
  assert.match(css, /@font-palette-values --ff-dark-ff-12-abc \{ font-family: "ff-12-abc"; override-colors: 0 rgb\(250 250 250 \/ 0\.2\); \}/);
  assert.match(css, /\.dark \[data-face="ff-12-abc"\] \{ font-palette: --ff-dark-ff-12-abc; \}/);
  assert.equal(darkPaletteCss('x"] { color: red } [y="', "0 red"), "", "only plain face names");
});
