import type { CharacterBlock } from "./api";

/**
 * The Characters tab's search: type characters ("ß€"), or Unicode code points ("U+00DF",
 * "u+20ac", a range "U+0041-U+005A"). Searching by character name ("euro sign") would need a
 * Unicode name list shipped with the app, so it waits. Pure; `npm run test:ui` covers it.
 */

/** At most this many code points are looked up at once (a long range or a pasted page). */
export const MAX_SEARCH = 2048;

const CODE = /^u\+([0-9a-f]{1,6})$/i;
const RANGE = /^u\+([0-9a-f]{1,6})(?:-|–|\.\.)(?:u\+)?([0-9a-f]{1,6})$/i;
/** Half-typed: "U+" on its own, or a range missing its end, waits for the digits. A lone "U" is
 *  the letter. */
const PARTIAL = /^u\+$|^u\+[0-9a-f]{1,6}(?:-|–|\.\.)(?:u\+?)?$/i;

const valid = (cp: number) => cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);

/** The code points a search asks for, in the order given, each once. */
export function parseCharacterQuery(query: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const add = (cp: number) => {
    if (out.length < MAX_SEARCH && valid(cp) && !seen.has(cp)) {
      seen.add(cp);
      out.push(cp);
    }
  };
  for (const token of query.trim().split(/\s+/).filter(Boolean)) {
    const code = CODE.exec(token);
    if (code) {
      add(parseInt(code[1], 16));
      continue;
    }
    const range = RANGE.exec(token);
    if (range) {
      const a = parseInt(range[1], 16);
      const b = parseInt(range[2], 16);
      for (let cp = Math.min(a, b); cp <= Math.max(a, b) && out.length < MAX_SEARCH; cp++) add(cp);
      continue;
    }
    if (PARTIAL.test(token)) continue;
    for (const ch of token) add(ch.codePointAt(0)!);
  }
  return out;
}

export interface CharacterMatch {
  cp: number;
  /** The glyph name, or "" when the font has none. */
  name: string;
}

/** Which of `wanted` the font has (with their glyph names), and which it doesn't. */
export function findCharacters(blocks: CharacterBlock[], wanted: number[]): { found: CharacterMatch[]; missing: number[] } {
  const found: CharacterMatch[] = [];
  const missing: number[] = [];
  for (const cp of wanted) {
    const hit = locate(blocks, cp);
    if (hit) found.push(hit);
    else missing.push(cp);
  }
  return { found, missing };
}

function locate(blocks: CharacterBlock[], cp: number): CharacterMatch | null {
  for (const block of blocks) {
    // glyphNames follow the runs in order, one per code point.
    let offset = 0;
    for (const [first, last] of block.runs) {
      if (cp >= first && cp <= last) return { cp, name: block.glyphNames[offset + cp - first] ?? "" };
      offset += last - first + 1;
    }
  }
  return null;
}

/** "U+00DF". */
export const codeLabel = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
