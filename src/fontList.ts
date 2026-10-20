import type { FoundFace, LineMatch, NameLine, NameMatchHow } from "./api.ts";

/**
 * Turn On Fonts from a List…: reading the pasted text into names to look up, and the words for
 * what each name found. The lookup itself is the app's one name matcher
 * (src-tauri/src/font_names). Pure (no React, no DOM), so `npm run test:ui` covers it.
 *
 * What can be pasted:
 * - One font per line: a PostScript name ("Inter-Bold"), a full name ("Inter Bold Italic"), a
 *   family and style ("Inter SemiBold"), or a family on its own (all its styles). The Figma
 *   plugin's Copy missing and Copy all give "Family Style" lines.
 * - Several on a line, between commas or semicolons, as in a CSS font-family list
 *   (`font-family: "Inter", sans-serif;`). CSS's own words (sans-serif, system-ui…) aren't
 *   fonts, so they're left out. Quotes, list bullets and a ".otf" or ".ttf" ending are ignored.
 * - A line copied from a table: its first column (up to a tab).
 * - JSON, pasted whole: {"fonts":[{"family":"Inter","style":"Bold","postscriptName":"Inter-Bold"}]}
 *   (the Figma plugin's Copy as JSON), or the list on its own. Each font needs a family or a
 *   PostScript name; a plain string in the list is a line.
 */

/** Most names looked up at once (MAX_LINES in src-tauri/src/font_names/mod.rs). */
export const MAX_NAMES = 5000;

/** CSS's generic families and keywords: not fonts, so a font-family list drops them (unquoted). */
const CSS_WORDS = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
  "-apple-system",
  "blinkmacsystemfont",
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
]);

/** One name to look up. */
export interface ListEntry {
  /** The name as the list gives it, without quotes: what the preview shows and Copy Not Found
   *  copies. For a JSON font, "Family Style" (or its PostScript name). */
  label: string;
  line: NameLine;
}

export interface ParsedList {
  entries: ListEntry[];
  /** Names given more than once (in any spacing or letter case), looked up once. */
  repeats: number;
  /** Names past MAX_NAMES, left out. */
  over: number;
  /** The text looked like JSON but couldn't be read (say, only part of it was pasted). */
  badJson: boolean;
}

/** How the matcher compares names: lowercase letters and digits only (name_key in Rust). */
export const nameKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

const QUOTES = /^["'`“”‘’]+|["'`“”‘’]+$/g;
const BULLET = /^(?:[-*•‣◦]|\d+[.)])\s+/;
const hasLetters = (s: string) => /[\p{L}\p{N}]/u.test(s);

/** The names on one line of text: its first column, split at commas and semicolons. */
function namesOnLine(raw: string): string[] {
  let line = raw.split("\t")[0].trim().replace(BULLET, "");
  line = line.replace(/^font-family\s*:/i, "").replace(/!important/gi, "");
  const out: string[] = [];
  for (const part of line.split(/[,;]/)) {
    const trimmed = part.trim();
    const quoted = /^["'`“‘]/.test(trimmed);
    const name = trimmed.replace(QUOTES, "").trim();
    if (!name || !hasLetters(name)) continue;
    if (!quoted && CSS_WORDS.has(name.toLowerCase())) continue;
    out.push(name);
  }
  return out;
}

/** A font from the JSON list, if it names one: its line for the matcher, and its label. */
function jsonEntry(item: unknown): ListEntry | null {
  if (typeof item === "string") {
    const name = item.trim();
    return name && hasLetters(name) ? { label: name, line: name } : null;
  }
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const family = text(o.family);
  const style = text(o.style);
  const postscriptName = text(o.postscriptName) ?? text(o.postScriptName);
  if (!family && !postscriptName) return null;
  const label = family ? (style ? `${family} ${style}` : family) : postscriptName!;
  const line: NameLine = {};
  if (family) line.family = family;
  if (style) line.style = style;
  if (postscriptName) line.postscriptName = postscriptName;
  return { label, line };
}

/** The JSON list's items, or null when the text isn't JSON. */
function jsonItems(text: string): unknown[] | null | "bad" {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return null;
  let value: unknown;
  try {
    value = JSON.parse(t);
  } catch {
    // Part of a JSON list (a font's fields are there), or just text that starts with a bracket.
    return /"(?:fonts|family|style|postscriptName)"\s*:/i.test(t) ? "bad" : null;
  }
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as { fonts?: unknown }).fonts)) return (value as { fonts: unknown[] }).fonts;
  return "bad";
}

