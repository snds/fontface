import type { PreviewAlign, PreviewCase, PreviewFeature, PreviewOptions } from "./api.ts";

/**
 * The View options' preview styling, applied to every layout and to the font page: alignment,
 * case, outline, underline, ink and paper colors, and a few OpenType features for every preview.
 * Pure (no React, no DOM), so `npm run test:ui` covers it. PreviewText (components/PreviewText.tsx)
 * applies it, and previewFit.ts fits the result so nothing is clipped.
 *
 * - **Case** changes the text itself rather than using CSS `text-transform`, so the canvas that
 *   measures the text for fitting measures exactly what's drawn.
 * - **Outline** draws the shapes' edges with no fill (`-webkit-text-stroke`). The stroke reaches
 *   half its width past the ink, so fitting keeps that much more room.
 * - **Underline** uses the font's own underline position and thickness (`from-font`). It sits
 *   below the baseline, so fitting keeps room for it there (`UNDERLINE_DEPTH`).
 * - **Ink and paper** default to the theme's. When only one is chosen, the other is picked to
 *   stay readable against it (`resolveColors`).
 * - **Features** go into `font-feature-settings`. These four never draw outside the plain
 *   text's ink (small capitals are smaller, case forms move punctuation up to the capitals), so
 *   fitting needs nothing more for them.
 */

/** The features every preview can have, in the order the View options show them. Must match
 *  PREVIEW_FEATURES in src-tauri/src/settings.rs. */
export const PREVIEW_FEATURES: readonly { id: PreviewFeature; label: string; description: string; values: Readonly<Record<string, number>> }[] = [
  {
    id: "noLigatures",
    label: "No ligatures",
    description: "Letters such as f and i stay apart",
    values: { liga: 0, clig: 0, dlig: 0, hlig: 0, calt: 0 },
  },
  { id: "smallCaps", label: "Small caps", description: "Lowercase letters as small capitals", values: { smcp: 1 } },
  { id: "tabularFigures", label: "Tabular figures", description: "Figures of equal width, for columns", values: { tnum: 1 } },
  { id: "caseForms", label: "Case forms", description: "Punctuation set for capitals", values: { case: 1 } },
];

/** The alignments and cases, in the order the View options show them. Must match the choices
 *  `preview_options` accepts in src-tauri/src/settings.rs. */
export const PREVIEW_ALIGNS: readonly { id: PreviewAlign; label: string; icon: string }[] = [
  { id: "left", label: "Left", icon: "format_align_left" },
  { id: "center", label: "Center", icon: "format_align_center" },
  { id: "right", label: "Right", icon: "format_align_right" },
];
export const PREVIEW_CASES: readonly { id: PreviewCase; label: string; short: string }[] = [
  { id: "asTyped", label: "As typed", short: "As typed" },
  { id: "upper", label: "UPPERCASE", short: "AB" },
  { id: "lower", label: "lowercase", short: "ab" },
  { id: "title", label: "Title Case", short: "Ab" },
];

export const DEFAULT_PREVIEW: PreviewOptions = {
  align: "left",
  case: "asTyped",
  outline: false,
  underline: false,
  ink: null,
  paper: null,
  features: [],
};

/** Whether these are the default options (nothing to reset). */
export const isDefaultPreview = (o: PreviewOptions) =>
  o.align === "left" && o.case === "asTyped" && !o.outline && !o.underline && !o.ink && !o.paper && o.features.length === 0;

// ----------------------------------------------------------------------------------- case

