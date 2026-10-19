import type { FontSummary } from "./api";
import type { Face, Family } from "./library";

/**
 * What the Table shows about a family or a style, and what sorting compares: weights, foundry,
 * dates, formats, sizes. Pure (no React, no DOM), so `npm run test:ui` covers it. A family's
 * facts come from its faces' preferred copies (`Face.primary`), except the added date, which is
 * when each face first arrived (its earliest copy).
 */

/** The weights some faces cover: static weights, and variable fonts' weight ranges. */
export interface WeightSpan {
  min: number;
  max: number;
  /** Some of them are variable. */
  variable: boolean;
}

export function weightSpan(faces: readonly Face[]): WeightSpan | null {
  let min = Infinity;
  let max = -Infinity;
  let variable = false;
  for (const { primary: f } of faces) {
    variable ||= f.variable;
    // A variable font without a weight axis counts by its default weight.
    const [low, high] = f.variable && f.weightRange ? f.weightRange : [f.weight, f.weight];
    min = Math.min(min, low);
    max = Math.max(max, high);
  }
  return Number.isFinite(min) ? { min, max, variable } : null;
}

/** "400", "300–900", "Variable 100–900". Empty for no faces. */
export function weightText(faces: readonly Face[]): string {
  const span = weightSpan(faces);
  if (!span) return "";
  const range = span.min === span.max ? `${span.min}` : `${span.min}–${span.max}`;
  return span.variable ? `Variable ${range}` : range;
}

/** The first of the representative's, then the other faces', that says. */
function firstSaid(family: Pick<Family, "faces" | "representative">, pick: (f: FontSummary) => string | undefined): string {
  const own = pick(family.representative.primary)?.trim();
  if (own) return own;
  for (const face of family.faces) {
    const v = pick(face.primary)?.trim();
    if (v) return v;
  }
  return "";
}

/** The foundry (name ID 8), or "". */
export const foundryOf = (family: Pick<Family, "faces" | "representative">) => firstSaid(family, (f) => f.manufacturer);
/** The designer (name ID 9), or "". */
export const designerOf = (family: Pick<Family, "faces" | "representative">) => firstSaid(family, (f) => f.designer);

/** When a face came into the library: its earliest copy. Undefined while unknown. */
export function faceAddedAt(face: Face): number | undefined {
  let at: number | undefined;
  for (const c of face.copies) if (c.addedAt !== undefined && (at === undefined || c.addedAt < at)) at = c.addedAt;
  return at;
}

/** When a family last gained a style: its newest face. Undefined while none is known. */
export function addedAt(faces: readonly Face[]): number | undefined {
  let at: number | undefined;
  for (const face of faces) {
    const t = faceAddedAt(face);
    if (t !== undefined && (at === undefined || t > at)) at = t;
  }
  return at;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** An added date in words ("Oct 12, 2026"), or "" while unknown. */
export const addedDateText = (seconds: number | undefined) => (seconds === undefined ? "" : dateFormat.format(new Date(seconds * 1000)));

/** "OpenType CFF", or several joined: "OpenType CFF, TrueType". */
export function formatsOf(faces: readonly Face[]): string {
  return [...new Set(faces.map((f) => f.primary.format))].sort().join(", ");
}

/** The bytes on disk for these faces: each file once (a collection holds several faces). */
export function fileSizeOf(faces: readonly Face[]): number {
  const files = new Map<string, number>();
  for (const { primary } of faces) files.set(primary.path, primary.fileSize);
  let total = 0;
  for (const size of files.values()) total += size;
  return total;
}

export const fileNameOf = (font: Pick<FontSummary, "path">) => font.path.slice(font.path.lastIndexOf("/") + 1);

/**
 * A version string as a short number: "Version 1.009;PS 001.000;Core 1.0.38" → "1.009",
 * "OTF 1.018;PS 001.000" → "1.018", "22.0d2e1" stays. Text with no number comes back up to its
 * first ";". The Info tab shows the whole string.
 */
export function shortVersion(version: string | undefined): string {
  if (!version) return "";
  const text = version.trim().replace(/^version\s*/i, "");
  const leading = /^\d[\w.]*/.exec(text);
  if (leading) return leading[0];
  const inside = /\d+(\.\d+)+/.exec(text);
  return inside ? inside[0] : text.split(";")[0].trim();
}

const VERSION_NUMBER = /^(\d+)(?:\.(\d+))?/;
const versionText = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
/** The digits after the point as a decimal fraction: "009" is 0.009, "1" and "10" are 0.1. */
const fraction = (digits: string | undefined) => (digits ? Number(`0.${digits}`) : 0);

/** A short version (shortVersion) that starts with a number, as most do: it sorts as one. */
export const hasVersionNumber = (version: string) => VERSION_NUMBER.test(version);

/**
 * Compares two short versions the way font versions are meant: a whole number, then the part
 * after the point as a decimal fraction (a font's version is a decimal, like the revision in its
 * head table). So 1.009 comes before 1.1, and 1.10 (1.100) before 1.9. Equal numbers, and the
 * rest of the text ("1.0.38"), go by the text with numbers inside it compared as numbers; text
 * with no leading number goes after every numbered version.
 */
export function compareVersions(a: string, b: string): number {
  const x = VERSION_NUMBER.exec(a);
  const y = VERSION_NUMBER.exec(b);
  if (!x || !y) return x ? -1 : y ? 1 : versionText.compare(a, b);
  return Number(x[1]) - Number(y[1]) || fraction(x[2]) - fraction(y[2]) || versionText.compare(a, b);
}

/**
 * Where some faces' files are, in words (a folder's name, or a service such as Google Fonts),
 * each place once and in order: every copy of each face, its preferred copy first. The Table's
 * Source column names the first and counts the rest.
 */
export function sourcesOf(faces: readonly Face[], sourceOf: (copy: FontSummary) => string): string[] {
  const out = new Set<string>();
  for (const face of faces)
    for (const copy of face.copies) {
      const place = sourceOf(copy);
      if (place) out.add(place);
    }
  return [...out];
}

/** A family's places (sourcesOf), its representative's first: the style its row previews, so
 *  the place the Source column names, and the Source sort goes by, is that style's. */
export function familySources(family: Pick<Family, "faces" | "representative">, sourceOf: (copy: FontSummary) => string): string[] {
  return sourcesOf([family.representative, ...family.faces.filter((f) => f !== family.representative)], sourceOf);
}

/** 0 when every style that can be is on (or the family is always on), 1 when some are, 2 when none. */
export function activeRank(family: Pick<Family, "switchable" | "activeCount">): number {
  const total = family.switchable.length;
  if (total === 0 || family.activeCount === total) return 0;
  return family.activeCount > 0 ? 1 : 2;
}

/** "12 KB", "3.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
