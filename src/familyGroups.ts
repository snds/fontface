import type { FontSummary } from "./api.ts";

/**
 * Family grouping by name: which family each font is listed under, and its style name there.
 * Many fonts carry their style in the family name ("AmintaBold", "Aaux ProBlack Italic OSF",
 * "Dynasty Heavy"), so exact names split one family into dozens. These rules put them back
 * together, wherever their files are: folders are never a requirement, a signal or a guard.
 * Pure (no React, no DOM), so `npm run test:ui` covers every rule; docs/FEATURES.md has them in
 * plain words.
 *
 * **Precedence** (for each face):
 * 1. Your choice for this font (by face key): a family and maybe a style, or "keep separate"
 *    (the font's own name).
 * 2. Your rule for its family name (by squash key): merge into a family, or keep separate.
 * 3. Grouping by name (only while Settings › Library › "Group families by name" is on), when
 *    all of these hold:
 *    a. The name ends in whole style words that can merge (weight, slope, variant; `WORDS`), or
 *       differs only in spelling ("BigCaslon" / "Big Caslon").
 *    b. What's left is a family in the library, or two different names reduce to it.
 *    c. Something else agrees: the PostScript name's family part, the same foundry or designer,
 *       or the weight number matching the weight word within 100.
 *    Guards keep a name out (it may still be suggested): G1 the font names its own grouping
 *    family (name ID 16); G2 a width, size or number word; G3 fewer than 3 letters left; G4 both
 *    sides name a foundry and they differ; G5 you chose "Keep separate" for the name.
 * 4. Otherwise the font's own name (ID 16, else 1).
 *
 * Your choices never change a font file: they're Fontface's own records (src-tauri/src/families.rs).
 */

// ---------------------------------------------------------------------------------- words

/** What a style word says. Weight, slope and variant words can merge on their own; width and
 *  size (optical) words only make a suggestion. */
export type WordKind = "weight" | "slope" | "variant" | "width" | "optical";

export interface Word {
  /** How labels spell it: "ExtraBold", "Italic", "OSF". An abbreviation spells out its word. */
  canon: string;
  kind: WordKind;
  /** An abbreviation ("Lt", "Ital"): it counts only when the PostScript name agrees. */
  abbrev: boolean;
  /** The weight it names (sorting, and the weight signal). */
  weight?: number;
  /** The width it names, 1 (ultra-condensed) to 9 (ultra-expanded). */
  width?: number;
  /** Right after the family part it may name a script instead: "SC" is Simplified Chinese in
   *  Noto Sans SC, small capitals in Elementa SC (`NameAnalysis.smallCaps`, `planByName`). */
  notInnermost?: boolean;
}

type Def = [canon: string, kind: WordKind, forms: string[], extra?: Partial<Word>, abbrevs?: string[]];

/**
 * Spellings are lowercase; a space in one allows nothing, a space, a hyphen or an underscore
 * there ("extra light" matches ExtraLight, Extra Light, Extra-Light).
 */
const DEFS: Def[] = [
  ["Thin", "weight", ["thin"], { weight: 100 }, ["th"]],
  ["Hairline", "weight", ["hairline"], { weight: 100 }],
  ["ExtraLight", "weight", ["extra light"], { weight: 200 }, ["xlt", "exlt", "xlight", "extlt"]],
  ["UltraLight", "weight", ["ultra light"], { weight: 200 }, ["ultlt"]],
  ["Light", "weight", ["light"], { weight: 300 }, ["lt", "lite"]],
  ["SemiLight", "weight", ["semi light", "demi light"], { weight: 350 }],
  ["Book", "weight", ["book"], { weight: 380 }, ["bk"]],
  ["Regular", "weight", ["regular"], { weight: 400 }, ["rg", "reg"]],
  ["Normal", "weight", ["normal"], { weight: 400 }],
  ["Roman", "weight", ["roman"], { weight: 400 }, ["rom"]],
  ["Plain", "weight", ["plain"], { weight: 400 }],
  ["Medium", "weight", ["medium"], { weight: 500 }, ["md", "med"]],
  ["SemiBold", "weight", ["semi bold"], { weight: 600 }, ["sb", "smbd", "sbd", "semibd", "semi"]],
  ["DemiBold", "weight", ["demi bold"], { weight: 600 }, ["dmbd"]],
  ["Demi", "weight", ["demi"], { weight: 600 }],
  ["Bold", "weight", ["bold"], { weight: 700 }, ["bd"]],
  ["ExtraBold", "weight", ["extra bold"], { weight: 800 }, ["xbd", "exbd", "xbold", "extbd"]],
  ["UltraBold", "weight", ["ultra bold"], { weight: 800 }],
  ["Heavy", "weight", ["heavy"], { weight: 800 }, ["hv", "hvy"]],
  ["Black", "weight", ["black"], { weight: 900 }, ["blk"]],
  ["ExtraBlack", "weight", ["extra black"], { weight: 950 }, ["xblk"]],
  ["UltraBlack", "weight", ["ultra black"], { weight: 950 }],
  ["Ultra", "weight", ["ultra"], { weight: 950 }],
  ["Italic", "slope", ["italic"], {}, ["it", "ita", "ital"]],
  ["Oblique", "slope", ["oblique"], {}, ["obl", "obliq"]],
  ["OSF", "variant", ["osf"]],
  ["OSTF", "variant", ["ostf"]],
  ["LF", "variant", ["lf"]],
  ["TF", "variant", ["tf"]],
  ["SC", "variant", ["sc"], { notInnermost: true }],
  ["SCTF", "variant", ["sctf"]],
  ["Caps", "variant", ["caps"]],
  ["Small Caps", "variant", ["small caps"]],
  ["Expert", "variant", ["expert"], {}, ["exp"]],
  ["Alt", "variant", ["alt"]],
  ["Swash", "variant", ["swash"], {}, ["sw"]],
  ["UltraCondensed", "width", ["ultra condensed", "ultra cond"], { width: 1 }],
  ["ExtraCondensed", "width", ["extra condensed", "extra cond", "xcond"], { width: 2 }],
  ["Compressed", "width", ["compressed", "comp"], { width: 2 }],
  ["Condensed", "width", ["condensed", "cond", "cnd", "cn"], { width: 3 }],
  ["Narrow", "width", ["narrow"], { width: 3 }],
  ["SemiCondensed", "width", ["semi condensed", "semi cond"], { width: 4 }],
  ["SemiExpanded", "width", ["semi expanded"], { width: 6 }],
  ["Expanded", "width", ["expanded"], { width: 7 }],
  ["Extended", "width", ["extended", "extd"], { width: 7 }],
  ["Wide", "width", ["wide"], { width: 7 }],
  ["ExtraExpanded", "width", ["extra expanded", "extra extended"], { width: 8 }],
  ["ExtraWide", "width", ["extra wide"], { width: 8 }],
  ["UltraExpanded", "width", ["ultra expanded", "ultra extended"], { width: 9 }],
  ["Display", "optical", ["display"]],
  ["Text", "optical", ["text"]],
  ["Caption", "optical", ["caption"]],
  ["Micro", "optical", ["micro"]],
  ["Subhead", "optical", ["subhead"]],
  ["Poster", "optical", ["poster"]],
  ["Headline", "optical", ["headline"]],
  ["Titling", "optical", ["titling"]],
  ["Deck", "optical", ["deck"]],
  ["Banner", "optical", ["banner"]],
];

/** Every spelling, with separators taken out ("extralight"), and what it is. */
const BY_FORM = new Map<string, Word>();
for (const [canon, kind, forms, extra = {}, abbrevs = []] of DEFS) {
  for (const form of forms) BY_FORM.set(form.replace(/ /g, ""), { canon, kind, abbrev: false, ...extra });
  for (const form of abbrevs) BY_FORM.set(form, { canon, kind, abbrev: true, ...extra });
}

const MERGEABLE = new Set<WordKind>(["weight", "slope", "variant"]);
const LONGEST_FORM = Math.max(...[...BY_FORM.keys()].map((k) => k.length));

/** Which words a search takes off: the ones that merge (with or without abbreviations), or every word. */
type WordSet = "merge" | "mergeAbbrev" | "every";
const inSet = (word: Word, set: WordSet) => set === "every" || (MERGEABLE.has(word.kind) && (set === "mergeAbbrev" || !word.abbrev));

/** A to Z (either case) as 0 to 25; anything else -1. */
const letterAt = (s: string, i: number) => {
  const c = s.charCodeAt(i) | 32;
  return c >= 97 && c <= 122 ? c - 97 : -1;
};

/**
 * The letters a set's words end in: the last three of the longer words ("old" for Bold, "lic"
 * for Italic), the two of the two-letter ones ("lf", "it"). Most names end in none of them, and
 * are done with at once. Every spelling's last part has three letters or more, or is all of it.
 */
const ENDS3: Record<WordSet, Uint8Array> = { merge: new Uint8Array(26 ** 3), mergeAbbrev: new Uint8Array(26 ** 3), every: new Uint8Array(26 ** 3) };
const ENDS2: Record<WordSet, Uint8Array> = { merge: new Uint8Array(26 ** 2), mergeAbbrev: new Uint8Array(26 ** 2), every: new Uint8Array(26 ** 2) };
for (const [form, word] of BY_FORM)
  for (const set of ["merge", "mergeAbbrev", "every"] as const) {
    if (!inSet(word, set)) continue;
    const n = form.length;
    if (n === 2) ENDS2[set][letterAt(form, 0) * 26 + letterAt(form, 1)] = 1;
    else ENDS3[set][(letterAt(form, n - 3) * 26 + letterAt(form, n - 2)) * 26 + letterAt(form, n - 1)] = 1;
  }