const WORD = /[\p{L}\p{M}\p{N}'’]+/gu;

/** The text in this case. Title: each word's first letter in capitals and the rest in lowercase. */
export function applyCase(text: string, mode: PreviewCase): string {
  switch (mode) {
    case "upper":
      return text.toLocaleUpperCase();
    case "lower":
      return text.toLocaleLowerCase();
    case "title":
      return text.replace(WORD, (w) => {
        const [first, ...rest] = [...w];
        return first.toLocaleUpperCase() + rest.join("").toLocaleLowerCase();
      });
    default:
      return text;
  }
}

/**
 * What a preview draws in this case. Typed text always changes. A sample of the font's own
 * characters never does (it's there because the font can't draw letters, or not these). The
 * font's name or the page's words change only if the font has every character of the result
 * (`missing`: the printable ASCII characters it can't draw), so a font with capitals only
 * keeps its name in capitals.
 */
export function previewCase(text: string, mode: PreviewCase, from: { typed?: boolean; sample?: boolean; missing?: string }): string {
  if (mode === "asTyped" || from.sample || !text) return text;
  const out = applyCase(text, mode);
  if (from.typed || !from.missing) return out;
  const missing = from.missing;
  return [...out].some((c) => missing.includes(c)) ? text : out;
}

// ------------------------------------------------------------------- features and axes

/** OpenType feature values by tag: 1 on, 0 off. */
export type FeatureValues = Readonly<Record<string, number>>;

/** A tag CSS can carry: four printable ASCII characters, without quotes or backslashes. */
export const validTag = (tag: string) => /^[\x20-\x7e]{4}$/.test(tag) && !/["\\]/.test(tag) && tag[0] !== " ";

/** The four-character tag for a trimmed one ("lao" is "lao "). */
export const padTag = (tag: string) => (tag.length < 4 ? tag.padEnd(4, " ") : tag);

/** The values the View options' features stand for. */
export function previewFeatureValues(features: readonly PreviewFeature[]): FeatureValues {
  const out: Record<string, number> = {};
  for (const f of PREVIEW_FEATURES) if (features.includes(f.id)) Object.assign(out, f.values);
  return out;
}

/** `font-feature-settings` for these values, tags in order (undefined: none, the font's defaults). */
export function featureSettings(values: FeatureValues): string | undefined {
  const tags = Object.keys(values)
    .filter(validTag)
    .sort();
  return tags.length ? tags.map((t) => `"${t}" ${values[t] ? 1 : 0}`).join(", ") : undefined;
}

/** `font-variation-settings` for axis values (undefined: none, the defaults). */
export function variationSettings(values: Readonly<Record<string, number>>): string | undefined {
  const parts = Object.entries(values)
    .filter(([tag, v]) => validTag(padTag(tag)) && Number.isFinite(v))
    .map(([tag, v]) => `"${padTag(tag)}" ${Math.round(v * 1000) / 1000}`);
  return parts.length ? parts.join(", ") : undefined;
}

// ------------------------------------------------------------------------------- colors

/**
 * The theme's colors (index.css): its text (`--foreground`) and page (`--background`), and every
 * surface a preview without a paper of its own is drawn on: the page, Tiles' cards (`--card`),
 * and selected or hovered rows and tiles (`--accent`, `--muted`). In the dark theme those are
 * lighter than the page, in the light theme darker.
 */
export const THEME_COLORS = {
  light: { ink: "#0a0a0a", paper: "#ffffff", surfaces: ["#ffffff", "#f5f5f5"] },
  dark: { ink: "#fafafa", paper: "#0a0a0a", surfaces: ["#0a0a0a", "#171717", "#262626"] },
} as const;

/** "#rrggbb" (any case), or null. */
export const isColor = (c: unknown): c is string => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);

function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance of "#rrggbb". */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colors, from 1 (none) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Large preview text reads well from 3:1 (WCAG's large-text minimum); below that, a warning. */
export const READABLE_CONTRAST = 3;

/** Of near-black and near-white, the one that reads best on `background`. */
export function readableOn(background: string): string {
  const { light, dark } = THEME_COLORS;
  return contrastRatio(light.ink, background) >= contrastRatio(dark.ink, background) ? light.ink : dark.ink;
}

export interface PreviewColors {
  /** The text color to set, or undefined for the theme's. */
  ink?: string;
  /** The paper to draw behind previews, or undefined for none (the page shows through). */
  paper?: string;
  /** Whether that paper is dark or light (undefined: no paper, the theme's surfaces show).
   *  Marks the element that draws it (`data-paper`), so a color font's palette follows the
   *  paper rather than the theme (colorPalette.ts). */
  paperTone?: PaperTone;
  /** Contrast between the ink and the paper the previews are drawn on. */
  contrast: number;
  /** Below `READABLE_CONTRAST`: only when both colors were chosen (otherwise one adapts). */
  low: boolean;
  /** One of the colors was picked to stay readable against the chosen one. */
  adapted: boolean;
}

export type PaperTone = "dark" | "light";

/** Dark if light text reads better on it than dark text does. */
export const paperTone = (paper: string): PaperTone => (readableOn(paper) === THEME_COLORS.dark.ink ? "dark" : "light");

/**
 * The colors previews are drawn in. Neither chosen: the theme's. Only paper: the theme's ink if
 * it reads on that paper, else near-black or near-white. Only ink: straight on the theme's
 * surfaces if it reads on every one of them (the page, a card, a selected row), else on a paper
 * of near-black or near-white. Both: as chosen, with `low` set when they're hard to read.
 */
export function resolveColors(o: Pick<PreviewOptions, "ink" | "paper">, dark: boolean): PreviewColors {
  const theme = dark ? THEME_COLORS.dark : THEME_COLORS.light;
  const ink = isColor(o.ink) ? o.ink.toLowerCase() : null;
  const paper = isColor(o.paper) ? o.paper.toLowerCase() : null;
  if (ink && paper) {
    const contrast = contrastRatio(ink, paper);
    return { ink, paper, paperTone: paperTone(paper), contrast, low: contrast < READABLE_CONTRAST, adapted: false };
  }
  if (paper) {
    const fits = contrastRatio(theme.ink, paper) >= READABLE_CONTRAST;
    const shown = fits ? theme.ink : readableOn(paper);
    return { ink: fits ? undefined : shown, paper, paperTone: paperTone(paper), contrast: contrastRatio(shown, paper), low: false, adapted: !fits };
  }
  if (ink) {
    // The surface it reads worst on is the one that counts.
    const worst = Math.min(...theme.surfaces.map((surface) => contrastRatio(ink, surface)));
    if (worst >= READABLE_CONTRAST) return { ink, contrast: worst, low: false, adapted: false };
    const under = readableOn(ink);
    return { ink, paper: under, paperTone: paperTone(under), contrast: contrastRatio(ink, under), low: false, adapted: true };
  }
  return { contrast: contrastRatio(theme.ink, theme.paper), low: false, adapted: false };
}

/** "4.5:1", rounded down so a ratio just under a threshold never reads as meeting it. */
export const contrastText = (ratio: number) => `${Math.floor(ratio * 10) / 10}:1`;

// ------------------------------------------------------------------------------ drawing

/** How far below the baseline an underline may reach, in em. Fonts put theirs about 0.1 em
 *  down and 0.05 em thick; this leaves room for unusually low ones. */
export const UNDERLINE_DEPTH = 0.25;

/** The outline's stroke width in px at a size: 1 px, a little more for big text. */
export const strokeWidth = (sizePx: number) => Math.max(1, Math.round((sizePx / 40) * 10) / 10);

/** Extra room the fit keeps for the styling (previewFit's `FitExtra`), in em. */
export interface StyleExtra {
  /** Past the ink on every side: half the outline's stroke. */
  pad: number;
  /** The least depth below the baseline: the underline. */
  minBottom: number;
}

export function styleExtra(o: Pick<PreviewOptions, "outline" | "underline">, sizePx: number): StyleExtra {
  return {
    pad: o.outline && sizePx > 0 ? strokeWidth(sizePx) / 2 / sizePx : 0,
    minBottom: o.underline ? UNDERLINE_DEPTH : 0,
  };
}

/** CSS for the styling at a size (alignment, outline, underline, colors). `paper` false leaves
 *  the paper to an enclosing element (the font page's waterfall draws one sheet for all lines). */
export function styleCss(o: PreviewOptions, colors: PreviewColors, sizePx: number, paper = true): Record<string, string | number> {
  const css: Record<string, string | number> = {};
  if (o.align !== "left") css.textAlign = o.align;
  if (colors.ink) css.color = colors.ink;
  if (paper && colors.paper) {
    css.backgroundColor = colors.paper;
    css.paddingInline = "0.35em";
    css.borderRadius = 4;
  }
  if (o.outline) {
    css.WebkitTextStroke = `${strokeWidth(sizePx)}px ${colors.ink ?? "currentColor"}`;
    css.WebkitTextFillColor = "transparent";
  }
  if (o.underline) {
    css.textDecorationLine = "underline";
    css.textUnderlinePosition = "from-font";
    css.textDecorationThickness = "from-font";
  }
  return css;
}
