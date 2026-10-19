// Run with `npm run test:ui`. The OpenType tab's names, groups, switches and languages (openType.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FontFeature } from "./api.ts";
import {
  describeFeature,
  featureSampleText,
  FEATURE_SLACK,
  featureSlack,
  groupFeatures,
  isOn,
  KNOWN_FEATURE_TAGS,
  languageChoices,
  otLanguageName,
  pageFeatureValues,
  scriptName,
  scriptsLine,
  setToggle,
} from "./openType.ts";
import { featureSettings, PREVIEW_CASES, previewCase, previewFeatureValues } from "./previewStyle.ts";

const f = (tag: string, more: Partial<FontFeature> = {}): FontFeature => ({ tag, gsub: true, gpos: false, ...more });

test("features get plain names; sets and variants use the font's own names", () => {
  assert.equal(describeFeature(f("liga")).label, "Standard ligatures");
  assert.equal(describeFeature(f("liga")).detail, "liga");
  assert.equal(describeFeature(f("smcp")).label, "Small capitals");
  const named = describeFeature(f("ss01", { name: "Single-storey a" }));
  assert.deepEqual([named.label, named.detail, named.group], ["Single-storey a", "Stylistic set 1 · ss01", "sets"]);
  const plain = describeFeature(f("ss12"));
  assert.deepEqual([plain.label, plain.detail], ["Stylistic set 12", "ss12"]);
  const variant = describeFeature(f("cv07", { name: "One storey a" }));
  assert.deepEqual([variant.label, variant.detail, variant.group], ["One storey a", "Character variant 7 · cv07", "variants"]);
  const unknown = describeFeature(f("THEX"));
  assert.deepEqual([unknown.label, unknown.group], ["Feature “THEX”", "other"]);
});

test("which features are on by default, and which a switch can show", () => {
  for (const tag of ["liga", "calt", "kern", "ccmp", "locl", "mark"]) assert.ok(describeFeature(f(tag)).defaultOn, tag);
  for (const tag of ["dlig", "smcp", "ss01", "onum", "frac", "swsh"]) assert.ok(!describeFeature(f(tag)).defaultOn, tag);
  assert.ok(!describeFeature(f("vert")).switchable, "vertical-text features change nothing here");
  assert.ok(describeFeature(f("ss01")).switchable);
});

test("samples: the font's own characters for alternates, Fontface's text where it shows more", () => {
  assert.equal(describeFeature(f("ss01", { sample: "a g y" })).sample, "a g y");
  assert.equal(describeFeature(f("liga", { sample: "fi fl" })).sample, "fi fl", "the ligatures the font really has");
  assert.equal(describeFeature(f("liga")).sample, "fi fl ff ffi");
  assert.equal(describeFeature(f("frac", { sample: "0 1 2 /" })).sample, "1/2 3/4 5/8", "fractions show as fractions");
  assert.equal(describeFeature(f("salt")).sample, undefined, "nothing to show");
  // A font without lowercase can't draw "Small Caps": the font's own characters instead.
  const caps = "abcdefghijklmnopqrstuvwxyz";
  assert.equal(describeFeature(f("smcp", { sample: "A B" }), caps).sample, "A B");
  assert.equal(describeFeature(f("smcp"), caps).sample, undefined);
});

test("a feature's sample keeps its case, whatever case the View options set", () => {
  // Fontface's own texts (some show a feature only in one case: "Small Caps", "CAPITALS"), and
  // the font's own characters (a character variant's "a à á", a set's "J", a ligature's "fi").
  const samples = [
    ...KNOWN_FEATURE_TAGS.map((tag) => describeFeature(f(tag)).sample),
    ...["a à á â ã ä å ā ă ą", "J", "I", "fi fl", "a g y"].map((s) => describeFeature(f("cv07", { sample: s })).sample),
  ].filter((s): s is string => !!s);
  assert.ok(samples.includes("Small Caps") && samples.includes("CAPITALS") && samples.includes("fi fl ff ffi"));
  // What each feature's row draws, in every case the View options offer.
  for (const c of PREVIEW_CASES) for (const s of samples) assert.equal(featureSampleText({ ...describeFeature(f("cv07")), sample: s }, c.id), s, `${c.id}: ${s}`);
  assert.equal(featureSampleText(describeFeature(f("salt")), "upper"), undefined, "no sample, nothing drawn");
  // Treated as words, they'd change, and their switches would show nothing: "SMALL CAPS" has no
  // lowercase for small capitals to change, "capitals" no capitals, "A À Á" not the variant's a.
  assert.equal(previewCase("Small Caps", "upper", {}), "SMALL CAPS");
  assert.equal(previewCase("CAPITALS", "lower", {}), "capitals");
  assert.equal(previewCase("a à á", "title", {}), "A À Á");
});

