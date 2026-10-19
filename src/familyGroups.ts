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
  /** Never the word right after the family part: "SC" there means Simplified Chinese (Noto Sans SC). */
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
const isDigit = (c: string | undefined) => !!c && c >= "0" && c <= "9";
const isSeparator = (c: string | undefined) => c === " " || c === "-" || c === "_" || c === "\t" || c === "\u00a0";
const SEPARATOR = /[\s\-_]/;

/**
 * A word may be taken off only where a word starts: after a space, hyphen or underscore, at a
 * lowercase-to-uppercase step ("AmintaBold"), after a digit ("Univers45Light"), or where an
 * all-capitals run gives way to a capitalized word ("MKSDMedium"). `atStart`: the very start
 * counts too (reading a style name; a family name always keeps something).
 */
function startsWord(s: string, at: number, atStart: boolean): boolean {
  if (at === 0) return atStart;
  const prev = s[at - 1];
  const first = s[at];
  if (isSeparator(prev)) return true;
  if (!isUpper(first)) return false;
  return isLower(prev) || isDigit(prev) || (isUpper(prev) && isLower(s[at + 1]));
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
  const lastSeparator = Math.max(s.lastIndexOf(" "), s.lastIndexOf("-"), s.lastIndexOf("_"));
  // No word is longer than the longest spelling, give or take a separator or two inside it.
  for (let start = Math.max(atStart ? 0 : 1, s.length - LONGEST_FORM - 2); start < s.length; start++) {
    if (isSeparator(s[start]) || !startsWord(s, start, atStart)) continue;
    const text = s.slice(start);
    const lower = text.toLowerCase();
    const word = BY_FORM.get(start > lastSeparator ? lower : lower.replace(/[ _-]/g, ""));
    if (!word || !inSet(word, set)) continue;
    // An abbreviation in capitals is an acronym: "LT" (Linotype), not Light.
    if (word.abbrev && text.length > 1 && text === text.toUpperCase()) continue;
    return { word, start };
  }
  return null;
}

const trimEnd = (s: string) => s.replace(/[\s\-_]+$/, "");
const trimStart = (s: string) => s.replace(/^[\s\-_]+/, "");

/** Where a number at the end starts, if it's a word of its own ("Univers 45"; not "X01"). */
const TRAILING_NUMBER = /(\d+)$/;
function numberAtEnd(s: string): number | null {
  const m = TRAILING_NUMBER.exec(s);
  if (!m || m.index === 0) return null;
  return isSeparator(s[m.index - 1]) ? m.index : null;
}

/** Names compared this way match: lowercase, without spaces, hyphens, underscores, dots, ™ and ®. */
export function squash(name: string): string {
  return name.toLowerCase().replace(/[\s\-_.™®]/g, "");
}

/** A family name without ™ and ®, trimmed. */
const clean = (name: string) => name.replace(/[™®]/g, "").trim();

const letters = (s: string) => (s.match(/\p{L}/gu) ?? []).length;

// ------------------------------------------------------------------------------- analysis

export interface Removed {
  word: Word;
  /** The words as the name spells them. */
  text: string;
}

/** What a family name says about itself. */
export interface NameAnalysis {
  /** The name without ™ and ®. */
  clean: string;
  /** What's left after taking off the style words that can merge. */
  base: string;
  key: string;
  /** Those words, in the name's order. Empty: the name is a family name as it stands. */
  words: Removed[];
  /** Some of them are abbreviations. */
  abbrev: boolean;
  /** What's left ends in a number ("Univers 45"): a numbered style, only ever suggested. */
  numbered: boolean;
}

/** A name's base with width, size and number words taken off too ("Arial Narrow" → "Arial"),
 *  for suggestions. */
export interface WideName {
  base: string;
  key: string;
  /** The first width, size or number word that went ("Narrow", "Display", "45"); none if none did. */
  word?: string;
  kind?: "width" | "optical" | "number";
}

const analyses = new Map<string, NameAnalysis>();

