// Run with `npm run test:ui`. On, off and the states in between (fontState.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActivationOutcome, FontSummary } from "./api.ts";
import { applyOutcomes, copyWords, faceState, lockOf, markOf, stateDetails, stateWords, summarize, switchLook } from "./fontState.ts";
import { groupFamilies, type Face } from "./library.ts";

let nextId = 1;
function font(subfamily: string, more: Partial<FontSummary> = {}): FontSummary {
  const id = nextId++;
  return {
    id,
    folderId: 1,
    path: `/fonts/Family-${subfamily}-${id}.otf`,
    faceIndex: 0,
    family: "Family",
    subfamily,
    fullName: null,
    postscriptName: `Family-${subfamily}`,
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

/** The faces of a family made of these fonts (copies with the same style become one face). */
const faces = (...fonts: FontSummary[]): Face[] => groupFamilies(fonts)[0].faces;
const one = (f: FontSummary) => faces(f)[0];

const MACOS = { installed: true, osActive: true, path: "/System/Library/Fonts/SF.ttf" };
const INSTALLED = { installed: true, osActive: true, path: "/Library/Fonts/Arial.ttf" };
const ON = { activated: true, osActive: true };
const TEMPORARY = { activated: true, osActive: true, temporary: true };
const WAITING = { activated: true, osActive: false };
const ELSEWHERE = { activated: false, osActive: true };
/** Why a style that's set to turn on may not be on (every case says the same "may"). */
const WHY_ONE = "Its file may be on a drive that isn't connected, or online-only. Or macOS may not have loaded it, for example if it's turned off in Font Book.";
const WHY_MANY = "Their files may be on a drive that isn't connected, or online-only. Or macOS may not have loaded them, for example if they're turned off in Font Book.";

test("each style's state", () => {
  assert.equal(faceState(one(font("A", MACOS))), "macos");
  assert.equal(faceState(one(font("A", INSTALLED))), "installed");
  assert.equal(faceState(one(font("A", { ...INSTALLED, path: "/Users/me/Library/Fonts/A.otf" }))), "installed", "~/Library/Fonts is installed too");
  assert.equal(faceState(one(font("A", TEMPORARY))), "temporary");
  assert.equal(faceState(one(font("A", ON))), "on");
  assert.equal(faceState(one(font("A", WAITING))), "waiting");
  assert.equal(faceState(one(font("A", ELSEWHERE))), "elsewhere");
  assert.equal(faceState(one(font("A"))), "off");
  // "temporary" only means something while it's on.
  assert.equal(faceState(one(font("A", { temporary: true }))), "off");
});

test("copies decide together", () => {
  // A macOS copy and one of yours: locked, part of macOS.
  const both = faces(font("A", MACOS), font("A", { path: "/u/A.otf" }));
  assert.equal(both.length, 1);
  assert.equal(lockOf(both[0]), "macos");
  // One copy on until logout, another on to stay: it stays on after logout, so it's just on.
  assert.equal(faceState(faces(font("A", TEMPORARY), font("A", ON))[0]), "on");
  // On through another app's copy while Fontface's copy can't load: on, by another app.
  assert.equal(faceState(faces(font("A", WAITING), font("A", ELSEWHERE))[0]), "elsewhere");
});

test("a family sums its styles, and the switch follows what's on or set to turn on", () => {
  const s = summarize(faces(font("Regular", ON), font("Bold", WAITING), font("Light"), font("Black", TEMPORARY), font("Thin", ELSEWHERE), font("Mono", INSTALLED)));
  assert.deepEqual(s, { lock: null, total: 5, on: 3, wanted: 4, temporary: 1, waiting: 1, elsewhere: 1, locked: 1, macos: 0 });
  assert.deepEqual(switchLook(s), { checked: false, partial: true, dim: false });
  assert.equal(stateWords(s), "3 of 5 on");
  assert.equal(markOf(s), "temporary", "on until logout comes first");
  assert.deepEqual(stateDetails(s, false), [
    "3 of 5 styles are on.",
    "1 style is on until you log out or restart.",
    `1 style is set to turn on, but it isn't on right now. ${WHY_ONE}`,
    "1 style was turned on by another app.",
    "1 style is always on (installed in macOS's font folders).",
  ]);  // The item's own description leaves out the count its name ("3 of 5 on") already says.
  assert.equal(stateDetails(s, false, {}, { count: false })[0], "1 style is on until you log out or restart.");
});

test("set to turn on but not on: the switch is on and dimmed", () => {
  const s = summarize([one(font("A", WAITING))]);
  assert.deepEqual(switchLook(s), { checked: true, partial: false, dim: true });
  assert.equal(markOf(s), "waiting");
  assert.equal(stateWords(s), "set to turn on, not on yet");
  assert.deepEqual(stateDetails(s, true), [`Set to turn on, but it isn't on right now. ${WHY_ONE}`]);
  // Some on, the rest waiting: on, not dimmed, with the mark.
  const mixed = summarize(faces(font("A", ON), font("B", WAITING)));
  assert.deepEqual(switchLook(mixed), { checked: true, partial: false, dim: false });
  assert.equal(stateWords(mixed), "on");
  assert.equal(markOf(mixed), "waiting");
});

test("locks say why", () => {
  const macos = summarize([one(font("A", MACOS))]);
  assert.equal(macos.lock, "macos");
  assert.equal(stateWords(macos), "always on, part of macOS");
  assert.deepEqual(stateDetails(macos, true), ["Part of macOS. Always on."]);
  assert.equal(markOf(macos), "macos");
  const installed = summarize([one(font("A", INSTALLED))]);
  assert.equal(installed.lock, "installed");
  assert.equal(stateWords(installed), "always on, installed");
  assert.deepEqual(stateDetails(installed, true), ["Installed in a Library Fonts folder. Always on while it's there."]);
  // A family with some of each: installed (not all of it is part of macOS).
  const mixed = summarize(faces(font("A", MACOS), font("B", INSTALLED)));
  assert.equal(mixed.lock, "installed");
  assert.match(stateDetails(mixed, false)[0], /some as part of macOS/);
  assert.deepEqual(switchLook(mixed), { checked: false, partial: false, dim: false }, "no switch to show");
});

test("on until logout and on by another app read as such when the whole item is", () => {
  const temporary = summarize(faces(font("A", TEMPORARY), font("B", TEMPORARY)));
  assert.equal(stateWords(temporary), "on until logout");
  assert.deepEqual(stateDetails(temporary, false), ["2 styles are on until you log out or restart."]);
  assert.deepEqual(stateDetails(summarize([one(font("A", TEMPORARY))]), true), ["On until you log out or restart."]);
  const elsewhere = summarize([one(font("A", ELSEWHERE))]);
  assert.equal(stateWords(elsewhere), "on, turned on by another app");
  assert.equal(markOf(elsewhere), "elsewhere");
  assert.deepEqual(stateDetails(elsewhere, true), ["Turned on by another app."]);
  const many = summarize(faces(font("A", ELSEWHERE), font("B", ELSEWHERE), font("C", WAITING), font("D", WAITING)));
  assert.deepEqual(stateDetails(many, false), [
    `2 styles are set to turn on, but they aren't on right now. ${WHY_MANY}`,
    "2 styles were turned on by another app.",
  ]);
});

test("plain on and off have no mark and nothing more to say", () => {
  for (const f of [font("A", ON), font("A")]) {
    const s = summarize([one(f)]);
    assert.equal(markOf(s), null);
    assert.deepEqual(stateDetails(s, true), []);
  }
  assert.equal(stateWords(summarize([one(font("A"))])), "off");
  assert.equal(stateWords(summarize([one(font("A", ON))])), "on");
  assert.equal(stateWords(summarize([])), "off");
});

test("each copy in words, for the font page", () => {
  assert.equal(copyWords(font("A", MACOS)), "Always on (part of macOS)");
  assert.equal(copyWords(font("A", INSTALLED)), "Always on (installed)");
  assert.equal(copyWords(font("A", TEMPORARY)), "On until logout");
  assert.equal(copyWords(font("A", ON)), "On");
  assert.equal(copyWords(font("A", ELSEWHERE)), "On (another app)");
  assert.equal(copyWords(font("A", WAITING)), "Set to turn on");
  assert.equal(copyWords(font("A")), "Off");
});

test("partly on says how many, and Tiles and Table (no room for n/total) show a mark for it", () => {
  const some = summarize(faces(font("Regular", ON), font("Bold", ON), font("Light"), font("Thin"), font("Black")));
  assert.deepEqual(switchLook(some), { checked: false, partial: true, dim: false });
  assert.equal(stateWords(some), "2 of 5 on");
  assert.deepEqual(stateDetails(some, false), ["2 of 5 styles are on."], "the switch is described, not just tinted");
  assert.equal(markOf(some), null, "Rows and the font page show n/total instead");
  assert.equal(markOf(some, { compact: true }), "partial");
  assert.deepEqual(stateDetails(summarize(faces(font("Regular", ON), font("Bold"))), false), ["1 of 2 styles is on."]);
  // Other marks come first; the count is still the first thing said.
  const temporary = summarize(faces(font("Regular", TEMPORARY), font("Bold")));
  assert.equal(markOf(temporary, { compact: true }), "temporary");
  assert.equal(stateDetails(temporary, false)[0], "1 of 2 styles is on.");
  // Plain on and off have no partial mark, compact or not.
  assert.equal(markOf(summarize([one(font("A", ON))]), { compact: true }), null);
  assert.equal(markOf(summarize([one(font("A"))]), { compact: true }), null);
});

test("the count shown is the styles that are on, as the item's name says", () => {
  // 2 styles set to turn on (not on), 3 off: none of it is on.
  const s = summarize(faces(font("A", WAITING), font("B", WAITING), font("C"), font("D"), font("E")));
  assert.equal(s.on, 0, "n/total shows `on`");
  assert.equal(stateWords(s), "0 of 5 on");
  assert.deepEqual(stateDetails(s, false), ["None of its 5 styles are on.", `2 styles are set to turn on, but they aren't on right now. ${WHY_MANY}`]);
  assert.equal(markOf(s, { compact: true }), "waiting");
});

test("with temporary fonts turned off at quit, on until logout says so", () => {
  const untilQuit = { untilQuit: true };
  const single = summarize([one(font("A", TEMPORARY))]);
  assert.deepEqual(stateDetails(single, true, untilQuit), ["On until you quit Fontface, log out or restart."]);
  assert.deepEqual(stateDetails(single, true), ["On until you log out or restart."]);
  const family = summarize(faces(font("A", TEMPORARY), font("B", TEMPORARY)));
  assert.deepEqual(stateDetails(family, false, untilQuit), ["2 styles are on until you quit Fontface, log out or restart."]);
  assert.equal(stateWords(family, untilQuit), "on until Fontface quits");
  assert.equal(stateWords(family), "on until logout");
  assert.equal(copyWords(font("A", TEMPORARY), untilQuit), "On until Fontface quits");
  assert.equal(copyWords(font("A", ON), untilQuit), "On", "fonts on to stay aren't affected");
});

test("after a switch, the list shows what the OS has and what Fontface recorded", () => {
  const outcome = (f: FontSummary, active: boolean, activated: boolean, error: string | null = null): ActivationOutcome => ({
    path: f.path,
    ids: [f.id],
    active,
    activated,
    temporary: false,
    error,
  });
  const after = (f: FontSummary, o: ActivationOutcome) => faceState(one(applyOutcomes([f], [o])[0]));
  // Turned off here, but another app keeps it on: recorded off, still on.
  const inter = font("A", ON);
  assert.equal(after(inter, outcome(inter, true, false, "Still on: another app…")), "elsewhere");
  // Turned on, but macOS didn't load it: recorded on, not on.
  const refused = font("A");
  assert.equal(after(refused, outcome(refused, false, true, "macOS didn't load this font.")), "waiting");
  // A style set to turn on whose file is missing: turning it on fails and the record stays.
  const missing = font("A", WAITING);
  assert.equal(after(missing, outcome(missing, false, true, "the font file was not found")), "waiting");
  // The plain cases.
  const off = font("A");
  assert.equal(after(off, outcome(off, true, true)), "on");
  assert.equal(after(inter, outcome(inter, false, false)), "off");
  // Every font in the file takes the outcome; others are left as they are.
  const [a, b, c] = [font("A"), font("B"), font("C", ON)];
  const list = applyOutcomes([a, b, c], [{ ...outcome(a, true, true), ids: [a.id, b.id], temporary: true }]);
  assert.deepEqual(
    list.map((f) => [f.osActive, f.activated, !!f.temporary]),
    [
      [true, true, true],
      [true, true, true],
      [true, true, false],
    ],
  );
  assert.equal(list[2], c, "untouched fonts are the same objects");
  assert.equal(applyOutcomes(list, []), list, "no outcomes: the same list");
});
