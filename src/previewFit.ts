// Fitting preview text into its row so nothing is clipped and baselines line up.
//
// Pure functions, no DOM: `node --test src/previewFit.test.ts` runs them. Every value is in em
// (multiples of the font size), so one measurement serves every preview size.
//
// How it works. A list preview is a box H em tall that hides overflow (for the ellipsis).
// Given an explicit line height L, WebKit puts the baseline (L + A − D) / 2 below the top of
// the line, where A and D are the font's line ascent and descent. So choosing
//   L = 2B − k(A − D)
// puts the baseline exactly at B, for text drawn at k times the size. The ink then spans
// B − k·a to B + k·d (a, d: the text's ink above and below the baseline), and B is chosen so
// that stays inside the box with a little padding. Text is shrunk (k < 1) only when its ink is
// taller than the box. No extra markup, and it needs neither ascent-override nor
// overflow-clip-margin, which this WebKit lacks or hides behind a flag.

/** Line metrics in em: what the web view lays a line out with. */
export interface LineMetrics {
  ascent: number;
  descent: number;
}

/** The ink of a piece of text in em: above the baseline (up) and below it (down). */
export interface Ink {
  top: number;
  bottom: number;
}

export interface Fit {
  /** Font size as a fraction of the nominal size (1 = unchanged). */
  scale: number;
  /** Baseline, in em from the top of the box. */
  baseline: number;
  /** Line height in em. */
  lineHeight: number;
  /** Box height in em. */
  height: number;
}

/** List rows: the preview box is 1.3 em tall, as before, so row height estimates stay right. */
export const ROW_HEIGHT = 1.3;
/** Where the baseline goes in a list row when the ink allows: 1 em below the top. */
export const ROW_BASELINE = 1.0;
/** Text never shrinks below half its size; the few fonts taller than that clip a little. */
export const MIN_SCALE = 0.5;
/** Waterfall rows are at least 1.5 em tall (the panel's normal line height). */
export const WATERFALL_MIN_HEIGHT = 1.5;

/** Space kept between the ink and the box edge: 0.03 em, at least 1 px. */
export const padding = (sizePx: number) => Math.max(0.03, sizePx > 0 ? 1 / sizePx : 0.03);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function place(m: LineMetrics, ink: Ink | null, height: number, target: number, scale: number, pad: number): Fit {
  let baseline = target;
  if (ink && ink.top + ink.bottom > 0) {
    const lo = scale * ink.top + pad;
    const hi = height - scale * ink.bottom - pad;
    baseline = lo <= hi ? clamp(target, lo, hi) : (lo + hi) / 2;
  }
  const lineHeight = Math.max(0, 2 * baseline - scale * (m.ascent - m.descent));
  return { scale, baseline, lineHeight, height };
}

/** A list row: shrink only when the ink is taller than the box, and keep the baseline at 1 em
 *  below the top whenever the ink allows. */
export function fitRow(m: LineMetrics, ink: Ink | null, sizePx: number): Fit {
  const pad = padding(sizePx);
  const tall = ink ? ink.top + ink.bottom : 0;
  const scale = tall > 0 ? clamp((ROW_HEIGHT - 2 * pad) / tall, MIN_SCALE, 1) : 1;
  return place(m, ink, ROW_HEIGHT, ROW_BASELINE, scale, pad);
}

/** A detail-panel waterfall row: never shrinks; the row grows to fit the ink instead. The
 *  baseline stays where a 1.5 line height would put it, so ordinary fonts don't move. */
export function fitWaterfall(m: LineMetrics, ink: Ink | null, sizePx: number): Fit {
  const pad = padding(sizePx);
  const tall = ink ? ink.top + ink.bottom : 0;
  const height = Math.max(WATERFALL_MIN_HEIGHT, tall + 2 * pad);
  const natural = (WATERFALL_MIN_HEIGHT + m.ascent - m.descent) / 2;
  return place(m, ink, height, natural, 1, pad);
}

/** The CSS for a fit at a given size, in px. */
export function fitStyle(fit: Fit, sizePx: number) {
  return { fontSize: fit.scale * sizePx, lineHeight: `${fit.lineHeight * sizePx}px`, height: fit.height * sizePx };
}

/** What the canvas reports for text in a loaded font, in em. */
export interface Measured {
  /** actualBoundingBoxAscent / Descent: the ink of the text as drawn, shaped (ligatures,
   *  contextual swashes and marks included). */
  ink: Ink;
  /** fontBoundingBoxAscent / Descent: the line metrics the canvas used. Missing on engines
   *  that don't report them. */
  line?: LineMetrics;
}

/** What Rust read from the font file (the preview profile). */
export interface Stored {
  /** The line ascent and descent CoreText reads from the file. */
  line?: LineMetrics;
  /** The ink of the profile's own text, each character's own glyph (no shaping). Only for that
   *  text: typed text has none. */
  ink?: Ink;
}

/**
 * The line metrics and ink to fit with, once the face has loaded (before that the canvas
 * measures the fallback font).
 * - Line metrics: the canvas's, which are what WebKit lays the line out with. They can differ
 *   from the file's: WebKit adds 15% ascent to installed Times, Helvetica and Courier. The
 *   file's are the fallback for an engine that doesn't report them.
 * - Ink: the canvas's, since shaping can reach further than any single glyph (Zapfino's swashes,
 *   Voluta Script's joins). For the profile's own text, the larger of the canvas's and the
 *   stored ink, so neither source can clip the other.
 */
export function chooseMetrics(stored: Stored | undefined, measured: Measured | undefined): { line: LineMetrics; ink: Ink | null } | undefined {
  const line = measured?.line ?? stored?.line;
  if (!line) return undefined;
  const drawn = measured?.ink;
  const own = stored?.ink;
  const ink = drawn && own ? { top: Math.max(drawn.top, own.top), bottom: Math.max(drawn.bottom, own.bottom) } : (drawn ?? own ?? null);
  return { line, ink };
}

/** A small least-recently-used map, for measurements keyed by face and text. */
export class LruCache<V> {
  private map = new Map<string, V>();
  private readonly max: number;
  constructor(max = 4000) {
    this.max = max;
  }

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: V) {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }

  get size() {
    return this.map.size;
  }
}