// Letter tests that skip the case conversion for plain ASCII (nearly every font name).
const isLower = (c: string | undefined) => {
  if (!c) return false;
  const n = c.charCodeAt(0);
  if (n < 128) return n >= 97 && n <= 122;
  return c !== c.toUpperCase() && c === c.toLowerCase();
};
const isUpper = (c: string | undefined) => {
  if (!c) return false;
  const n = c.charCodeAt(0);
  if (n < 128) return n >= 65 && n <= 90;
  return c !== c.toLowerCase() && c === c.toUpperCase();
};
const isSeparator = (c: string | undefined) => c === " " || c === "-" || c === "_" || c === "\t" || c === "\u00a0";
const SEPARATOR = /[\s\-_]/;

// The same tests by position, without making a string of each character (the word search runs
// on every family and PostScript name in the library).
const lowerAt = (s: string, i: number) => {
  const n = s.charCodeAt(i);
  return n < 128 ? n >= 97 && n <= 122 : n === n && isLower(s[i]);
};
const upperAt = (s: string, i: number) => {
  const n = s.charCodeAt(i);
  return n < 128 ? n >= 65 && n <= 90 : n === n && isUpper(s[i]);
};
const digitAt = (s: string, i: number) => {
  const n = s.charCodeAt(i);
  return n >= 48 && n <= 57;
};
const separatorAt = (s: string, i: number) => {
  const n = s.charCodeAt(i);
  return n === 32 || n === 45 || n === 95 || n === 9 || n === 160;
};

/**
 * A word may be taken off only where a word starts: after a space, hyphen or underscore, at a
 * lowercase-to-uppercase step ("AmintaBold"), after a digit ("Univers45Light"), or where an
 * all-capitals run gives way to a capitalized word ("MKSDMedium"). `atStart`: the very start
 * counts too (reading a style name; a family name always keeps something).
 */
function startsWord(s: string, at: number, atStart: boolean): boolean {
  if (at === 0) return atStart;
  if (separatorAt(s, at - 1)) return true;
  if (!upperAt(s, at)) return false;
  return lowerAt(s, at - 1) || digitAt(s, at - 1) || (upperAt(s, at - 1) && lowerAt(s, at + 1));
}

interface Found {
  word: Word;
  /** Where it starts in the string searched. */
  start: number;
}

/**
 * The longest style word at the end of `s` that starts where a word starts, if any: each place
 * a word could start is tried from the left, so "ExtraBlack" wins over "Black". Spaces, hyphens
 * and underscores inside it don't matter ("Extra Light" is ExtraLight).
 */
function wordAtEnd(s: string, set: WordSet, atStart: boolean): Found | null {
  // Every spelling ends in letters a word of the set ends in (`ENDS3`, `ENDS2`): most names
  // that don't are done with at once ("Univers 45", "Helvetica", "Futura").
  const n = s.length;
  if (s.charCodeAt(n - 1) < 128) {
    const z = letterAt(s, n - 1);
    if (z < 0) return null;
    const y = letterAt(s, n - 2);
    if (y >= 0) {
      const x = letterAt(s, n - 3);
      if (!ENDS2[set][y * 26 + z] && !(x >= 0 && ENDS3[set][(x * 26 + y) * 26 + z])) return null;
    } else if (s.charCodeAt(n - 2) < 128) return null;
  }
  let lower: string | undefined;
  let lastSeparator = -1;
  // No word is longer than the longest spelling, give or take a separator or two inside it.
  for (let start = Math.max(atStart ? 0 : 1, s.length - LONGEST_FORM - 2); start < s.length; start++) {
    if (separatorAt(s, start) || !startsWord(s, start, atStart)) continue;
    if (lower === undefined) {
      lower = s.toLowerCase();
      // Lowercasing that changes the length (a rare letter) can't be cut at the same places.
      if (lower.length !== s.length) lower = "";
      lastSeparator = Math.max(s.lastIndexOf(" "), s.lastIndexOf("-"), s.lastIndexOf("_"));
    }
    const tail = lower ? lower.slice(start) : s.slice(start).toLowerCase();
    const word = BY_FORM.get(start > lastSeparator ? tail : tail.replace(/[ _-]/g, ""));
    if (!word || !inSet(word, set)) continue;
    // An abbreviation in capitals is an acronym: "LT" (Linotype), not Light.
    if (word.abbrev && s.length - start > 1) {
      const text = s.slice(start);
      if (text === text.toUpperCase()) continue;
    }
    return { word, start };
  }
  return null;
}

/** Without separators at the end. Nearly every name ends in a letter or digit already. */
const trimEnd = (s: string) => {
  const c = s.charCodeAt(s.length - 1);
  if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return s;
  return s.replace(/[\s\-_]+$/, "");
};
const trimStart = (s: string) => s.replace(/^[\s\-_]+/, "");

/** Where a number at the end starts, if it's a word of its own ("Univers 45"; not "X01"). */
const TRAILING_NUMBER = /(\d+)$/;
function numberAtEnd(s: string): number | null {
  if (!digitAt(s, s.length - 1)) return null;
  const m = TRAILING_NUMBER.exec(s);
  if (!m || m.index === 0) return null;
  return isSeparator(s[m.index - 1]) ? m.index : null;
}

const squashed = new Map<string, string>();
const squashNow = (name: string) => name.toLowerCase().replace(/[\s\-_.™®]/g, "");

/** Names compared this way match: lowercase, without spaces, hyphens, underscores, dots, ™ and ®. */
export function squash(name: string): string {
  let out = squashed.get(name);
  if (out === undefined) {
    out = squashNow(name);
    // A few thousand family and designer names; never without bound.
    if (squashed.size > 100_000) squashed.clear();
    squashed.set(name, out);
  }
  return out;
}

/** A family name without ™ and ®, trimmed. */
const clean = (name: string) => {
  const s = name.indexOf("™") < 0 && name.indexOf("®") < 0 ? name : name.replace(/[™®]/g, "");
  // Trimmed only when it starts or ends with what might be white space (nearly never).
  const a = s.charCodeAt(0);
  const b = s.charCodeAt(s.length - 1);
  return a > 32 && a < 127 && b > 32 && b < 127 ? s : s.trim();
};

const LETTER = /\p{L}/u;
/** How many letters a name has (G3). */
function letters(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c < 128 ? (c >= 65 && c <= 90) || (c >= 97 && c <= 122) : LETTER.test(ch)) n++;
  }
  return n;
}

// ------------------------------------------------------------------------------- analysis

export interface Removed {
  word: Word;
  /** The words as the name spells them. */
  text: string;
  /** Where they start in `NameAnalysis.clean`. */
  start: number;
}

/** What a family name says about itself. */
export interface NameAnalysis {
  /** The name without ™ and ®. */
  clean: string;
  /** The whole name's squash key (`squash`). */
  full: string;
  /** What's left after taking off the style words that can merge. */
  base: string;
  key: string;
  /** Those words, in the name's order. Empty: the name is a family name as it stands. */
  words: Removed[];
  /** Some of them are abbreviations. */
  abbrev: boolean;
  /** What's left ends in a number ("Univers 45"): a numbered style, only ever suggested. */
  numbered: boolean;
  /**
   * "SC" right after the family part is read as a script code here (Noto Sans SC: Simplified
   * Chinese), so it stays in `base`. When it may be small capitals instead (Elementa SC), this
   * is the reading that takes it off too; `planByName` picks one by the font.
   */
  smallCaps?: NameAnalysis;
}

/** A name's base with width, size and number words taken off too ("Arial Narrow" → "Arial"),
 *  for suggestions. */
export interface WideName {
  /** With every width, size and number word off, and every style word before them. */
  base: string;
  key: string;
  /** The innermost width, size or number word that went ("Narrow", "Display", "45"); none if
   *  none did. */
  word?: string;
  kind?: "width" | "optical" | "number";
  /**
   * Each name a suggestion could join, longest first: right after the outermost width, size or
   * number word is off, then after each word before it ("Times New Roman Condensed": Times New
   * Roman, then Times New). The last is `base`. Empty when no such word went.
   */
  steps: WideStep[];
}

export interface WideStep {
  base: string;
  key: string;
  /** The style word taken off to get here from the step before, if it was one (not a width,
   *  size or number word): "Roman" for Times New. */
  word?: Word;
}

const analyses = new Map<string, NameAnalysis>();
const analysesWithout = new Map<string, NameAnalysis>();

/** Reads a family name (cached: the library has a few thousand). `abbrev`: abbreviations count. */
export function analyzeName(name: string, abbrev = true): NameAnalysis {
  const cache = abbrev ? analyses : analysesWithout;
  const known = cache.get(name);
  if (known) return known;
  const c = clean(name);
  const words: Removed[] = [];
  let rest = trimEnd(c);
  for (;;) {
    const found = wordAtEnd(rest, abbrev ? "mergeAbbrev" : "merge", false);
    if (!found) break;
    words.unshift({ word: found.word, text: rest.slice(found.start).trim(), start: found.start });
    rest = trimEnd(rest.slice(0, found.start));
  }
  const full = squashNow(c);
  const make = (base: string, list: Removed[]): NameAnalysis => ({
    clean: c,
    full,
    base,
    key: base === c ? full : squashNow(base),
    words: list,
    abbrev: list.some((w) => w.word.abbrev),
    numbered: numberAtEnd(base) !== null,
  });
  let analysis: NameAnalysis;
  if (words.length && words[0].word.notInnermost) {
    // "SC" right after the family part: a script (Noto Sans SC) unless the font says otherwise.
    const smallCaps = make(rest, words);
    let at = 0;
    while (at < words.length && words[at].word.notInnermost) at++;
    analysis = { ...make(trimEnd(c.slice(0, at < words.length ? words[at].start : c.length)), words.slice(at)), smallCaps };
  } else analysis = make(rest, words);
  cache.set(name, analysis);
  return analysis;
}

