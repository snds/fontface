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
  assert.deepEqual(widen(analyzeName("Univers 45 Light").base), { base: "Univers", key: "univers", word: "45", kind: "number" });
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