test("required variation alternates are on by default, like the text engine has them", () => {
  const rvrn = describeFeature(f("rvrn"));
  assert.deepEqual([rvrn.label, rvrn.group, rvrn.defaultOn], ["Alternates for variable styles", "alternates", true]);
  assert.equal(isOn("rvrn", rvrn.defaultOn, {}, {}), true);
  assert.equal(featureSlack({ rvrn: 1 }), 0, "already in the plain text's measurement");
});

test("only groups the face has, in order, each in a steady order", () => {
  const groups = groupFeatures([f("ss02"), f("kern", { gsub: false, gpos: true }), f("ss01"), f("tnum"), f("onum"), f("liga"), f("dlig"), f("vert"), f("zzzz")]);
  assert.deepEqual(
    groups.map((g) => [g.id, g.features.map((x) => x.tag)]),
    [
      ["ligatures", ["liga", "dlig"]],
      ["figures", ["onum", "tnum"]],
      ["sets", ["ss01", "ss02"]],
      ["spacing", ["kern"]],
      ["vertical", ["vert"]],
      ["other", ["zzzz"]],
    ],
  );
  assert.deepEqual(groupFeatures([]), []);
});

test("a switch's state: the page's switch, else the View options, else the font's default", () => {
  const preview = previewFeatureValues(["noLigatures", "smallCaps"]);
  assert.equal(isOn("liga", true, {}, {}), true);
  assert.equal(isOn("liga", true, {}, preview), false, "No ligatures in the View options");
  assert.equal(isOn("liga", true, { liga: true }, preview), true, "the page's switch wins");
  assert.equal(isOn("smcp", false, {}, preview), true);
  assert.equal(isOn("ss01", false, {}, preview), false);
});

test("switching back to how it would be anyway leaves nothing to reset", () => {
  const preview = previewFeatureValues(["smallCaps"]);
  let toggles = setToggle({}, "ss01", true, false, preview);
  assert.deepEqual(toggles, { ss01: true });
  toggles = setToggle(toggles, "liga", false, true, preview);
  assert.deepEqual(toggles, { ss01: true, liga: false });
  toggles = setToggle(toggles, "ss01", false, false, preview);
  assert.deepEqual(toggles, { liga: false });
  toggles = setToggle(toggles, "smcp", false, false, preview);
  assert.deepEqual(toggles, { liga: false, smcp: false }, "turning off what the View options turned on");
  toggles = setToggle(toggles, "smcp", true, false, preview);
  assert.deepEqual(toggles, { liga: false });
});

test("the page's switches go on top of the View options' features", () => {
  const preview = previewFeatureValues(["tabularFigures"]);
  const values = pageFeatureValues(preview, { ss01: true, liga: false, tnum: false });
  assert.equal(featureSettings(values), '"liga" 0, "ss01" 1, "tnum" 0');
  assert.deepEqual(pageFeatureValues(preview, {}), preview);
});

test("features that can draw past the plain text's ink make fitting keep more room", () => {
  assert.equal(featureSlack({}), 0);
  assert.equal(featureSlack({ smcp: 1, tnum: 1, liga: 0, case: 1 }), 0, "these stay inside");
  assert.equal(featureSlack({ swsh: 1 }), FEATURE_SLACK);
  assert.equal(featureSlack({ ss01: 1 }), FEATURE_SLACK);
  assert.equal(featureSlack({ ss01: 0, swsh: 0 }), 0, "turned off, nothing new is drawn");
});

test("scripts and languages are named in plain English", () => {
  assert.equal(scriptName("latn"), "Latin");
  assert.equal(scriptName("cyrl"), "Cyrillic");
  assert.equal(scriptName("dev2"), "Devanagari");
  assert.equal(scriptName("math"), "Math");
  assert.equal(scriptName("qqqq"), "qqqq", "unknown: the tag");
  assert.equal(otLanguageName("TRK"), "Turkish");
  assert.equal(otLanguageName("ZZZ"), "ZZZ");
  assert.equal(scriptsLine([{ tag: "latn", languages: ["TRK", "ROM"] }, { tag: "cyrl", languages: [] }]), "Latin (Turkish, Romanian), Cyrillic");
});

test("the language choices are the languages the font has its own forms for", () => {
  const choices = languageChoices([
    { tag: "latn", languages: ["TRK", "ROM", "MOL", "ZZZ"] },
    { tag: "cyrl", languages: ["SRB", "BGR"] },
    { tag: "grek", languages: ["TRK"] },
  ]);
  assert.deepEqual(
    choices.map((c) => [c.value, c.tag]),
    [
      ["bg", "BGR"],
      ["ro-MD", "MOL"],
      ["ro", "ROM"],
      ["sr", "SRB"],
      ["tr", "TRK"],
    ],
    "by name, each once, tags Fontface can't name left out",
  );
  assert.equal(choices.find((c) => c.value === "tr")?.label, "Turkish");
});
