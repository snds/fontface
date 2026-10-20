// Run with `npm run test:ui`. A tag's set of fonts, turning it on or off, and what can be done to it
// (tagActions.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActivationOutcome, FontSummary } from "./api.ts";
import { groupFamilies, type Face } from "./library.ts";
import {
  canNestIn,
  facesByTag,
  planTagSwitch,
  problemWords,
  tagEditStates,
  tagSwitchMessage,
  tagSwitchResult,
  tagSwitchStates,
  type TagLookup,
} from "./tagActions.ts";

let nextId = 1;
function font(family: string, subfamily: string, more: Partial<FontSummary> = {}): FontSummary {
  const id = nextId++;
  return {
    id,
    folderId: 1,
    path: `/fonts/${family}-${subfamily}-${id}.otf`,
    faceIndex: 0,
    family,
    subfamily,
    fullName: null,
    postscriptName: `${family}-${subfamily}`,
    weight: 400,
    width: 5,
    italic: false,
    monospace: false,
    variable: false,
    format: "OpenType CFF",
    activated: false,
    installed: false,
    mtime: 1,
    fileSize: 1,
    osActive: false,
    glyphCount: 1,
    preview: null,
    ...more,
  };
}

const ON = { activated: true, osActive: true };
const WAITING = { activated: true, osActive: false };
const ELSEWHERE = { activated: false, osActive: true };
const INSTALLED = { installed: true, osActive: true, path: "/Library/Fonts/Installed.otf" };

// The tag tree: Sci-Fi › Star Trek › TNG, Sci-Fi › Aliens, and Retro beside it.
const SCIFI = 1, TREK = 2, TNG = 3, ALIENS = 4, RETRO = 5, EMPTY = 6;
const LINEAGE = new Map<number, number[]>([
  [SCIFI, [SCIFI]],
  [TREK, [TREK, SCIFI]],
  [TNG, [TNG, TREK, SCIFI]],
  [ALIENS, [ALIENS, SCIFI]],
  [RETRO, [RETRO]],
  [EMPTY, [EMPTY]],
]);
const lookupOf = (tags: Map<string, number[]>): TagLookup => ({ lineage: LINEAGE, tagsOf: (face: Face) => tags.get(face.key) ?? [] });

/** A library: each font is its own family, tagged as given. */
function library(entries: [FontSummary, number[]][]) {
  const families = groupFamilies(entries.map(([f]) => f));
  const faces = families.flatMap((fam) => fam.faces);
  const byFont = new Map(faces.flatMap((face) => face.copies.map((c) => [c.id, face] as const)));
  const tags = new Map(entries.map(([f, ids]) => [byFont.get(f.id)!.key, ids]));
  return { families, lookup: lookupOf(tags), face: (f: FontSummary) => byFont.get(f.id)! };
}

test("a tag's set has its own fonts and every tag's inside it; a nested tag only its own", () => {
  const okuda = font("Okuda", "Regular");
  const trekBold = font("Okuda", "Bold");
  const tng = font("Federation", "Regular");
  const alien = font("Xeno", "Regular");
  const retro = font("Retro", "Regular");
  const both = font("Bridge", "Regular"); // tagged with the parent and a child: counted once
  const none = font("Plain", "Regular");
  const lib = library([
    [okuda, [SCIFI]],
    [trekBold, [TREK]],
    [tng, [TNG]],
    [alien, [ALIENS, RETRO]],
    [retro, [RETRO]],
    [both, [SCIFI, TREK]],
    [none, []],
  ]);
  const sets = facesByTag(lib.families, lib.lookup);
  const names = (id: number) => (sets.get(id) ?? []).map((f) => `${f.primary.family} ${f.style}`).sort();

  assert.deepEqual(names(SCIFI), ["Bridge Regular", "Federation Regular", "Okuda Bold", "Okuda Regular", "Xeno Regular"]);
  assert.deepEqual(names(TREK), ["Bridge Regular", "Federation Regular", "Okuda Bold"], "a child: itself and the tags inside it, not its parent's own fonts");
  assert.deepEqual(names(TNG), ["Federation Regular"]);
  assert.deepEqual(names(ALIENS), ["Xeno Regular"], "not its sibling's");
  assert.deepEqual(names(RETRO), ["Retro Regular", "Xeno Regular"]);
  assert.equal(sets.has(EMPTY), false, "a tag with no fonts in the library has no set");
  for (const set of sets.values()) assert.equal(new Set(set).size, set.length, "each style once");
});