/** The pasted text as names to look up, each once, in the order given. */
export function parseFontList(text: string): ParsedList {
  const items = jsonItems(text);
  if (items === "bad") return { entries: [], repeats: 0, over: 0, badJson: true };
  const all: ListEntry[] =
    items === null
      ? text.split(/\r\n|\r|\n/).flatMap((raw) => namesOnLine(raw).map((name) => ({ label: name, line: name })))
      : items.flatMap((item) => jsonEntry(item) ?? []);
  const seen = new Set<string>();
  const entries: ListEntry[] = [];
  let repeats = 0;
  for (const entry of all) {
    const l = entry.line;
    const key = typeof l === "string" ? nameKey(l) : `${nameKey(l.postscriptName ?? "")}|${nameKey(l.family ?? "")}|${nameKey(l.style ?? "")}`;
    if (seen.has(key)) {
      repeats++;
      continue;
    }
    seen.add(key);
    entries.push(entry);
  }
  const over = Math.max(0, entries.length - MAX_NAMES);
  return { entries: entries.slice(0, MAX_NAMES), repeats, over, badJson: false };
}

// ---------------------------------------------------------------------------- what it found

/** What the library says about a style now (its Face in library.ts). */
export interface FaceState {
  active: boolean;
  installed: boolean;
}

export type FaceLookup = (key: string) => FaceState | undefined;

/** A style that's on: turned on, or in a macOS font folder. */
const isOn = (f: FoundFace, state: FaceLookup) => {
  const s = state(f.key);
  return s ? s.active || s.installed : f.installed;
};

/** A row's state: nothing found, all on, all off, or some on. */
export type RowStatus = "notFound" | "on" | "off" | "some";

export function rowStatus(match: LineMatch, state: FaceLookup): RowStatus {
  if (!match.faces.length) return "notFound";
  const on = match.faces.filter((f) => isOn(f, state)).length;
  return on === match.faces.length ? "on" : on === 0 ? "off" : "some";
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The row's state in words. */
export function statusText(match: LineMatch, state: FaceLookup): string {
  const status = rowStatus(match, state);
  if (status === "notFound") return "Not found";
  if (status === "on") return match.faces.every((f) => state(f.key)?.installed ?? f.installed) ? "On in macOS Fonts" : "On";
  if (status === "off") return match.faces.some((f) => f.onlineOnly) ? "Off, online-only" : "Off";
  const on = match.faces.filter((f) => isOn(f, state)).length;
  return `${on.toLocaleString()} of ${match.faces.length.toLocaleString()} on`;
}

/** How a row found its styles, after what it found: "Inter Bold · PostScript name". */
const HOW_WORDS: Record<NameMatchHow, string> = {
  family: "whole family",
  postScript: "PostScript name",
  fullName: "full name",
  familyStyle: "family and style",
  namedStyle: "variable font",
};

export const howText = (how: NameMatchHow) => HOW_WORDS[how];

/** What a row found, in a few words: "Inter Bold", "Inter, 18 styles", "Roboto Flex (variable)". */
export function foundText(match: LineMatch): string {
  const faces = match.faces;
  if (!faces.length) return match.near.length ? `Closest: ${match.near.join(", ")}` : "";
  const families = [...new Set(faces.map((f) => f.family))];
  if (match.how === "family" && families.length === 1) return `${families[0]}, ${count(faces.length, "style")}`;
  const first = faces[0];
  const name = `${first.family} ${first.style}`;
  if (match.how === "namedStyle") return faces.length === 1 ? `${name} (variable)` : `${first.family}, ${count(faces.length, "variable font")}`;
  return faces.length === 1 ? name : `${name} and ${count(faces.length - 1, "other")}`;
}

/** The whole list in numbers: names, styles found (each once), and what Turn On would do. */
export interface ListSummary {
  names: number;
  found: number;
  notFound: number;
  /** Every style found, each once. */
  faces: FoundFace[];
  /** The styles found that are off, each once: what Turn On turns on. */
  off: FoundFace[];
  /** Of those, the ones that download first. */
  downloads: number;
}

export function summarize(matches: readonly LineMatch[], state: FaceLookup): ListSummary {
  const byKey = new Map<string, FoundFace>();
  let found = 0;
  for (const m of matches) {
    if (m.faces.length) found++;
    for (const f of m.faces) if (!byKey.has(f.key)) byKey.set(f.key, f);
  }
  const faces = [...byKey.values()];
  const off = faces.filter((f) => !isOn(f, state));
  return { names: matches.length, found, notFound: matches.length - found, faces, off, downloads: off.filter((f) => f.onlineOnly).length };
}

/** The line above the list: "12 names: 9 found (31 styles, 4 off), 3 not found". */
export function summaryText(s: ListSummary): string {
  if (!s.names) return "";
  const head = `${count(s.names, "name")}: `;
  if (!s.found) return `${head}none found`;
  const on = s.faces.length - s.off.length;
  const detail = s.off.length === 0 ? "all on" : on === 0 ? "all off" : `${s.off.length.toLocaleString()} off`;
  const found = s.notFound ? `${s.found.toLocaleString()} found` : "all found";
  return `${head}${found} (${count(s.faces.length, "style")}, ${detail})${s.notFound ? `, ${s.notFound.toLocaleString()} not found` : ""}`;
}

/** The names that found nothing, one per line, as the list gave them (Copy Not Found). */
export function notFoundText(entries: readonly ListEntry[], matches: readonly LineMatch[]): string {
  return entries
    .filter((_, i) => matches[i] && !matches[i].faces.length)
    .map((e) => e.label)
    .join("\n");
}
