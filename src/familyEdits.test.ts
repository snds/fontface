// Run with `npm run test:ui`. What the Family groups page and the font page write
// (familyEdits.ts), applied the way src-tauri/src/families.rs applies them, then grouped again.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FamilyChange, FontSummary } from "./api.ts";
import { familyRuleKey, familyRuleKeys, nameRef, yourEdits } from "./familyEdits.ts";
import { autoGroups, type FaceChoice, type GroupingOptions, type NameRule } from "./familyGroups.ts";
import { groupLibrary, type Family } from "./library.ts";

let nextId = 1;
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
    postscriptName: `${family.replace(/\s/g, "")}-${subfamily.replace(/\s/g, "")}`,
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

/** Your choices, saved the way families.rs's `apply` saves a change. */
class Saved {
  choices = new Map<string, FaceChoice>();
  rules = new Map<string, NameRule>();
  apply(change: FamilyChange) {
    for (const { faceKey, set } of change.faces) {
      if (set) this.choices.set(faceKey, { faceKey, family: set.family, style: set.style });
      else this.choices.delete(faceKey);
    }
    for (const { nameKey, set } of change.names) {
      if (set) this.rules.set(nameKey, { nameKey, name: set.name, decision: set.decision, into: set.decision === "merge" ? set.into : null });
      else this.rules.delete(nameKey);
    }
  }
  keepSeparate(names: { nameKey: string; name: string }[], faces: string[] = []) {
    this.apply({
      names: names.map((n) => ({ nameKey: n.nameKey, set: { name: n.name, decision: "separate", into: null } })),
      faces: faces.map((faceKey) => ({ faceKey, set: { family: null, style: null } })),
    });
  }
  reset(faces: string[], nameKeys: string[]) {
    this.apply({ faces: faces.map((faceKey) => ({ faceKey, set: null })), names: nameKeys.map((nameKey) => ({ nameKey, set: null })) });
  }
  options(byName = true): GroupingOptions {
    return { byName, choices: this.choices, rules: this.rules };
  }
}

const names = (families: readonly Family[]) => families.map((f) => f.name);
const named = (families: readonly Family[], name: string) => {
  const f = families.find((x) => x.name === name);
  assert.ok(f, `a family named ${name} (have: ${names(families).join(", ")})`);
  return f;
};

test("chained automatic groups leave no family behind, and nothing left to group (F4, S4)", () => {
  // "A TF" into "A Text", and "A Text" with "A Display" into a new family "A".
  const fonts = [
    font("Neutra Text", "Book", { postscriptName: "NeutraText-Book" }),
    font("Neutra Text", "Bold", { postscriptName: "NeutraText-Bold", weight: 700 }),
    font("Neutra Text TF", "Book", { postscriptName: "NeutraTextTF-Book", hasTypoFamily: true }),
    font("Neutra Display", "Titling", { postscriptName: "NeutraDisplay-Titling" }),
  ];
  const saved = new Saved();
  const lib = groupLibrary(fonts, saved.options());
  assert.deepEqual(names(lib.families), ["Neutra"]);
  assert.equal(named(lib.families, "Neutra").faces.length, 4);
  assert.deepEqual(autoGroups(lib.families, lib.plan, saved.options()), [], "grouping again finds nothing more");
});

test("Keep separate wins over an automatic group, and clearing it (Undo) groups it again", () => {
  const fonts = [
    font("Neutra Text", "Book", { postscriptName: "NeutraText-Book" }),
    font("Neutra Text TF", "Book", { postscriptName: "NeutraTextTF-Book", hasTypoFamily: true }),
    font("Neutra Display", "Titling", { postscriptName: "NeutraDisplay-Titling" }),
    font("Neutra Display", "Bold", { postscriptName: "NeutraDisplay-Bold", weight: 700 }),
  ];
  const saved = new Saved();
  assert.deepEqual(names(groupLibrary(fonts, saved.options()).families), ["Neutra"]);
  // The Family groups page's Keep separate, on Neutra Text: Neutra Text TF still joins it, and
  // Neutra Display alone would only get another name, so it keeps its own.
  saved.keepSeparate([nameRef("Neutra Text")]);
  const kept = groupLibrary(fonts, saved.options());
  assert.deepEqual(names(kept.families), ["Neutra Display", "Neutra Text"]);
  assert.deepEqual(kept.auto.map((g) => [g.into, g.sources.map((s) => s.family.name)]), [["Neutra Text", ["Neutra Text TF"]]]);
  assert.deepEqual(yourEdits(named(kept.families, "Neutra Text").faces), { faces: [], nameKeys: ["neutratext"] });
  // Undo forgets the rule, the way Clear my choices does.
  saved.reset([], ["neutratext"]);
  assert.deepEqual(names(groupLibrary(fonts, saved.options()).families), ["Neutra"]);
  // Off, nothing is grouped automatically, and the rule changes nothing.
  assert.deepEqual(names(groupLibrary(fonts, saved.options(false)).families), ["Neutra Display", "Neutra Text", "Neutra Text TF"]);
});