test("turning a set on: off styles only, one copy each, in batches of whole files", () => {
  const off = font("A", "Regular");
  const on = font("B", "Regular", ON);
  const waiting = font("C", "Regular", WAITING);
  const installed = font("D", "Regular", INSTALLED);
  const lib = library([off, on, waiting, installed].map((f) => [f, [SCIFI]]));
  const set = facesByTag(lib.families, lib.lookup).get(SCIFI)!;

  const plan = planTagSwitch(set, true);
  assert.deepEqual(plan.faces.map((f) => f.primary.family).sort(), ["A", "C"], "set to turn on but not on is asked again");
  assert.equal(plan.already, 1);
  assert.equal(plan.locked, 1, "installed fonts are always on and never sent");
  assert.deepEqual(plan.batches, [{ ids: [off.id, waiting.id], faces: 2 }]);

  // Two copies of one style: only one is turned on.
  const copyA = font("Dup", "Regular", { path: "/fonts/a/Dup.otf" });
  const copyB = font("Dup", "Regular", { path: "/fonts/b/Dup.otf" });
  const dup = library([[copyA, [RETRO]], [copyB, [RETRO]]]);
  const dupSet = facesByTag(dup.families, dup.lookup).get(RETRO)!;
  assert.equal(dupSet.length, 1);
  assert.equal(planTagSwitch(dupSet, true).batches.flatMap((b) => b.ids).length, 1);
});

test("turning a set off: every copy of every style that's on, however it was turned on", () => {
  const on = font("A", "Regular", ON);
  const elsewhere = font("B", "Regular", ELSEWHERE);
  const waiting = font("C", "Regular", WAITING);
  const off = font("D", "Regular");
  const installed = font("E", "Regular", INSTALLED);
  const copy1 = font("F", "Regular", { ...ON, path: "/fonts/1/F.otf" });
  const copy2 = font("F", "Regular", { path: "/fonts/2/F.otf" });
  const lib = library([on, elsewhere, waiting, off, installed, copy1, copy2].map((f) => [f, [TREK]]));
  const plan = planTagSwitch(facesByTag(lib.families, lib.lookup).get(TREK)!, false);
  assert.deepEqual(plan.faces.map((f) => f.primary.family).sort(), ["A", "B", "C", "F"]);
  assert.deepEqual(plan.batches.flatMap((b) => b.ids).sort((a, b) => a - b), [on.id, elsewhere.id, waiting.id, copy1.id, copy2.id].sort((a, b) => a - b));
  assert.equal(plan.already, 1);
  assert.equal(plan.locked, 1);
});

test("big sets go in about ten batches, at least 25 files each, each style counted once", () => {
  const make = (n: number) => {
    const lib = library(Array.from({ length: n }, (_, i) => [font(`F${i}`, "Regular"), [SCIFI]] as [FontSummary, number[]]));
    return planTagSwitch(facesByTag(lib.families, lib.lookup).get(SCIFI)!, true);
  };
  const small = make(20);
  assert.equal(small.batches.length, 1);
  const mid = make(60);
  assert.deepEqual(mid.batches.map((b) => b.ids.length), [25, 25, 10]);
  const sciFi = make(373);
  assert.equal(sciFi.batches.length, 10);
  assert.ok(sciFi.batches.every((b) => b.ids.length <= 38));
  assert.equal(sciFi.batches.reduce((n, b) => n + b.faces, 0), 373, "progress adds up to the set");
});

const outcome = (f: FontSummary, active: boolean, error: string | null = null): ActivationOutcome => ({
  path: f.path,
  ids: [f.id],
  active,
  activated: active,
  temporary: false,
  error,
});

const NOT_LOADED = "macOS didn't load this font. It may be turned off in another app. It stays set to turn on until you switch it off.";

