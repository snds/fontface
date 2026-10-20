import { clampAxis, OPSZ, type AxisInfo } from "./axisField.ts";
import { isDefaultOn } from "./openType.ts";
import { featureSettings, validTag, variationSettings, type FeatureValues } from "./previewStyle.ts";

/**
 * Copy as CSS on the font page: CSS for the style it shows, with the page's axes and OpenType
 * settings, ready to paste into a rule. Pure (no React, no DOM), so `npm run test:ui` covers it.
 *
 * - **Family.** `font-family` with the font's own family name (quoted unless it's one plain
 *   word), and a generic fallback when Fontface knows the kind of font: monospace, serif or
 *   sans serif. Otherwise just the family.
 * - **Axes.** CSS's own properties where there's one: `font-weight` for wght, `font-stretch` (a
 *   percentage) for wdth, `font-style` (italic, or oblique and an angle) for ital and slnt, and
 *   `font-optical-sizing: auto` while optical size follows the text size (axisField.ts). A
 *   static style says its own weight, slope and width the same way. Only what's left goes in
 *   `font-variation-settings`: optical size set by hand, values those properties can't say, and
 *   the font's own axes (upper-case tags, such as GRAD) where they're away from their defaults.
 * - **Features.** Only the ones that differ from the default, and, when the style's list is
 *   known, that it has. Each goes to a `font-variant-*` property (or `font-kerning`) when one
 *   says exactly the same, else to `font-feature-settings`. Keywords that let the browser fake a
 *   feature the font lacks (small caps, superscripts) are used only when the font is known to
 *   have it, so the CSS draws what the page does.
 */

/** A CSS generic family Fontface can tell a font belongs to. */
export type GenericFamily = "serif" | "sans-serif" | "monospace";

export interface CssStyle {
  /** The font's family name (its name ID 16, else 1). */
  family: string;
  /** The kind of font, for the fallback, when it's known. */
  generic?: GenericFamily | null;
  /** The style's weight (OS/2 usWeightClass), width class (1 to 9) and slope, used where it has
   *  no axis for them. */
  weight: number;
  width: number;
  italic: boolean;
  /** Every axis of a variable style (none for a static one). */
  axes: readonly AxisInfo[];
  /** The axis values set on the page (by hand or by a named style); the others are at their
   *  defaults. Optical size follows the text size unless it's here. */
  values: Readonly<Record<string, number>>;
  /** The features the page's previews use (the preview bar's and the page's switches): 1 on, 0 off. */
  features: FeatureValues;
  /** The tags of the features the style has, or null when that isn't known (then every feature
   *  set counts, and no keyword that could fake one is used). */
  has?: ReadonlySet<string> | null;
}

/** One declaration: a property and its value. */
export type Declaration = readonly [property: string, value: string];

/** The CSS for the style: one declaration per line, each ending in a semicolon. */
export function cssText(style: CssStyle): string {
  return styleDeclarations(style)
    .map(([property, value]) => `${property}: ${value};`)
    .join("\n");
}

/** Every declaration, in the order the CSS lists them. */
export function styleDeclarations(style: CssStyle): Declaration[] {
  const family = style.family.trim();
  return [
    ...(family ? [["font-family", fontFamilyValue(family, style.generic)] as const] : []),
    ...axisDeclarations(style),
    ...featureDeclarations(style.features, style.has ?? null),
  ];
}

// ------------------------------------------------------------------------------- family

/** Words CSS reserves: a family name with one of them as a word must be quoted. */
const RESERVED = new Set(["inherit", "initial", "unset", "revert", "revert-layer", "default"]);
/** Generic family names: a family called just this must be quoted. */
const GENERIC_NAMES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif",
  "ui-monospace", "ui-rounded", "math", "emoji", "fangsong",
]);
/** A CSS identifier: a letter, underscore or non-ASCII character (after at most one hyphen),
 *  then those, digits and hyphens. */
const IDENT = /^-?[A-Za-z_\u{80}-\u{10FFFF}][\w\-\u{80}-\u{10FFFF}]*$/u;

/** A family name as CSS writes it: bare when it's one plain word (Inter), else in double quotes
 *  ("Inter Display", "3 Dots", "Font \"Q\""). */
