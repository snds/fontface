// Run with `npm run test:ui`. The preview bar's preview styling (previewStyle.ts), and that it
// matches what the back end saves (src-tauri/src/settings.rs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyCase,
  contrastRatio,
  contrastText,
  DEFAULT_PREVIEW,
  featureSettings,
  paperTone,
  isDefaultPreview,
  PREVIEW_ALIGNS,
  PREVIEW_CASES,
  PREVIEW_FEATURES,
  previewCase,
  previewFeatureValues,
  readableOn,
  READABLE_CONTRAST,
  resolveColors,
  strokeWidth,
  styleCss,
  styleExtra,
  THEME_COLORS,
  UNDERLINE_DEPTH,
  validTag,
  variationSettings,
} from "./previewStyle.ts";

const settingsRs = readFileSync(new URL("../src-tauri/src/settings.rs", import.meta.url), "utf8");

test("the features, alignments and cases match what the back end accepts", () => {
  const rust = settingsRs.match(/PREVIEW_FEATURES: &\[&str\] = &\[([^\]]*)\]/)?.[1];
  assert.ok(rust, "PREVIEW_FEATURES is in settings.rs");
  assert.deepEqual([...rust.matchAll(/"(\w+)"/g)].map((m) => m[1]), PREVIEW_FEATURES.map((f) => f.id));
  const choices = (label: string) => {
    const at = settingsRs.indexOf(`"${label}"`);
    const list = settingsRs.slice(at, settingsRs.indexOf("]", at));
    return [...list.matchAll(/\("(\w+)", /g)].map((m) => m[1]);
  };
  assert.deepEqual(choices("Preview alignment"), PREVIEW_ALIGNS.map((a) => a.id));
  assert.deepEqual(choices("Preview case"), PREVIEW_CASES.map((c) => c.id));
  assert.deepEqual(DEFAULT_PREVIEW, { align: "left", case: "asTyped", outline: false, underline: false, ink: null, paper: null, features: [] });
  assert.ok(isDefaultPreview(DEFAULT_PREVIEW));
  assert.ok(!isDefaultPreview({ ...DEFAULT_PREVIEW, features: ["smallCaps"] }));
});

test("case changes the text itself, so what's measured is what's drawn", () => {
  assert.equal(applyCase("The quick brown fox", "upper"), "THE QUICK BROWN FOX");
  assert.equal(applyCase("The QUICK Brown fox", "lower"), "the quick brown fox");
  assert.equal(applyCase("the QUICK brown-fox's tail", "title"), "The Quick Brown-Fox's Tail");
  assert.equal(applyCase("élan vital 2nd", "title"), "Élan Vital 2nd");
  assert.equal(applyCase("straße", "upper"), "STRASSE", "the result can be longer");
  assert.equal(applyCase("As Typed", "asTyped"), "As Typed");
});

test("typed text always changes case; a sample never; a name only if the font can draw it", () => {
  assert.equal(previewCase("hello", "upper", { typed: true, missing: "HELO" }), "HELLO", "typed: as asked, even with characters missing");
  assert.equal(previewCase("Avenir", "upper", {}), "AVENIR");
  assert.equal(previewCase("Avenir", "upper", { missing: "abc" }), "AVENIR", "it has the capitals");
  assert.equal(previewCase("ALLCAPS", "lower", { missing: "abcdefghijklmnopqrstuvwxyz" }), "ALLCAPS", "a font with capitals only keeps them");
  assert.equal(previewCase("  ", "upper", { sample: true }), "  ");
  assert.equal(previewCase("αβγ", "upper", { sample: true }), "αβγ", "a sample of the font's own characters stays as it is");
  assert.equal(previewCase("Avenir", "asTyped", { typed: true }), "Avenir");
});

test("the features build font-feature-settings, the page's switches on top", () => {
  assert.equal(featureSettings({}), undefined, "nothing set: the font's defaults");
  assert.equal(featureSettings(previewFeatureValues(["smallCaps"])), '"smcp" 1');
  assert.equal(
    featureSettings(previewFeatureValues(["caseForms", "noLigatures", "tabularFigures"])),
    '"calt" 0, "case" 1, "clig" 0, "dlig" 0, "hlig" 0, "liga" 0, "tnum" 1',
    "in tag order, so the same choice always gives the same CSS",
  );
  assert.equal(featureSettings({ 'li"a': 1, "ss01": 1, "toolong": 1, "ok": 1 }), '"ss01" 1', "only tags CSS can carry");
  assert.ok(validTag("cv01") && validTag("lao ") && !validTag(" abc") && !validTag("ab\\c"));
});

