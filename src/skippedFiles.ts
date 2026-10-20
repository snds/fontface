import type { SkippedFiles } from "./api.ts";

/**
 * How Fontface words the files a scan found but didn't add (`SkippedFiles`, counted by the
 * scanner): the one line a finished scan shows ("Skipped 1,104 Type 1 fonts and 37 WOFF files
 * that Fontface can't use yet"), and the list Show Skipped Files… opens, with why each kind is
 * left out. Pure (no React, no DOM), so `npm run test:ui` covers it.
 */

export type SkippedKind = keyof SkippedFiles;

interface KindWords {
  one: string;
  many: string;
  /** Why it's left out, in plain words. */
  why: string;
}

const WEB_FONTS = "Fontface can't list web fonts yet.";

/** Each kind's name, for one file and for several, and why Fontface leaves it out. */
export const SKIPPED_WORDS: Record<SkippedKind, KindWords> = {
  type1: {
    one: "Type 1 font",
    many: "Type 1 fonts",
    why: "PostScript Type 1, an older format that macOS and most apps no longer support. Fontface can't read it yet.",
  },
  type1Metrics: {
    one: "Type 1 metrics file",
    many: "Type 1 metrics files",
    why: "Spacing files (.pfm, .afm, .inf) that come with Type 1 fonts. They aren't fonts on their own.",
  },
  woff: { one: "WOFF file", many: "WOFF files", why: `A web font, packed for websites. ${WEB_FONTS}` },
  woff2: { one: "WOFF2 file", many: "WOFF2 files", why: `A newer, smaller kind of web font. ${WEB_FONTS}` },
  dfont: { one: ".dfont file", many: ".dfont files", why: "An older Mac format that keeps several fonts in one file. Fontface can't read it yet." },
  eot: { one: "EOT file", many: "EOT files", why: "An old web font format made for Internet Explorer. Mac apps can't use it." },
  windowsBitmap: {
    one: "Windows bitmap font",
    many: "Windows bitmap fonts",
    why: "Old Windows screen fonts (.fon, .fnt), drawn in pixels at a few fixed sizes. Mac apps can't use them.",
  },
  suitcase: {
    one: "old Mac suitcase",
    many: "old Mac suitcases",
    why: "Classic Mac font files that keep their fonts in a hidden part of the file. Fontface doesn't open those yet.",
  },
  noExtension: {
    one: "font with no file extension",
    many: "fonts with no file extension",
    why: "TrueType or OpenType fonts whose names don't end in .ttf or .otf. Add the ending to a file's name, then rescan, to list it.",
  },
  unreadable: {
    one: "file that couldn't be read",
    many: "files that couldn't be read",
    why: "Damaged files, files that aren't really fonts, or files Fontface couldn't open. Fontface tries again when a file changes.",
  },
};

/** The order kinds are listed in when their counts tie: fonts first, then the files that only
 *  come with fonts, then the ones that couldn't be read. */
const ORDER: readonly SkippedKind[] = ["type1", "woff", "woff2", "dfont", "suitcase", "noExtension", "eot", "windowsBitmap", "type1Metrics", "unreadable"];

/** Listed after the fonts whatever their counts, in this order: they're not fonts themselves. */
const rank = (kind: SkippedKind) => (kind === "type1Metrics" ? 1 : kind === "unreadable" ? 2 : 0);

const n = (v: number) => v.toLocaleString();

/** "1 Type 1 font", "1,104 Type 1 fonts". */
export function countOf(kind: SkippedKind, count: number): string {
  const words = SKIPPED_WORDS[kind];
  return `${n(count)} ${count === 1 ? words.one : words.many}`;
}

export interface SkippedEntry {
  kind: SkippedKind;
  count: number;
  /** Its name, capitalised, for one file or several: "Old Mac suitcases". */
  title: string;
  why: string;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The kinds with any files: fonts first, most files first, then Type 1 metrics files and the
 * files that couldn't be read. `unreadable: false` leaves those last ones out (a scan's warning
 * already says how many couldn't be read).
 */
export function skippedEntries(skipped: SkippedFiles | null | undefined, { unreadable = true } = {}): SkippedEntry[] {
  if (!skipped) return [];
  return ORDER.filter((kind) => (skipped[kind] ?? 0) > 0 && (unreadable || kind !== "unreadable"))
    .map((kind) => {
      const count = skipped[kind];
      const words = SKIPPED_WORDS[kind];
      return { kind, count, title: capital(count === 1 ? words.one : words.many), why: words.why };
    })
    .sort((a, b) => rank(a.kind) - rank(b.kind) || b.count - a.count || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

/** How many files in all (with the ones that couldn't be read, unless `unreadable: false`). */
export function skippedTotal(skipped: SkippedFiles | null | undefined, opts: { unreadable?: boolean } = {}): number {
  return skippedEntries(skipped, opts).reduce((sum, e) => sum + e.count, 0);
}

/** "a", "a and b", "a, b and c". */
function list(parts: readonly string[]): string {
  return parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Kinds named in the line; with more, the first two and "N other files". */
const NAMED = 3;

/**
 * The one line a finished scan shows: "Skipped 1,104 Type 1 fonts, 37 WOFF files and 12 old
 * Mac suitcases that Fontface can't use yet". Up to three kinds by name, most first; with more,
 * the first two and how many other files. Type 1 metrics files go with Type 1 fonts and aren't
 * fonts themselves, so the line names them only when there's nothing else (the full list has
 * them). With `unreadable`, the files that couldn't be read get a sentence of their own ("3
 * files couldn't be read."). Null when there's nothing to say.
 */
export function skippedSummary(skipped: SkippedFiles | null | undefined, { unreadable = false } = {}): string | null {
  const all = skippedEntries(skipped, { unreadable: false });
  const fonts = all.filter((e) => e.kind !== "type1Metrics");
  const formats = fonts.length ? fonts : all;
  const failed = unreadable ? (skipped?.unreadable ?? 0) : 0;
  const named = formats.length > NAMED ? formats.slice(0, NAMED - 1) : formats;
  const others = formats.slice(named.length).reduce((sum, e) => sum + e.count, 0);
  const parts = named.map((e) => countOf(e.kind, e.count));
  if (others > 0) parts.push(`${n(others)} other ${others === 1 ? "file" : "files"}`);
  const sentences: string[] = [];
  if (parts.length) sentences.push(`Skipped ${list(parts)} that Fontface can't use yet`);
  if (failed > 0) sentences.push(`${n(failed)} ${failed === 1 ? "file" : "files"} couldn't be read`);
  if (!sentences.length) return null;
  // One sentence has no closing period; two each end with one.
  return sentences.length === 1 ? sentences[0] : sentences.map((s) => `${s}.`).join(" ");
}

/** Several folders' counts as one (Installed has three folders). Null when none was counted. */
export function sumSkipped(list: readonly (SkippedFiles | null | undefined)[]): SkippedFiles | null {
  const counted = list.filter((s): s is SkippedFiles => !!s);
  if (!counted.length) return null;
  const sum = Object.fromEntries(ORDER.map((kind) => [kind, 0])) as unknown as SkippedFiles;
  for (const s of counted) for (const kind of ORDER) sum[kind] += s[kind] ?? 0;
  return sum;
}

/** The tooltip of Show Skipped Files…, on a source's right-click menu. */
export function skippedMenuTip(skipped: SkippedFiles): string {
  const total = skippedTotal(skipped);
  return `Lists the ${total === 1 ? "file" : `${n(total)} files`} the last scan found here but didn't add, and why`;
}