test("the result counts styles and groups the reasons", () => {
  const fonts = Array.from({ length: 6 }, (_, i) => font(`R${i}`, "Regular"));
  const lib = library(fonts.map((f) => [f, [RETRO]]));
  const plan = planTagSwitch(facesByTag(lib.families, lib.lookup).get(RETRO)!, true);
  const outcomes = [
    outcome(fonts[0], true),
    outcome(fonts[1], true),
    outcome(fonts[2], false, NOT_LOADED),
    outcome(fonts[3], false, NOT_LOADED),
    outcome(fonts[4], false, "Its folder was removed from the library"),
    // fonts[5]: its request failed as a whole.
  ];
  const result = tagSwitchResult(plan, outcomes, ["The connection dropped"]);
  assert.equal(result.done, 2);
  assert.deepEqual(result.problems, [
    { error: NOT_LOADED, count: 2 },
    { error: "Its folder was removed from the library", count: 1 },
    { error: "The connection dropped", count: 1 },
  ]);
  assert.equal(problemWords(result.problems[0], true), "2 fonts didn't turn on. macOS didn't load them. They may be turned off in another app.");
  assert.equal(problemWords(result.problems[1], true), "1 font didn't turn on. Its folder was removed from the library.");
  assert.equal(problemWords(result.problems[2], true), "1 font didn't turn on. The connection dropped.");

  const message = tagSwitchMessage("Retro", plan, result);
  assert.equal(message.tone, "warning");
  assert.equal(message.title, "Turned on 2 of 6 fonts in “Retro”");
  assert.equal(message.details.length, 3);
});

test("what a tag switch says", () => {
  const a = font("A", "Regular");
  const b = font("B", "Regular", ON);
  const c = font("C", "Regular", INSTALLED);
  const lib = library([a, b, c].map((f) => [f, [SCIFI]]));
  const set = facesByTag(lib.families, lib.lookup).get(SCIFI)!;
  const on = planTagSwitch(set, true);
  const all = tagSwitchResult(on, [outcome(a, true)]);
  assert.deepEqual(tagSwitchMessage("Sci-Fi", on, all), {
    tone: "success",
    title: "Turned on 1 font in “Sci-Fi”",
    details: ["1 font was already on.", "1 font is always on: installed in macOS's font folders."],
  });
  assert.equal(tagSwitchMessage("Sci-Fi", on, all, { mode: "temporary" }).title, "Turned on 1 font in “Sci-Fi” until logout");
  assert.equal(tagSwitchMessage("Sci-Fi", on, all, { mode: "temporary", untilQuit: true }).title, "Turned on 1 font in “Sci-Fi” until Fontface quits");
  const none = tagSwitchMessage("Sci-Fi", on, tagSwitchResult(on, [outcome(a, false, NOT_LOADED)]));
  assert.equal(none.tone, "error");
  assert.equal(none.title, "Couldn't turn on the fonts in “Sci-Fi”");
  assert.equal(none.details[0], "1 font didn't turn on. macOS didn't load it. It may be turned off in another app.");

  const off = planTagSwitch(set, false);
  const stillOn = "Still on: another app has turned this font on. Turn it off there.";
  const offMessage = tagSwitchMessage("Sci-Fi", off, tagSwitchResult(off, [outcome(b, true, stillOn)]));
  assert.equal(offMessage.title, "Couldn't turn off the fonts in “Sci-Fi”");
  assert.deepEqual(offMessage.details, [
    "1 font didn't turn off. Another app keeps it on. Turn it off there.",
    "1 font stays on: installed in macOS's font folders.",
  ]);

  // Nothing to do.
  const empty = planTagSwitch([], true);
  assert.equal(tagSwitchMessage("Sci-Fi", empty, tagSwitchResult(empty, [])).title, "No fonts in your library have the tag “Sci-Fi”");
  const allOn = planTagSwitch([lib.face(b), lib.face(c)], true);
  assert.equal(tagSwitchMessage("Sci-Fi", allOn, tagSwitchResult(allOn, [])).title, "All fonts in “Sci-Fi” are already on");
  const allOff = planTagSwitch([lib.face(a)], false);
  assert.equal(tagSwitchMessage("Sci-Fi", allOff, tagSwitchResult(allOff, [])).title, "None of the fonts in “Sci-Fi” are on");
});

