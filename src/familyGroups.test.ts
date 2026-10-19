// Run with `npm run test:ui`. Family grouping by name (familyGroups.ts, through library.ts):
// every example and guard in the plan (ui-3-plan.md 5.3 and 5.5), the style labels and sort
// order (5.4), and the precedence of your choices and rules (5.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FontSummary } from "./api.ts";
import { filterFamilies, groupFamilies, groupLibrary, ungroup, type Family } from "./library.ts";
import { weightText } from "./familyFacts.ts";
import {
  analyzeName,
  foundryKey,
  leftover,
  postscriptStems,
  reasonText,
  sameFoundry,
  squash,
  styleLabel,
  suggestGroups,
  suggestionText,
  traitsOf,
  widen,
  type FaceChoice,
  type GroupingOptions,
  type NameRule,
} from "./familyGroups.ts";

let nextId = 1;
/** A font as the list sends it. The PostScript name defaults to the family and style squashed
 *  together with a hyphen, as most fonts have it; `ps: null` leaves it out. */
function font(family: string, subfamily = "Regular", more: Partial<FontSummary> = {}): FontSummary {
  const id = nextId++;
  return {
    id,
    folderId: 1,
    path: `/fonts/${id}.otf`,
    faceIndex: 0,
    family,
    subfamily,
    fullName: `${family} ${subfamily}`,
    postscriptName: `${family.replace(/[\s™®]/g, "")}-${subfamily.replace(/\s/g, "")}`,
    weight: 400,
    width: 5,
    italic: false,
    monospace: false,
    variable: false,
    format: "OpenType CFF",
    activated: false,
    installed: false,
    mtime: 1,
    fileSize: 1000,
    osActive: false,
    glyphCount: 100,
    preview: null,
    ...more,
  };
}

const ON: GroupingOptions = { byName: true };
const OFF: GroupingOptions = { byName: false };
const names = (families: Family[]) => families.map((f) => f.name);
const family = (families: Family[], name: string) => {
  const f = families.find((x) => x.name === name);
  assert.ok(f, `a family named ${name} (have: ${names(families).join(", ")})`);
  return f;
};
const styles = (f: Family) => f.faces.map((x) => x.style);
const suggestionsOf = (fonts: FontSummary[], options: GroupingOptions = ON) => {
  const { families, plan } = groupLibrary(fonts, options);
  return suggestGroups(families, plan, options);
};

// ------------------------------------------------------------------------- 5.5 examples

test("Abhaya Libre ExtraBold and Medium join Abhaya Libre (weight words, PostScript prefix)", () => {
  const families = groupFamilies(
    [font("Abhaya Libre ExtraBold"), font("Abhaya Libre Medium"), font("Abhaya Libre")].map((f) => ({
      ...f,
      postscriptName: `AbhayaLibre-${f.family.split(" ")[2] ?? "Regular"}`,
    })),
    ON,
  );
  assert.deepEqual(names(families), ["Abhaya Libre"]);
  assert.deepEqual(styles(families[0]), ["Regular", "Medium", "ExtraBold"], "light to heavy, though every one says weight 400");
  assert.ok(families[0].faces.slice(0, 2).every((f) => f.groupedBy !== "own" || f.primary.family === "Abhaya Libre"));
  assert.equal(families[0].faces[2].groupedBy, "name");
});

test("AmintaBold and AmintaBlackItalic join Aminta at the lowercase-to-uppercase step", () => {
  const families = groupFamilies(
    [
      font("AmintaBold", "Regular", { postscriptName: "AmintaBold", weight: 700 }),
      font("AmintaBlackItalic", "Regular", { postscriptName: "AmintaBlackItalic", weight: 900, italic: true }),
      font("Aminta", "Regular", { postscriptName: "Aminta" }),
    ],
    ON,
  );
  assert.deepEqual(names(families), ["Aminta"]);
  assert.deepEqual(styles(families[0]), ["Regular", "Bold", "Black Italic"]);
});

test("Aaux ProBold and AauxPro-BlackOSF are one family, Aaux Pro, with no Aaux Pro font of its own", () => {
  const fonts = [
    font("Aaux ProBold", "Regular", { postscriptName: "AauxProBold" }),
    font("Aaux ProThin", "Regular", { postscriptName: "AauxProThin" }),
    font("Aaux ProRegular", "Regular", { postscriptName: "AauxProRegular" }),
    font("Aaux ProBlack Italic OSF", "Regular", { postscriptName: "AauxProBlackItalicOSF", italic: true }),
    font("Aaux ProBlack SC", "Regular", { postscriptName: "AauxProBlackSC" }),
    font("AauxPro-BlackOSF", "Regular", { postscriptName: "AauxPro-BlackOSF" }),
    // 406 of Sean's italics aren't flagged as italic.
    font("AauxPro-ThinItalicOSF", "Regular", { postscriptName: "AauxPro-ThinItalicOSF" }),
  ];
  const families = groupFamilies(fonts, ON);
  assert.deepEqual(names(families), ["Aaux Pro"], "squash key aauxpro; the spelling with a space wins");
  assert.deepEqual(styles(families[0]), ["Thin", "Regular", "Bold", "Black OSF", "Black SC", "Thin Italic OSF", "Black Italic OSF"]);
});

test("Dynasty Heavy is Dynasty's Heavy (weight word)", () => {
  const families = groupFamilies(
    [
      font("Dynasty", "Bold", { postscriptName: "DynastyBold", weight: 700 }),
      font("Dynasty Heavy", "Regular", { postscriptName: "DynastyHeavy" }),
      font("Dynasty Heavy", "Italic", { postscriptName: "DynastyHeavyItalic", italic: true }),
      font("DynastyThin-Italic", "Regular", { postscriptName: "DynastyThin-Italic" }),
    ],
    ON,
  );
  assert.deepEqual(names(families), ["Dynasty"]);
  assert.deepEqual(styles(families[0]), ["Bold", "Heavy", "Thin Italic", "Heavy Italic"]);
});

test("Big Caslon / BigCaslon and Hoefler Text / HoeflerText differ only in spelling: merged", () => {
  const families = groupFamilies(
    [
      // The same foundry, and PostScript names that don't help.
      font("Big Caslon", "Medium", { postscriptName: "BCas-Medium", manufacturer: "Apple Inc." }),
      font("BigCaslon", "Alternate", { postscriptName: "BCAlt", manufacturer: "Apple Computer, Inc." }),
      // The PostScript name agrees.
      font("Hoefler Text", "Regular", { postscriptName: "HoeflerText-Regular" }),
      font("HoeflerText", "Bold", { postscriptName: "HoeflerText-Bold" }),
      font("HoeflerText", "Italic", { postscriptName: "HoeflerText-Italic" }),
    ],
    ON,
  );
  assert.deepEqual(names(families), ["Big Caslon", "Hoefler Text"], "the spelling with spaces is shown");
  assert.deepEqual(styles(family(families, "Big Caslon")), ["Alternate", "Medium"], "Medium is heavier than the 400 the fonts say");
  assert.equal(family(families, "Hoefler Text").faces.length, 3);
});

test("Arial Narrow, MetaCond and FarnhamDisplay are only suggested (width and size words)", () => {
  const fonts = [
    font("Arial", "Regular", { postscriptName: "ArialMT", manufacturer: "Monotype" }),
    font("Arial Narrow", "Regular", { postscriptName: "ArialNarrow", manufacturer: "Monotype" }),
    font("Arial Narrow", "Bold", { postscriptName: "ArialNarrow-Bold", manufacturer: "Monotype", weight: 700 }),
    font("Meta", "Normal", { postscriptName: "Meta-Normal" }),
    font("MetaCond", "Normal", { postscriptName: "MetaCond-Normal" }),
    font("FarnhamDisplay", "Regular", { postscriptName: "FarnhamDisplay-Regular" }),
    font("FarnhamDisplay-Bold", "Normal", { postscriptName: "FarnhamDisplay-Bold" }),
    font("FarnhamText", "Regular", { postscriptName: "FarnhamText-Regular" }),
  ];
  const families = groupFamilies(fonts, ON);
  assert.deepEqual(names(families), ["Arial", "Arial Narrow", "FarnhamDisplay", "FarnhamText", "Meta", "MetaCond"], "FarnhamDisplay-Bold still joins FarnhamDisplay");
  const suggestions = suggestionsOf(fonts);
  const into = (name: string) => suggestions.find((s) => s.into === name);
  assert.deepEqual(
    into("Arial")?.sources.map((s) => [s.family.name, s.reason, s.word]),
    [["Arial Narrow", "width", "Narrow"]],
  );
  assert.deepEqual(into("Meta")?.sources.map((s) => [s.family.name, s.reason]), [["MetaCond", "width"]]);
  // No Farnham family: two names reduce to it, so it's offered.
  assert.deepEqual(into("Farnham")?.sources.map((s) => [s.family.name, s.reason, s.word]), [
    ["FarnhamDisplay", "optical", "Display"],
    ["FarnhamText", "optical", "Text"],
  ]);
  assert.equal(into("Farnham")?.existing, undefined);
  assert.equal(suggestionText(into("Farnham")!), "Merge 2 families into Farnham (3 styles)");
  assert.equal(suggestionText(into("Arial")!), "Merge “Arial Narrow” into Arial (3 styles)");
  assert.equal(reasonText(into("Arial")!.sources[0]), "Width word “Narrow”");
});

test("Univers 45 Light is a numbered style: only suggested", () => {
  const fonts = [
    font("Univers 45 Light", "Regular", { postscriptName: "Univers-Light", weight: 300 }),
    font("Univers 55 Roman", "Regular", { postscriptName: "Univers-Roman" }),
    font("Univers 65 Bold", "Regular", { postscriptName: "Univers-Bold", weight: 700 }),
  ];
  const families = groupFamilies(fonts, ON);
  assert.equal(families.length, 3, "nothing merges automatically");
  const suggestions = suggestionsOf(fonts);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].into, "Univers", "suggested for the family without the number");
  assert.deepEqual(
    suggestions[0].sources.map((src) => [src.family.name, src.reason, src.word]),
    [
      ["Univers 45 Light", "number", "45"],
      ["Univers 55 Roman", "number", "55"],
      ["Univers 65 Bold", "number", "65"],
    ],
  );
  assert.equal(reasonText(suggestions[0].sources[0]), "Numbered style");
  // Its Oblique is a slope word on Univers 45 Light's own name: the number is part of that
  // family's name (as in Bodoni 72), so it joins it, and the family is still only suggested.
  const oblique = [...fonts, font("Univers 45 Light Oblique", "Regular", { postscriptName: "Univers-LightOblique", weight: 300 })];
  const withOblique = groupFamilies(oblique, ON);
  assert.deepEqual(styles(family(withOblique, "Univers 45 Light")), ["Regular", "Oblique"]);
  assert.deepEqual(suggestionsOf(oblique)[0].sources.map((src) => [src.family.name, src.word]), [
    ["Univers 45 Light", "45"],
    ["Univers 55 Roman", "55"],
    ["Univers 65 Bold", "65"],
  ]);
});