/** Reads a family name (cached: the library has a few thousand). `abbrev`: abbreviations count. */
export function analyzeName(name: string, abbrev = true): NameAnalysis {
  const cacheKey = `${abbrev ? "a" : "w"}${name}`;
  const known = analyses.get(cacheKey);
  if (known) return known;
  const c = clean(name);
  const words: (Removed & { start: number })[] = [];
  let rest = trimEnd(c);
  for (;;) {
    const found = wordAtEnd(rest, abbrev ? "mergeAbbrev" : "merge", false);
    if (!found) break;
    words.unshift({ word: found.word, text: rest.slice(found.start), start: found.start });
    rest = trimEnd(rest.slice(0, found.start));
  }
  // "SC" right after the family part names a script (Noto Sans SC), not small capitals.
  while (words.length && words[0].word.notInnermost) {
    words.shift();
    rest = trimEnd(c.slice(0, words.length ? words[0].start : c.length));
  }
  const analysis: NameAnalysis = {
    clean: c,
    base: rest,
    key: squash(rest),
    words: words.map(({ word, text }) => ({ word, text: text.trim() })),
    abbrev: words.some((w) => w.word.abbrev),
    numbered: numberAtEnd(rest) !== null,
  };
  analyses.set(cacheKey, analysis);
  return analysis;
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
  for (;;) {
    const found = wordAtEnd(rest, "every", false);
    const number = numberAtEnd(rest);
    if (found && !found.word.notInnermost && (number === null || found.start > number)) {
      if (found.word.kind === "width" || found.word.kind === "optical") {
        word = found.word.canon;
        kind = found.word.kind;
      }
      rest = trimEnd(rest.slice(0, found.start));
    } else if (number !== null) {
      word = rest.slice(number);
      kind = "number";
      rest = trimEnd(rest.slice(0, number));
    } else break;
  }
  const out: WideName = kind ? { base: rest, key: squash(rest), word, kind } : { base, key: squash(base) };
  wides.set(base, out);
  return out;
}

const stems = new Map<string, string[]>();

/**
 * The family part of a PostScript name, as squash keys: the part before the first "-", and the
 * whole name, each with style words taken off its end ("AbhayaLibre-ExtraBold" → "abhayalibre";
 * "AauxProBold" → "aauxpro"; "Beekman-SquareBold" → "beekman" and "beekmansquare"). Empty
 * without a name.
 */
export function postscriptStems(ps: string | null | undefined): readonly string[] {
  if (!ps) return [];
  const known = stems.get(ps);
  if (known) return known;
  const prefix = analyzeName(ps.split("-")[0]).key;
  const whole = analyzeName(ps).key;
  const out = prefix === whole ? [prefix] : [prefix, whole];
  stems.set(ps, out);
  return out;
}

/** Words that say nothing about which foundry it is. */
const FOUNDRY_NOISE = new Set([
  "the", "inc", "incorporated", "corporation", "corp", "co", "company", "ltd", "limited", "llc", "gmbh", "ag", "sa", "bv", "srl",
  "systems", "type", "typography", "foundry", "fonts", "font", "design", "studio", "studios", "imaging", "library", "by", "and",
]);

/** A foundry (name ID 8) as one word to compare: "The Monotype Corporation" and "Monotype
 *  Typography, Inc." are both "monotype". Undefined when the font doesn't say. */
export function foundryKey(manufacturer: string | null | undefined): string | undefined {
  if (!manufacturer) return undefined;
  if (foundryKeys.has(manufacturer)) return foundryKeys.get(manufacturer);
  let key: string | undefined;
  for (const word of manufacturer.toLowerCase().split(/[^\p{L}\p{N}]+/u))
    if (word && !FOUNDRY_NOISE.has(word)) {
      key = word;
      break;
    }
  foundryKeys.set(manufacturer, key);
  return key;
}
const foundryKeys = new Map<string, string | undefined>();

// --------------------------------------------------------------------------- style labels

/** The words of a style name, read from its end: the words it knows, then whatever's left. */
function styleWords(style: string): { words: Word[]; rest: string } {
  const words: Word[] = [];
  let rest = trimEnd(style.trim());
  for (;;) {
    const found = wordAtEnd(rest, "every", true);
    if (!found) break;
    words.unshift(found.word);
    rest = trimEnd(rest.slice(0, found.start));
  }
  return { words, rest };
}

/** Text split where words start (separators, case steps), for the part of a name no word list knows. */
function tokens(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || SEPARATOR.test(text[i]) || startsWord(text, i, false)) {
      const token = text.slice(at, i).replace(/[\s\-_]/g, "");
      if (token) out.push(token);
      at = i;
    }
  }
  return out;
}

