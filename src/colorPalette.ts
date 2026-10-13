// Color fonts whose palette is all dark, redrawn light in the dark theme.
//
// A COLR color font draws each glyph as layers. Each layer takes a color from the font's CPAL
// palette, or the text color when it uses index 0xFFFF. Material Icons Two Tone has one palette
// of five entries, all black at different opacities, and its layers never use the text color.
// So in the dark theme its icons draw black on a near-black page, and CSS `color` can't change
// them. For a font whose whole first palette is dark like that, the page defines a CSS font
// palette (`@font-palette-values`) giving each entry the dark theme's text color at the entry's
// own opacity, and elements marked with the face (`data-face`) use it under `.dark`. Colorful
// palettes (emoji, flags) are left alone, and so are glyphs drawn in the text color.

/** A palette entry counts as dark when no channel is above this (25%). */
const DARK_MAX = 0x40;
/** Larger palettes aren't icon fonts drawn in shades of one color; they're left alone. */
const MAX_ENTRIES = 256;
/** The dark theme's text color (`--foreground`, oklch(0.985 0 0)), as RGB channels. */
const LIGHT = "250 250 250";

const SFNT_VERSIONS = new Set([0x00010000, 0x4f54544f /* OTTO */, 0x74727565 /* true */]);

const tagAt = (view: DataView, at: number) =>
  String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

/** Where each table is, by tag: the font itself, or the first font of a collection. Null if the
 *  data isn't a plain (uncompressed) font file or its directory doesn't fit. */
function tableDirectory(view: DataView): Map<string, { offset: number; length: number }> | null {
  const size = view.byteLength;
  if (size < 12) return null;
  const base = tagAt(view, 0) === "ttcf" ? (size >= 16 ? view.getUint32(12) : size) : 0;
  if (base + 12 > size || !SFNT_VERSIONS.has(view.getUint32(base))) return null;
  const count = view.getUint16(base + 4);
  if (base + 12 + count * 16 > size) return null;
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < count; i++) {
    const at = base + 12 + i * 16;
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    if (offset + length <= size) tables.set(tagAt(view, at), { offset, length });
  }
  return tables;
}

/**
 * For a COLR color font whose first CPAL palette is all dark: CSS `override-colors` that redraw
 * each entry in the dark theme's text color at the entry's opacity, such as
 * `0 rgb(250 250 250 / 0.2), 1 rgb(250 250 250 / 0.298)`. Null for anything else, including
 * data it can't read.
 */
export function darkPaletteOverride(data: ArrayBuffer): string | null {
  try {
    const view = new DataView(data);
    const tables = tableDirectory(view);
    const cpal = tables?.get("CPAL");
    if (!cpal || !tables?.has("COLR") || cpal.length < 14) return null;
    const at = cpal.offset;
    const entries = view.getUint16(at + 2);
    const palettes = view.getUint16(at + 4);
    const records = view.getUint16(at + 6);
    const recordsAt = view.getUint32(at + 8);
    if (!entries || !palettes || entries > MAX_ENTRIES || cpal.length < 12 + 2 * palettes) return null;
    const first = view.getUint16(at + 12); // the first palette's first color record
    if (first + entries > records || recordsAt + (first + entries) * 4 > cpal.length) return null;
    const out: string[] = [];
    for (let i = 0; i < entries; i++) {
      const record = at + recordsAt + (first + i) * 4; // blue, green, red, alpha
      const [blue, green, red, alpha] = [0, 1, 2, 3].map((k) => view.getUint8(record + k));
      if (Math.max(red, green, blue) > DARK_MAX) return null;
      out.push(`${i} rgb(${LIGHT} / ${+(alpha / 255).toFixed(3)})`);
    }
    return out.join(", ");
  } catch {
    return null; // read past the end: not a font this can use
  }
}

/** The CSS for one face (a `faceName`) with a dark palette: the light palette, and the rule that
 *  uses it in the dark theme for elements marked `data-face="<face>"` and what's inside them. */
export function darkPaletteCss(face: string, overrides: string): string {
  if (!/^[\w-]+$/.test(face)) return "";
  const name = `--ff-dark-${face}`;
  return (
    `@font-palette-values ${name} { font-family: "${face}"; override-colors: ${overrides}; }\n` +
    `.dark [data-face="${face}"] { font-palette: ${name}; }\n`
  );
}