test("Barlow Condensed and Avenir Next Condensed name their own families (G1): they stay", () => {
  const fonts = [
    font("Barlow", "Regular", { postscriptName: "Barlow-Regular", hasTypoFamily: false }),
    font("Barlow Condensed", "Medium", { postscriptName: "BarlowCondensed-Medium", hasTypoFamily: true }),
    font("Avenir Next", "Regular", { postscriptName: "AvenirNext-Regular", hasTypoFamily: true }),
    font("Avenir Next Condensed", "Bold", { postscriptName: "AvenirNextCondensed-Bold", hasTypoFamily: true, weight: 700 }),
  ];
  assert.deepEqual(names(groupFamilies(fonts, ON)), ["Avenir Next", "Avenir Next Condensed", "Barlow", "Barlow Condensed"]);
});

test("G1 holds back even a weight word when the font names its own family, as a suggestion", () => {
  const fonts = [
    font("Gotham", "Regular", { postscriptName: "Gotham-Regular" }),
    font("Gotham Black", "Regular", { postscriptName: "Gotham-Black", weight: 900, hasTypoFamily: true }),
  ];
  assert.deepEqual(names(groupFamilies(fonts, ON)), ["Gotham", "Gotham Black"]);
  const [s] = suggestionsOf(fonts);
  assert.deepEqual([s.into, s.sources[0].family.name, s.sources[0].reason], ["Gotham", "Gotham Black", "ownName"]);
  // Not read yet (an online-only file): it isn't held back.
  const unread = fonts.map((f) => ({ ...f, hasTypoFamily: undefined }));
  assert.deepEqual(names(groupFamilies(unread, ON)), ["Gotham"]);
});

test("Noto Sans Arabic, Roboto Mono and Gill Sans Nova aren't style words: separate, not suggested", () => {
  const fonts = [
    font("Noto Sans"),
    font("Noto Sans Arabic"),
    font("Roboto"),
    font("Roboto Mono"),
    font("Gill Sans"),
    font("Gill Sans Nova"),
  ];
  assert.equal(groupFamilies(fonts, ON).length, 6);
  assert.deepEqual(suggestionsOf(fonts), []);
});

test("Book Antiqua and Moonlight stay: only words at the end, and only where a word starts", () => {
  const fonts = [font("Book"), font("Book Antiqua"), font("Moon"), font("Moonlight", "Regular", { weight: 300 })];
  assert.deepEqual(names(groupFamilies(fonts, ON)), ["Book", "Book Antiqua", "Moon", "Moonlight"]);
  assert.deepEqual(suggestionsOf(fonts), []);
});

test("Flyerfonts-*: a PostScript prefix alone never merges", () => {
  const fonts = [
    font("Flyerfonts Alpha", "Regular", { postscriptName: "Flyerfonts-Alpha" }),
    font("Flyerfonts Bravo", "Regular", { postscriptName: "Flyerfonts-Bravo" }),
    font("Flyerfonts", "Regular", { postscriptName: "Flyerfonts-Regular" }),
  ];
  assert.equal(groupFamilies(fonts, ON).length, 3);
  assert.deepEqual(suggestionsOf(fonts), []);
});

test("Agu Display stays separate: a size word, and no Agu family", () => {
  const fonts = [font("Agu Display"), font("ADLaM Display")];
  assert.deepEqual(names(groupFamilies(fonts, ON)), ["ADLaM Display", "Agu Display"]);
  assert.deepEqual(suggestionsOf(fonts), []);
});

// --------------------------------------------------------------------------- 5.3 guards

test("G2: a width or size word never merges on its own, even with every signal", () => {
  const fonts = [
    font("Kappa", "Regular", { postscriptName: "Kappa-Regular", manufacturer: "Kappa Type" }),
    font("Kappa Condensed", "Regular", { postscriptName: "Kappa-Condensed", manufacturer: "Kappa Type" }),
    font("Kappa Text", "Regular", { postscriptName: "Kappa-Text", manufacturer: "Kappa Type" }),
  ];
  assert.equal(groupFamilies(fonts, ON).length, 3);
  assert.deepEqual(
    suggestionsOf(fonts)[0].sources.map((s) => s.reason),
    ["width", "optical"],
  );
});

test("G2: a weight word after a width word joins the width's own family", () => {
  const families = groupFamilies(
    [font("Kappa Condensed", "Regular", { postscriptName: "KappaCondensed-Regular" }), font("Kappa Condensed Bold", "Regular", { postscriptName: "KappaCondensed-Bold" })],
    ON,
  );
  assert.deepEqual(names(families), ["Kappa Condensed"]);
  assert.deepEqual(styles(families[0]), ["Regular", "Bold"]);
});

test("G3: fewer than 3 letters left is no family", () => {
  const fonts = [font("Ox", "Regular", { postscriptName: "Ox-Regular" }), font("Ox Bold", "Regular", { postscriptName: "Ox-Bold", weight: 700 }), font("104"), font("104 Bold")];
  assert.equal(groupFamilies(fonts, ON).length, 4);
  assert.deepEqual(suggestionsOf(fonts), []);
});

test("G4: different foundries hold a merge back, as a suggestion; the same foundry counts as a signal", () => {
  const fonts = [
    font("Lumen", "Regular", { postscriptName: "Lumen-Regular", manufacturer: "North Foundry" }),
    font("Lumen Bold", "Regular", { postscriptName: "Lumen-Bold", manufacturer: "South Type Co." }),
  ];
  assert.equal(groupFamilies(fonts, ON).length, 2);
  assert.equal(suggestionsOf(fonts)[0].sources[0].reason, "foundry");
  // Spelled differently, still one foundry ("The Monotype Corporation", "Monotype Typography, Inc.").
  assert.equal(foundryKey("The Monotype Corporation"), foundryKey("Monotype Typography, Inc."));
  const same = [
    font("Lumen", "Regular", { postscriptName: "LmnR", manufacturer: "The Monotype Corporation" }),
    font("Lumen Bold", "Regular", { postscriptName: "LmnB", manufacturer: "Monotype Typography, Inc." }),
  ];
  assert.deepEqual(names(groupFamilies(same, ON)), ["Lumen"]);
});

test("G5: Keep separate for a name keeps it out, and it isn't suggested", () => {
  const fonts = [font("Dynasty", "Bold", { postscriptName: "DynastyBold" }), font("Dynasty Heavy", "Regular", { postscriptName: "DynastyHeavy" })];
  const rules = new Map<string, NameRule>([["dynastyheavy", { nameKey: "dynastyheavy", name: "Dynasty Heavy", decision: "separate", into: null }]]);
  const options = { byName: true, rules };
  const families = groupFamilies(fonts, options);
  assert.deepEqual(names(families), ["Dynasty", "Dynasty Heavy"]);
  assert.equal(family(families, "Dynasty Heavy").faces[0].groupedBy, "rule");
  assert.deepEqual(suggestionsOf(fonts, options), []);
});

test("a supporting signal is needed: without one it's a suggestion; the weight number is one", () => {
  const fonts = [font("Flux", "Regular", { postscriptName: "Xa-1" }), font("Flux Bold", "Regular", { postscriptName: "Yb-2" })];
  assert.equal(groupFamilies(fonts, ON).length, 2);
  assert.equal(suggestionsOf(fonts)[0].sources[0].reason, "noSignal");
  const weighed = [font("Flux", "Regular", { postscriptName: "Xa-1" }), font("Flux Bold", "Regular", { postscriptName: "Yb-2", weight: 650 })];
  assert.deepEqual(names(groupFamilies(weighed, ON)), ["Flux"], "Bold (700) and weight 650 agree within 100");
  // A PostScript prefix the family already uses agrees too.
  const prefixed = [font("Flux", "Regular", { postscriptName: "QQ-1" }), font("Flux Bold", "Regular", { postscriptName: "QQ-2" })];
  assert.deepEqual(names(groupFamilies(prefixed, ON)), ["Flux"]);
});

test("abbreviations count only when the PostScript name agrees; capitals are acronyms", () => {
  const families = groupFamilies(
    [
      font("Kappa", "Regular", { postscriptName: "Kappa-Regular" }),
      font("Kappa Lt", "Regular", { postscriptName: "Kappa-Lt", weight: 300 }),
      font("Kappa Bd", "Regular", { postscriptName: "Other-Bd", weight: 700 }),
      font("Optima nova", "Regular", { postscriptName: "OptimaNova-Regular" }),
      font("Optima nova LT", "Regular", { postscriptName: "OptimaNovaLT-Regular" }),
    ],
    ON,
  );
  assert.deepEqual(names(families), ["Kappa", "Kappa Bd", "Optima nova", "Optima nova LT"]);
  assert.deepEqual(styles(family(families, "Kappa")), ["Light", "Regular"], "Lt is spelled out");
});

test("SC right after the family part: Simplified Chinese in a CJK font (Noto Sans SC), else small capitals", () => {
  const families = groupFamilies(
    [
      font("Noto Sans", "Regular", { postscriptName: "NotoSans-Regular", manufacturer: "Google" }),
      font("Noto Sans SC", "Regular", { postscriptName: "NotoSansSC-Regular", manufacturer: "Google", glyphCount: 30_000 }),
      font("Elementa", "Regular", { postscriptName: "Elementa-Regular" }),
      font("ElementaBold SC", "Regular", { postscriptName: "ElementaBoldSC" }),
      // Small capitals right after the family part, in a font of a few hundred glyphs.
      font("Elementa SC", "Regular", { postscriptName: "ElementaSC", glyphCount: 229 }),
      font("Elementa SC", "Bold", { postscriptName: "ElementaSC-Bold", glyphCount: 229, weight: 700 }),
      font("LTAroma", "Regular", { postscriptName: "LinotypeAroma", manufacturer: "Linotype GmbH" }),
      font("LTAromaSC", "Regular", { postscriptName: "LinotypeAromaSC", manufacturer: "Linotype GmbH", glyphCount: 248 }),
    ],
    ON,
  );
  assert.deepEqual(names(families), ["Elementa", "LTAroma", "Noto Sans", "Noto Sans SC"]);
  assert.deepEqual(styles(family(families, "Elementa")), ["Regular", "SC", "Bold SC", "SC Bold"]);
  assert.deepEqual(styles(family(families, "LTAroma")), ["Regular", "SC"]);
  // A name with siblings for other scripts is a script code too, whatever its glyph count.
  const siblings = groupFamilies(
    [
      font("Source Han Sans", "Regular", { postscriptName: "SourceHanSans-Regular", manufacturer: "Adobe" }),
      font("Source Han Sans SC", "Regular", { postscriptName: "SourceHanSansSC-Regular", manufacturer: "Adobe" }),
      font("Source Han Sans TC", "Regular", { postscriptName: "SourceHanSansTC-Regular", manufacturer: "Adobe" }),
    ],
    ON,
  );
  assert.deepEqual(names(siblings), ["Source Han Sans", "Source Han Sans SC", "Source Han Sans TC"]);
});

