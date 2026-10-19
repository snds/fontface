// Run with `npm run test:ui`. On, off and the states in between (fontState.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FontSummary } from "./api.ts";
import { copyWords, faceState, lockOf, markOf, stateDetails, stateWords, summarize, switchLook } from "./fontState.ts";
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
    "1 style is on until you log out or restart.",
    "1 style is set to turn on, but it isn't on right now. Its file may be on a drive that isn't connected, or online-only.",
    "1 style was turned on by another app.",
    "1 style is always on (installed in macOS's font folders).",
  ]);
});

test("set to turn on but not on: the switch is on and dimmed", () => {
  const s = summarize([one(font("A", WAITING))]);
  assert.deepEqual(switchLook(s), { checked: true, partial: false, dim: true });
  assert.equal(markOf(s), "waiting");
  assert.equal(stateWords(s), "set to turn on, not on yet");
  assert.match(stateDetails(s, true)[0], /^Set to turn on, but it isn't on right now/);
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
    "2 styles are set to turn on, but they aren't on right now. Their files may be on a drive that isn't connected, or online-only.",
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