test("the tag menu's on and off items", () => {
  const a = font("A", "Regular");
  const b = font("B", "Regular", ON);
  const lib = library([a, b].map((f) => [f, [SCIFI]]));
  const set = facesByTag(lib.families, lib.lookup).get(SCIFI)!;

  const some = tagSwitchStates("Sci-Fi", set, { mode: "persistent", nested: true });
  assert.equal(some.turnOn.label, "Turn on all fonts");
  assert.equal(some.turnOn.tip, "Turns on the 1 font that is off in “Sci-Fi”, and in the tags inside it. They stay on until you turn them off.");
  assert.equal(some.turnOnOther.label, "Turn on all fonts until logout");
  assert.match(some.turnOnOther.tip, /They go off when you log out\.$/);
  assert.equal(some.turnOff.enabled, true);
  assert.equal(some.turnOff.tip, "Turns off the 1 font that is on in “Sci-Fi”, and in the tags inside it, however it was turned on");

  const temporary = tagSwitchStates("Sci-Fi", set, { mode: "temporary", untilQuit: true });
  assert.equal(temporary.turnOn.label, "Turn on all fonts until Fontface quits");
  assert.equal(temporary.turnOnOther.label, "Turn on all fonts");

  const allOn = tagSwitchStates("Sci-Fi", [lib.face(b)], { mode: "persistent" });
  assert.deepEqual([allOn.turnOn.enabled, allOn.turnOn.tip], [false, "The font in “Sci-Fi” is already on"]);
  const allOff = tagSwitchStates("Sci-Fi", [lib.face(a)], { mode: "persistent" });
  assert.deepEqual([allOff.turnOff.enabled, allOff.turnOff.tip], [false, "None of the fonts in “Sci-Fi” are on"]);
  const nothing = tagSwitchStates("Empty", [], { mode: "persistent" });
  assert.ok(!nothing.turnOn.enabled && !nothing.turnOnOther.enabled && !nothing.turnOff.enabled);
  assert.equal(nothing.turnOff.tip, "No fonts in your library have this tag");
});

test("built-in tags are read-only, except to export them or make them your own", () => {
  const style = { name: "Style", builtin: true };
  const sans = { name: "Style/Sans", builtin: true };
  const mine = { name: "Sci-Fi", builtin: false };

  for (const [tag, top] of [[style, style], [sans, style]] as const) {
    const s = tagEditStates(tag, top);
    for (const id of ["rename", "color", "newInside", "moveTo", "delete"] as const) {
      assert.equal(s[id].enabled, false, `${tag.name}: ${id}`);
      assert.match(s[id].tip, /Make it my tag/, `${tag.name}: ${id} says how to change it`);
    }
    assert.equal(s.export.enabled, true);
    assert.equal(s.makeMine.enabled, true);
  }
  assert.equal(tagEditStates(style, style).makeMine.label, "Make it my tag");
  assert.equal(tagEditStates(sans, style).makeMine.label, "Make “Style” my tag", "a nested tag makes its whole branch yours");
  assert.match(tagEditStates(sans, style).makeMine.tip, /^Moves “Style” and the tags inside it to My tags\./);
  assert.match(tagEditStates(style, style).delete.tip, /Settings › Sidebar/);

  const own = tagEditStates(mine, mine, { nested: true });
  for (const id of ["rename", "color", "newInside", "moveTo", "export", "delete"] as const) assert.equal(own[id].enabled, true, id);
  assert.equal(own.makeMine.enabled, false);
  assert.equal(own.delete.tip, "Deletes it and the tags inside it. The fonts stay in your library.");
  assert.equal(own.color.tip, "Changes its color", "one sentence: no closing period");
});

test("only your own tags move, and only into your own tags", () => {
  const style = { name: "Style", builtin: true };
  const sciFi = { name: "Sci-Fi", builtin: false };
  const trek = { name: "Sci-Fi/Star Trek", builtin: false };
  const retro = { name: "Retro", builtin: false };
  assert.equal(canNestIn(retro, sciFi), true);
  assert.equal(canNestIn(trek, retro), true);
  assert.equal(canNestIn(retro, style), false, "not into a built-in tag");
  assert.equal(canNestIn(style, retro), false, "a built-in tag doesn't move");
  assert.equal(canNestIn(sciFi, trek), false, "not inside itself");
  assert.equal(canNestIn(sciFi, { name: "sci-fi", builtin: false }), false, "not onto itself, in any case");
  assert.equal(canNestIn(trek, sciFi), false, "not where it already is");
});