/** The analysis that reads the name's family part to the end of `words[0..count)` too: what's
 *  left when its first `count` style words are part of the family's name ("Times New Roman"). */
function keepingWords(a: NameAnalysis, count: number): NameAnalysis {
  const base = trimEnd(a.clean.slice(0, count < a.words.length ? a.words[count].start : a.clean.length));
  const words = a.words.slice(count);
  return { clean: a.clean, full: a.full, base, key: squash(base), words, abbrev: words.some((w) => w.word.abbrev), numbered: numberAtEnd(base) !== null };
}

const wides = new Map<string, WideName>();

/** A base (`NameAnalysis.base`) with width, size and number words, and the style words before
 *  them, taken off as well: what a suggestion would join. Cached. */
export function widen(base: string): WideName {
  const known = wides.get(base);
  if (known) return known;
  let rest = base;
  let word: string | undefined;
  let kind: WideName["kind"];
  const steps: WideStep[] = [];
  for (;;) {
    const found = wordAtEnd(rest, "every", false);
    const number = numberAtEnd(rest);
    let style: Word | undefined;
    if (found && !found.word.notInnermost && (number === null || found.start > number)) {
      if (found.word.kind === "width" || found.word.kind === "optical") {
        word = found.word.canon;
        kind = found.word.kind;
      } else style = found.word;
      rest = trimEnd(rest.slice(0, found.start));
    } else if (number !== null) {
      word = rest.slice(number);
      kind = "number";
      rest = trimEnd(rest.slice(0, number));
    } else break;
    if (kind) steps.push(style && steps.length ? { base: rest, key: squash(rest), word: style } : { base: rest, key: squash(rest) });
  }
  const out: WideName = kind ? { base: rest, key: squash(rest), word, kind, steps } : { base, key: squash(base), steps };
  wides.set(base, out);
  return out;
}

const stems = new Map<string, string[]>();

/**
 * The family part of a PostScript name, as squash keys: the part before the first "-", and the
 * whole name, each with style words taken off its end ("AbhayaLibre-ExtraBold" → "abhayalibre";
 * "AauxProBold" → "aauxpro"; "Beekman-SquareBold" → "beekman" and "beekmansquare"; "ElementaSC"
 * → "elementasc" and, read as small capitals, "elementa"). Empty without a name.
 */
export function postscriptStems(ps: string | null | undefined): readonly string[] {
  if (!ps) return [];
  const known = stems.get(ps);
  if (known) return known;
  const dash = ps.indexOf("-");
  const out: string[] = [];
  if (dash >= 0) stemKeys(ps.slice(0, dash), out);
  stemKeys(ps, out);
  if (stems.size > 100_000) stems.clear();
  stems.set(ps, out);
  return out;
}

const stemKeysOf = new Map<string, readonly string[]>();

/**
 * `analyzeName(name).key`, then its small-capitals reading's (`NameAnalysis.smallCaps`), added
 * to `out` once each: the same words come off the same way, but no analysis is made or kept
 * (most PostScript names are read once).
 */
function stemKeys(name: string, out: string[]) {
  let keys = stemKeysOf.get(name);
  if (!keys) {
    const known = analyses.get(name);
    if (known) keys = known.smallCaps ? [known.key, known.smallCaps.key] : [known.key];
    else {
      const c = clean(name);
      let rest = trimEnd(c);
      // Where the innermost word that isn't "SC" starts, and whether the innermost is "SC".
      let cut = -1;
      let innerSC = false;
      for (;;) {
        const found = wordAtEnd(rest, "mergeAbbrev", false);
        if (!found) break;
        innerSC = found.word.notInnermost === true;
        if (!innerSC) cut = found.start;
        rest = trimEnd(rest.slice(0, found.start));
      }
      keys = innerSC ? [squashNow(cut < 0 ? trimEnd(c) : trimEnd(c.slice(0, cut))), squashNow(rest)] : [squashNow(rest)];
    }
    if (stemKeysOf.size > 100_000) stemKeysOf.clear();
    stemKeysOf.set(name, keys);
  }
  for (const k of keys) if (!out.includes(k)) out.push(k);
}

/** Words that say nothing about which foundry it is. */
const FOUNDRY_NOISE = new Set([
  "the", "inc", "incorporated", "corporation", "corp", "co", "company", "ltd", "limited", "llc", "gmbh", "ag", "sa", "bv", "srl",
  "systems", "type", "typography", "foundry", "fonts", "font", "design", "studio", "studios", "imaging", "library", "by", "and",
]);

/**
 * A foundry (name ID 8) to compare: its words that say which foundry it is, A to Z, without the
 * ones that don't ("The Monotype Corporation" and "Monotype Typography, Inc." are both
 * "monotype"; "Pablo Impallari" is "impallari pablo"). Words of one letter don't count ("A&O").
 * Undefined when the font doesn't say. Compare two with `sameFoundry`.
 */
export function foundryKey(manufacturer: string | null | undefined): string | undefined {
  if (!manufacturer) return undefined;
  if (foundryKeys.has(manufacturer)) return foundryKeys.get(manufacturer);
  const words = new Set<string>();
  for (const word of manufacturer.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (word.length >= 2 && !FOUNDRY_NOISE.has(word)) words.add(word);
  const key = words.size ? [...words].sort().join(" ") : undefined;
  foundryKeys.set(manufacturer, key);
  return key;
}
const foundryKeys = new Map<string, string | undefined>();
const foundryWords = new Map<string, readonly string[]>();

/** The same foundry: one key's words are all among the other's ("Linotype" and "Linotype-Hell
 *  AG"; not "Daniel Bruce" and "Daniel Hernandez", two people). */
export function sameFoundry(a: string, b: string): boolean {
  if (a === b) return true;
  const words = (k: string) => {
    let w = foundryWords.get(k);
    if (!w) foundryWords.set(k, (w = k.split(" ")));
    return w;
  };
  const [small, big] = words(a).length <= words(b).length ? [words(a), words(b)] : [words(b), words(a)];
  return small.every((w) => big.includes(w));
}

// --------------------------------------------------------------------------- style labels

interface StyleWords {
  words: Word[];
  rest: string;
}
const styleWordsOf = new Map<string, StyleWords>();

/** The words of a style name, read from its end: the words it knows, then whatever's left.
 *  Cached: labels and sorting read the same few thousand. */
function styleWords(style: string): StyleWords {
  let out = styleWordsOf.get(style);
  if (out) return out;
  const words: Word[] = [];
  let rest = trimEnd(style.trim());
  for (;;) {
    const found = wordAtEnd(rest, "every", true);
    if (!found) break;
    words.unshift(found.word);
    rest = trimEnd(rest.slice(0, found.start));
  }
  out = { words, rest };
  if (styleWordsOf.size > 100_000) styleWordsOf.clear();
  styleWordsOf.set(style, out);
  return out;
}

/** Text split where words start (separators, case steps), for the part of a name no word list knows. */
function tokens(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  const push = (end: number) => {
    let token = text.slice(at, end);
    if (SEPARATOR.test(token)) token = token.replace(/[\s\-_]/g, "");
    if (token) out.push(token);
  };
  for (let i = 1; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 128 ? c === 32 || c === 45 || c === 95 || (c >= 9 && c <= 13) : SEPARATOR.test(text[i])) || startsWord(text, i, false)) {
      push(i);
      at = i;
    }
  }
  if (text.length) push(text.length);
  return out;
}

/** Spaces, hyphens, underscores, dots, ™ and ®: what `squash` and `leftover` leave out. */
const SKIPPED = /[\s\-_.™®]/;
const skippedAt = (s: string, i: number) => {
  const c = s.charCodeAt(i);
  return c < 128 ? c === 32 || c === 45 || c === 95 || c === 46 || (c >= 9 && c <= 13) : SKIPPED.test(s[i]);
};

/** What's left of `raw` after `family`, ignoring case, spaces, hyphens, underscores, dots, ™
 *  and ®, or null if `raw` doesn't start with it ("AauxPro-BlackOSF" after "Aaux Pro" is "-BlackOSF"). */
export function leftover(raw: string, family: string): string | null {
  let i = 0;
  for (let j = 0; j < family.length; j++) {
    if (skippedAt(family, j)) continue;
    while (i < raw.length && skippedAt(raw, i)) i++;
    if (i >= raw.length) return null;
    const a = raw.charCodeAt(i);
    const b = family.charCodeAt(j);
    if (a !== b) {
      // The same letter in another case: ASCII by its 32 bit, the rest the slow way.
      if (a < 128 && b < 128) {
        if ((a | 32) !== (b | 32) || !((a | 32) >= 97 && (a | 32) <= 122)) return null;
      } else if (raw[i].toLowerCase() !== family[j].toLowerCase()) return null;
    }
    i++;
  }
  return raw.slice(i);
}

const PLAIN = new Set(["regular", "roman", "plain", "normal", ""]);
const labels = new Map<string, string>();

/**
 * A face's style in the family it's listed under (5.4): the words its family name has past
 * that family, spelled the usual way, then its own style unless that's Regular, Roman, Plain or
 * Normal, without repeating a word. "AmintaBlackItalic" (style Regular) in Aminta is "Black
 * Italic"; "Dynasty Heavy" (Italic) in Dynasty is "Heavy Italic". A face under its own name
 * keeps its own style; one moved under an unrelated family puts its family name first.
 *
 * `weight` is the font's stored weight. Old Fontographer fonts call every style "Medium" and
 * store 400: when the family name already names a weight ("VisageBold"), that "Medium" is
 * dropped ("Bold", not "Bold Medium").
 */