test("a held SC name is suggested: Proxima Nova ScOsf names its own family (G1)", () => {
  const fonts = [
    font("Proxima Nova", "Regular", { postscriptName: "ProximaNova-Regular", hasTypoFamily: true }),
    font("Proxima Nova ScOsf", "Regular", { postscriptName: "ProximaNovaS-Regular", hasTypoFamily: true }),
  ];
  assert.equal(groupFamilies(fonts, ON).length, 2);
  const [s] = suggestionsOf(fonts);
  assert.deepEqual([s.into, s.sources[0].family.name, s.sources[0].reason], ["Proxima Nova", "Proxima Nova ScOsf", "ownName"]);
});

test("folders are never a signal: the same names group wherever the files are", () => {
  const fonts = [
    font("Aminta", "Regular", { folderId: 1, path: "/a/Aminta.otf", postscriptName: "Aminta" }),
    font("AmintaBold", "Regular", { folderId: 7, path: "/Google Drive/x/AmintaBold.otf", postscriptName: "AmintaBold" }),
  ];
  assert.deepEqual(names(groupFamilies(fonts, ON)), ["Aminta"]);
});

test("a family needs two names: one name with style words and no family to join is left as it is", () => {
  assert.deepEqual(names(groupFamilies([font("Solo Bold", "Regular", { postscriptName: "Solo-Bold" })], ON)), ["Solo Bold"]);
  assert.deepEqual(names(groupFamilies([font("Solo Bold", "Regular", { postscriptName: "Solo-Bold" }), font("Solo Light", "Regular", { postscriptName: "Solo-Light" })], ON)), ["Solo"]);
});

test("a number that's part of the family's name doesn't hold it back (Bodoni 72)", () => {
  const families = groupFamilies(
    [font("Bodoni 72", "Book", { postscriptName: "BodoniSvtyTwo-Book" }), font("Bodoni 72 Bold", "Regular", { postscriptName: "BodoniSvtyTwo-Bold" })],
    ON,
  );
  assert.deepEqual(names(families), ["Bodoni 72"]);
});

// ------------------------------------------------------------------- 5.4 labels and order

test("style labels: the words past the family, spelled the usual way, then the font's own style", () => {
  assert.equal(styleLabel("AmintaBlackItalic", "Regular", "Aminta"), "Black Italic");
  assert.equal(styleLabel("Dynasty Heavy", "Italic", "Dynasty"), "Heavy Italic");
  assert.equal(styleLabel("AauxPro-BlackOSF", "Regular", "Aaux Pro"), "Black OSF");
  assert.equal(styleLabel("Dynasty Demi Bold", "Italic", "Dynasty"), "DemiBold Italic");
  assert.equal(styleLabel("Abhaya Libre ExtraBold", "ExtraBold", "Abhaya Libre"), "ExtraBold", "no repeats");
  assert.equal(styleLabel("Foo Bold", "Bold Italic", "Foo"), "Bold Italic");
  assert.equal(styleLabel("FarnhamDisplay-RegItalSwash", "Normal", "FarnhamDisplay"), "Regular Italic Swash", "abbreviations spelled out; Normal dropped");
  assert.equal(styleLabel("FarnhamDisplay-BoldItalOSF", "Regular", "Farnham"), "Display Bold Italic OSF", "a size word stays in the label");
  assert.equal(styleLabel("Univers 45 Light", "Regular", "Univers"), "45 Light");
  assert.equal(styleLabel("BigCaslon", "Medium", "Big Caslon"), "Medium", "spelling only: the font's own style");
  assert.equal(styleLabel("BigCaslon", "Roman", "Big Caslon"), "Roman");
  assert.equal(styleLabel("Arial Black", "Italic", "Helvetica"), "Arial Black Italic", "an unrelated family: its own name first");
  assert.equal(styleLabel("Inter", "Bold", "Inter"), "Bold", "under its own name: its own style");
});

test("sorting uses the style's words when the font's numbers are wrong, in every family", () => {
  assert.deepEqual(traitsOf("Black Italic", { weight: 400, width: 5, italic: false, variable: false }), { weight: 900, width: 5, italic: true, variant: false });
  assert.deepEqual(traitsOf("Book", { weight: 350, width: 5, italic: false, variable: false }), { weight: 350, width: 5, italic: false, variant: false }, "close enough: its own number");
  assert.deepEqual(traitsOf("Condensed Bold", { weight: 700, width: 5, italic: false, variable: false }).width, 3);
  assert.equal(traitsOf("Bold", { weight: 400, width: 5, italic: false, variable: true }).weight, 400, "a variable font keeps its default");
  // A family that was never regrouped: its own style names say what the numbers don't.
  const families = groupFamilies(
    [font("Klavika", "Bold"), font("Klavika", "Light Italic"), font("Klavika", "Light"), font("Klavika", "Regular"), font("Klavika", "Black")],
    ON,
  );
  assert.deepEqual(styles(families[0]), ["Light", "Regular", "Bold", "Black", "Light Italic"]);
});

test("the representative is the most regular style by its words, not its wrong numbers", () => {
  const families = groupFamilies(
    [
      font("Aaux ProBlack Italic", "Regular", { postscriptName: "AauxProBlackItalic" }),
      font("Aaux ProRegular", "Regular", { postscriptName: "AauxProRegular" }),
      font("Aaux ProThin", "Regular", { postscriptName: "AauxProThin" }),
    ],
    ON,
  );
  assert.equal(families[0].representative.style, "Regular");
});

// --------------------------------------------------------------------- 5.1 precedence

const aminta = () => [
  font("Aminta", "Regular", { postscriptName: "Aminta" }),
  font("AmintaBold", "Regular", { postscriptName: "AmintaBold" }),
  font("AmintaBlack", "Regular", { postscriptName: "AmintaBlack" }),
];
/** The face key of a static upright font with this PostScript name. */
const keyOf = (ps: string) => `ps:${ps}|static|r`;

test("your choice for a font wins over everything, and can name its style", () => {
  const fonts = aminta();
  const choices = new Map<string, FaceChoice>([
    [keyOf("AmintaBold"), { faceKey: keyOf("AmintaBold"), family: "Display Faces", style: "Aminta Bold" }],
    [keyOf("AmintaBlack"), { faceKey: keyOf("AmintaBlack"), family: null, style: null }],
  ]);
  const rules = new Map<string, NameRule>([["amintabold", { nameKey: "amintabold", name: "AmintaBold", decision: "separate", into: null }]]);
  const families = groupFamilies(fonts, { byName: true, choices, rules });
  assert.deepEqual(names(families), ["Aminta", "AmintaBlack", "Display Faces"]);
  assert.deepEqual(styles(family(families, "Display Faces")), ["Aminta Bold"]);
  assert.equal(family(families, "AmintaBlack").faces[0].groupedBy, "choice", "kept under its own name by your choice");
});

test("your rule for a name comes next, and fonts that arrive later follow it", () => {
  const rules = new Map<string, NameRule>([[squash("Arial Narrow"), { nameKey: squash("Arial Narrow"), name: "Arial Narrow", decision: "merge", into: "Arial" }]]);
  const options = { byName: true, rules };
  const fonts = [font("Arial"), font("Arial Narrow"), font("ArialNarrow", "Bold", { postscriptName: "ArialNarrow-Bold" })];
  const families = groupFamilies(fonts, options);
  assert.deepEqual(names(families), ["Arial"], "the rule's squash key covers both spellings");
  assert.deepEqual(styles(families[0]), ["Narrow", "Narrow Bold", "Regular"], "narrow before normal width");
  assert.ok(families[0].faces.filter((f) => f.primary.family !== "Arial").every((f) => f.groupedBy === "rule"));
  const later = groupFamilies([...fonts, font("Arial Narrow", "Italic", { italic: true })], options);
  assert.deepEqual(names(later), ["Arial"]);
});

test("with Group families by name off: the fonts' own names, your choices still apply, merges become suggestions", () => {
  const fonts = aminta();
  assert.deepEqual(names(groupFamilies(fonts, OFF)), ["Aminta", "AmintaBlack", "AmintaBold"]);
  const choices = new Map<string, FaceChoice>([[keyOf("AmintaBold"), { faceKey: keyOf("AmintaBold"), family: "Aminta", style: null }]]);
  const families = groupFamilies(fonts, { byName: false, choices });
  assert.deepEqual(names(families), ["Aminta", "AmintaBlack"]);
  assert.deepEqual(styles(family(families, "Aminta")), ["Regular", "Bold"]);
  const [s] = suggestionsOf(fonts, OFF);
  assert.deepEqual([s.into, s.sources.map((x) => [x.family.name, x.reason])], ["Aminta", [["AmintaBlack", "strong"], ["AmintaBold", "strong"]]]);
  assert.equal(reasonText(s.sources[0]), "Grouped when “Group families by name” is on");
  assert.deepEqual(suggestionsOf(fonts, ON), [], "on, they're grouped already");
});

// ------------------------------------------------------------------ what keys stay the same

test("regrouping keeps face keys (tags), family ids by name, and finds families by face key", () => {
  const fonts = aminta();
  const on = groupFamilies(fonts, ON);
  const off = groupFamilies(fonts, OFF);
  const keys = (families: Family[]) => families.flatMap((f) => f.faces.map((x) => x.key)).sort();
  assert.deepEqual(keys(on), keys(off), "tags are keyed by face key, so every tag count stays the same");
  assert.equal(on[0].id, off.find((f) => f.name === "Aminta")!.id, "the family that was already Aminta keeps its id");
  const byFace = new Map(on.flatMap((f) => f.faces.map((x) => [x.key, f.id] as const)));
  assert.equal(byFace.get(keyOf("AmintaBold")), on[0].id, "a font page opened on AmintaBold finds Aminta");
});

test("grouping off lists each style as Family Style, with the grouped family and its label", () => {
  const single = ungroup(groupFamilies(aminta(), ON));
  assert.deepEqual(names(single), ["Aminta Regular", "Aminta Bold", "Aminta Black"]);
});

test("search finds a font by the family and style grouping gave it", () => {
  const families = groupFamilies([...aminta(), font("Inter")], ON);
  assert.deepEqual(names(filterFamilies(families, { kind: "all" }, { query: "aminta black" })), ["Aminta"]);
  assert.equal(filterFamilies(families, { kind: "all" }, { query: "aminta black" })[0].faces.length, 1);
});

