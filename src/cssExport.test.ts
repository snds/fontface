// Run with `npm run test:ui`. Copy as CSS on the font page (cssExport.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AxisInfo } from "./axisField.ts";
import { cssFamilyName, cssNumber, cssText, featureDeclarations, fontFamilyValue, type CssStyle } from "./cssExport.ts";
import { previewFeatureValues } from "./previewStyle.ts";

const STATIC: CssStyle = { family: "Inter", weight: 400, width: 5, italic: false, axes: [], values: {}, features: {} };

const FLEX: AxisInfo[] = [
  { tag: "GRAD", min: -200, max: 150, default: 0 },
  { tag: "opsz", min: 8, max: 144, default: 14 },
  { tag: "slnt", min: -10, max: 0, default: 0 },
  { tag: "wdth", min: 25, max: 151, default: 100 },
  { tag: "wght", min: 100, max: 1000, default: 400 },
  { tag: "XTRA", min: 323, max: 603, default: 468 },
];
const flex = (values: Record<string, number>): CssStyle => ({ ...STATIC, family: "Roboto Flex", generic: "sans-serif", axes: FLEX, values });

/** The declarations as "property: value" lines, for comparing. */
const lines = (s: CssStyle) => cssText(s).split("\n");

test("a static style: its family, weight and slope, and its width when it isn't normal", () => {
  assert.equal(cssText(STATIC), "font-family: Inter;\nfont-weight: 400;\nfont-style: normal;", "no fallback when the kind isn't known");
  assert.deepEqual(lines({ ...STATIC, family: "Helvetica Neue", generic: "sans-serif", weight: 700, width: 3, italic: true }), [
    'font-family: "Helvetica Neue", sans-serif;',
    "font-weight: 700;",
    "font-stretch: 75%;",
    "font-style: italic;",
  ]);
  assert.ok(lines({ ...STATIC, width: 7 }).includes("font-stretch: 125%;"));
  assert.ok(!cssText({ ...STATIC, weight: 0 }).includes("font-weight"), "a weight CSS can't take is left out");
  assert.ok(!cssText({ ...STATIC, family: "  " }).includes("font-family"), "no name, no family line");
});

test("family names are quoted unless they're one plain word, and get a generic fallback when it's known", () => {
  assert.equal(cssFamilyName("Inter"), "Inter");
  assert.equal(cssFamilyName("Font-Awesome"), "Font-Awesome");
  assert.equal(cssFamilyName("Ünïcode"), "Ünïcode", "non-ASCII letters are fine in a name");
  assert.equal(cssFamilyName("Inter Display"), '"Inter Display"');
  assert.equal(cssFamilyName("3Dumb"), '"3Dumb"', "a name can't start with a figure");
  assert.equal(cssFamilyName("Serif"), '"Serif"', "a generic family's name");
  assert.equal(cssFamilyName("Inherit"), '"Inherit"', "a word CSS reserves");
  assert.equal(cssFamilyName("Inter.Var"), '"Inter.Var"');
  assert.equal(cssFamilyName('Big "Q" \\ Co'), '"Big \\"Q\\" \\\\ Co"', "quotes and backslashes are escaped");
  assert.equal(fontFamilyValue("Courier Prime", "monospace"), '"Courier Prime", monospace');
  assert.equal(fontFamilyValue("Garamond", "serif"), "Garamond, serif");
  assert.equal(fontFamilyValue("Garamond", null), "Garamond");
});

test("axes use CSS's own properties; optical size is auto while it follows the text size", () => {
  assert.deepEqual(lines(flex({})), [
    'font-family: "Roboto Flex", sans-serif;',
    "font-weight: 400;",
    "font-stretch: 100%;",
    "font-style: normal;",
    "font-optical-sizing: auto;",
  ], "at the defaults, the font's own axes say nothing");
  assert.deepEqual(lines(flex({ wght: 650, wdth: 87.5, slnt: -10, GRAD: 50.25 })).slice(1), [
    "font-weight: 650;",
    "font-stretch: 87.5%;",
    "font-style: oblique 10deg;",
    "font-optical-sizing: auto;",
    'font-variation-settings: "GRAD" 50.25;',
  ], "slnt -10 leans right, which is oblique 10deg");
});

test("optical size set by hand goes in font-variation-settings, with the font's own axes, in the font's order", () => {
  const css = lines(flex({ opsz: 36, XTRA: 500, GRAD: -50 }));
  assert.ok(!css.some((l) => l.startsWith("font-optical-sizing")), "no auto once it's set by hand");
  assert.equal(css.at(-1), 'font-variation-settings: "GRAD" -50, "opsz" 36, "XTRA" 500;');
  assert.ok(lines(flex({ opsz: 14 })).includes('font-variation-settings: "opsz" 14;'), "even at its default: it was set by hand");
  assert.ok(lines(flex({ XTRA: 468.0001 })).every((l) => !l.includes("XTRA")), "a custom axis at its default says nothing");
});

test("values CSS's own properties can't say go in font-variation-settings instead", () => {
  const axes: AxisInfo[] = [
    { tag: "wght", min: 0, max: 1200, default: 400 },
    { tag: "ital", min: 0, max: 1, default: 0 },
    { tag: "slnt", min: -20, max: 0, default: 0 },
  ];
  const css = (values: Record<string, number>) => lines({ ...STATIC, axes, values });
  assert.deepEqual(css({ wght: 1100 }), ["font-family: Inter;", "font-style: normal;", 'font-variation-settings: "wght" 1100;'], "font-weight stops at 1000");
  assert.ok(css({ ital: 1 }).includes("font-style: italic;"));
  assert.deepEqual(css({ ital: 0.5 }).slice(-2), ["font-style: normal;", 'font-variation-settings: "ital" 0.5;'], "half italic");
  assert.deepEqual(css({ ital: 1, slnt: -12 }).slice(-2), ["font-style: italic;", 'font-variation-settings: "slnt" -12;'], "italic and slanted: one property can't say both");
  assert.ok(css({ wght: 274.31500244 }).includes("font-weight: 274.315;"), "three decimals");
  assert.ok(lines({ ...STATIC, italic: true, axes: [{ tag: "wght", min: 100, max: 900, default: 400 }], values: {} }).includes("font-style: italic;"), "an italic file with no ital axis");
  assert.ok(lines({ ...STATIC, axes: [{ tag: "wdth", min: 0, max: 100, default: 100 }], values: { wdth: 0 } }).includes('font-variation-settings: "wdth" 0;'));
  assert.equal(cssNumber(-0.0001), "0");
});