export function styleLabel(raw: string, own: string, family: string, weight?: number): string {
  if (raw === family) return own;
  const ownTrim = own.trim();
  const ownLower = ownTrim.toLowerCase();
  const fallback = weight === 400 && ownLower === "medium";
  const cacheKey = `${raw}\u0000${own}\u0000${family}\u0000${fallback ? 1 : 0}`;
  const known = labels.get(cacheKey);
  if (known !== undefined) return known;
  const after = leftover(clean(raw), family);
  // A few words: a list, not a set, to leave out repeats.
  const out: string[] = [];
  const seen: string[] = [];
  const add = (word: string) => {
    const k = word.toLowerCase();
    if (seen.includes(k)) return;
    seen.push(k);
    out.push(word);
  };
  let namesWeight = false;
  if (after === null) add(clean(raw));
  else if (after) {
    const { words, rest } = styleWords(separatorAt(after, 0) ? trimStart(after) : after);
    if (rest) for (const t of tokens(rest)) add(t);
    for (const w of words) {
      add(w.canon);
      if (w.kind === "weight") namesWeight = true;
    }
  }
  if (!PLAIN.has(ownLower) && !(fallback && namesWeight)) {
    const { words, rest } = styleWords(own);
    if (rest) add(ownTrim);
    else for (const w of words) add(w.canon);
  }
  const label = out.join(" ") || ownTrim || "Regular";
  if (labels.size > 100_000) labels.clear();
  labels.set(cacheKey, label);
  return label;
}

/** Weight, width and slope for sorting a family's styles. */
export interface Traits {
  weight: number;
  width: number;
  italic: boolean;
  /** Its style names a variant (Alt, Swash, Caps, SC, OSF, LF, TF, Expert…): a plain style of
   *  the same weight comes before it, and shows the family. */
  variant: boolean;
}

type TraitFont = Pick<FontSummary, "weight" | "width" | "italic" | "variable">;

interface NamedWeight {
  weight: number;
  /** Regular, Roman, Normal or Plain. */
  plain: boolean;
}

/** What a style's words say. */
interface Said {
  /** The weights its words name: whole words only, unless it has none ("Semi Medium" is
   *  Medium; "Semi" alone is SemiBold). */
  weights: NamedWeight[];
  width?: number;
  slope: boolean;
  variant: boolean;
}

const saids = new Map<string, Said>();

function saidOf(label: string): Said {
  let said = saids.get(label);
  if (!said) {
    const full: NamedWeight[] = [];
    const abbrevs: NamedWeight[] = [];
    said = { weights: full, slope: false, variant: false };
    for (const w of styleWords(label).words) {
      if (w.weight !== undefined) (w.abbrev ? abbrevs : full).push({ weight: w.weight, plain: PLAIN.has(w.canon.toLowerCase()) });
      if (w.width !== undefined && said.width === undefined) said.width = w.width;
      if (w.kind === "slope") said.slope = true;
      if (w.kind === "variant") said.variant = true;
    }
    if (!full.length) said.weights = abbrevs;
    saids.set(label, said);
  }
  return said;
}

/**
 * The weight a style's name gives it (`Said.weights`), and of several ("Book Heavy"), the one
 * nearest the font's own number. A plain word (Regular, Roman, Normal, Plain) says 400 but
 * corrects a number only when the family's numbers are shown wrong (`traitsOf`).
 */
function namedWeight(said: Said, stored: number): NamedWeight | undefined {
  const list = said.weights;
  if (list.length < 2) return list[0];
  let best = list[0];
  for (const w of list) if (Math.abs(w.weight - stored) < Math.abs(best.weight - stored)) best = w;
  return best;
}

const widthOf = (said: Said, font: TraitFont) => (said.width !== undefined && font.width === 5 ? said.width : font.width);

/**
 * Where a family's style weights come from (`familyWeightSource`): the fonts' own numbers, or
 * the styles' names. "allNames" lets a plain word correct a number too ("Regular" in a family
 * that stores 500 for every weight).
 */
export type WeightSource = "numbers" | "names" | "allNames";

/**
 * What a style says about itself, where the font's own numbers are wrong (1,583 of Sean's faces
 * say weight 400 whatever their name, and 406 italics aren't flagged): the weight its name gives
 * it (`namedWeight`) wins when it's 100 or more from the stored weight, unless the family's
 * numbers are to be trusted (`source` "numbers"), the word is a plain one outside "allNames"
 * ("Regular" says nothing about Pokerface, stored at 900), or the font is variable (it keeps its
 * default). A width word wins over the normal width, and Italic or Oblique counts as italic.
 */
export function traitsOf(label: string, font: TraitFont, source: WeightSource = "names"): Traits {
  return traitsFrom(saidOf(label), font, source);
}

function traitsFrom(said: Said, font: TraitFont, source: WeightSource): Traits {
  const named = source === "numbers" || font.variable ? undefined : namedWeight(said, font.weight);
  const weight = named && (!named.plain || source === "allNames") && Math.abs(named.weight - font.weight) >= 100 ? named.weight : font.weight;
  const width = widthOf(said, font);
  const italic = font.italic || said.slope;
  // The same traits are the same object (read-only): a few hundred for the whole library.
  if (!Number.isInteger(weight) || !Number.isInteger(width) || width < 0 || width > 15) return { weight, width, italic, variant: said.variant };
  const id = ((weight * 16 + width) * 2 + Number(italic)) * 2 + Number(said.variant);
  let traits = traitsById.get(id);
  if (!traits) traitsById.set(id, (traits = Object.freeze({ weight, width, italic, variant: said.variant })));
  return traits;
}
const traitsById = new Map<number, Traits>();

/** Slope, width and stored weight → the weight named there (reused: one family at a time). */
const slots = new Map<number, number>();

/**
 * Whether a family's own weight numbers order its styles, or their names do (`traitsOf`):
 * - The names, plain words too, when the numbers are shown wrong: two styles of the same slope
 *   and width that name different weights share a number, or a style at 400 names a weight more
 *   than 100 away ("Heavy": the 400 many fonts store whatever their weight). Aaux Pro says 400
 *   for all its weights; Amplitude says 500.
 * - The numbers when they tell the styles apart (two different ones at least) and aren't shown
 *   wrong. BB Strata Pro numbers its styles 100 to 500 on purpose, so its Semi Regular (250)
 *   stays before its Regular (300).
 * - Otherwise (one style, or one number for all) the names, but a plain word doesn't change a
 *   number: a lone "Regular" stored at 900 is a Black.
 */
export function familyWeightSource(faces: readonly { style: string; primary: TraitFont }[]): WeightSource {
  return weightSource(faces, faces.map((f) => saidOf(f.style)));
}

/** `familyWeightSource`, with what each style's words say already read. */
function weightSource(faces: readonly { primary: TraitFont }[], said: readonly Said[]): WeightSource {
  // One style: nothing to tell apart (and a plain word can't be shown wrong).
  if (faces.length < 2) return "names";
  let first: number | undefined;
  let varied = false;
  let wrong = false;
  const named = slots;
  named.clear();
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i].primary;
    if (f.variable) continue;
    if (first === undefined) first = f.weight;
    else if (f.weight !== first) varied = true;
    if (wrong) continue;
    const words = said[i];
    const n = namedWeight(words, f.weight);
    if (!n) continue;
    if (f.weight === 400 && !n.plain && Math.abs(n.weight - 400) > 100) wrong = true;
    const slot = (f.italic || words.slope ? 100_000 : 0) + widthOf(words, f) * 10_000 + f.weight;
    const there = named.get(slot);
    if (there === undefined) named.set(slot, n.weight);
    else if (there !== n.weight) wrong = true;
  }
  return wrong ? "allNames" : varied ? "numbers" : "names";
}

/** Each style's sorting traits in its family (`traitsOf`, by `familyWeightSource`), reading
 *  each style's words once. */
export function familyTraits(faces: readonly { style: string; primary: TraitFont }[]): Traits[] {
  if (faces.length === 1) return [traitsFrom(saidOf(faces[0].style), faces[0].primary, "names")];
  const said: Said[] = [];
  for (const f of faces) said.push(saidOf(f.style));
  const source = weightSource(faces, said);
  const out: Traits[] = [];
  for (let i = 0; i < faces.length; i++) out.push(traitsFrom(said[i], faces[i].primary, source));
  return out;
}

// ---------------------------------------------------------------------------- your choices

/** Your choice for one font (by face key): a family, and maybe a style; family null keeps it
 *  under its own name. Must match FaceChoice in src-tauri/src/families.rs. */
export interface FaceChoice {
  faceKey: string;
  family: string | null;
  style: string | null;
}

/** Your rule for a family name (by its squash key): merge it into a family, or keep it
 *  separate. Must match NameRule in src-tauri/src/families.rs. */
export interface NameRule {
  nameKey: string;
  /** The name as it was spelled when you chose. */
  name: string;
  decision: "merge" | "separate";
  /** For "merge". */
  into: string | null;
}

export interface GroupingOptions {
  /** Settings › Library › "Group families by name". Off: no automatic merging. */
  byName: boolean;
  choices?: ReadonlyMap<string, FaceChoice>;
  rules?: ReadonlyMap<string, NameRule>;
}

/** How a face got its family: its own name, grouping by name, your rule for its name, or your
 *  choice for it. A rule or choice can also keep it under its own name. */
export type GroupedBy = "own" | "name" | "rule" | "choice";

/** What the rules read from a copy of a font. */
export type NameFont = Pick<
  FontSummary,
  "family" | "subfamily" | "postscriptName" | "weight" | "width" | "italic" | "variable" | "manufacturer" | "designer" | "hasTypoFamily" | "glyphCount"
>;

