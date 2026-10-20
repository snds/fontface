import type { LibraryLayout, SortKey, SortOrder } from "./api";

/**
 * The View vocabulary: the three layouts, the size steps of Cmd+= and Cmd+- (the preview bar's
 * size), and the sort keys with the words for each direction. Pure (no React, no DOM), so
 * `npm run test:ui` covers it; the popover is components/ViewOptions.tsx and the shortcuts live
 * in App.
 */

export interface LayoutInfo {
  id: LibraryLayout;
  label: string;
  /** Material Symbols name. */
  icon: string;
  /** Cmd+1, Cmd+2, Cmd+3 (Ctrl on Windows). */
  digit: "1" | "2" | "3";
}

export const LAYOUTS: readonly LayoutInfo[] = [
  { id: "tiles", label: "Tiles", icon: "grid_view", digit: "1" },
  { id: "rows", label: "Rows", icon: "view_agenda", digit: "2" },
  { id: "table", label: "Table", icon: "table_rows", digit: "3" },
];

export const layoutInfo = (id: LibraryLayout): LayoutInfo => LAYOUTS.find((l) => l.id === id) ?? LAYOUTS[1];

/** The parts of a key press the shortcuts look at. `code` is the physical key, so Cmd+1 works
 *  on keyboard layouts where the digits need Shift (AZERTY). */
export interface ShortcutKey {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Cmd+1/2/3 (Ctrl on Windows): the layout it picks, or null. */
export function layoutShortcut(e: ShortcutKey, mac: boolean): LibraryLayout | null {
  const command = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!command || e.altKey || e.shiftKey) return null;
  const digit = e.code?.startsWith("Digit") ? e.code.slice(5) : e.key;
  return LAYOUTS.find((l) => l.digit === digit)?.id ?? null;
}

/** The preview sizes Cmd+= and Cmd+- step through, and the preview bar's size select lists. */
export const SIZE_STEPS = [12, 16, 24, 32, 48, 64, 96, 128] as const;

/** The next size up (+1) or down (-1) from `size`, which may sit between steps or past either
 *  end (a custom size goes down to 10). Past the last step it stays: smaller never makes it bigger,
 *  and bigger never smaller. */
export function stepSize(size: number, direction: 1 | -1): number {
  if (direction > 0) return SIZE_STEPS.find((s) => s > size) ?? Math.max(size, SIZE_STEPS[SIZE_STEPS.length - 1]);
  return [...SIZE_STEPS].reverse().find((s) => s < size) ?? Math.min(size, SIZE_STEPS[0]);
}

/** Cmd+= (or Cmd++) and Cmd+- (Ctrl on Windows): +1, -1, or null. */
export function sizeShortcut(e: ShortcutKey, mac: boolean): 1 | -1 | null {
  const command = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!command || e.altKey) return null;
  if (e.key === "=" || e.key === "+" || e.code === "Equal" || e.code === "NumpadAdd") return 1;
  if (e.key === "-" || e.key === "_" || e.code === "Minus" || e.code === "NumpadSubtract") return -1;
  return null;
}

// ------------------------------------------------------------------------------------ sort

export interface SortInfo {
  key: SortKey;
  /** "Sort by" label. */
  label: string;
  /** How it runs, smallest first and the other way: ["A to Z", "Z to A"]. */
  directions: [string, string];
  /** The way it starts when picked: newest first for dates, most first for counts. */
  desc: boolean;
  /** Listed in the View options (the others come from the Table's headers). */
  main: boolean;
}

const AZ: [string, string] = ["A to Z", "Z to A"];

export const SORTS: readonly SortInfo[] = [
  { key: "name", label: "Name", directions: AZ, desc: false, main: true },
  { key: "added", label: "Date added", directions: ["Oldest first", "Newest first"], desc: true, main: true },
  { key: "styles", label: "Number of styles", directions: ["Fewest first", "Most first"], desc: true, main: true },
  { key: "weight", label: "Weight", directions: ["Lightest first", "Heaviest first"], desc: false, main: true },
  { key: "foundry", label: "Foundry", directions: AZ, desc: false, main: true },
  { key: "active", label: "On or off", directions: ["On first", "Off first"], desc: false, main: true },
  { key: "format", label: "Format", directions: AZ, desc: false, main: false },
  { key: "source", label: "Source", directions: AZ, desc: false, main: false },
  { key: "version", label: "Version", directions: ["Lowest first", "Highest first"], desc: false, main: false },
  { key: "designer", label: "Designer", directions: AZ, desc: false, main: false },
  { key: "file", label: "File name", directions: AZ, desc: false, main: false },
  { key: "size", label: "File size", directions: ["Smallest first", "Largest first"], desc: true, main: false },
  { key: "glyphs", label: "Glyphs", directions: ["Fewest first", "Most first"], desc: true, main: false },
];

export const sortInfo = (key: SortKey): SortInfo => SORTS.find((s) => s.key === key) ?? SORTS[0];

/** Picking a sort key: the same key turns it round, another starts its usual way. */
export function nextSort(current: SortOrder, key: SortKey): SortOrder {
  return current.key === key ? { key, desc: !current.desc } : { key, desc: sortInfo(key).desc };
}

/** "A to Z", "Newest first": how this sort runs. */
export const directionWords = (sort: SortOrder): string => sortInfo(sort.key).directions[sort.desc ? 1 : 0];

/** What's announced when the sort changes: "Sorted by Date added, newest first". */
export function describeSort(sort: SortOrder): string {
  const words = directionWords(sort);
  // "Newest first" reads on in lowercase; "A to Z" keeps its capitals.
  const inSentence = /^[A-Z][a-z]/.test(words) ? words.charAt(0).toLowerCase() + words.slice(1) : words;
  return `Sorted by ${sortInfo(sort.key).label}, ${inSentence}`;
}
