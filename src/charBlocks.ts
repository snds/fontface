import type { CharacterBlock } from "./api";

/**
 * The Characters tab's Unicode block picker: which blocks show, in what order, what its button
 * says, and how a choice carries from one font to the next. Pure (no DOM), so `npm run test:ui`
 * covers it; components/fontPage/BlockSelect.tsx draws it, charBlocksStore.ts remembers it.
 *
 * - Blocks are listed, and shown as groups, in Unicode order (the order the font's characters
 *   come in): related blocks stay together (Latin, Latin-1 Supplement, Latin Extended-A…), and
 *   the list matches the groups below it. The button names the alphabetically first block picked.
 * - The choice is remembered for the whole app, block by block: a font shows the blocks last
 *   picked that it has. If it has none of them, it shows its biggest block. If every block was
 *   picked, the next font shows all of its own.
 */

/** A block's name and how many characters the font has in it. */
export interface BlockInfo {
  name: string;
  count: number;
}

/** How many characters a block holds. */
export const blockCount = (b: CharacterBlock) => b.runs.reduce((n, [a, z]) => n + z - a + 1, 0);

/**
 * The font's blocks with each name once, in Unicode order. Code points outside every block are
 * all "No Block", which can turn up in more than one gap: those are merged into one group.
 */
export function uniqueBlocks(blocks: CharacterBlock[]): CharacterBlock[] {
  const byName = new Map<string, CharacterBlock>();
  for (const b of blocks) {
    const seen = byName.get(b.name);
    if (seen) byName.set(b.name, { name: b.name, runs: [...seen.runs, ...b.runs], glyphNames: [...seen.glyphNames, ...b.glyphNames] });
    else byName.set(b.name, b);
  }
  return [...byName.values()];
}

/** The block with the most characters (the first of equals): what a font shows first. */
export function biggestBlock(blocks: BlockInfo[]): string | null {
  let best: BlockInfo | null = null;
  for (const b of blocks) if (!best || b.count > best.count) best = b;
  return best?.name ?? null;
}

/** `names` that are blocks of the font, each once, in the font's (Unicode) order. */
export function inBlockOrder(names: Iterable<string>, blocks: BlockInfo[]): string[] {
  const want = new Set(names);
  return blocks.filter((b) => want.has(b.name)).map((b) => b.name);
}

/** Picks or unpicks one block. */
export function toggleBlock(picked: string[], name: string, blocks: BlockInfo[]): string[] {
  const next = new Set(picked);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return inBlockOrder(next, blocks);
}

/** Every block of the font. */
export const allBlocks = (blocks: BlockInfo[]) => blocks.map((b) => b.name);

/** Whether every block is picked (more than one, so a one-block font never counts as "all"). */
export const isAll = (picked: string[], blocks: BlockInfo[]) => blocks.length > 1 && inBlockOrder(picked, blocks).length === blocks.length;

/** What the app remembers of the last choice, for the next font. */
export interface BlockMemory {
  /** Every block was picked: a font shows all of its own. */
  all: boolean;
  /** For each block, the latest choice made in a font that has it: these were picked. */
  picked: string[];
}

export const NO_MEMORY: BlockMemory = { all: false, picked: [] };

/** At most this many remembered names (Unicode has about 340 blocks). */
const MEMORY_LIMIT = 500;

/**
 * The memory after a choice in a font with `blocks`: its blocks are now as `picked` says; blocks
 * it doesn't have keep what was chosen for them before. `all`: the choice was "All blocks". Only
 * that carries as all: picking both blocks of a two-block font one by one doesn't mean every
 * block of the next.
 */
export function remember(memory: BlockMemory, blocks: BlockInfo[], picked: string[], all = false): BlockMemory {
  const here = new Set(blocks.map((b) => b.name));
  const kept = memory.picked.filter((n) => !here.has(n));
  return { all: all && isAll(picked, blocks), picked: [...kept, ...inBlockOrder(picked, blocks)].slice(-MEMORY_LIMIT) };
}

/** What the app keeps (charBlocksStore.ts): the memory, and the groups the user closed. */
export interface StoredBlocks {
  memory: BlockMemory;
  /** Closed groups, by block name. */
  closed: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

/** What was kept, from its saved text; anything unreadable is nothing kept. */
export function readStoredBlocks(text: string | null): StoredBlocks {
  try {
    const raw = JSON.parse(text ?? "null");
    if (!raw || typeof raw !== "object") return { memory: NO_MEMORY, closed: [] };
    return { memory: { all: raw.memory?.all === true, picked: strings(raw.memory?.picked) }, closed: strings(raw.closed) };
  } catch {
    return { memory: NO_MEMORY, closed: [] };
  }
}

/**
 * The blocks a font starts with: all of them if every block was picked last time; else the ones
 * remembered that it has; else its biggest block.
 */
export function startingBlocks(blocks: BlockInfo[], memory: BlockMemory): string[] {
  if (!blocks.length) return [];
  if (memory.all) return allBlocks(blocks);
  const kept = inBlockOrder(memory.picked, blocks);
  if (kept.length) return kept;
  const biggest = biggestBlock(blocks);
  return biggest ? [biggest] : [];
}

/**
 * Groups closed by the user, after a choice: a block just picked opens, so it shows at once.
 */
export function openNewlyPicked(closed: string[], before: string[], after: string[]): string[] {
  const had = new Set(before);
  const fresh = new Set(after.filter((n) => !had.has(n)));
  return fresh.size ? closed.filter((n) => !fresh.has(n)) : closed;
}

/**
 * The groups made at once, from the top, while they hold fewer than `budget` cells between them
 * (a closed group holds none). The rest wait till they come near the screen. The first is always
 * made, however big.
 */
export function eagerGroups(groups: { name: string; cells: number }[], budget: number): Set<string> {
  const out = new Set<string>();
  let used = 0;
  for (const g of groups) {
    if (out.size && used + g.cells > budget) break;
    out.add(g.name);
    used += g.cells;
  }
  return out;
}

// Block names are English, so they sort as English does, whatever the Mac's language.
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/** Names in alphabetical order. */
export const alphabetical = (names: string[]) => [...names].sort(collator.compare);

/**
 * What the picker's button shows: the alphabetically first block picked, and how many more
 * ("+2"). Null when none is picked (the button shows its placeholder).
 */
export function pickerLabel(picked: string[]): { first: string; more: number } | null {
  if (!picked.length) return null;
  return { first: alphabetical(picked)[0], more: picked.length - 1 };
}

/** The "+N" in the circle. */
export const moreText = (more: number) => `+${more.toLocaleString()}`;

/**
 * The picker's name for screen readers, which says what's picked: "Unicode blocks: Arrows,
 * Basic Latin and 2 more"; "…: all 22"; "…: none".
 */
export function pickerName(picked: string[], total: number): string {
  const lead = "Unicode blocks";
  if (!picked.length) return `${lead}: none`;
  if (total > 1 && picked.length === total) return `${lead}: all ${total.toLocaleString()}`;
  const names = alphabetical(picked);
  if (names.length === 1) return `${lead}: ${names[0]}`;
  if (names.length <= 3) return `${lead}: ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${lead}: ${names.slice(0, 2).join(", ")} and ${(names.length - 2).toLocaleString()} more`;
}