test("axis values build font-variation-settings", () => {
  assert.equal(variationSettings({}), undefined);
  assert.equal(variationSettings({ wght: 700, wdth: 87.5 }), '"wght" 700, "wdth" 87.5');
  assert.equal(variationSettings({ wght: 274.31500244 }), '"wght" 274.315', "three decimals are plenty");
  assert.equal(variationSettings({ wght: Number.NaN, "x\"yz": 1 }), undefined);
});

test("contrast is WCAG's", () => {
  assert.equal(Math.round(contrastRatio("#000000", "#ffffff") * 10) / 10, 21);
  assert.equal(contrastRatio("#777777", "#777777"), 1);
  assert.equal(contrastText(4.4999), "4.4:1", "rounded down, never up past a threshold");
  assert.equal(readableOn("#ffffff"), THEME_COLORS.light.ink);
  assert.equal(readableOn("#1d2a5a"), THEME_COLORS.dark.ink);
});

test("the theme's colors by default; one chosen color gets a readable partner", () => {
  const theme = resolveColors({ ink: null, paper: null }, false);
  assert.equal(theme.ink, undefined);
  assert.equal(theme.paper, undefined);
  assert.ok(theme.contrast > 15 && !theme.low);
  // A dark paper in the light theme: the theme's near-black ink wouldn't read, so near-white.
  const navy = resolveColors({ ink: null, paper: "#1D2A5A" }, false);
  assert.deepEqual([navy.ink, navy.paper, navy.adapted, navy.low], [THEME_COLORS.dark.ink, "#1d2a5a", true, false]);
  // The same paper in the dark theme: its ink already reads.
  assert.deepEqual([resolveColors({ ink: null, paper: "#1d2a5a" }, true).ink, resolveColors({ ink: null, paper: "#1d2a5a" }, true).adapted], [undefined, false]);
  // White ink: on the dark page as is, but on the light page it gets a dark paper.
  assert.equal(resolveColors({ ink: "#ffffff", paper: null }, true).paper, undefined);
  const white = resolveColors({ ink: "#ffffff", paper: null }, false);
  assert.equal(white.paper, THEME_COLORS.light.ink);
  assert.ok(white.contrast >= READABLE_CONTRAST && white.adapted);
  // Both chosen: as chosen, with a warning when they're hard to read.
  const pale = resolveColors({ ink: "#cccccc", paper: "#ffffff" }, false);
  assert.deepEqual([pale.ink, pale.paper, pale.low, pale.adapted], ["#cccccc", "#ffffff", true, false]);
  assert.equal(resolveColors({ ink: "#000000", paper: "#f6f1e3" }, true).low, false);
  // Anything that isn't "#rrggbb" counts as the theme's.
  assert.equal(resolveColors({ ink: "red", paper: null }, false).ink, undefined);
});

/** "#rrggbb" for a gray `oklch(L 0 0)`: its linear luminance is L³. */
function oklchGray(l: number): string {
  const y = l ** 3;
  const v = y <= 0.0031308 ? 12.92 * y : 1.055 * y ** (1 / 2.4) - 0.055;
  return `#${Math.round(v * 255).toString(16).padStart(2, "0").repeat(3)}`;
}

test("the theme's colors and surfaces are index.css's", () => {
  const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");
  const block = (selector: string) => css.slice(css.indexOf(`${selector} {`)).split("}")[0];
  const color = (b: string, name: string) => {
    const m = b.match(new RegExp(`--${name}: oklch\\(([\\d.]+) 0 0\\)`));
    assert.ok(m, name);
    return oklchGray(Number(m[1]));
  };
  for (const [selector, theme] of [[":root", THEME_COLORS.light], [".dark", THEME_COLORS.dark]] as const) {
    const b = block(selector);
    assert.equal(theme.ink, color(b, "foreground"), selector);
    assert.equal(theme.paper, color(b, "background"), selector);
    const surfaces = new Set(["background", "card", "accent", "muted"].map((n) => color(b, n)));
    assert.deepEqual([...theme.surfaces].sort(), [...surfaces].sort(), `${selector}: the page, cards, selected and hovered rows`);
  }
});