/** What's left of `raw` after `family`, ignoring case, spaces, hyphens, underscores, dots, ™
 *  and ®, or null if `raw` doesn't start with it ("AauxPro-BlackOSF" after "Aaux Pro" is "-BlackOSF"). */
export function leftover(raw: string, family: string): string | null {
  const skip = /[\s\-_.™®]/;
  let i = 0;
  for (const ch of family.toLowerCase()) {
    if (skip.test(ch)) continue;
    while (i < raw.length && skip.test(raw[i])) i++;
    if (i >= raw.length || raw[i].toLowerCase() !== ch) return null;
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
 */
export function styleLabel(raw: string, own: string, family: string): string {
  if (raw === family) return own;
  const cacheKey = `${raw}\u0000${own}\u0000${family}`;
  const known = labels.get(cacheKey);
  if (known !== undefined) return known;
  const after = leftover(clean(raw), family);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (word: string) => {
    const k = word.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(word);
  };
  if (after === null) add(clean(raw));
  else {
    const { words, rest } = styleWords(trimStart(after));
    for (const t of tokens(rest)) add(t);
    for (const w of words) add(w.canon);
  }
  if (!PLAIN.has(own.trim().toLowerCase())) {
    const { words, rest } = styleWords(own);
    if (rest) add(own.trim());
    else for (const w of words) add(w.canon);
  }
  const label = out.join(" ") || own.trim() || "Regular";
  labels.set(cacheKey, label);
  return label;
}

/** Weight, width and slope for sorting a family's styles. */
export interface Traits {
  weight: number;
  width: number;
  italic: boolean;
}

const traitWords = new Map<string, { weight?: number; width?: number; slope: boolean }>();

/**
 * What a style says about itself, where the font's own numbers disagree (1,583 of Sean's faces
 * say weight 400 whatever their name, and 406 italics aren't flagged): a weight word 100 or more
 * from the stored weight wins (a variable font keeps its default), a width word wins over the
 * normal width, and Italic or Oblique counts as italic.
 */
export function traitsOf(label: string, font: Pick<FontSummary, "weight" | "width" | "italic" | "variable">): Traits {
  let said = traitWords.get(label);
  if (!said) {
    const { words } = styleWords(label);
    said = {
      weight: words.find((w) => w.weight !== undefined)?.weight,
      width: words.find((w) => w.width !== undefined)?.width,
      slope: words.some((w) => w.kind === "slope"),
    };
    traitWords.set(label, said);
  }
  return {
    weight: said.weight !== undefined && !font.variable && Math.abs(said.weight - font.weight) >= 100 ? said.weight : font.weight,
    width: said.width !== undefined && font.width === 5 ? said.width : font.width,
    italic: font.italic || said.slope,
  };
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

/** What the rules need to know about a face. */
export interface FaceInput {
  key: string;
  primary: Pick<FontSummary, "family" | "subfamily" | "postscriptName" | "weight" | "width" | "italic" | "variable" | "manufacturer" | "designer" | "hasTypoFamily">;
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
}

interface NameFacts {
  stems: Set<string>;
  foundries: Set<string>;
  designers: Set<string>;
  weights: number[];
  typo: boolean;
}

/** What a name's faces say: their PostScript stems, foundries, designers, weights, name 16. */
function factsOf(info: NameInfo): NameFacts {
  if (info.facts) return info.facts;
  const facts: NameFacts = { stems: new Set(), foundries: new Set(), designers: new Set(), weights: [], typo: false };
  for (const { primary: f } of info.list) {
    for (const stem of postscriptStems(f.postscriptName)) facts.stems.add(stem);
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

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** The spelling a group shows: one with spaces ("Big Caslon" over "BigCaslon"), then the one
 *  most faces use, then A to Z. */
function bestSpelling(candidates: [spelling: string, faces: number][]): string {
  const totals = new Map<string, number>();
  for (const [s, n] of candidates) totals.set(s, (totals.get(s) ?? 0) + n);
  return [...totals].sort(([a, n], [b, m]) => Number(/\s/.test(b)) - Number(/\s/.test(a)) || m - n || collator.compare(a, b))[0][0];
}

const intersects = (a: ReadonlySet<string>, b: ReadonlyMap<string, number>) => {
  for (const x of a) if ((b.get(x) ?? 0) > 0) return true;
  return false;
};

/** Counts of each value over some names, less one name's own (`except`). */
function countsOf(names: readonly NameInfo[], pick: (n: NameFacts) => Set<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of names) for (const v of pick(factsOf(n))) out.set(v, (out.get(v) ?? 0) + 1);
  return out;
}
function without(counts: Map<string, number>, own: Set<string>, inside: boolean): Map<string, number> {
  if (!inside || !own.size) return counts;
  const out = new Map(counts);
  for (const v of own) out.set(v, (out.get(v) ?? 1) - 1);
  return out;
}

/**
 * What grouping by name does with each family name in the library (rule 3): which names merge
 * into which family, and which could but are held back (for suggestions). Rules you made take
 * their names out (G5, or the rule decides). Works on names, so it runs once per name, not per
 * face; a name's faces all go the same way.
 *
 * Two passes: names that reduce to the same base once style words are off, then names left on
 * their own that differ only in spelling ("Times New Roman" / "TimesNewRoman").
 */
export function planByName(faces: readonly FaceInput[], rules?: ReadonlyMap<string, NameRule>): GroupPlan {
  const byName = new Map<string, FaceInput[]>();
  for (const face of faces) {
    const list = byName.get(face.primary.family);
    if (list) list.push(face);
    else byName.set(face.primary.family, [face]);
  }
  const infos: NameInfo[] = [];
  for (const [raw, list] of byName) {
    let a = analyzeName(raw, true);
    // Abbreviations count only when the PostScript name agrees.
    if (a.abbrev && !list.some((f) => postscriptStems(f.primary.postscriptName).includes(a.key))) a = analyzeName(raw, false);
    infos.push({ raw, a, faces: list.length, list });
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
    const anchorStems = new Set(anchors.flatMap((m) => [...factsOf(m).stems]));
    const foundries = countsOf(context, (m) => m.foundries);
    const designers = countsOf(context, (m) => m.designers);
    const moving: NameInfo[] = [];
    for (const m of members) {
      if (m.raw === display || rules?.has(squash(m.raw))) continue; // already it; or G5, or your rule decides
      // G3: too little left to be a family name.
      if (letters(m.a.words.length ? m.a.base : m.a.clean) < 3) continue;
      const inside = context.includes(m);
      const f = factsOf(m);
      const theirFoundries = without(foundries, f.foundries, inside);
      const theirDesigners = without(designers, f.designers, inside);
      const hold = (reason: HoldReason) => held.set(m.raw, { into: display, reason });
      // G2: a numbered style, unless what's left is a family that exists ("Bodoni 72"). It's
      // suggested for the family without the number ("Univers 45 Light" for Univers).
      if (m.a.words.length && m.a.numbered && !anchors.length) {
        const wide = widen(m.a.base);
        held.set(m.raw, { into: wide.base, reason: "number", word: wide.word });
        continue;
      }
      // G1: the font names its own grouping family.
      if (f.typo) {
        hold("ownName");
        continue;
      }
      // G4: both name a foundry, and they differ.
      if (f.foundries.size && [...theirFoundries.values()].some((n) => n > 0) && !intersects(f.foundries, theirFoundries)) {
        hold("foundry");
        continue;
      }
      const weightWord = m.a.words.find((w) => w.word.weight !== undefined)?.word.weight;
      const agrees =
        [...f.stems].some((s) => s === key || anchorStems.has(s)) ||
        intersects(f.foundries, theirFoundries) ||
        intersects(f.designers, theirDesigners) ||
        (weightWord !== undefined && f.weights.some((w) => Math.abs(w - weightWord) <= 100));
      if (!agrees) {
        hold("noSignal");
        continue;
      }
      moving.push(m);
    }
    // With no family of that name yet, at least two names must come together to make one.
    if (!displayIsName && new Set(moving.map((m) => squash(m.a.clean))).size < 2) {
      for (const m of moving) held.set(m.raw, { into: display, reason: "alone" });
      return;
    }
    for (const m of moving) merges.set(m.raw, display);
  };

  // 1. Names that reduce to the same base.
  const groups = new Map<string, NameInfo[]>();
  for (const info of infos) {
    const key = info.a.words.length ? info.a.key : squash(info.a.clean);
    const group = groups.get(key);
    if (group) group.push(info);
    else groups.set(key, [info]);
  }
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const anchors = members.filter((m) => m.a.words.length === 0);
    // Two spellings of one name are one name here: the base must exist, or two different names
    // reduce to it.
    if (!anchors.length && new Set(members.map((m) => squash(m.a.clean))).size < 2) continue;
    if (anchors.length) settle(key, members, anchors, bestSpelling(anchors.map((m) => [m.raw, m.faces])), true);
    else settle(key, members, anchors, bestSpelling(members.map((m) => [m.a.base, m.faces])), false);
  }

  // 2. Names still on their own that differ only in spelling.
  const spellings = new Map<string, NameInfo[]>();
  for (const info of infos) {
    if (decided(info) || rules?.has(squash(info.raw))) continue;
    const key = squash(info.a.clean);
    const list = spellings.get(key);
    if (list) list.push(info);
    else spellings.set(key, [info]);
  }
  for (const [key, members] of spellings) {
    if (members.length < 2) continue;
    const display = bestSpelling(members.map((m) => [m.raw, m.faces]));
    // Compared as names of their own: their style words stay, so G2's numbers don't apply.
    const own = members.map((m) => ({ ...m, facts: factsOf(m), a: { ...m.a, words: [], base: m.a.clean } }));
    settle(key, own, own, display, true);
  }
  return { merges, held };
}

export interface Placement {
  family: string;
  style: string;
  by: GroupedBy;
}

/** Where one face goes (precedence 1 to 4, above). */
export function placeFace(face: FaceInput, plan: GroupPlan, options: GroupingOptions): Placement {
  const raw = face.primary.family;
  const own = face.primary.subfamily;
  const choice = options.choices?.get(face.key);
  if (choice) {
    if (choice.family === null || choice.family === raw) return { family: raw, style: choice.style ?? own, by: "choice" };
    return { family: choice.family, style: choice.style ?? styleLabel(raw, own, choice.family), by: "choice" };
  }
  const rule = options.rules?.get(squash(raw));
  if (rule) {
    if (rule.decision === "separate" || !rule.into || rule.into === raw) return { family: raw, style: own, by: "rule" };
    return { family: rule.into, style: styleLabel(raw, own, rule.into), by: "rule" };
  }
  const into = options.byName ? plan.merges.get(raw) : undefined;
  if (into) return { family: into, style: styleLabel(raw, own, into), by: "name" };
  return { family: raw, style: own, by: "own" };
}

// ----------------------------------------------------------------------------- suggestions

/** A family grouping as it stands, for suggestions (library.ts's Family). */
export interface FamilyLike {
  id: string;
  name: string;
  faces: readonly { key: string; style: string; groupedBy: GroupedBy; primary: Pick<FontSummary, "family"> }[];
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
  // Width, size and number words.
  const wider = new Map<string, { spellings: [string, number][]; list: { family: F; a: WideName }[] }>();
  for (const family of families) {
    if (used.has(family.id) || kept(family.name)) continue;
    const a = widen(analyzeName(family.name).base);
    if (!a.kind || a.key === squash(family.name) || letters(a.base) < 3) continue;
    const w = wider.get(a.key);
    if (w) {
      w.spellings.push([a.base, family.faces.length]);
      w.list.push({ family, a });
    } else wider.set(a.key, { spellings: [[a.base, family.faces.length]], list: [{ family, a }] });
  }
  for (const [key, w] of wider) {
    const target = byKey.get(key);
    const pending = out.get(key);
    if (!target && !pending && new Set(w.list.map((x) => squash(x.family.name))).size < 2) continue;
    const into = target?.name ?? pending?.into ?? bestSpelling(w.spellings);
    for (const { family, a } of w.list) add(into, family, a.kind!, a.word);
  }
  const suggestions: Suggestion<F>[] = [];
  for (const [id, s] of out) {
    const existing = byKey.get(id);
    const sources = s.sources.filter((src) => src.family !== existing);
    if (!sources.length) continue;
    sources.sort((a, b) => collator.compare(a.family.name, b.family.name));
    const styles = (existing?.faces.length ?? 0) + sources.reduce((n, src) => n + src.family.faces.length, 0);
    suggestions.push({ id, into: existing?.name ?? s.into, existing, sources, styles });
  }
  return suggestions.sort((a, b) => collator.compare(a.into, b.into));
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