/** What the rules need to know about a face. */
export interface FaceInput {
  key: string;
  /** The copy shown and turned on (library.ts `preferred`). */
  primary: NameFont;
  /** Every copy, the primary first. Copies can carry other family names ("BlindfishDemi" and
   *  "Blindfish"; "House-A-Rama-Kingpin" and "House-A-Rama"): your rule for any of them applies. */
  copies?: readonly NameFont[];
  /** The copy whose family name the face is grouped by, when its copies carry different ones
   *  (`namedCopy`, then `planByName`'s step 3); else the primary's. */
  named?: NameFont;
  /** Its copies carry different family or style names: false when known they don't (labels
   *  then need only the primary's). */
  varied?: boolean;
}

/** The copy whose family name a face is grouped by. */
const namedOf = (face: FaceInput): NameFont => face.named ?? face.primary;

const PLAIN_STYLE = new Set(["regular", "roman", "plain", "normal", "book", ""]);

/**
 * How well a copy's family and style names agree with its PostScript name: 2 when they spell it
 * ("Engine-LightLF" for family Engine-LightLF, style Regular; "Blindfish" + "Demi" for
 * BlindfishDemi), 1 when the family starts it, 0 otherwise. Copies of one font sometimes carry
 * different names ("Engine", style "Medium", for the same Engine-LightLF): the one whose names
 * agree says the style best.
 */
export function namesAgree(f: Pick<FontSummary, "family" | "subfamily" | "postscriptName">): number {
  if (!f.postscriptName) return 0;
  // Sorting copies, naming a face and labelling it all ask, for the same copies.
  const known = agreed.get(f);
  if (known && known.ps === f.postscriptName && known.family === f.family && known.subfamily === f.subfamily) return known.n;
  const ps = squash(f.postscriptName);
  const family = squash(f.family);
  const style = squash(f.subfamily);
  const rest = ps.startsWith(family) ? ps.slice(family.length) : null;
  const n = rest === null ? 0 : rest === style || (!rest && PLAIN_STYLE.has(style)) ? 2 : 1;
  agreed.set(f, { ps: f.postscriptName, family: f.family, subfamily: f.subfamily, n });
  return n;
}
const agreed = new WeakMap<object, { ps: string; family: string; subfamily: string; n: number }>();

/** Some copy carries another family name than the primary. */
function namesDiffer(face: FaceInput): boolean {
  const copies = face.copies;
  if (!copies || copies.length < 2) return false;
  const family = face.primary.family;
  for (let i = 1; i < copies.length; i++) if (copies[i].family !== family) return true;
  return false;
}

/** Of two copies with different family names, the one whose names say more about the font:
 *  names that agree with its PostScript name, then the more general name (one that starts the
 *  other: "Blindfish" over "BlindfishDemi", "CQN-Molecular-Xtra" over
 *  "CQN-Molecular-Xtra-Regular"), the one that names its own family (name ID 16), then A to Z.
 *  Below 0: `a` first. */
function betterNamed(a: NameFont, b: NameFont): number {
  const ka = squash(a.family);
  const kb = squash(b.family);
  return (
    namesAgree(b) - namesAgree(a) ||
    (ka !== kb && kb.startsWith(ka) ? -1 : ka !== kb && ka.startsWith(kb) ? 1 : 0) ||
    Number(b.hasTypoFamily === true) - Number(a.hasTypoFamily === true) ||
    compareNames(a.family, b.family) ||
    compareNames(a.subfamily, b.subfamily)
  );
}

/**
 * Two copies' family names that are one family's: one starts the other ("KO" and "KO-dirty",
 * "Blindfish" and "BlindfishDemi"), or they start alike for at least 3 letters and half the
 * shorter name ("Lido STF CE" and "LidoSTFCondCE-Bold"). Not unrelated fonts that share a
 * PostScript name ("Apex" and "ø"): those keep the shown copy's name.
 */
function kin(a: string, b: string): boolean {
  const x = squash(a);
  const y = squash(b);
  const n = Math.min(x.length, y.length);
  let i = 0;
  while (i < n && x.charCodeAt(i) === y.charCodeAt(i)) i++;
  return (i === n && n >= 2) || (i >= 3 && i * 2 >= n);
}

/**
 * The copy whose family name a face is grouped by (`FaceInput.named`), when its copies carry
 * different names of one family (`kin`, `betterNamed`); undefined when that's the primary's.
 * Never by the file's path, its state or the row order, so moving or renaming a folder, or
 * turning a copy on, doesn't move a face. `copies`: the primary first. `planByName` may then
 * group a family by another copy's name (its step 3).
 */
export function namedCopy<C extends NameFont>(copies: readonly C[]): C | undefined {
  const primary = copies[0];
  let best = primary;
  for (let i = 1; i < copies.length; i++) {
    const c = copies[i];
    if (c.family !== best.family && kin(c.family, primary.family) && betterNamed(c, best) < 0) best = c;
  }
  return best === primary ? undefined : best;
}

/** A copy whose family name is `family`, or starts it (then what's left is a style). */
const relates = (raw: string, family: string) => raw === family || leftover(clean(raw), family) !== null;

/**
 * A face's style label in `family` (`styleLabel`), from the copy whose names say it best: one
 * whose family name is that family or starts with it, then the one whose names agree with its
 * PostScript name (Engine-LightLF, style Regular, is "Light LF" in Engine; the copy that calls
 * it Engine, style Medium, isn't), then one whose label comes from its family name's words
 * ("UltraBronzo-Lite" is "Light", where the "UltraBronzo" copy says "Lite"), then A to Z. Never
 * by which copy is shown or what placed it, so turning one on doesn't change it.
 */
function labelFor(face: FaceInput, family: string): string {
  const copies = face.copies;
  let best = face.primary;
  const alike = !copies || copies.length < 2 || face.varied === false || (face.varied === undefined && copies.every((c) => c.family === best.family && c.subfamily === best.subfamily));
  if (alike) return best.family === family ? best.subfamily : styleLabel(best.family, best.subfamily, family, best.weight);
  const score = (c: NameFont) => (relates(c.family, family) ? 8 : 0) + namesAgree(c) * 2 + (c.family !== family ? 1 : 0);
  let bestScore = score(best);
  for (const c of copies) {
    if (c === best || (c.family === best.family && c.subfamily === best.subfamily)) continue;
    const s = score(c);
    if (s > bestScore || (s === bestScore && (compareNames(c.family, best.family) || compareNames(c.subfamily, best.subfamily)) < 0)) {
      best = c;
      bestScore = s;
    }
  }
  return styleLabel(best.family, best.subfamily, family, face.primary.weight);
}

/** Why a name that could join a family isn't grouped with it automatically. */
export type HoldReason =
  /** G1: the font names its own grouping family (name ID 16). */
  | "ownName"
  /** G2: its name ends in a numbered style ("Univers 45 Light"). */
  | "number"
  /** G4: the two sides name different foundries. */
  | "foundry"
  /** Nothing else agrees: no PostScript name, foundry, designer or weight number backs the name. */
  | "noSignal"
  /** It could, but no other name would join it, so there's no family to join. */
  | "alone";

export interface GroupPlan {
  /** Family name → the family grouping by name lists it under (only names that move). */
  merges: Map<string, string>;
  /** Names that could join a family but aren't grouped automatically, and why. */
  held: Map<string, Held>;
}

export interface Held {
  into: string;
  reason: HoldReason;
  /** A numbered style's number ("45"). */
  word?: string;
}

interface NameInfo {
  raw: string;
  a: NameAnalysis;
  faces: number;
  list: readonly FaceInput[];
  /** Worked out only for names in a group (most names have none): see `facts`. */
  facts?: NameFacts;
  /** Its faces' PostScript stems, worked out only when asked for (`stemsOf`). */
  stems?: Set<string>;
}

interface NameFacts {
  foundries: Set<string>;
  designers: Set<string>;
  weights: number[];
  typo: boolean;
}

/** What a name's faces say: their foundries, designers, weights, name 16. */
function factsOf(info: NameInfo): NameFacts {
  if (info.facts) return info.facts;
  const facts: NameFacts = { foundries: new Set(), designers: new Set(), weights: [], typo: false };
  for (const face of info.list) {
    const f = namedOf(face);
    const foundry = foundryKey(f.manufacturer);
    if (foundry) facts.foundries.add(foundry);
    const designer = f.designer ? squash(f.designer) : "";
    if (designer) facts.designers.add(designer);
    facts.weights.push(f.weight);
    facts.typo ||= f.hasTypoFamily === true;
  }
  info.facts = facts;
  return facts;
}

/** A name's faces' PostScript stems (`postscriptStems`). Most names that merge are backed by
 *  their own, so a family's other names' are seldom needed. */