export function cssFamilyName(name: string): string {
  const lower = name.toLowerCase();
  if (IDENT.test(name) && !RESERVED.has(lower) && !GENERIC_NAMES.has(lower)) return name;
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\A ")}"`;
}

/** `font-family`'s value: the family, then the generic fallback if there is one. */
export const fontFamilyValue = (family: string, generic?: GenericFamily | null) =>
  generic ? `${cssFamilyName(family)}, ${generic}` : cssFamilyName(family);

// --------------------------------------------------------------------------------- axes

/** Registered axes, which CSS's own properties cover (opsz by `font-optical-sizing`). */
const REGISTERED = new Set(["wght", "wdth", "ital", "slnt", OPSZ]);

/** OS/2 width classes 1 to 9 as `font-stretch` percentages, as the OpenType spec maps them. */
const WIDTH_PERCENT: Readonly<Record<number, number>> = { 1: 50, 2: 62.5, 3: 75, 4: 87.5, 5: 100, 6: 112.5, 7: 125, 8: 150, 9: 200 };

/** A number as CSS gets it: at most three decimals, no trailing zeros. */
export function cssNumber(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
}

/** The axes' declarations: weight, width, slope and optical size, then whatever is left. */
export function axisDeclarations(style: CssStyle): Declaration[] {
  const { axes, values } = style;
  const value = (a: AxisInfo) => clampAxis(values[a.tag] ?? a.default, a);
  const axis = (tag: string) => axes.find((a) => a.tag === tag);
  const out: Declaration[] = [];
  /** Registered axes that CSS's own properties can't say: these go in font-variation-settings. */
  const left = new Set<string>();

  const wght = axis("wght");
  const weight = wght ? value(wght) : style.weight;
  // font-weight takes 1 to 1000.
  if (weight >= 1 && weight <= 1000) out.push(["font-weight", cssNumber(weight)]);
  else if (wght) left.add("wght");

  const wdth = axis("wdth");
  if (wdth) {
    if (value(wdth) > 0) out.push(["font-stretch", `${cssNumber(value(wdth))}%`]);
    else left.add("wdth");
  } else if (style.width !== 5 && WIDTH_PERCENT[style.width]) out.push(["font-stretch", `${WIDTH_PERCENT[style.width]}%`]);

  // Italic is the ital axis at 1 (or a static italic); a slant is `oblique` and the angle the
  // other way round (slnt -12 leans right, as oblique 12deg does).
  const ital = axis("ital");
  let italic = style.italic;
  if (ital) {
    const v = value(ital);
    italic = v === 1;
    if (v !== 0 && v !== 1) left.add("ital");
  }
  let slope = italic ? "italic" : "normal";
  const slnt = axis("slnt");
  if (slnt && value(slnt) !== 0) {
    const angle = -value(slnt);
    if (!italic && angle >= -90 && angle <= 90) slope = `oblique ${cssNumber(angle)}deg`;
    else left.add("slnt");
  }
  out.push(["font-style", slope]);

  const opsz = axis(OPSZ);
  if (opsz) {
    if (OPSZ in values) left.add(OPSZ);
    else out.push(["font-optical-sizing", "auto"]);
  }

  // What's left, in the font's own axis order.
  const rest: Record<string, number> = {};
  for (const a of axes) {
    const v = value(a);
    if (left.has(a.tag) || (!REGISTERED.has(a.tag) && cssNumber(v) !== cssNumber(a.default))) rest[a.tag] = v;
  }
  const variation = variationSettings(rest);
  if (variation) out.push(["font-variation-settings", variation]);
  return out;
}

// ----------------------------------------------------------------------------- features

/** font-variant-caps: the features each keyword turns on, as a set. */
const CAPS: readonly (readonly [readonly string[], string])[] = [
  [["smcp"], "small-caps"],
  [["smcp", "c2sc"], "all-small-caps"],
  [["pcap"], "petite-caps"],
  [["pcap", "c2pc"], "all-petite-caps"],
  [["unic"], "unicase"],
  [["titl"], "titling-caps"],
];
const CAPS_TAGS = ["smcp", "c2sc", "pcap", "c2pc", "unic", "titl"];

/**
 * The features' declarations. `features`: what the previews use; `has`: the style's features
 * (null: not known). Only the ones that differ from the default count, and only those the style
 * has when that's known (a switch for a feature it lacks changes nothing).
 */
export function featureDeclarations(features: FeatureValues, has: ReadonlySet<string> | null): Declaration[] {
  const changes: Record<string, number> = {};
  for (const [tag, v] of Object.entries(features)) {
    if (!validTag(tag) || (has && !has.has(tag))) continue;
    const on = v === 1;
    if (on !== isDefaultOn(tag)) changes[tag] = on ? 1 : 0;
  }
  const on = (tag: string) => changes[tag] === 1;
  const off = (tag: string) => changes[tag] === 0;
  /** Off, or not in the style at all (so it's as good as off). */
  const offOrMissing = (tag: string) => off(tag) || (!(tag in changes) && !!has && !has.has(tag));
  /** Known to be in the style: a keyword that fakes what's missing is safe. */
  const known = (tag: string) => !!has?.has(tag);
  const take = (...tags: string[]) => tags.forEach((t) => delete changes[t]);
  /** The keyword for the one feature of a group that's on (none if two are: they'd clash). */
  const oneOf = (into: string[], group: readonly (readonly [string, string])[], needKnown = false) => {
    const hits = group.filter(([tag]) => on(tag));
    if (hits.length !== 1 || (needKnown && !known(hits[0][0]))) return;
    into.push(hits[0][1]);
    take(hits[0][0]);
  };
  const out: Declaration[] = [];

  if (off("kern")) {
    out.push(["font-kerning", "none"]);
    take("kern");
  }

  // Common ligatures are liga and clig together; `none` is those and contextual alternates off.
  const ligatures: string[] = [];
  if ((off("liga") || off("clig")) && offOrMissing("liga") && offOrMissing("clig")) {
    ligatures.push("no-common-ligatures");
    take("liga", "clig");
  }
  if (on("dlig")) {
    ligatures.push("discretionary-ligatures");
    take("dlig");
  }
  if (on("hlig")) {
    ligatures.push("historical-ligatures");
    take("hlig");
  }
  if (off("calt")) {
    ligatures.push("no-contextual");
    take("calt");
  }
  if (ligatures.length) {
    const none = ligatures.length === 2 && ligatures[0] === "no-common-ligatures" && ligatures[1] === "no-contextual";
    out.push(["font-variant-ligatures", none ? "none" : ligatures.join(" ")]);
  }

  // One keyword, for exactly the capitals features that are on, all known to be in the font.
  const capsOn = CAPS_TAGS.filter(on);
  const caps = CAPS.find(([tags]) => tags.length === capsOn.length && tags.every((t) => capsOn.includes(t)));
  if (caps && caps[0].every(known)) {
    out.push(["font-variant-caps", caps[1]]);
    take(...caps[0]);
  }

  const numeric: string[] = [];
  oneOf(numeric, [["lnum", "lining-nums"], ["onum", "oldstyle-nums"]]);
  oneOf(numeric, [["pnum", "proportional-nums"], ["tnum", "tabular-nums"]]);
  oneOf(numeric, [["frac", "diagonal-fractions"], ["afrc", "stacked-fractions"]]);
  oneOf(numeric, [["ordn", "ordinal"]]);
  oneOf(numeric, [["zero", "slashed-zero"]]);
  if (numeric.length) out.push(["font-variant-numeric", numeric.join(" ")]);

  const position: string[] = [];
  oneOf(position, [["subs", "sub"], ["sups", "super"]], true);
  if (position.length) out.push(["font-variant-position", position[0]]);

  const eastAsian: string[] = [];
  oneOf(eastAsian, [["jp78", "jis78"], ["jp83", "jis83"], ["jp90", "jis90"], ["jp04", "jis04"], ["smpl", "simplified"], ["trad", "traditional"]]);
  oneOf(eastAsian, [["fwid", "full-width"], ["pwid", "proportional-width"]]);
  oneOf(eastAsian, [["ruby", "ruby"]]);
  if (eastAsian.length) out.push(["font-variant-east-asian", eastAsian.join(" ")]);

  const alternates: string[] = [];
  oneOf(alternates, [["hist", "historical-forms"]]);
  if (alternates.length) out.push(["font-variant-alternates", alternates[0]]);

  const rest = featureSettings(changes);
  if (rest) out.push(["font-feature-settings", rest]);
  return out;
}