test("a lone ink must read on every surface previews sit on, not just the page", () => {
  // Dark theme: #606060 reads on the page (3.1:1) but not on a card or a selected row.
  assert.ok(contrastRatio("#606060", THEME_COLORS.dark.paper) >= READABLE_CONTRAST);
  assert.ok(contrastRatio("#606060", "#262626") < READABLE_CONTRAST);
  const gray = resolveColors({ ink: "#606060", paper: null }, true);
  assert.deepEqual([gray.paper, gray.adapted, gray.low], [THEME_COLORS.dark.ink, true, false], "drawn on a paper it reads on");
  assert.ok(gray.contrast >= READABLE_CONTRAST);
  // Light theme: #949494 reads on white, not on a selected row's light gray.
  assert.ok(contrastRatio("#949494", "#ffffff") >= READABLE_CONTRAST && contrastRatio("#949494", "#f5f5f5") < READABLE_CONTRAST);
  assert.equal(resolveColors({ ink: "#949494", paper: null }, false).paper, THEME_COLORS.light.ink);
  // Reads everywhere: no paper, and the contrast shown is the lowest one, on a selected row.
  const white = resolveColors({ ink: "#ffffff", paper: null }, true);
  assert.deepEqual([white.paper, white.adapted], [undefined, false]);
  assert.equal(white.contrast, contrastRatio("#ffffff", "#262626"));
});

test("the paper drawn is marked dark or light, for color fonts' palettes", () => {
  assert.equal(paperTone("#1d2a5a"), "dark");
  assert.equal(paperTone("#000000"), "dark");
  assert.equal(paperTone("#f4efe1"), "light");
  assert.equal(paperTone("#ffffff"), "light");
  assert.equal(resolveColors({ ink: null, paper: null }, true).paperTone, undefined, "no paper: the theme decides");
  assert.equal(resolveColors({ ink: null, paper: "#ffffff" }, true).paperTone, "light", "white paper in the dark theme");
  assert.equal(resolveColors({ ink: null, paper: "#1d2a5a" }, false).paperTone, "dark", "navy paper in the light theme");
  assert.equal(resolveColors({ ink: "#ffffff", paper: "#000000" }, false).paperTone, "dark");
  assert.equal(resolveColors({ ink: "#ffffff", paper: null }, false).paperTone, "dark", "the paper picked for white ink");
  assert.equal(resolveColors({ ink: "#ffffff", paper: null }, true).paperTone, undefined, "white ink on the dark theme's own page");
});

test("outline and underline get room in the fit, and the right CSS", () => {
  assert.deepEqual(styleExtra({ outline: false, underline: false }, 32), { pad: 0, minBottom: 0 });
  assert.equal(strokeWidth(12), 1);
  assert.equal(strokeWidth(96), 2.4);
  assert.equal(styleExtra({ outline: true, underline: false }, 96).pad, 2.4 / 2 / 96, "half the stroke, in em");
  assert.equal(styleExtra({ outline: false, underline: true }, 32).minBottom, UNDERLINE_DEPTH);

  const colors = resolveColors({ ink: "#112233", paper: "#fafaf0" }, false);
  const css = styleCss({ ...DEFAULT_PREVIEW, align: "center", outline: true, underline: true, ink: "#112233", paper: "#fafaf0" }, colors, 40);
  assert.equal(css.textAlign, "center");
  assert.equal(css.color, "#112233");
  assert.equal(css.backgroundColor, "#fafaf0");
  assert.equal(css.WebkitTextStroke, "1px #112233");
  assert.equal(css.WebkitTextFillColor, "transparent");
  assert.equal(css.textUnderlinePosition, "from-font", "the font's own underline");
  assert.equal(styleCss(DEFAULT_PREVIEW, colors, 40, false).backgroundColor, undefined, "paper left to the page's own sheet");
  assert.deepEqual(styleCss(DEFAULT_PREVIEW, resolveColors(DEFAULT_PREVIEW, false), 40), {}, "plain previews stay plain");
  assert.equal(styleCss({ ...DEFAULT_PREVIEW, outline: true }, resolveColors(DEFAULT_PREVIEW, false), 40).WebkitTextStroke, "1px currentColor");
});