function stemsOf(info: NameInfo): Set<string> {
  if (info.stems) return info.stems;
  const stems = new Set<string>();
  for (const face of info.list) for (const stem of postscriptStems(namedOf(face).postscriptName)) stems.add(stem);
  info.stems = stems;
  return stems;
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** A to Z, ignoring case and accents; names that differ only there ("GOTHAM", "Gotham") still
 *  come in one order, whatever order they arrived in. */
export const compareNames = (a: string, b: string): number => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/** All capitals ("GOTHAM"). */
const shouting = (s: string) => s === s.toUpperCase() && s !== s.toLowerCase();

/** The spelling a group shows: one with spaces ("Big Caslon" over "BigCaslon"), then the one
 *  most faces use, then one that isn't all capitals ("Gotham" over "GOTHAM"), then A to Z. */
function bestSpelling(candidates: [spelling: string, faces: number][]): string {
  if (candidates.length === 1) return candidates[0][0];
  const totals = new Map<string, number>();
  for (const [s, n] of candidates) totals.set(s, (totals.get(s) ?? 0) + n);
  return [...totals].sort(
    ([a, n], [b, m]) => Number(/\s/.test(b)) - Number(/\s/.test(a)) || m - n || Number(shouting(a)) - Number(shouting(b)) || compareNames(a, b),
  )[0][0];
}

/**
 * What the other names of a group say (`counts`: how many names have each value, `countsOf`),
 * less the name's own when it's among those counted (`inside`): a name's own PostScript name,
 * foundry or designer is no signal for itself. Plain functions: they run for every name in
 * every group.
 */
const othersCount = (own: ReadonlySet<string>, inside: boolean, v: string, n: number) => (inside && own.has(v) ? n - 1 : n);

/** Some other name has one of `mine`. */
function othersShare(counts: ReadonlyMap<string, number>, own: ReadonlySet<string>, inside: boolean, mine: ReadonlySet<string>): boolean {
  for (const v of mine) if (othersCount(own, inside, v, counts.get(v) ?? 0) > 0) return true;
  return false;
}

/** Some other name has any value at all. */
function othersAny(counts: ReadonlyMap<string, number>, own: ReadonlySet<string>, inside: boolean): boolean {
  for (const [v, n] of counts) if (othersCount(own, inside, v, n) > 0) return true;
  return false;
}

/** Some other name has the same foundry as one of `mine` (`sameFoundry`). */
function othersShareFoundry(counts: ReadonlyMap<string, number>, own: ReadonlySet<string>, inside: boolean, mine: ReadonlySet<string>): boolean {
  for (const a of mine) for (const [b, n] of counts) if (othersCount(own, inside, b, n) > 0 && sameFoundry(a, b)) return true;
  return false;
}

type WordFont = Pick<FontSummary, "weight" | "variable" | "postscriptName">;

/**
 * Whether a style word all the names of a new family share is part of the family's name (5.1 b),
 * rather than their style: a plain word ("Times New Roman"); a weight word their own weight
 * numbers contradict, more than 100 away and not the 400 so many fonts store whatever their
 * weight (Shadows Into Light has a Bold at 700); or one a PostScript name spells in its family
 * part ("ShadowsIntoLight-Italic"). Otherwise it's their style: "Gotham Bold" (700) and "Gotham
 * Bold Italic" are Gotham's Bold and Bold Italic. `through`: the family's squash key with the
 * word on.
 */
function partOfName(word: Word, through: string, fonts: readonly (readonly WordFont[])[]): boolean {
  if (PLAIN.has(word.canon.toLowerCase())) return true;
  for (const list of fonts)
    for (const f of list) {
      if (word.weight !== undefined && !f.variable && f.weight !== 400 && Math.abs(f.weight - word.weight) > 100) return true;
      const ps = f.postscriptName;
      const dash = ps ? ps.indexOf("-") : -1;
      if (dash > 0 && squash(ps!.slice(0, dash)).startsWith(through)) return true;
    }
  return false;
}

/**
 * How many style words, from the innermost, every name has in common and are part of the
 * family's name (`partOfName`): "Times New Roman" and "Times New Roman Italic" share "Roman";
 * "Gotham Bold" and "Gotham Bold Italic" share none. All the words they share stay when what
 * would be left can't be a family anyway (a numbered style, G2, or under 3 letters, G3):
 * "Univers 45 Light" and its Oblique are one family, Univers 45 Light.
 */
function sharedWords(members: readonly NameInfo[]): number {
  let all = 0;
  let part = -1;
  let through = members[0].a.key;
  for (;; all++) {
    const first = members[0].a.words[all];
    if (!first) break;
    const text = squash(first.text);
    if (!members.every((m) => m.a.words[all] && squash(m.a.words[all].text) === text)) break;
    through += text;
    if (part < 0 && !partOfName(first.word, through, members.map((m) => m.list.map(namedOf)))) part = all;
  }
  if (part < 0 || part === all) return all;
  const left = keepingWords(members[0].a, part);
  return left.numbered || letters(left.base) < 3 ? all : part;
}

/** A CJK font, or one whose name has siblings for other scripts: "SC" after its family part is
 *  Simplified Chinese, not small capitals. */
const CJK_GLYPHS = 10_000;
const SCRIPT_SIBLINGS = ["tc", "hk", "jp", "kr"];

/** How many of these names have each value. */
function countsOf(names: readonly NameInfo[], pick: (n: NameInfo) => Set<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of names) for (const v of pick(n)) out.set(v, (out.get(v) ?? 0) + 1);
  return out;
}

/**
 * `planByName`'s first step: faces by the family name they're grouped by (`FaceInput.named`'s,
 * else the primary's), and the faces whose copies carry other family names (its step 3). A font
 * you chose a family for doesn't speak for its name (keeping one name's styles apart by hand
 * doesn't leave the other name renamed on its own), so it's left out. library.ts adds each face
 * as it makes it; `planByName` makes one itself when it isn't given one.
 */
export class NameIndex {
  readonly byName = new Map<string, FaceInput[]>();
  readonly differ: FaceInput[] = [];
  private readonly choices?: ReadonlyMap<string, FaceChoice>;
  // The list comes A to Z, so a face's name is mostly the one before's: no lookup for those.
  private lastName: string | undefined;
  private lastList: FaceInput[] = [];
  constructor(choices?: ReadonlyMap<string, FaceChoice>) {
    this.choices = choices?.size ? choices : undefined;
  }
  add(face: FaceInput): void {
    if (this.choices?.has(face.key)) return;
    const name = (face.named ?? face.primary).family;
    if (name !== this.lastName) {
      this.lastName = name;
      const list = this.byName.get(name);
      if (list) this.lastList = list;
      else this.byName.set(name, (this.lastList = []));
    }
    this.lastList.push(face);
    if (face.copies && face.copies.length > 1 && namesDiffer(face)) this.differ.push(face);
  }
}

/**
 * What grouping by name does with each family name in the library (rule 3): which names merge
 * into which family, and which could but are held back (for suggestions). Rules you made take
 * their names out (G5, or the rule decides). Works on names, so it runs once per name, not per
 * face; a name's faces all go the same way.
 *
 * Faces are grouped by their named copy's name (`FaceInput.named`). Three steps: names that
 * reduce to the same base once style words are off; names left on their own that differ only in
 * spelling ("Times New Roman" / "TimesNewRoman"); then families whose every style has a copy
 * carrying a name more of the library has go by that name (step 3 sets those faces' `named`).
 */