test("suggestions: each family once, never one you kept separate or made yourself", () => {
  const fonts = [font("Arial"), font("Arial Narrow"), font("Arial Narrow Bold", "Regular", { postscriptName: "ArialNarrow-Bold" }), font("Arial Wide")];
  const all = suggestionsOf(fonts);
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].sources.map((s) => s.family.name), ["Arial Narrow", "Arial Wide"]);
  assert.equal(all[0].styles, 4);
  const rules = new Map<string, NameRule>([["arialwide", { nameKey: "arialwide", name: "Arial Wide", decision: "separate", into: null }]]);
  assert.deepEqual(suggestionsOf(fonts, { byName: true, rules })[0].sources.map((s) => s.family.name), ["Arial Narrow"]);
});

// ------------------------------------------------------------------------------- pieces

test("name analysis: whole words from the end, longest first, case steps", () => {
  const a = analyzeName("Foo ExtraBlack");
  assert.deepEqual([a.base, a.words.map((w) => w.word.canon)], ["Foo", ["ExtraBlack"]], "ExtraBlack before Black");
  assert.deepEqual(widen(analyzeName("FooSemiCondensed").base).word, "SemiCondensed");
  assert.deepEqual(widen(analyzeName("Univers 45 Light").base), { base: "Univers", key: "univers", word: "45", kind: "number", steps: [{ base: "Univers", key: "univers" }] });
  assert.equal(analyzeName("Foo Extra Light Italic").base, "Foo");
  assert.equal(analyzeName("078MKSDMedium").base, "078MKSD", "an all-capitals run gives way to a word");
  assert.equal(analyzeName("Highlight").base, "Highlight");
  assert.equal(analyzeName("Abaddon™ Bold").base, "Abaddon");
  assert.equal(squash("Aaux Pro"), squash("AauxPro"));
  assert.equal(squash("Big-Caslon_™."), "bigcaslon");
});

test("PostScript stems: the family part before the hyphen, and the whole name, style words off", () => {
  assert.deepEqual(postscriptStems("AbhayaLibre-ExtraBold"), ["abhayalibre"]);
  assert.deepEqual(postscriptStems("AauxProBold"), ["aauxpro"]);
  assert.deepEqual(postscriptStems("Beekman-SquareBold"), ["beekman", "beekmansquare"]);
  assert.deepEqual(postscriptStems(null), []);
});

test("leftover: what a name has past a family, ignoring spaces and case", () => {
  assert.equal(leftover("AauxPro-BlackOSF", "Aaux Pro"), "-BlackOSF");
  assert.equal(leftover("Aaux ProBold", "AauxPro"), "Bold");
  assert.equal(leftover("Arial Black", "Helvetica"), null);
});

// ------------------------------------------------------------- fixes after the M3 review

test("a new family keeps a style word all its names share: Times New Roman, not Times New (F1)", () => {
  const times = groupFamilies(
    [
      font("Times New Roman", "Regular", { postscriptName: "TimesNewRomanPSMT", manufacturer: "Monotype Typography, Inc." }),
      font("Times New Roman Italic", "Regular", { postscriptName: "TimesNewRomanPS-ItalicMT", manufacturer: "The Monotype Corporation", italic: true }),
    ],
    ON,
  );
  assert.deepEqual(names(times), ["Times New Roman"]);
  assert.deepEqual(styles(times[0]), ["Regular", "Italic"]);
  const shadows = groupFamilies(
    [font("Shadows Into Light", "Regular", { postscriptName: "ShadowsIntoLight" }), font("Shadows Into Light Bold", "Regular", { postscriptName: "ShadowsIntoLight-Bold", weight: 700 })],
    ON,
  );
  assert.deepEqual(names(shadows), ["Shadows Into Light"]);
  assert.deepEqual(styles(shadows[0]), ["Regular", "Bold"]);
  // Nothing suggests "Times New" either.
  const bold = [
    font("Times New Roman", "Regular", { postscriptName: "TimesNewRomanPSMT", manufacturer: "Monotype" }),
    font("Times New Roman Bold", "Regular", { postscriptName: "TimesNewRomanPS-BoldMT", manufacturer: "Monotype", hasTypoFamily: true }),
  ];
  assert.ok(suggestionsOf(bold).every((s) => s.into === "Times New Roman"), "no Times New");
  // Names that share no style word still make the family their base names ("Solo").
  assert.deepEqual(names(groupFamilies([font("Solo Bold", "Regular", { postscriptName: "Solo-Bold" }), font("Solo Light", "Regular", { postscriptName: "Solo-Light" })], ON)), ["Solo"]);
});

test("foundries are compared by their words: two people with one first name differ (F2)", () => {
  assert.notEqual(foundryKey("Daniel Bruce"), foundryKey("Daniel Hernandez"));
  assert.equal(sameFoundry(foundryKey("Daniel Bruce")!, foundryKey("Daniel Hernandez")!), false);
  assert.equal(foundryKey("A&O"), undefined, "one-letter words don't count");
  assert.equal(foundryKey("a.Foundry"), undefined);
  assert.equal(foundryKey("A-1 Corp ZenFonts"), "zenfonts");
  assert.ok(sameFoundry(foundryKey("Linotype GmbH")!, foundryKey("Linotype-Hell AG")!), "one's words are all the other's");
  assert.ok(sameFoundry(foundryKey("Apple Inc.")!, foundryKey("Apple Computer, Inc.")!));
  // G4: both name a foundry and they differ, though they start alike.
  const fonts = [
    font("Lumen", "Regular", { postscriptName: "Xa", manufacturer: "Daniel Bruce" }),
    font("Lumen Bold", "Regular", { postscriptName: "Yb", manufacturer: "Daniel Hernandez" }),
  ];
  assert.equal(groupFamilies(fonts, ON).length, 2);
  assert.equal(suggestionsOf(fonts)[0].sources[0].reason, "foundry");
  // One-letter foundries say nothing, so nothing else agrees: only suggested.
  const letters = [font("Lumen", "Regular", { postscriptName: "Xa", manufacturer: "A&O" }), font("Lumen Bold", "Regular", { postscriptName: "Yb", manufacturer: "a.Foundry" })];
  assert.equal(groupFamilies(letters, ON).length, 2);
  assert.equal(suggestionsOf(letters)[0].sources[0].reason, "noSignal");
});

test("chained suggestions are one: Merge all leaves no family behind (F4)", () => {
  const fonts = [
    font("Neutra Text", "Regular", { postscriptName: "NeutraText-Book" }),
    font("Neutra Text TF", "Regular", { postscriptName: "NeutraTextTF-Book", hasTypoFamily: true }),
    font("Neutra Display", "Regular", { postscriptName: "NeutraDisplay-Titling" }),
  ];
  const suggestions = suggestionsOf(fonts);
  assert.equal(suggestions.length, 1, "Neutra Text TF goes on with Neutra Text into Neutra");
  assert.equal(suggestions[0].into, "Neutra");
  assert.deepEqual(suggestions[0].sources.map((s) => s.family.name), ["Neutra Display", "Neutra Text", "Neutra Text TF"]);
  assert.equal(suggestions[0].styles, 3);
});

test("a name's own PostScript name doesn't back itself: spelling variants need another signal (F5)", () => {
  const futura = [font("Futura", "Bold", { postscriptName: "Futura-Bold", manufacturer: "Bitstream" }), font("FUTURA", "Regular", { postscriptName: "XYZ123" })];
  assert.deepEqual(names(groupFamilies(futura, ON)), ["FUTURA", "Futura"]);
  assert.deepEqual([...groupLibrary(futura, ON).plan.held.values()].map((h) => h.reason), ["noSignal"]);
  const caslon = [font("Big Caslon", "Medium", { postscriptName: "AAA" }), font("BigCaslon", "Regular", { postscriptName: "BBB" })];
  assert.equal(groupFamilies(caslon, ON).length, 2);
  // The same foundry, or PostScript names that agree, still merge them.
  assert.equal(groupFamilies(caslon.map((f) => ({ ...f, manufacturer: "Apple Inc." })), ON).length, 1);
  assert.equal(groupFamilies([font("Big Caslon", "Medium", { postscriptName: "BigCaslon-Medium" }), font("BigCaslon", "Regular", { postscriptName: "BigCaslon-Regular" })], ON).length, 1);
});

test("names that differ only in case come out the same whatever order the fonts come in (F6)", () => {
  const fonts = [font("GOTHAM", "Bold", { postscriptName: "Gotham-Bold", manufacturer: "H&FJ" }), font("Gotham", "Regular", { postscriptName: "Gotham-Regular", manufacturer: "H&FJ" })];
  assert.deepEqual(names(groupFamilies(fonts, ON)), names(groupFamilies([...fonts].reverse(), ON)));
  // A shuffled library groups the same.
  const library = [
    ...aminta(),
    font("AAUX Pro", "Regular", { postscriptName: "AauxPro-Regular" }),
    font("Aaux ProBold", "Regular", { postscriptName: "AauxProBold" }),
    font("Aaux Pro Light", "Regular", { postscriptName: "AauxPro-Light" }),
    ...fonts,
  ];
  const shape = (families: Family[]) => families.map((f) => `${f.name}: ${styles(f).join(", ")}`);
  const expected = shape(groupFamilies(library, ON));
  for (let seed = 1; seed <= 5; seed++) {
    const shuffled = [...library].sort((a, b) => ((a.id * 7919 * seed) % 101) - ((b.id * 7919 * seed) % 101));
    assert.deepEqual(shape(groupFamilies(shuffled, ON)), expected);
  }
});

test("keeping one name's styles apart by hand doesn't leave the other name renamed (F7)", () => {
  const fonts = [font("Solo Bold", "Regular", { postscriptName: "Solo-Bold" }), font("Solo Light", "Regular", { postscriptName: "Solo-Light" })];
  const choices = new Map<string, FaceChoice>([[keyOf("Solo-Light"), { faceKey: keyOf("Solo-Light"), family: null, style: null }]]);
  const families = groupFamilies(fonts, { byName: true, choices });
  assert.deepEqual(names(families), ["Solo Bold", "Solo Light"]);
  assert.deepEqual(styles(family(families, "Solo Bold")), ["Regular"]);
});