test("features: only changes from the default, as font-variant keywords where they say exactly the same", () => {
  const css = (features: Record<string, number>, has: string[] | null = null) => featureDeclarations(features, has && new Set(has));
  assert.deepEqual(css({ liga: 1, calt: 1, kern: 1, dlig: 0, smcp: 0 }), [], "already the defaults");
  assert.deepEqual(css(previewFeatureValues(["noLigatures"])), [["font-variant-ligatures", "none"]], "the preview bar's No ligatures");
  assert.deepEqual(css({ onum: 1, tnum: 1 }), [["font-variant-numeric", "oldstyle-nums tabular-nums"]]);
  assert.deepEqual(css({ frac: 1, zero: 1, ordn: 1 }), [["font-variant-numeric", "diagonal-fractions ordinal slashed-zero"]]);
  assert.deepEqual(css({ lnum: 1, onum: 1 }), [["font-feature-settings", '"lnum" 1, "onum" 1']], "two figure styles at once: no keyword says that");
  assert.deepEqual(css({ kern: 0 }), [["font-kerning", "none"]]);
  assert.deepEqual(css({ dlig: 1, calt: 0 }), [["font-variant-ligatures", "discretionary-ligatures no-contextual"]]);
  assert.deepEqual(css({ hist: 1, jp78: 1, fwid: 1 }), [
    ["font-variant-east-asian", "jis78 full-width"],
    ["font-variant-alternates", "historical-forms"],
  ]);
  assert.deepEqual(css({ ss01: 1, case: 1, cv11: 1 }), [["font-feature-settings", '"case" 1, "cv11" 1, "ss01" 1']], "no keyword: in tag order");
});

test("common ligatures are liga and clig together; a feature the style lacks counts as off", () => {
  const css = (features: Record<string, number>, has: string[] | null) => featureDeclarations(features, has && new Set(has));
  assert.deepEqual(css({ liga: 0 }, null), [["font-feature-settings", '"liga" 0']], "clig may still be on");
  assert.deepEqual(css({ liga: 0 }, ["liga", "clig"]), [["font-feature-settings", '"liga" 0']]);
  assert.deepEqual(css({ liga: 0 }, ["liga", "kern"]), [["font-variant-ligatures", "no-common-ligatures"]], "no clig to keep on");
  assert.deepEqual(css({ liga: 0, calt: 0 }, ["liga"]), [["font-variant-ligatures", "no-common-ligatures"]], "calt isn't in it either");
  assert.deepEqual(css({ ss01: 1, smcp: 1 }, ["ss01"]), [["font-feature-settings", '"ss01" 1']], "a switch for a missing feature changes nothing");
});

test("keywords that could fake a missing feature are used only when the style has it", () => {
  const css = (features: Record<string, number>, has: string[] | null) => featureDeclarations(features, has && new Set(has));
  assert.deepEqual(css({ smcp: 1 }, ["smcp"]), [["font-variant-caps", "small-caps"]]);
  assert.deepEqual(css({ smcp: 1 }, null), [["font-feature-settings", '"smcp" 1']], "not known: the browser might fake small caps");
  assert.deepEqual(css({ smcp: 1, c2sc: 1 }, ["smcp", "c2sc"]), [["font-variant-caps", "all-small-caps"]]);
  assert.deepEqual(css({ pcap: 1 }, ["pcap"]), [["font-variant-caps", "petite-caps"]]);
  assert.deepEqual(css({ c2sc: 1 }, ["c2sc", "smcp"]), [["font-feature-settings", '"c2sc" 1']], "capitals only: no keyword");
  assert.deepEqual(css({ smcp: 1, unic: 1 }, ["smcp", "unic"]), [["font-feature-settings", '"smcp" 1, "unic" 1']]);
  assert.deepEqual(css({ sups: 1 }, ["sups"]), [["font-variant-position", "super"]]);
  assert.deepEqual(css({ subs: 1 }, null), [["font-feature-settings", '"subs" 1']]);
  assert.deepEqual(css({ subs: 1, sups: 1 }, ["subs", "sups"]), [["font-feature-settings", '"subs" 1, "sups" 1']]);
});

test("the whole CSS, in order: family, axes, then features", () => {
  const style: CssStyle = {
    ...flex({ wght: 700, opsz: 72 }),
    features: { ...previewFeatureValues(["tabularFigures", "caseForms"]), smcp: 1, kern: 0, ss02: 1 },
    has: new Set(["smcp", "tnum", "case", "kern", "ss02", "liga"]),
  };
  assert.equal(
    cssText(style),
    [
      'font-family: "Roboto Flex", sans-serif;',
      "font-weight: 700;",
      "font-stretch: 100%;",
      "font-style: normal;",
      'font-variation-settings: "opsz" 72;',
      "font-kerning: none;",
      "font-variant-caps: small-caps;",
      "font-variant-numeric: tabular-nums;",
      'font-feature-settings: "case" 1, "ss02" 1;',
    ].join("\n"),
  );
});