export function planByName(faces: readonly FaceInput[], rules?: ReadonlyMap<string, NameRule>, choices?: ReadonlyMap<string, FaceChoice>, index?: NameIndex): GroupPlan {
  if (!index) {
    index = new NameIndex(choices);
    for (const face of faces) index.add(face);
  }
  const { byName, differ } = index;
  const infos: NameInfo[] = [];
  // How many faces carry each name, by its squash key (step 3), and the keys more than one
  // name has (step 2).
  const carry = new Map<string, number>();
  const shared = new Set<string>();
  // Step 1's groups: names that reduce to the same base (a name on its own isn't put in a list).
  const groups = new Map<string, NameInfo | NameInfo[]>();
  const group = (info: NameInfo) => {
    const key = info.a.words.length ? info.a.key : info.a.full;
    const there = groups.get(key);
    if (there === undefined) groups.set(key, info);
    else if (Array.isArray(there)) there.push(info);
    else groups.set(key, [there, info]);
  };
  let smallCaps: NameInfo[] | undefined;
  for (const [raw, list] of byName) {
    let a = analyzeName(raw, true);
    const had = carry.get(a.full);
    if (had !== undefined) shared.add(a.full);
    carry.set(a.full, (had ?? 0) + list.length);
    // Abbreviations count only when the PostScript name agrees.
    if (a.abbrev && !list.some((f) => postscriptStems(namedOf(f).postscriptName).includes(a.key))) a = analyzeName(raw, false);
    const info: NameInfo = { raw, a, faces: list.length, list };
    infos.push(info);
    if (a.smallCaps) (smallCaps ??= []).push(info);
    else group(info);
  }
  // "SC" right after the family part is small capitals (Elementa SC), unless the font is a CJK
  // one or the name has siblings for other scripts (Noto Sans SC, with Noto Sans TC: every
  // other name's key is among the groups by now).
  if (smallCaps) {
    const script = smallCaps.map((info) => info.list.some((f) => namedOf(f).glyphCount > CJK_GLYPHS) || SCRIPT_SIBLINGS.some((s) => groups.has(info.a.smallCaps!.key + s)));
    smallCaps.forEach((info, i) => {
      if (!script[i]) info.a = info.a.smallCaps!;
      group(info);
    });
  }

  const merges = new Map<string, string>();
  const held = new Map<string, Held>();
  const decided = (m: NameInfo) => merges.has(m.raw) || held.has(m.raw);

  /**
   * One group: names that would all be the family `display`. `anchors` are the names already
   * spelled as the family (no style words), `key` the family's squash key.
   */
  const settle = (key: string, members: NameInfo[], anchors: NameInfo[], display: string, displayIsName: boolean) => {
    // What the others say: the family that exists (its names), or the other names.
    const context = anchors.length ? anchors : members;
    const inContext = new Set(context);
    const isAnchor = new Set(anchors);
    // The anchors' stems only when a name's own don't back it.
    let stems: Map<string, number> | undefined;
    const foundries = countsOf(context, (m) => factsOf(m).foundries);
    const designers = countsOf(context, (m) => factsOf(m).designers);
    const moving: NameInfo[] = [];
    for (const m of members) {
      if (m.raw === display || (rules?.size && rules.has(squash(m.raw)))) continue; // already it; or G5, or your rule decides
      // G3: too little left to be a family name.
      if (letters(m.a.words.length ? m.a.base : m.a.clean) < 3) continue;
      const inside = inContext.has(m);
      const f = factsOf(m);
      // G2: a numbered style, unless what's left is a family that exists ("Bodoni 72"). It's
      // suggested for the family without the number ("Univers 45 Light" for Univers).
      if (m.a.words.length && m.a.numbered && !anchors.length) {
        const wide = widen(m.a.base);
        held.set(m.raw, { into: wide.base, reason: "number", word: wide.word });
        continue;
      }
      // G1: the font names its own grouping family.
      if (f.typo) {
        held.set(m.raw, { into: display, reason: "ownName" });
        continue;
      }
      // G4: both name a foundry, and they differ.
      // What the other names say: a name's own PostScript name, foundry or designer is no signal.
      if (f.foundries.size && othersAny(foundries, f.foundries, inside) && !othersShareFoundry(foundries, f.foundries, inside, f.foundries)) {
        held.set(m.raw, { into: display, reason: "foundry" });
        continue;
      }
      const weightWord = m.a.words.find((w) => w.word.weight !== undefined)?.word.weight;
      const agrees =
        // A PostScript name whose family part is the key backs a name that had style words
        // taken off ("AbhayaLibre-ExtraBold" says Abhaya Libre). For a spelling of the name
        // itself it's its own name again, so only the other names' PostScript names count.
        (m.a.words.length > 0 && stemsOf(m).has(key)) ||
        othersShare((stems ??= countsOf(anchors, stemsOf)), stemsOf(m), isAnchor.has(m), stemsOf(m)) ||
        othersShareFoundry(foundries, f.foundries, inside, f.foundries) ||
        othersShare(designers, f.designers, inside, f.designers) ||
        (weightWord !== undefined && f.weights.some((w) => Math.abs(w - weightWord) <= 100));
      if (!agrees) {
        held.set(m.raw, { into: display, reason: "noSignal" });
        continue;
      }
      moving.push(m);
    }
    // With no family of that name yet, at least two names must come together to make one.
    if (!displayIsName && new Set(moving.map((m) => m.a.full)).size < 2) {
      for (const m of moving) held.set(m.raw, { into: display, reason: "alone" });
      return;
    }
    for (const m of moving) merges.set(m.raw, display);
  };

  // 1. Names that reduce to the same base.
  for (const [key, members] of groups) {
    if (!Array.isArray(members)) continue;
    const anchors = members.filter((m) => m.a.words.length === 0);
    if (anchors.length) {
      settle(key, members, anchors, bestSpelling(anchors.map((m) => [m.raw, m.faces])), true);
      continue;
    }
    // Two spellings of one name are one name here: the base must exist, or two different names
    // reduce to it.
    if (new Set(members.map((m) => m.a.full)).size < 2) continue;
    // With no family of that name, the family is what every name has in common: a style word
    // they all share is part of its name ("Times New Roman" and "Times New Roman Italic" are
    // Times New Roman, not "Times New"), and a name that's only that is the family.
    const common = sharedWords(members);
    if (common) {
      const named = members.map((m) => ({ ...m, a: keepingWords(m.a, common) }));
      const own = named.filter((m) => m.a.words.length === 0);
      if (own.length) settle(named[0].a.key, named, own, bestSpelling(own.map((m) => [m.raw, m.faces])), true);
      else settle(named[0].a.key, named, [], bestSpelling(named.map((m) => [m.a.base, m.faces])), false);
    } else settle(key, members, anchors, bestSpelling(members.map((m) => [m.a.base, m.faces])), false);
  }

  // 2. Names still on their own that differ only in spelling (only names whose key another
  // name has can).
  const spellings = new Map<string, NameInfo[]>();
  if (shared.size) {
    for (const info of infos) {
      if (!shared.has(info.a.full) || decided(info) || (rules?.size && rules.has(squash(info.raw)))) continue;
      const key = info.a.full;
      const list = spellings.get(key);
      if (list) list.push(info);
      else spellings.set(key, [info]);
    }
  }
  for (const [key, members] of spellings) {
    if (members.length < 2) continue;
    const display = bestSpelling(members.map((m) => [m.raw, m.faces]));
    // Compared as names of their own: their style words stay, so G2's numbers don't apply.
    const own = members.map((m) => ({ ...m, facts: factsOf(m), a: { ...m.a, words: [], base: m.a.clean } }));
    settle(key, own, own, display, true);
  }

  // 3. Copies' other names: a family as planned whose every style has a copy that carries a
  // name more of the library has goes by that name. A per-style folder's "House-A-Rama-Kingpin"
  // (style Regular) whose other copy is "House-A-Rama" (style Medium), like its siblings', is
  // House-A-Rama's Kingpin; Readout-OneBack and its Expert, both also "Readout", are Readout's.
  // A family only some of whose styles have such a copy stays whole (LTUnivers-Cond, whatever
  // the "LTUnivers" copies of half its styles say).
  if (differ.length) rehome(byName, differ, carry, merges, rules);
  return { merges, held };
}

/**
 * `planByName`'s step 3. `byName`: family name → its faces (your choices left out); `differ`:
 * the faces whose copies carry other names (`namesDiffer`), the only ones that can move;
 * `carry`: how many faces each name (by squash key) is grouped by.
 */
function rehome(
  byName: ReadonlyMap<string, FaceInput[]>,
  differ: readonly FaceInput[],
  carry: ReadonlyMap<string, number>,
  merges: ReadonlyMap<string, string>,
  rules?: ReadonlyMap<string, NameRule>,
) {
  // The families as planned whose every face is one of those: display name → its faces. One
  // with a face that isn't, or a name your rule decides, stays as it is.
  const moving = new Set(differ);
  const into = new Map<string, string[]>();
  for (const [raw, display] of merges) {
    const list = into.get(display);
    if (list) list.push(raw);
    else into.set(display, [raw]);
  }
  const families = new Map<string, FaceInput[] | null>();
  for (const face of differ) {
    const raw = namedOf(face).family;
    const display = merges.get(raw) ?? raw;
    if (families.has(display)) continue;
    const names = byName.has(display) ? [display, ...(into.get(display) ?? [])] : (into.get(display) ?? []);
    const ok = names.every((n) => !(rules?.size && rules.has(squash(n))) && byName.get(n)!.every((f) => moving.has(f)));
    families.set(display, ok ? names.flatMap((n) => byName.get(n)!) : null);
  }
  // The names every face of a family has a copy of (of the same family: `kin`), but its own.
  const otherNames = (face: FaceInput) => {
    const own = namedOf(face).family;
    const out = new Set<string>();
    for (const c of face.copies!) if (c.family !== own && kin(c.family, own)) out.add(squash(c.family));
    return out;
  };
  const candidates: [faces: FaceInput[], keys: Set<string>][] = [];
  const counts = new Map<string, number>();
  for (const [display, faces] of families) {
    if (!faces) continue;
    let keys = otherNames(faces[0]);
    for (let i = 1; i < faces.length && keys.size; i++) {
      const theirs = otherNames(faces[i]);
      keys = new Set([...keys].filter((k) => theirs.has(k)));
    }
    keys.delete(squash(display));
    if (!keys.size) continue;
    candidates.push([faces, keys]);
    for (const k of keys) counts.set(k, carry.get(k) ?? 0);
  }
  if (!candidates.length) return;
  // Faces that carry those names on a copy too.
  for (const face of differ) {
    const seen = new Set([squash(namedOf(face).family)]);
    for (const c of face.copies!) {
      const k = squash(c.family);
      const n = counts.get(k);
      if (n === undefined || seen.has(k)) continue;
      seen.add(k);
      counts.set(k, n + 1);
    }
  }
  for (const [faces, keys] of candidates) {
    // The name most faces carry, more than this family's own; then the better named.
    let key: string | undefined;
    let most = faces.length;
    let copy: NameFont | undefined;
    for (const k of keys) {
      const n = counts.get(k)!;
      const c = faces[0].copies!.find((x) => squash(x.family) === k)!;
      if (n > most || (n === most && key !== undefined && betterNamed(c, copy!) < 0)) [key, most, copy] = [k, n, c];
    }
    if (key === undefined) continue;
    for (const face of faces) {
      let best: NameFont | undefined;
      for (const c of face.copies!) if (squash(c.family) === key && (!best || betterNamed(c, best) < 0)) best = c;
      face.named = best;
    }
  }
}

/** Where a face goes: the fields library.ts's Face has by the same names. */
export interface Placement {
  family: string;
  style: string;
  groupedBy: GroupedBy;
  /** Your rule or choice keeps it under its own name, rather than moving it anywhere. */
  kept: boolean;
  /** The name key of the rule that placed it: its own family name's, or a copy's. */
  ruleKey?: string;
  /** The family name it was placed by: the name it's grouped by (`FaceInput.named`), the copy's
   *  whose name your rule is for, or for your choice to keep it, the primary's. The Info tab's
   *  and Family groups page's "from" text, and the name a merge writes a rule for. */
  name: string;
}

/** `placeFace`'s last lookup of a name's merge (faces come name by name). */
let lastMerges: ReadonlyMap<string, string> | undefined;
let lastRaw: string | undefined;
let lastInto: string | undefined;

/**
 * Where one face goes (precedence 1 to 4, above). It's grouped by its named copy's family name
 * (`FaceInput.named`). Your rule for a name applies to a face when any of its copies carries that
 * name (the named copy's first, then the primary's), so it holds whichever copy is shown. A
 * "keep separate" rule lists every spelling of the name under the one you chose it for
 * ("MetaCond LF" with "Meta Cond LF"). The style label always comes from the copy whose names
 * say it best (`labelFor`), whichever copy's name placed it. `out`: an object to fill in and
 * return, rather than a new one (library.ts passes the face itself).
 */