test("a Fontographer \"Medium\" isn't added to a weight the family name already says (F8)", () => {
  assert.equal(styleLabel("VisageBold", "Medium", "Visage", 400), "Bold");
  assert.equal(styleLabel("VisageBlackOblique", "Medium", "Visage", 400), "Black Oblique");
  assert.equal(styleLabel("Beekman-SquareBoldExpert", "Medium", "Beekman-Square", 400), "Bold Expert");
  assert.equal(styleLabel("VisageOblique", "Medium", "Visage", 400), "Oblique Medium", "no weight in the name: its Medium stays");
  assert.equal(styleLabel("VisageBold", "Medium", "Visage", 500), "Bold Medium", "a real Medium (500) stays");
  assert.equal(styleLabel("LTAroma Light", "Bold", "LTAroma"), "Light Bold", "a real second weight stays");
  const visage = groupFamilies(
    ["Light", "Book", "Medium", "Bold", "Black"].map((w) => font(`Visage${w}`, "Medium", { postscriptName: `Visage${w}` })).concat(font("Visage", "Regular", { postscriptName: "Visage" })),
    ON,
  );
  assert.deepEqual(styles(family(visage, "Visage")), ["Light", "Book", "Regular", "Medium", "Bold", "Black"]);
});

test("a family's own weight numbers are kept when they tell its styles apart (F9, R1)", () => {
  // BB Strata Pro numbers its styles 100 to 500 on purpose.
  const strata = groupFamilies(
    (
      [
        ["Light", 200],
        ["Semi Regular", 250],
        ["Regular", 300],
        ["Semi Medium", 350],
        ["Medium", 400],
        ["Semi Bold", 450],
        ["Bold", 500],
        ["Skeleton", 100],
        ["Thin", 150],
      ] as const
    ).map(([style, weight]) => font("BB Strata Pro HL", style, { weight })),
    ON,
  );
  assert.deepEqual(styles(strata[0]), ["Skeleton", "Thin", "Light", "Semi Regular", "Regular", "Semi Medium", "Medium", "Semi Bold", "Bold"]);
  assert.equal(weightText(strata[0].faces), "100–500");
  // Book Heavy (850) is a heavy Book: its nearest word and its own number agree.
  const neuzeit = groupFamilies([font("Neuzeit S LT Std", "Book Heavy", { weight: 850 }), font("Neuzeit S LT Std", "Book")], ON);
  assert.deepEqual(styles(neuzeit[0]), ["Book", "Book Heavy"]);
  // "Regular" never says a correct number is wrong; a lone Black stays 900, with grouping on or off.
  assert.equal(traitsOf("Regular", { weight: 900, width: 5, italic: false, variable: false }).weight, 900);
  for (const options of [ON, OFF]) {
    const poker = groupFamilies([font("Pokerface", "Regular", { weight: 900 })], options);
    assert.equal(weightText(poker[0].faces), "900");
    const arial = groupFamilies([font("Arial", "Regular"), font("Arial Black", "Regular", { postscriptName: "Arial-Black", weight: 900, hasTypoFamily: true })], options);
    assert.equal(weightText(family(arial, "Arial Black").faces), "900");
  }
  // But in a family that says 500 for every weight, its Regular is 400, before its Medium.
  const amplitude = groupFamilies(
    ["Light", "Book", "Regular", "Medium", "Black"].map((w) => font(`Amplitude-${w}`, "Regular", { postscriptName: `Amplitude-${w}`, weight: 500 })),
    ON,
  );
  assert.deepEqual(styles(family(amplitude, "Amplitude")), ["Light", "Book", "Regular", "Medium", "Black"]);
  // Abbreviations give way to whole words ("Semi Medium" is Medium).
  assert.equal(traitsOf("Semi Medium", { weight: 400, width: 5, italic: false, variable: false }).weight, 500);
});

test("which copy names a face doesn't depend on the order the list sends them in (F10, S1)", () => {
  // The same font twice, with different family names, the same date and format.
  const a = font("BlindfishDemi", "Regular", { postscriptName: "BlindfishDemi", path: "/Drive/b/BlindfishDemi.otf", id: 23797 });
  const b = font("Blindfish", "Demi", { postscriptName: "BlindfishDemi", path: "/Drive/a/Blindfish-Demi.otf", id: 25477, hasTypoFamily: true });
  const place = (fonts: FontSummary[], options: GroupingOptions) =>
    groupFamilies(fonts, options).flatMap((f) => f.faces.map((x) => `${f.name}/${x.style}/${x.groupedBy}`));
  assert.deepEqual(place([a, b], ON), place([b, a], ON));
  // Your rule for either copy's name holds, whichever copy is shown.
  const rules = new Map<string, NameRule>([["blindfishdemi", { nameKey: "blindfishdemi", name: "BlindfishDemi", decision: "separate", into: null }]]);
  const kept = { byName: true, rules };
  assert.deepEqual(place([a, b], kept), ["BlindfishDemi/Regular/rule"]);
  assert.deepEqual(place([b, a], kept), ["BlindfishDemi/Regular/rule"]);
  const [face] = groupFamilies([b, a], kept)[0].faces;
  assert.equal(face.ruleKey, "blindfishdemi", "Clear my choices finds the rule");
  // A copy whose names agree with its PostScript name is the one shown ("Engine-LightLF", not
  // a copy that calls it Engine Medium).
  const engine = [
    font("Engine", "Medium", { postscriptName: "Engine-LightLF", path: "/Fonts/Engine/desktop/EngineLightLF.otf" }),
    font("Engine-LightLF", "Regular", { postscriptName: "Engine-LightLF", path: "/Fonts/EngineLightLF/EngineLightLF.otf" }),
  ];
  for (const order of [engine, [...engine].reverse()]) assert.equal(groupFamilies(order, ON)[0].faces[0].primary.family, "Engine-LightLF");
});

test("Keep separate keeps every spelling of the name in one family (S2)", () => {
  const fonts = [
    font("Meta Cond", "Regular", { postscriptName: "MetaCond-Regular" }),
    font("Meta Cond LF", "Regular", { postscriptName: "MetaCondLF-Regular", hasTypoFamily: true }),
    font("MetaCond LF", "Bold", { postscriptName: "MetaCondLF-Bold", weight: 700 }),
  ];
  const rules = new Map<string, NameRule>([["metacondlf", { nameKey: "metacondlf", name: "Meta Cond LF", decision: "separate", into: null }]]);
  const families = groupFamilies(fonts, { byName: true, rules });
  assert.deepEqual(names(families), ["Meta Cond", "Meta Cond LF"]);
  assert.deepEqual(styles(family(families, "Meta Cond LF")), ["Regular", "Bold"]);
  assert.ok(family(families, "Meta Cond LF").faces.every((f) => f.groupedBy === "rule" && f.kept));
  const poster = [font("Aaux ProPoster", "Regular", { postscriptName: "AauxProPoster" }), font("AauxPro-Poster", "Italic", { postscriptName: "AauxPro-PosterItalic", italic: true })];
  const posterRules = new Map<string, NameRule>([["aauxproposter", { nameKey: "aauxproposter", name: "Aaux ProPoster", decision: "separate", into: null }]]);
  assert.deepEqual(names(groupFamilies(poster, { byName: true, rules: posterRules })), ["Aaux ProPoster"]);
});

test("a plain style shows the family and comes before its variants (R2)", () => {
  const families = groupFamilies(
    [
      font("Proxima Nova", "Regular", { postscriptName: "ProximaNova-Regular", manufacturer: "Mark Simonson Studio" }),
      font("Proxima Nova Alt", "Regular", { postscriptName: "ProximaNovaA-Regular", manufacturer: "Mark Simonson Studio" }),
    ],
    ON,
  );
  assert.deepEqual(names(families), ["Proxima Nova"]);
  assert.equal(families[0].representative.style, "Regular");
  assert.deepEqual(styles(families[0]), ["Regular", "Alt"]);
});

// ------------------------------------------------------ fixes after the second M3 review

/** One font in two files that name it differently: a family folder's copy and a per-style one. */
const copies = (ps: string, perStyle: [family: string, style: string], inFamily: [family: string, style: string], more: Partial<FontSummary> = {}) => [
  font(perStyle[0], perStyle[1], { postscriptName: ps, path: `/Drive/${ps}/${ps}.otf`, ...more }),
  font(inFamily[0], inFamily[1], { postscriptName: ps, path: `/Drive/${inFamily[0]}/${ps}.otf`, ...more }),
];
const shape = (families: Family[]) => families.map((f) => `${f.name}: ${styles(f).join(", ")}`);
/** The same fonts in other orders, in other folders (every path changed), with another copy on. */
const variants = (fonts: FontSummary[]) => [
  [...fonts].reverse(),
  fonts.map((f, i) => ({ ...f, id: 9000 - i, path: f.path.replace("/Drive/", "/Moved/").split("/").reverse().join("/") })),
  fonts.map((f, i) => ({ ...f, osActive: i % 2 === 1, activated: i % 2 === 1 })),
];

test("a per-style copy doesn't split a family its other copies share (M3-new-1: House-A-Rama)", () => {
  const fonts = [
    font("House-A-Rama", "Regular", { postscriptName: "House-A-Rama" }),
    ...copies("House-A-Rama-Kingpin", ["House-A-Rama-Kingpin", "Regular"], ["House-A-Rama", "Medium"]),
    ...copies("House-A-Rama-Tenpin", ["House-A-Rama-Tenpin", "Regular"], ["House-A-Rama", "Medium"]),
    ...copies("House-A-RamaHigh-Roller", ["House-A-RamaHigh-Roller", "Regular"], ["House-A-Rama", "High-Roller"]),
  ];
  for (const options of [ON, OFF]) {
    const families = groupFamilies(fonts, options);
    assert.deepEqual(shape(families), ["House-A-Rama: High Roller, Kingpin, Regular, Tenpin"], "one family; styles from the names that agree with the PostScript name");
    for (const other of variants(fonts)) assert.deepEqual(shape(groupFamilies(other, options)), shape(families), "whatever the order, folders or copy on");
  }
  // The style still shows its own copy, and says which name placed it.
  const kingpin = groupFamilies(fonts, ON)[0].faces.find((f) => f.key === keyOf("House-A-Rama-Kingpin"))!;
  assert.deepEqual([kingpin.primary.family, kingpin.name, kingpin.groupedBy], ["House-A-Rama-Kingpin", "House-A-Rama", "own"]);
  // Barcode and MorganAvec: no style of the family's own, every style a per-style copy too.
  const barcode = ["One", "Two", "Three"].flatMap((n) => copies(`Barcode-${n}`, [`Barcode-${n}`, "Regular"], ["Barcode", "Medium"]));
  assert.deepEqual(shape(groupFamilies(barcode, ON)), ["Barcode: One, Three, Two"]);
  const morgan = [
    font("MorganAvec", "Regular", { postscriptName: "MorganAvec-Regular" }),
    font("MorganAvec", "Bold", { postscriptName: "MorganAvec-Bold", weight: 700 }),
    ...copies("MorganAvec-RegularPi", ["MorganAvec-RegularPi", "Regular"], ["MorganAvec", "Regular"]),
    ...copies("MorganAvec-BoldFigures", ["MorganAvec-BoldFigures", "Regular"], ["MorganAvec", "Bold"], { weight: 700 }),
  ];
  assert.deepEqual(shape(groupFamilies(morgan, ON)), ["MorganAvec: Regular, Regular Pi, Bold, Bold Figures"]);
  // Names that group with each other (OneBack and its Expert), all with the family's copy too.
  const readout = [
    ...copies("Readout-OneBack", ["Readout-OneBack", "Regular"], ["Readout", "Medium"]),
    ...copies("Readout-OneBackExpert", ["Readout-OneBackExpert", "Regular"], ["Readout", "Medium"]),
    ...copies("Readout-TwoFront", ["Readout-TwoFront", "Regular"], ["Readout", "Medium"]),
  ];
  assert.deepEqual(shape(groupFamilies(readout, ON)), ["Readout: One Back, Two Front, One Back Expert"]);
});

