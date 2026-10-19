import type { Family } from "./library.ts";

/**
 * Compare and Pair: which fonts they show, and the library search that adds them. Pure (no
 * React, no DOM), so `npm run test:ui` covers it; the pages are components/ComparePage.tsx and
 * components/PairPage.tsx, and their stack entries (nav.ts) hold these lists.
 *
 * Fonts are face keys: a lane shows one style, and its style picker swaps the key for another
 * style of the same family. Families are found by face key (App's `familyOfFace`), so a lane
 * survives regrouping, like the font page.
 */

/** Compare shows at most this many fonts at once. */
export const COMPARE_MAX = 8;

/** Compare's fonts: face keys in lane order, and how many asked-for fonts were left out. */
export interface CompareList {
  faces: string[];
  /** Fonts asked for that didn't fit (more than COMPARE_MAX): the page says so. */
  left: number;
}

/** The fonts to compare from what was asked for: each once, in order, at most `max`. */
export function compareList(keys: readonly string[], max = COMPARE_MAX): CompareList {
  const unique = [...new Set(keys)];
  return { faces: unique.slice(0, max), left: Math.max(0, unique.length - max) };
}

/** Adds fonts after the ones shown. Those already shown are skipped; any that don't fit are
 *  counted in `left` (the note is about this addition: an earlier one no longer matters). */
export function addToCompare(list: CompareList, keys: readonly string[], max = COMPARE_MAX): CompareList {
  const shown = new Set(list.faces);
  const fresh = [...new Set(keys)].filter((k) => !shown.has(k));
  const room = Math.max(0, max - list.faces.length);
  return { faces: [...list.faces, ...fresh.slice(0, room)], left: Math.max(0, fresh.length - room) };
}

/** Takes a font out. The note about fonts left out goes too: there's room now. */
export function removeFromCompare(list: CompareList, key: string): CompareList {
  if (!list.faces.includes(key)) return list;
  return { faces: list.faces.filter((k) => k !== key), left: 0 };
}

/** A lane's style picker: the lane shows `to` instead of `from`. A style already in another
 *  lane isn't shown twice (nothing changes). */
export function replaceInCompare(list: CompareList, from: string, to: string): CompareList {
  if (from === to || !list.faces.includes(from) || list.faces.includes(to)) return list;
  return { ...list, faces: list.faces.map((k) => (k === from ? to : k)) };
}

/** Moves a lane one place up (-1) or down (+1). */
export function moveInCompare(list: CompareList, key: string, by: -1 | 1): CompareList {
  const at = list.faces.indexOf(key);
  const to = at + by;
  if (at < 0 || to < 0 || to >= list.faces.length) return list;
  const faces = [...list.faces];
  [faces[at], faces[to]] = [faces[to], faces[at]];
  return { ...list, faces };
}

/** After a lane moves (`by` from place `at`, of `count`): the lane's new place, and which of its
 *  Move buttons keeps focus. The one pressed, unless the lane has reached that end, where that
 *  button is off: then the other. Null if the lane didn't move. */
export function focusAfterMove(at: number, by: -1 | 1, count: number): { lane: number; by: -1 | 1 } | null {
  const to = at + by;
  if (at < 0 || to < 0 || to >= count) return null;
  const atEnd = by < 0 ? to === 0 : to === count - 1;
  return { lane: to, by: atEnd ? (by < 0 ? 1 : -1) : by };
}

/** The families Add Fonts… leaves out (by Family.id): picking a family adds its usual style
 *  (its representative), so a family already shown in that style isn't offered again. One
 *  shown only in another style can still be added. */
export function shownFamilies(faces: readonly string[], familyOf: (key: string) => { family: Family } | undefined): string[] {
  const out = new Set<string>();
  for (const key of faces) {
    const family = familyOf(key)?.family;
    if (family && family.representative.key === key) out.add(family.id);
  }
  return [...out];
}

/** Pair: a heading font and a body font (face keys). */
export interface PairFonts {
  heading: string;
  body: string;
}

export const swapPair = (p: PairFonts): PairFonts => ({ heading: p.body, body: p.heading });

/** The Pair page's own words: a headline, a line under it, and a paragraph. */
export const PAIR_TEXT = {
  heading: "Type sets the tone",
  subheading: "A heading and its text, side by side",
  body: "A heading draws the eye; the text keeps it. One face can be loud and the other quiet, as long as they share a rhythm: similar proportions, a matching sense of weight, and letters that feel made for the same page. Set the two together, change their sizes, then swap them to see which way round reads best.",
} as const;

/** Text set for comparing, before you type your own. */
export const COMPARE_TEXT = {
  lines: "The quick brown fox jumps over the lazy dog",
  columns:
    "Every typeface has a voice. Set a few lines and you can hear it: whether the letters sit calmly or lean forward, whether the spaces between words breathe, and how the figures 0123456789 keep pace with the text around them.",
} as const;

// ----------------------------------------------------------------------------- search

/** Without accents, so "Futura" finds "Fútura" and the other way round. */
const plain = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "");
const fold = (s: string) => plain(s).toLowerCase();

/** A word starts at `i`: after a space, hyphen, underscore or dot, or a lowercase-to-uppercase
 *  step ("AauxPro"). */
function wordStart(name: string, i: number): boolean {
  if (i === 0) return true;
  const before = name[i - 1];
  if (/[\s\-_.]/.test(before)) return true;
  const at = name[i];
  return before === before.toLowerCase() && before !== before.toUpperCase() && at === at.toUpperCase() && at !== at.toLowerCase();
}

/**
 * The library search behind Compare's and Pair's font pickers: families whose name matches,
 * best first. A name that starts with what's typed comes first, then one with a word that
 * starts with it, then one that has it anywhere; ties keep the order given (A to Z). Nothing
 * typed: the first `limit` families.
 */
export function searchFamilies(families: readonly Family[], query: string, limit = 60): Family[] {
  const q = fold(query.trim());
  if (!q) return families.slice(0, limit);
  const ranked: { family: Family; rank: number; at: number }[] = [];
  families.forEach((family, at) => {
    const shown = plain(family.name);
    const name = shown.toLowerCase();
    let i = name.indexOf(q);
    if (i < 0) return;
    let rank = i === 0 ? 0 : 2;
    // A later match may start a word: "pro" in "Approach Pro".
    for (; rank === 2 && i >= 0; i = name.indexOf(q, i + 1)) if (wordStart(shown, i)) rank = 1;
    ranked.push({ family, rank, at });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.at - b.at);
  return ranked.slice(0, limit).map((r) => r.family);
}