export function placeFace(face: FaceInput, plan: GroupPlan, options: GroupingOptions, out?: Placement): Placement {
  const raw = (face.named ?? face.primary).family;
  const choice = options.choices?.size ? options.choices.get(face.key) : undefined;
  if (choice) {
    // Keeping it under its own name: the shown copy's own, the most particular one it has.
    const own = face.primary.family;
    if (choice.family === null || choice.family === own) return placed(out, own, choice.style ?? face.primary.subfamily, "choice", own, true);
    return placed(out, choice.family, choice.style ?? labelFor(face, choice.family), "choice", raw);
  }
  const rules = options.rules;
  if (rules?.size) {
    let ruleKey = squash(raw);
    let rule = rules.get(ruleKey);
    let name = raw;
    if (!rule && face.copies)
      for (const copy of face.copies) {
        if (copy.family === raw) continue;
        const k = squash(copy.family);
        const r = rules.get(k);
        if (!r) continue;
        [rule, ruleKey, name] = [r, k, copy.family];
        break;
      }
    if (rule) {
      const family = rule.decision === "separate" || !rule.into ? rule.name : rule.into;
      return placed(out, family, labelFor(face, family), "rule", name, squash(family) === ruleKey, ruleKey);
    }
  }
  let into: string | undefined;
  if (options.byName) {
    // The last face's answer, without a lookup.
    if (lastMerges === plan.merges && lastRaw === raw) into = lastInto;
    else [lastMerges, lastRaw, lastInto] = [plan.merges, raw, (into = plan.merges.get(raw))];
  }
  if (into) return placed(out, into, labelFor(face, into), "name", raw);
  // Under its own name, with copies named alike (nearly every face): its own style.
  return placed(out, raw, face.varied === false || !face.copies || face.copies.length < 2 ? face.primary.subfamily : labelFor(face, raw), "own", raw);
}

/** A placement, in `out` when given (`groupLibrary` writes it straight into each face). */
function placed(out: Placement | undefined, family: string, style: string, groupedBy: GroupedBy, name: string, kept = false, ruleKey?: string): Placement {
  if (!out) return { family, style, groupedBy, kept, ruleKey, name };
  out.family = family;
  out.style = style;
  out.groupedBy = groupedBy;
  out.kept = kept;
  out.ruleKey = ruleKey;
  out.name = name;
  return out;
}

// ----------------------------------------------------------------------------- suggestions

/** A family grouping as it stands, for suggestions (library.ts's Family). */
export interface FamilyLike {
  id: string;
  name: string;
  faces: readonly { key: string; style: string; groupedBy: GroupedBy; primary: Pick<FontSummary, "family" | "weight" | "variable" | "postscriptName"> }[];
}

/** Why a family is only suggested: a held name's reason, a width, size or number word, or
 *  (with "Group families by name" off) one grouping by name would merge. */
export type SuggestReason = HoldReason | "width" | "optical" | "strong";

export interface SuggestionSource<F extends FamilyLike = FamilyLike> {
  family: F;
  reason: SuggestReason;
  /** The width, size or number word ("Narrow", "Display", "45"). */
  word?: string;
}

export interface Suggestion<F extends FamilyLike = FamilyLike> {
  /** The squash key of the family they'd join: stable while the library is the same. */
  id: string;
  /** The family they'd join. */
  into: string;
  /** It's in the library now (else merging makes it). */
  existing?: F;
  sources: SuggestionSource<F>[];
  /** Styles in the family after merging. */
  styles: number;
}

/**
 * Families that could join another family, for the Family groups page: names grouping by name
 * holds back (G1, G2's numbers, G4, no signal), names with width or size words ("Arial Narrow"
 * into Arial, "FarnhamDisplay" and "FarnhamText" into Farnham), and with "Group families by
 * name" off, the ones it would merge. One suggestion per family to join; a family is in one at
 * most. A name you chose to keep separate isn't suggested (G5), and nor is a family made only of
 * your own choices.
 */
export function suggestGroups<F extends FamilyLike>(families: readonly F[], plan: GroupPlan, options: GroupingOptions): Suggestion<F>[] {
  const byName = new Map(families.map((f) => [f.name, f]));
  const byKey = new Map<string, F>();
  for (const f of families) {
    const k = squash(f.name);
    const there = byKey.get(k);
    if (!there || f.faces.length > there.faces.length) byKey.set(k, f);
  }
  const kept = (name: string) => options.rules?.get(squash(name))?.decision === "separate";
  const yours = (f: F) => f.faces.every((face) => face.groupedBy === "choice");
  const out = new Map<string, { into: string; sources: SuggestionSource<F>[] }>();
  const used = new Set<string>();
  const add = (into: string, family: F, reason: SuggestReason, word?: string) => {
    const id = squash(into);
    if (used.has(family.id) || squash(family.name) === id || yours(family)) return;
    used.add(family.id);
    const s = out.get(id);
    if (s) s.sources.push({ family, reason, word });
    else out.set(id, { into, sources: [{ family, reason, word }] });
  };
  for (const [raw, h] of plan.held) {
    const family = byName.get(raw);
    if (family && !kept(raw)) add(h.into, family, h.reason, h.word);
  }
  if (!options.byName)
    for (const [raw, into] of plan.merges) {
      const family = byName.get(raw);
      if (family) add(into, family, "strong");
    }
  // Width, size and number words: into the longest name left that's a family, or one others
  // are suggested into ("Times New Roman Condensed" into Times New Roman, not "Times New").
  // Otherwise names that reduce to the same name make it, with the style words they all share
  // that are part of its name (`partOfName`).
  const wider = new Map<string, { list: { family: F; a: WideName }[] }>();
  for (const family of families) {
    if (used.has(family.id) || kept(family.name)) continue;
    const a = widen(analyzeName(family.name).base);
    if (!a.kind) continue;
    const own = squash(family.name);
    let key: string | undefined;
    for (const step of a.steps)
      if (step.key !== own && (byKey.has(step.key) || out.has(step.key)) && letters(step.base) >= 3) {
        key = step.key;
        break;
      }
    if (key === undefined) {
      if (a.key === own || letters(a.base) < 3) continue;
      key = a.key;
    }
    const w = wider.get(key);
    if (w) w.list.push({ family, a });
    else wider.set(key, { list: [{ family, a }] });
  }
  for (const [key, w] of wider) {
    const target = byKey.get(key);
    const pending = out.get(key);
    let into = target?.name ?? pending?.into;
    if (into === undefined) {
      if (new Set(w.list.map((x) => squash(x.family.name))).size < 2) continue;
      // Every name reduces to `key` (each one's last step). Words they all share go back on
      // while they're part of the name.
      const at = (x: { a: WideName }, up: number) => x.a.steps[x.a.steps.length - 1 - up];
      let up = 0;
      for (;;) {
        const here = at(w.list[0], up);
        const above = at(w.list[0], up + 1);
        if (!above || !here.word || !w.list.every((x) => at(x, up + 1)?.key === above.key)) break;
        if (!partOfName(here.word, above.key, w.list.map((x) => x.family.faces.map((f) => f.primary)))) break;
        up++;
      }
      into = bestSpelling(w.list.map((x) => [at(x, up).base, x.family.faces.length]));
    }
    for (const { family, a } of w.list) add(into, family, a.kind!, a.word);
  }
  // A family that others would join, and that would join another family itself, takes them
  // along: "Neutra Text TF" into Neutra Text, and Neutra Text into Neutra, is one suggestion,
  // all into Neutra (so "Merge all" leaves no Neutra Text behind). Never round in a circle.
  const sourceOf = new Map<string, string>();
  for (const [id, s] of out) for (const src of s.sources) sourceOf.set(src.family.id, id);
  const finalOf = (id: string): string => {
    const seen = new Set([id]);
    for (let at = id; ; ) {
      const target = byKey.get(at);
      const next = target ? sourceOf.get(target.id) : undefined;
      if (!next) return at;
      if (seen.has(next)) return id;
      seen.add(next);
      at = next;
    }
  };
  for (const id of [...out.keys()]) {
    const to = finalOf(id);
    if (to === id) continue;
    out.get(to)!.sources.push(...out.get(id)!.sources);
    out.delete(id);
  }
  const suggestions: Suggestion<F>[] = [];
  for (const [id, s] of out) {
    const existing = byKey.get(id);
    const sources = s.sources.filter((src) => src.family !== existing);
    if (!sources.length) continue;
    sources.sort((a, b) => compareNames(a.family.name, b.family.name));
    const styles = (existing?.faces.length ?? 0) + sources.reduce((n, src) => n + src.family.faces.length, 0);
    suggestions.push({ id, into: existing?.name ?? s.into, existing, sources, styles });
  }
  return suggestions.sort((a, b) => compareNames(a.into, b.into));
}

/** A suggestion's sentence: "Merge 3 families into Abhaya Libre (5 styles)". */
export function suggestionText(s: Pick<Suggestion, "into" | "sources" | "styles">, count = s.sources.length): string {
  const what = count === 1 ? `“${s.sources[0]?.family.name ?? ""}”` : `${count.toLocaleString()} families`;
  return `Merge ${what} into ${s.into} (${s.styles.toLocaleString()} ${s.styles === 1 ? "style" : "styles"})`;
}

/** Why a family is only suggested, in words. */
export function reasonText(source: Pick<SuggestionSource, "reason" | "word">): string {
  switch (source.reason) {
    case "ownName":
      return "The font names its own family";
    case "number":
      return "Numbered style";
    case "foundry":
      return "Different foundry";
    case "noSignal":
      return "Only the names match";
    case "alone":
      return "No other name joins it";
    case "width":
      return source.word ? `Width word “${source.word}”` : "Width word";
    case "optical":
      return source.word ? `Size word “${source.word}”` : "Size word";
    case "strong":
      return "Grouped when “Group families by name” is on";
  }
}