test("a family only some of whose styles have another copy's name stays whole; a lone pair keeps its own (M3-new-1)", () => {
  // LTUnivers-Cond groups by name; half its styles also have an "LTUnivers" copy. It stays one
  // family (a width word is only suggested), and so does LTUnivers.
  const fonts = [
    font("LTUnivers", "Normal", { postscriptName: "LTUnivers-Normal" }),
    font("LTUnivers", "Bold", { postscriptName: "LTUnivers-Bold", weight: 700 }),
    ...copies("LTUnivers-CondThin", ["LTUnivers-CondThin", "Regular"], ["LTUnivers", "Normal"], { weight: 100 }),
    font("LTUnivers-CondBold", "Regular", { postscriptName: "LTUnivers-CondBold", weight: 700 }),
  ];
  const families = groupFamilies(fonts, ON);
  assert.deepEqual(shape(families), ["LTUnivers: Normal, Bold", "LTUnivers-Cond: Thin, Bold"]);
  assert.ok(suggestionsOf(fonts).some((s) => s.into === "LTUnivers" && s.sources[0].family.name === "LTUnivers-Cond"), "suggested, as a width");
  // One font in two files and nothing else carrying either name: the name that agrees with its
  // PostScript name.
  assert.deepEqual(shape(groupFamilies(copies("House-A-Rama-Kingpin", ["House-A-Rama-Kingpin", "Regular"], ["House-A-Rama", "Medium"]), ON)), [
    "House-A-Rama-Kingpin: Regular",
  ]);
  // Unrelated fonts that share a PostScript name aren't one family's copies: the shown copy's name.
  const clash = [font("Apex", "Bold", { postscriptName: "ø", mtime: 2 }), font("ø", "ø", { postscriptName: "ø" }), font("Apex", "Light", { postscriptName: "Apex-Light" })];
  assert.deepEqual(names(groupFamilies(clash, ON)), ["Apex"]);
});

test("the name a face is grouped by doesn't depend on its file's path (M3-new-2)", () => {
  const pairs: [string, [string, string], [string, string], string][] = [
    ["BlindfishDemi", ["BlindfishDemi", "Regular"], ["Blindfish", "Demi"], "Blindfish: Demi"],
    ["Bull-Double", ["Bull-Double", "Regular"], ["Bull", "Double"], "Bull: Double"],
    ["CQN-Molecular-Xtra-Regular", ["CQN-Molecular-Xtra-Regular", "Regular"], ["CQN-Molecular-Xtra", "Regular"], "CQN-Molecular-Xtra: Regular"],
    ["Aardvark-Regular", ["Aardvark-Regular", "Regular"], ["Aardvark", "Regular"], "Aardvark: Regular"],
  ];
  for (const [ps, a, b, expected] of pairs) {
    // Names that agree with the PostScript name equally: the more general one, wherever the files are.
    const fonts = copies(ps, a, b);
    for (const options of [ON, OFF]) {
      assert.deepEqual(shape(groupFamilies(fonts, options)), [expected], ps);
      for (const other of variants(fonts)) assert.deepEqual(shape(groupFamilies(other, options)), [expected], `${ps}, moved`);
      const swapped = [{ ...fonts[0], path: fonts[1].path }, { ...fonts[1], path: fonts[0].path }];
      assert.deepEqual(shape(groupFamilies(swapped, options)), [expected], `${ps}, paths swapped`);
    }
  }
});

test("a shared weight word stays in a new family's name only when it's part of the name (M3-new-3)", () => {
  // No Gotham family: the two names reduce to it, and Bold is their style (stored at 700).
  const gotham = [
    font("Gotham Bold", "Regular", { postscriptName: "Gotham-Bold", weight: 700 }),
    font("Gotham Bold Italic", "Italic", { postscriptName: "Gotham-BoldItalic", weight: 700, italic: true }),
  ];
  assert.deepEqual(shape(groupFamilies(gotham, ON)), ["Gotham: Bold, Bold Italic"]);
  // Heavy stored as 400 (as many fonts store whatever their weight) or 800: a style either way.
  for (const weight of [400, 800]) {
    const dynasty = [
      font("Dynasty Heavy", "Regular", { postscriptName: "Dynasty-Heavy", weight }),
      font("Dynasty Heavy Italic", "Regular", { postscriptName: "Dynasty-HeavyItalic", weight, italic: true }),
    ];
    assert.deepEqual(shape(groupFamilies(dynasty, ON)), ["Dynasty: Heavy, Heavy Italic"], `stored ${weight}`);
  }
  const helvetica = [
    font("Helvetica Light", "Regular", { postscriptName: "Helvetica-Light", weight: 300 }),
    font("Helvetica Light Oblique", "Regular", { postscriptName: "Helvetica-LightOblique", weight: 300, italic: true }),
  ];
  assert.deepEqual(shape(groupFamilies(helvetica, ON)), ["Helvetica: Light, Light Oblique"]);
  // Part of the name: a plain word, a weight the fonts' numbers contradict, or one the PostScript
  // name's family part spells.
  assert.deepEqual(
    shape(groupFamilies([font("Times New Roman", "Regular", { postscriptName: "TimesNewRomanPSMT" }), font("Times New Roman Italic", "Regular", { postscriptName: "TimesNewRomanPSMT-Italic", italic: true })], ON)),
    ["Times New Roman: Regular, Italic"],
  );
  assert.deepEqual(
    shape(groupFamilies([font("Shadows Into Light", "Regular", { postscriptName: "ShadowsIntoLight" }), font("Shadows Into Light Bold", "Regular", { postscriptName: "ShadowsIntoLight-Bold", weight: 700 })], ON)),
    ["Shadows Into Light: Regular, Bold"],
  );
  assert.deepEqual(
    shape(groupFamilies([font("Shadows Into Light", "Regular", { postscriptName: "ShadowsIntoLight" }), font("Shadows Into Light Italic", "Regular", { postscriptName: "ShadowsIntoLight-Italic", italic: true })], ON)),
    ["Shadows Into Light: Regular, Italic"],
  );
  // A third name without the word: the family is Gotham anyway.
  assert.deepEqual(names(groupFamilies([...gotham, font("Gotham Light", "Regular", { postscriptName: "Gotham-Light", weight: 300 })], ON)), ["Gotham"]);
});

test("a rule found through another copy keeps the style its own names give it (M3-new-4: Engine-LightLF)", () => {
  const fonts = [
    font("Engine", "Regular", { postscriptName: "Engine-Regular" }),
    font("Engine", "Bold", { postscriptName: "Engine-Bold", weight: 700 }),
    ...copies("Engine-LightLF", ["Engine-LightLF", "Regular"], ["Engine", "Medium"]),
  ];
  const rules = new Map<string, NameRule>([["engine", { nameKey: "engine", name: "Engine", decision: "separate", into: null }]]);
  for (const grouping of [ON, { byName: true, rules }]) {
    const families = groupFamilies(fonts, grouping);
    assert.deepEqual(shape(families), ["Engine: Light LF, Regular, Bold"], "Light LF, not the other copy's Medium, and it sorts as a Light");
  }
  const face = groupFamilies(fonts, { byName: true, rules })[0].faces.find((f) => f.key === keyOf("Engine-LightLF"))!;
  assert.deepEqual([face.groupedBy, face.kept, face.ruleKey, face.name], ["rule", true, "engine", "Engine"], "the copy's name: only the rule and the Info tab's words");
  // Whichever copy is shown.
  for (const other of variants(fonts)) assert.deepEqual(shape(groupFamilies(other, { byName: true, rules })), ["Engine: Light LF, Regular, Bold"]);
});

test("spellings that differ only in case show the one that isn't all capitals (M3-new-5)", () => {
  const fonts = [font("GOTHAM", "Bold", { postscriptName: "Gotham-Bold", manufacturer: "H&FJ" }), font("Gotham", "Regular", { postscriptName: "Gotham-Regular", manufacturer: "H&FJ" })];
  for (const order of [fonts, [...fonts].reverse()]) assert.deepEqual(shape(groupFamilies(order, ON)), ["Gotham: Regular, Bold"]);
  // More styles that spell it in capitals still win (the spelling most fonts use).
  const more = [...fonts, font("GOTHAM", "Black", { postscriptName: "Gotham-Black", manufacturer: "H&FJ", weight: 900 })];
  assert.deepEqual(names(groupFamilies(more, ON)), ["GOTHAM"]);
});

test("a width or size suggestion joins the longest name left that's a family (F1: Times New Roman, not Times New)", () => {
  const times = font("Times New Roman", "Regular", { postscriptName: "TimesNewRomanPSMT" });
  const condensed = font("Times New Roman Condensed", "Regular", { postscriptName: "TimesNewRomanPS-Condensed" });
  const narrow = font("Times New Roman Narrow", "Regular", { postscriptName: "TimesNewRomanPS-Narrow" });
  const into = (fonts: FontSummary[]) => suggestionsOf(fonts).map((s) => `${s.into} <- ${s.sources.map((src) => src.family.name).join(", ")}`);
  assert.deepEqual(into([times, condensed, narrow]), ["Times New Roman <- Times New Roman Condensed, Times New Roman Narrow"]);
  assert.deepEqual(into([times, condensed]), ["Times New Roman <- Times New Roman Condensed"], "a single variant is suggested too");
  assert.deepEqual(into([condensed, narrow]), ["Times New Roman <- Times New Roman Condensed, Times New Roman Narrow"], "no family yet: Roman is part of the name");
  const shadows = font("Shadows Into Light", "Regular", { postscriptName: "ShadowsIntoLight" });
  const display = font("Shadows Into Light Display", "Regular", { postscriptName: "ShadowsIntoLight-Display" });
  const text = font("Shadows Into Light Text", "Regular", { postscriptName: "ShadowsIntoLight-Text" });
  assert.deepEqual(into([shadows, display, text]), ["Shadows Into Light <- Shadows Into Light Display, Shadows Into Light Text"]);
  // A weight word all the names share and that isn't part of the name goes: Gotham, not Gotham Bold.
  const gotham = [
    font("Gotham Bold Condensed", "Regular", { postscriptName: "Gotham-BoldCondensed", weight: 700 }),
    font("Gotham Bold Narrow", "Regular", { postscriptName: "Gotham-BoldNarrow", weight: 700 }),
  ];
  assert.deepEqual(into(gotham), ["Gotham <- Gotham Bold Condensed, Gotham Bold Narrow"]);
  // Still never merged automatically.
  assert.equal(groupFamilies([times, condensed, narrow], ON).length, 3);
});

