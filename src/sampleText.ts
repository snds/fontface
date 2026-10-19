import type { PreviewInfo } from "./api.ts";

/**
 * Which text a font is shown with when you haven't typed any: the font page's waterfall and
 * paragraph, Compare's lanes and Pair's heading and body. Each place has its own words, but a
 * font that can't draw them (one with capitals only, a symbol or icon font, or one for another
 * script) gets text it can draw instead, so its preview never shows another font's letters under
 * its name. Pure (no React, no DOM), so `npm run test:ui` covers it.
 */

/** The font page's line, and the fallback when longer text can't be drawn. */
export const PANGRAM = "The quick brown fox jumps over the lazy dog";

/** The Specimen tab's paragraph: Fontface's own words, with figures and punctuation in use. */
export const PARAGRAPH =
  "Every typeface has a voice. Set a few lines and you can hear it: whether the letters sit calmly or lean forward, whether the spaces between words breathe, and how the figures 0123456789 keep pace with the text around them. Good type disappears into the reading; it simply makes the next line a little easier than the last.";

/** True if the font can draw every character of `text` (by its profile; unknown counts as yes). */
export function drawsAll(text: string, profile: PreviewInfo | undefined): boolean {
  const missing = profile?.asciiMissing ?? "";
  return ![...text].some((c) => missing.includes(c));
}

/** Symbol and Expert fonts: their letter keys hold pictures or extra characters, not letters. */
const lettersMeanLetters = (profile: PreviewInfo | undefined) => !profile || (profile.kind !== "symbols" && profile.kind !== "expert");

/**
 * The first of `texts` the font can draw, as written or in UPPER or lower case; else the
 * profile's own text (its name, or a sample of the characters it has); else `family`. With no
 * profile yet, the first text.
 */
export function fittingText(texts: readonly string[], profile: PreviewInfo | undefined, family: string): string {
  if (!profile) return texts[0] ?? family;
  if (lettersMeanLetters(profile)) {
    for (const text of texts) for (const t of [text, text.toUpperCase(), text.toLowerCase()]) if (drawsAll(t, profile)) return t;
  }
  return profile.familyText ?? family;
}

/**
 * The waterfall's text, first that fits: the typed text; the pangram, if the font has all its
 * letters; the pangram in UPPER or lower case; the profile's own text (the name, or a sample of
 * the font's characters).
 */
export function waterfallText(typed: string, profile: PreviewInfo | undefined, family: string): string {
  return typed || fittingText([PANGRAM], profile, family);
}

/** The paragraph's text: the paragraph if the font can draw it (in either case), else what the waterfall shows. */
export function paragraphText(profile: PreviewInfo | undefined, family: string): string {
  return fittingText([PARAGRAPH, PANGRAM], profile, family);
}

/**
 * What a font shows in Compare or Pair. Typed text is shown as typed (the page marks characters
 * the font doesn't have). Otherwise the page's own words if the font can draw them, else the
 * pangram, else text it can draw (`fittingText`).
 */
export function sampleFor(typed: string, words: string, profile: PreviewInfo | undefined, family: string): string {
  return typed || fittingText(words === PANGRAM ? [PANGRAM] : [words, PANGRAM], profile, family);
}
