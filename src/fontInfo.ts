import type { CharacterBlock, Embedding, FactsUnread } from "./api.ts";
import { languageName } from "./openType.ts";

/**
 * Words for the font page's Info tab: embedding permissions, web addresses, languages, scripts
 * and dates. Pure (no React, no DOM), so `npm run test:ui` covers it.
 */

/** What a font's embedding permissions (OS/2 `fsType`) mean, in plain words. */
export function embeddingWords(e: Embedding): { title: string; text: string; extra: string[] } {
  const extra: string[] = [];
  if (e.noSubsetting) extra.push("Documents must hold the whole font, not only the characters they use.");
  if (e.bitmapOnly) extra.push("Only its bitmaps may be embedded, not its outlines.");
  switch (e.kind) {
    case "installable":
      return { title: "Installable", text: "It can go inside documents you share, and the people you share them with can install it.", extra };
    case "editable":
      return { title: "Editable", text: "It can go inside documents you share, and others can view, print and edit them, but not install it.", extra };
    case "previewPrint":
      return { title: "Preview and print", text: "It can go inside documents you share for viewing and printing only, not editing.", extra };
    case "restricted":
      return { title: "Restricted", text: "It shouldn't go inside documents you share unless its license allows it.", extra };
    default:
      return { title: "Unclear", text: "The font's embedding settings contradict each other.", extra };
  }
}

/** Shown under the embedding words: the file only says what its maker set. */
export const EMBEDDING_NOTE = "This is what the font file says. Your license is what counts.";

/**
 * A web address from a font's names (name IDs 11 and 12), as written and as a link to open.
 * Addresses without "https://" ("www.foundry.com", "http://…") open over https; anything that
 * isn't a web address (an email, words) gets no link.
 */
export function webAddress(raw: string): { text: string; href: string | null } {
  const text = raw.trim();
  let candidate: string | null = null;
  if (/^https:\/\//i.test(text)) candidate = text;
  else if (/^http:\/\//i.test(text)) candidate = `https://${text.slice(7)}`;
  else if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(text)) candidate = `https://${text}`;
  if (!candidate || /\s/.test(candidate)) return { text, href: null };
  try {
    const url = new URL(candidate);
    return { text, href: url.protocol === "https:" && url.hostname.includes(".") ? url.href : null };
  } catch {
    return { text, href: null };
  }
}

/** Language codes as names, each once, in order ("en", "fr" → "English", "French"). Codes
 *  without an English name are left out. */
export function languageList(codes: readonly string[]): string[] {
  const names = new Set<string>();
  for (const code of codes) {
    const name = languageName(code);
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Unicode blocks that hold one script's letters, by their names' start; the script's name. */
const SCRIPT_BLOCKS: readonly [RegExp, string][] = [
  [/^(Basic Latin|Latin|IPA Extensions|Phonetic Extensions)/, "Latin"],
  [/^Greek/, "Greek"],
  [/^Cyrillic/, "Cyrillic"],
  [/^(Hangul)/, "Hangul"],
  [/^(CJK Unified Ideographs|CJK Compatibility Ideographs|Kangxi Radicals|CJK Radicals)/, "Han (Chinese characters)"],
  [/^(Hiragana|Katakana|Kana |Small Kana)/, "Kana (Japanese)"],
  [/^Unified Canadian Aboriginal Syllabics/, "Canadian Aboriginal"],
  [/^Arabic(?! Mathematical)/, "Arabic"],
  [/^Yi /, "Yi"],
  [/^(Linear B)/, "Linear B"],
  [/^Cuneiform/, "Cuneiform"],
  [/^Egyptian Hieroglyphs/, "Egyptian hieroglyphs"],
];

/** Blocks that hold symbols, punctuation or marks rather than a script's letters. */
const NOT_A_SCRIPT =
  /Symbols|Punctuation|Arrows|Mathematical|Operators|Technical|Pictures|Box Drawing|Block Elements|Geometric|Dingbats|Braille|Private Use|Surrogates|Specials|Variation Selectors|Combining|Modifier|Number|Numeral|Enclosed|Forms|Form Variants|Tiles|Playing Cards|Emoticons|Musical|Format Controls|^Tags$|Optical Character|Superscripts|Ideographic Description|CJK Strokes|Kanbun|^CJK Compatibility$|Hexagram|Vedic|Pictographs|Shorthand|Siyaq|Ornamental/;

/** A script needs this many characters to be listed (a Latin font's π and Ω aren't Greek). */
export const SCRIPT_MIN = 10;

/** In Basic Latin and Latin-1, only letters count (digits and punctuation are in every font). */
function letters(block: CharacterBlock): number {
  if (block.name !== "Basic Latin" && block.name !== "Latin-1 Supplement") return block.runs.reduce((n, [a, z]) => n + z - a + 1, 0);
  let n = 0;
  for (const [a, z] of block.runs)
    for (let cp = a; cp <= z; cp++) if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0xff && cp !== 0xd7 && cp !== 0xf7)) n++;
  return n;
}

/** The scripts a font's characters cover, most characters first: "Latin", "Greek", "Cyrillic". */
export function scriptsOfBlocks(blocks: readonly CharacterBlock[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const block of blocks) {
    if (NOT_A_SCRIPT.test(block.name)) continue;
    const named = SCRIPT_BLOCKS.find(([re]) => re.test(block.name));
    // Otherwise the block is named for its script, perhaps with "Supplement" or "Extended-A".
    const name = named ? named[1] : block.name.replace(/ (Supplement|Extended(-[A-Z]| Additional)?|Extensions|Syllables|Syllabary|Radicals|Components)$/, "");
    counts.set(name, (counts.get(name) ?? 0) + letters(block));
  }
  return [...counts]
    .filter(([, count]) => count >= SCRIPT_MIN)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

const dateTime = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });

/** "19 October 2026 at 14:05" (in the system's own form), from Unix seconds. */
export const dateTimeText = (seconds: number) => dateTime.format(new Date(seconds * 1000));

/** The Info tab's "Last turned on". `alwaysOn`: a font macOS always keeps on (its lock). */
export function lastTurnedOnText(at: number | null | undefined, alwaysOn: boolean): string {
  if (at) return dateTimeText(at);
  return alwaysOn ? "Always on: macOS keeps it on" : "Not by Fontface yet";
}

/** What the font page says when it couldn't read a file's details. */
export function unreadWords(unread: FactsUnread, message: string | null): { title: string; text: string } {
  if (unread === "cloud") return { title: "Download to see details", text: "This file is online-only. Its details show once your cloud drive downloads it." };
  return { title: "Details unavailable", text: message ?? "This font's file can't be read right now." };
}