test("merging writes the rule for the name a style was placed by (Face.name)", () => {
  const fonts = [
    font("House-A-Rama", "Regular", { postscriptName: "House-A-Rama" }),
    ...copies("House-A-Rama-Kingpin", ["House-A-Rama-Kingpin", "Regular"], ["House-A-Rama", "Medium"]),
    ...copies("House-A-Rama-Tenpin", ["House-A-Rama-Tenpin", "Regular"], ["House-A-Rama", "Medium"]),
  ];
  const families = groupFamilies(fonts, ON);
  assert.deepEqual(families[0].faces.map((f) => f.name), ["House-A-Rama", "House-A-Rama", "House-A-Rama"]);
  // A rule for that name holds for every style, whichever copy is shown.
  const rules = new Map<string, NameRule>([["housearama", { nameKey: "housearama", name: "House-A-Rama", decision: "merge", into: "Bowling" }]]);
  assert.deepEqual(shape(groupFamilies(fonts, { byName: true, rules })), ["Bowling: House-A-Rama, House-A-Rama-Kingpin, House-A-Rama-Tenpin"], "an unrelated family: their names first");
  // Keeping one style under its own name takes it out (the shown copy's own name).
  const choices = new Map<string, FaceChoice>([[keyOf("House-A-Rama-Kingpin"), { faceKey: keyOf("House-A-Rama-Kingpin"), family: null, style: null }]]);
  assert.deepEqual(shape(groupFamilies(fonts, { byName: true, choices })), ["House-A-Rama: Regular, Tenpin", "House-A-Rama-Kingpin: Regular"]);
});

/**
 * Turning "Group families by name" off only ever splits families, by the fonts' own names:
 * - I1: every family with it off lies inside one family with it on (off refines on);
 * - I2: no style is alone with it off while it's in one family with it on with a family (off)
 *   that one of its copies names, or one whose styles have a copy carrying its name.
 */
function offRefinesOn(fonts: FontSummary[]) {
  const on = groupFamilies(fonts, ON);
  const off = groupFamilies(fonts, OFF);
  const onOf = new Map(on.flatMap((f) => f.faces.map((x) => [x.key, f.name] as const)));
  for (const f of off) assert.equal(new Set(f.faces.map((x) => onOf.get(x.key))).size, 1, `${f.name} (off) lies inside one family on`);
  for (const f of off) {
    if (f.faces.length !== 1) continue;
    const x = f.faces[0];
    for (const g of off) {
      if (g === f || !g.faces.some((y) => onOf.get(y.key) === onOf.get(x.key))) continue;
      const named = x.copies.some((c) => c.family === g.name) || g.faces.some((y) => y.copies.some((c) => c.family === f.name));
      assert.ok(!named, `${x.primary.postscriptName} is alone off, though it's with ${g.name} on and a copy names one for the other`);
    }
  }
}

test("with grouping off, a style's other copies still keep its family together (M3-r3-1: MorganAvec, Engine)", () => {
  const morgan = [
    font("MorganAvec", "Regular", { postscriptName: "MorganAvec-Regular" }),
    font("MorganAvec", "Bold", { postscriptName: "MorganAvec-Bold", weight: 700 }),
    ...copies("MorganAvec-RegularPi", ["MorganAvec-RegularPi", "Regular"], ["MorganAvec", "Regular"]),
    // A name grouping by name merges (Bold, Caps): with it off, its copy still brings it back.
    ...copies("MorganAvec-BoldCaps", ["MorganAvec-BoldCaps", "Regular"], ["MorganAvec", "Bold"], { weight: 700 }),
  ];
  const engine = [
    font("Engine", "Regular", { postscriptName: "Engine-Regular" }),
    font("Engine", "Bold", { postscriptName: "Engine-Bold", weight: 700 }),
    ...copies("Engine-LightLF", ["Engine-LightLF", "Regular"], ["Engine", "Medium"]),
  ];
  const fonts = [...morgan, ...engine];
  for (const options of [OFF, ON]) {
    const families = groupFamilies(fonts, options);
    assert.deepEqual(shape(families), ["Engine: Light LF, Regular, Bold", "MorganAvec: Regular, Regular Pi, Bold, Bold Caps"], `grouping ${options.byName ? "on" : "off"}`);
    for (const other of variants(fonts)) assert.deepEqual(shape(groupFamilies(other, options)), shape(families), "whatever the order, folders or copy on");
  }
  const caps = groupFamilies(fonts, OFF)[1].faces.find((f) => f.key === keyOf("MorganAvec-BoldCaps"))!;
  assert.deepEqual([caps.groupedBy, caps.name], ["own", "MorganAvec"], "the fonts' own names: its other copy's");
  // Nothing to suggest for it any more; a name with no such copy still is.
  const lone = [...morgan, font("MorganAvec-ItalicCaps", "Regular", { postscriptName: "MorganAvec-ItalicCaps", italic: true })];
  assert.deepEqual(
    suggestionsOf(lone, OFF).map((s) => [s.into, s.sources.map((src) => [src.family.name, src.reason])]),
    [["MorganAvec", [["MorganAvec-ItalicCaps", "strong"]]]],
  );
  for (const f of [fonts, lone]) offRefinesOn(f);
});

test("with grouping off, a family is never joined that grouping on keeps it out of, and a lone style keeps its company (M3-r3-1)", () => {
  // LTUnivers-CondThin's other copy says LTUnivers, but grouping by name lists it in
  // LTUnivers-Cond: off, it stays under its own name rather than join LTUnivers (I1).
  const univers = [
    font("LTUnivers", "Normal", { postscriptName: "LTUnivers-Normal" }),
    font("LTUnivers", "Bold", { postscriptName: "LTUnivers-Bold", weight: 700 }),
    ...copies("LTUnivers-CondThin", ["LTUnivers-CondThin", "Regular"], ["LTUnivers", "Normal"], { weight: 100 }),
    font("LTUnivers-CondBold", "Regular", { postscriptName: "LTUnivers-CondBold", weight: 700 }),
  ];
  assert.deepEqual(shape(groupFamilies(univers, OFF)), ["LTUnivers: Normal, Bold", "LTUnivers-CondBold: Regular", "LTUnivers-CondThin: Regular"]);
  // Sansation-Light's files say Sansation (Light) and Sansation Light (Light); its Light Italic
  // has only the second. Off, the Light stays with its Light Italic rather than leave it alone.
  const sansation = [
    font("Sansation", "Regular", { postscriptName: "Sansation-Regular" }),
    font("Sansation", "Bold", { postscriptName: "Sansation-Bold", weight: 700 }),
    ...copies("Sansation-Light", ["Sansation", "Light"], ["Sansation Light", "Light"], { weight: 300 }),
    font("Sansation Light", "Light Italic", { postscriptName: "Sansation-LightItalic", weight: 300, italic: true }),
  ];
  assert.deepEqual(shape(groupFamilies(sansation, OFF)), ["Sansation: Regular, Bold", "Sansation Light: Light, Light Italic"]);
  assert.deepEqual(shape(groupFamilies(sansation, ON)), ["Sansation: Light, Regular, Bold, Light Italic"]);
  // A style whose other family has styles of its own stays where its better names put it.
  const hoefler = [
    font("Hoefler Text", "Regular", { postscriptName: "HoeflerText-Regular" }),
    ...copies("HoeflerText-Italic", ["Hoefler Text", "Italic"], ["HoeflerText", "Medium Italic"], { italic: true }),
    font("HoeflerText", "Medium", { postscriptName: "HoeflerText-Roman", weight: 500 }),
    font("HoeflerText", "Bold", { postscriptName: "HoeflerText-Bold", weight: 700 }),
  ];
  assert.deepEqual(shape(groupFamilies(hoefler, OFF)), ["Hoefler Text: Regular, Italic", "HoeflerText: Medium, Bold"]);
  for (const fonts of [univers, sansation, hoefler]) {
    for (const other of variants(fonts)) assert.deepEqual(shape(groupFamilies(other, OFF)), shape(groupFamilies(fonts, OFF)), "whatever the order, folders or copy on");
    offRefinesOn(fonts);
  }
  // The M3 fixtures above hold it too.
  const house = [
    font("House-A-Rama", "Regular", { postscriptName: "House-A-Rama" }),
    ...copies("House-A-Rama-Kingpin", ["House-A-Rama-Kingpin", "Regular"], ["House-A-Rama", "Medium"]),
    font("House-A-Rama-Strike", "Regular", { postscriptName: "House-A-Rama-Strike" }),
  ];
  offRefinesOn(house);
  offRefinesOn(["One", "Two", "Three"].flatMap((n) => copies(`Barcode-${n}`, [`Barcode-${n}`, "Regular"], ["Barcode", "Medium"])));
});

