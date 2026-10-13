import { LruCache, type Measured } from "./previewFit";

// Measures text with a shared canvas, for fitting previews (see previewFit.ts). Call it only
// once the font has loaded (PreviewText checks fontLoader's isFaceLoaded): before that the
// canvas measures the fallback font, and the cache would keep that answer.
//
// Cached by font-family and text. The app's font-family names carry the file's version
// (fontLoader's faceName), so a changed file is a new key and gets measured afresh.

const SIZE = 100;
const cache = new LruCache<Measured | null>(4000);
let context: CanvasRenderingContext2D | null | undefined;

function canvas(): CanvasRenderingContext2D | null {
  if (context === undefined) {
    const el = document.createElement("canvas");
    el.width = el.height = 1;
    context = el.getContext("2d");
  }
  return context;
}

/**
 * The ink and line metrics of `text` in `fontFamily` (a CSS font-family value), in em, as the
 * text is drawn (shaped). Cached by family and text; null when the canvas can't measure.
 */
export function measureText(fontFamily: string, text: string): Measured | null {
  const key = `${fontFamily}\u0000${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const ctx = canvas();
  let result: Measured | null = null;
  if (ctx && text) {
    ctx.font = `${SIZE}px ${fontFamily}`;
    const m = ctx.measureText(text);
    if (Number.isFinite(m.actualBoundingBoxAscent) && Number.isFinite(m.actualBoundingBoxDescent)) {
      const line =
        Number.isFinite(m.fontBoundingBoxAscent) && Number.isFinite(m.fontBoundingBoxDescent)
          ? { ascent: m.fontBoundingBoxAscent / SIZE, descent: m.fontBoundingBoxDescent / SIZE }
          : undefined;
      result = { ink: { top: m.actualBoundingBoxAscent / SIZE, bottom: m.actualBoundingBoxDescent / SIZE }, line };
    }
  }
  cache.set(key, result);
  return result;
}