test("rules follow a face whichever copy is shown, and Clear my choices finds them (S1)", () => {
  // One font in two files that name it differently: "BlindfishDemi", and "Blindfish" + "Demi".
  const a = font("BlindfishDemi", "Regular", { postscriptName: "BlindfishDemi", path: "/Drive/x/BlindfishDemi.otf" });
  const b = font("Blindfish", "Demi", { postscriptName: "BlindfishDemi", path: "/Drive/y/Blindfish-Demi.otf" });
  const saved = new Saved();
  // The font page's "Keep “BlindfishDemi” separate".
  saved.keepSeparate([nameRef("BlindfishDemi")]);
  // Whichever copy is shown, and in whatever order the rows come (the folder removed and added
  // again gives them new ids), the rule holds.
  for (const rows of [
    [a, b],
    [
      { ...b, id: 90 },
      { ...a, id: 91 },
    ],
    [{ ...a, path: "/Drive/z/BlindfishDemi.otf" }, b],
  ]) {
    const face = groupLibrary(rows, saved.options()).families.flatMap((f) => f.faces)[0];
    assert.deepEqual([face.family, face.groupedBy, face.kept, face.ruleKey], ["BlindfishDemi", "rule", true, "blindfishdemi"]);
    assert.deepEqual(yourEdits([face]), { faces: [], nameKeys: ["blindfishdemi"] }, "Clear my choices finds the rule");
  }
  saved.reset([], ["blindfishdemi"]);
  assert.equal(saved.rules.size, 0);
});

test("Keep separate on a family grouped by name is listed and can be cleared (S3)", () => {
  const fonts = [
    font("Amplitude", "Regular", { postscriptName: "Amplitude-Regular" }),
    font("AmplitudeComp-Light", "Regular", { postscriptName: "AmplitudeComp-Light", weight: 300 }),
    font("AmplitudeComp-Bold", "Regular", { postscriptName: "AmplitudeComp-Bold", weight: 700 }),
  ];
  const saved = new Saved();
  const before = groupLibrary(fonts, saved.options());
  assert.deepEqual(names(before.families), ["Amplitude"], "AmplitudeComp joins Amplitude automatically");
  const [s] = before.auto;
  assert.deepEqual([s.into, s.sources.map((src) => src.family.name)], ["Amplitude", ["AmplitudeComp"]]);
  const comp = s.sources[0].family;
  assert.ok(comp.faces.every((f) => f.groupedBy === "name" && f.name !== comp.name), "a family no style is named");
  assert.deepEqual(comp.faces.map((f) => f.auto), [{ from: "AmplitudeComp", reason: "width", word: "Compressed" }, { from: "AmplitudeComp", reason: "width", word: "Compressed" }]);
  // The automatic group's Keep separate: a rule on the family's own name.
  saved.keepSeparate([nameRef(comp.name)]);
  const after = groupLibrary(fonts, saved.options());
  assert.deepEqual(names(after.families), ["Amplitude", "AmplitudeComp"], "it stays as grouping by name made it");
  assert.deepEqual(after.auto, [], "and it isn't grouped again");
  const kept = named(after.families, "AmplitudeComp");
  assert.equal(familyRuleKey(kept, saved.rules), "amplitudecomp", "listed under Your changes");
  const familyRules = familyRuleKeys(after.families, saved.rules);
  assert.deepEqual([...familyRules], ["amplitudecomp"]);
  // Clear my choices on its styles forgets it.
  const mine = yourEdits(kept.faces, familyRules);
  assert.deepEqual(mine, { faces: [], nameKeys: ["amplitudecomp"] });
  saved.reset(mine.faces, mine.nameKeys);
  const cleared = groupLibrary(fonts, saved.options());
  assert.deepEqual([names(cleared.families), cleared.auto.length], [["Amplitude"], 1], "grouped automatically again");
  // A rule a style carries is the style's own, not the family's.
  saved.keepSeparate([nameRef("Amplitude")]);
  assert.equal(familyRuleKey(named(groupLibrary(fonts, saved.options()).families, "Amplitude"), saved.rules), undefined);
});

test("Keep separate on one spelling keeps both spellings together, under the one you chose (S2)", () => {
  const fonts = [
    font("Aaux Pro", "Regular", { postscriptName: "AauxPro-Regular" }),
    font("Aaux ProPoster", "Regular", { postscriptName: "AauxProPoster" }),
    font("AauxPro-Poster", "Italic", { postscriptName: "AauxPro-PosterItalic", italic: true }),
  ];
  const saved = new Saved();
  const before = groupLibrary(fonts, saved.options());
  assert.deepEqual(names(before.families), ["Aaux Pro"], "a size word: Aaux ProPoster joins Aaux Pro automatically");
  assert.equal(named(before.auto[0].sources.map((s) => s.family), "Aaux ProPoster").faces.length, 2, "both spellings, as grouping by name made it");
  saved.keepSeparate([nameRef("Aaux ProPoster")]);
  const after = groupLibrary(fonts, saved.options());
  assert.deepEqual(names(after.families), ["Aaux Pro", "Aaux ProPoster"]);
  assert.deepEqual(
    named(after.families, "Aaux ProPoster").faces.map((f) => [f.style, f.kept]),
    [
      ["Regular", true],
      ["Italic", true],
    ],
  );
});

test("tag counts don't change with any of it: faces keep their keys (tags are by face key)", () => {
  const fonts = [font("Aminta"), font("AmintaBold", "Regular", { postscriptName: "AmintaBold" }), font("Times New Roman"), font("Times New Roman Italic", "Regular", { italic: true })];
  const keys = (options: GroupingOptions) =>
    groupLibrary(fonts, options)
      .families.flatMap((f) => f.faces.map((x) => x.key))
      .sort();
  const saved = new Saved();
  const off = keys({ byName: false });
  assert.deepEqual(keys(saved.options()), off);
  saved.keepSeparate([nameRef("AmintaBold")], ["ps:TimesNewRoman-Regular|static|r"]);
  assert.deepEqual(keys(saved.options()), off);
});