test("a style's label comes from the copy whose names agree with its PostScript name, inside its family (M3-r3-3)", () => {
  // ZeitgeistExpertMT-Cameo has a family-folder copy (Zeitgeist MT, Regular) whose names don't
  // spell the font: its own copy's do, and has every word of Zeitgeist MT.
  const zeitgeist = [
    font("Zeitgeist MT", "Regular", { postscriptName: "ZeitgeistMT" }),
    ...copies("ZeitgeistExpertMT-Cameo", ["ZeitgeistExpertMT-Cameo", "Regular"], ["Zeitgeist MT", "Regular"]),
    ...copies("ZeitgeistExpertMT", ["ZeitgeistExpertMT", "Regular"], ["Zeitgeist MT", "Regular"]),
  ];
  const lido = [
    font("Lido STF CE", "Normal", { postscriptName: "LidoSTFCE" }),
    font("Lido STF CE", "Bold", { postscriptName: "LidoSTFCE-Bold", weight: 700 }),
    ...copies("LidoSTFCondCE-Bold", ["LidoSTFCondCE-Bold", "Regular"], ["Lido STF CE", "Normal"], { weight: 700 }),
  ];
  for (const options of [ON, OFF]) {
    const families = groupFamilies([...zeitgeist, ...lido], options);
    assert.deepEqual(shape(families), ["Lido STF CE: Condensed Bold, Normal, Bold", "Zeitgeist MT: Expert Cameo, Regular, Expert"], "no second Regular or Normal");
    for (const other of variants([...zeitgeist, ...lido])) assert.deepEqual(shape(groupFamilies(other, options)), shape(families), "whichever copy is shown");
  }
  // With a copy named the family (`besides`, as labelFor passes it).
  assert.equal(styleLabel("ZeitgeistExpertMT-Cameo", "Regular", "Zeitgeist MT", undefined, true), "Expert Cameo", "the words it has besides the family's");
  assert.equal(styleLabel("LidoSTFCondCE-Bold", "Regular", "Lido STF CE", undefined, true), "Condensed Bold");
  assert.equal(styleLabel("Times New Roman", "Regular", "New York", undefined, true), "Times New Roman", "not every word of the family: its own name first");
  assert.equal(styleLabel("Helvetica Neue", "Bold", "Neue", undefined, true), "Helvetica Neue Bold", "the family's first word must start it");
  // A copy whose names agree but name another family doesn't rename the style away from its
  // family: XyzBold, moved into Foo by your choice, is Foo's Bold, from its "Foo" copy.
  const foo = [font("Foo", "Regular", { postscriptName: "Foo-Regular" }), ...copies("XyzBold", ["XyzBold", "Regular"], ["Foo", "Bold"], { weight: 700 })];
  const choices = new Map<string, FaceChoice>([[keyOf("XyzBold"), { faceKey: keyOf("XyzBold"), family: "Foo", style: null }]]);
  assert.deepEqual(shape(groupFamilies(foo, { byName: true, choices })), ["Foo: Regular, Bold"]);
});

test("a numbered name is suggested for the longest name left that's a family, with its width word as the reason (F1, M3-r3-2)", () => {
  const into = (fonts: FontSummary[]) => suggestionsOf(fonts).map((s) => `${s.into} <- ${s.sources.map((src) => `${src.family.name} (${reasonText(src)})`).join(", ")}`);
  const numbered = (family: string, ps: string) => [
    font(`${family} 2 Bold`, "Regular", { postscriptName: `${ps}2-Bold`, weight: 700 }),
    font(`${family} 2 Italic`, "Regular", { postscriptName: `${ps}2-Italic`, italic: true }),
  ];
  const times = font("Times New Roman", "Regular", { postscriptName: "TimesNewRomanPSMT" });
  const shadows = font("Shadows Into Light", "Regular", { postscriptName: "ShadowsIntoLight" });
  const tnr = "Times New Roman <- Times New Roman 2 Bold (Numbered style), Times New Roman 2 Italic (Numbered style)";
  const sil = "Shadows Into Light <- Shadows Into Light 2 Bold (Numbered style), Shadows Into Light 2 Italic (Numbered style)";
  assert.deepEqual(into([times, ...numbered("Times New Roman", "TimesNewRoman")]), [tnr], "not a new Times New");
  assert.deepEqual(into([shadows, ...numbered("Shadows Into Light", "ShadowsIntoLight")]), [sil], "not a new Shadows Into");
  // No such family: the style words before the number that are part of the name stay.
  assert.deepEqual(into(numbered("Times New Roman", "TimesNewRoman")), [tnr]);
  assert.deepEqual(into(numbered("Shadows Into Light", "ShadowsIntoLight")), [sil]);
  for (const fonts of [[times, ...numbered("Times New Roman", "TimesNewRoman")], numbered("Shadows Into Light", "ShadowsIntoLight")]) {
    assert.equal(groupFamilies(fonts, ON).length, fonts.length, "still never merged automatically");
  }
  // Joining MINI 7 takes Condensed off, not the number: that's the reason given.
  const mini = [font("MINI 7", "Regular", { postscriptName: "MINI7" }), font("MINI 7 Condensed", "Regular", { postscriptName: "MINI7Condensed" }), font("MINI 7 Extended", "Regular", { postscriptName: "MINI7Extended" })];
  assert.deepEqual(into(mini), ["MINI 7 <- MINI 7 Condensed (Width word “Condensed”), MINI 7 Extended (Width word “Extended”)"]);
  assert.deepEqual(into([font("Foo 2", "Regular", { postscriptName: "Foo2" }), font("Foo 2 Condensed", "Regular", { postscriptName: "Foo2-Condensed" })]), ["Foo 2 <- Foo 2 Condensed (Width word “Condensed”)"]);
  assert.deepEqual([widen("MINI 7 Condensed").word, widen("MINI 7 Condensed").kind], ["Condensed", "width"], "the outermost word");
  assert.deepEqual(widen("MINI 7 Condensed").steps.map((s) => s.base), ["MINI 7", "MINI"]);
});

test("with grouping off, a name whose chosen name goes by another isn't left alone under it (M3-r4-1: a two-step chain)", () => {
  // FagoLf's styles also say Fago, so off they go by Fago. FagoLf-BoldCaps's other copy says
  // FagoLf, but none says Fago: it stays under its own name, not alone under a FagoLf that holds
  // none of the FagoLf fonts.
  const fago = [
    font("Fago", "Regular", { postscriptName: "Fago-Regular" }),
    font("Fago", "Bold", { postscriptName: "Fago-Bold", weight: 700 }),
    ...copies("FagoLf-Regular", ["FagoLf", "Regular"], ["Fago", "Regular"]),
    ...copies("FagoLf-Bold", ["FagoLf", "Bold"], ["Fago", "Bold"], { weight: 700 }),
    ...copies("FagoLf-BoldCaps", ["FagoLf-BoldCaps", "Regular"], ["FagoLf", "Bold"], { weight: 700 }),
  ];
  assert.deepEqual(shape(groupFamilies(fago, ON)), ["Fago: Regular, LF, Bold, LF Bold, LF Bold Caps"]);
  assert.deepEqual(shape(groupFamilies(fago, OFF)), ["Fago: Regular, LF, Bold, LF Bold", "FagoLf-BoldCaps: Regular"]);
  assert.deepEqual(
    suggestionsOf(fago, OFF).map((s) => [s.into, s.sources.map((src) => src.family.name)]),
    [["Fago", ["FagoLf-BoldCaps"]]],
    "still suggested for Fago",
  );
  for (const other of variants(fago)) assert.deepEqual(shape(groupFamilies(other, OFF)), shape(groupFamilies(fago, OFF)), "whatever the order, folders or copy on");
  offRefinesOn(fago);
});

test("a numbered name is suggested for the longest name left that's a family as they stand (M3-r4-2: Gill Sans Light 2)", () => {
  // Grouping lists Gill Sans Light in Gill Sans, so no family is called Gill Sans Light: the
  // numbered names are suggested for Gill Sans, not for a new Gill Sans Light beside it.
  const gill = [
    font("Gill Sans", "Regular", { postscriptName: "GillSans" }),
    font("Gill Sans", "Bold", { postscriptName: "GillSans-Bold", weight: 700 }),
    font("Gill Sans Light", "Regular", { postscriptName: "GillSans-Light", weight: 300 }),
    font("Gill Sans Light", "Italic", { postscriptName: "GillSans-LightItalic", weight: 300, italic: true }),
  ];
  const italic = font("Gill Sans Light 2 Italic", "Regular", { postscriptName: "GillSansLight2-Italic", italic: true });
  const bold = font("Gill Sans Light 2 Bold", "Regular", { postscriptName: "GillSansLight2-Bold", weight: 700 });
  const said = (fonts: FontSummary[], options: GroupingOptions) =>
    suggestionsOf(fonts, options).map((s) => `${suggestionText(s)} [${s.existing?.name ?? "new"}]: ${s.sources.map((src) => `${src.family.name} (${src.reason})`).join(", ")}`);
  assert.deepEqual(said([...gill, italic, bold], ON), ["Merge 2 families into Gill Sans (6 styles) [Gill Sans]: Gill Sans Light 2 Bold (number), Gill Sans Light 2 Italic (number)"]);
  assert.deepEqual(said([...gill, italic], ON), ["Merge “Gill Sans Light 2 Italic” into Gill Sans (5 styles) [Gill Sans]: Gill Sans Light 2 Italic (number)"], "one numbered name, the same");
  // Off, Gill Sans Light is a family as it stands, and it's suggested for Gill Sans itself.
  assert.deepEqual(said([...gill, italic, bold], OFF), [
    "Merge 3 families into Gill Sans (6 styles) [Gill Sans]: Gill Sans Light (strong), Gill Sans Light 2 Bold (number), Gill Sans Light 2 Italic (number)",
  ]);
  for (const other of variants([...gill, italic, bold])) assert.deepEqual(said(other, ON), said([...gill, italic, bold], ON), "whatever the order");
});

test("a style moved by hand into a family whose words it has keeps its full name (M3-r4-3: Times New Roman into Times Roman)", () => {
  // Only a font with a copy named the family itself is labelled by the words it has besides
  // (Zeitgeist MT, Lido STF CE, above); styles you move keep their family name first.
  const fonts = [
    font("Times Roman", "Regular", { postscriptName: "Times-Roman" }),
    font("Times Roman", "Bold", { postscriptName: "Times-Bold", weight: 700 }),
    font("Times New Roman", "Regular", { postscriptName: "TimesNewRomanPSMT" }),
    font("Times New Roman", "Bold", { postscriptName: "TimesNewRomanPS-BoldMT", weight: 700 }),
    font("Proxima Soft", "Regular", { postscriptName: "ProximaSoft-Regular" }),
    font("Proxima Nova Soft", "Bold", { postscriptName: "ProximaNovaSoft-Bold", weight: 700 }),
  ];
  const moved: [string, string][] = [["TimesNewRomanPSMT", "Times Roman"], ["TimesNewRomanPS-BoldMT", "Times Roman"], ["ProximaNovaSoft-Bold", "Proxima Soft"]];
  const choices = new Map<string, FaceChoice>(moved.map(([ps, family]) => [keyOf(ps), { faceKey: keyOf(ps), family, style: null }]));
  const expected = ["Proxima Soft: Regular, Proxima Nova Soft Bold", "Times Roman: Regular, Times New Roman, Bold, Times New Roman Bold"];
  for (const byName of [true, false]) assert.deepEqual(shape(groupFamilies(fonts, { byName, choices })), expected, `your choice, grouping ${byName ? "on" : "off"}`);
  const rules = new Map<string, NameRule>([["timesnewroman", { nameKey: "timesnewroman", name: "Times New Roman", decision: "merge", into: "Times Roman" }]]);
  assert.deepEqual(shape(groupFamilies(fonts.slice(0, 4), { byName: true, rules })), [expected[1]], "your rule");
  assert.equal(styleLabel("Times New Roman", "Bold", "Times Roman"), "Times New Roman Bold");
  assert.equal(styleLabel("Avenir Next Condensed", "Demi Bold", "Avenir Condensed"), "Avenir Next Condensed DemiBold");
});
