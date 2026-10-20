// Run with `npm run test:ui`. The menu bar icon's Tags menu and "Turn Off Temporary Fonts" (trayMenu.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FontSummary } from "./api.ts";
import { groupFamilies, type Face } from "./library.ts";
import { RECENT_TAG_LIMIT, rememberTag, temporaryOffMessage, TRAY_TAG_LIMIT, trayTags, trayTagTurnsOn, type TrayTagSource } from "./trayMenu.ts";

let nextId = 1;
function font(family: string, more: Partial<FontSummary> = {}): FontSummary {
  const id = nextId++;
  return {
    id,
    folderId: 1,
    path: `/fonts/${family}-${id}.otf`,
    faceIndex: 0,
    family,
    subfamily: "Regular",
    fullName: null,
    postscriptName: `${family}-Regular`,
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
const INSTALLED = { installed: true, osActive: true, path: "/Library/Fonts/Installed.otf" };

/** One face per font, each its own family. */
const faces = (...fonts: FontSummary[]): Face[] => groupFamilies(fonts).flatMap((f) => f.faces);

const tag = (id: number, name: string, builtin = false): TrayTagSource => ({ id, name, builtin });

test("the menu lists tags in sidebar order, with what their switch shows", () => {
  const tags = [tag(1, "Display"), tag(2, "Sci-Fi"), tag(3, "Sci-Fi/Star Trek"), tag(4, "Fixed Width", true)];
  const sets = new Map<number, Face[]>([
    [1, faces(font("A", ON), font("B", ON))],
    [2, faces(font("C", ON), font("D"))],
    [3, faces(font("E"))],
    [4, faces(font("F"))],
  ]);
  assert.deepEqual(trayTags(tags, sets, []), [
    { id: 1, name: "Display", state: "on" },
    { id: 2, name: "Sci-Fi", state: "some" },
    { id: 3, name: "Sci-Fi/Star Trek", state: "off" },
    { id: 4, name: "Fixed Width", state: "off" },
  ]);
  assert.deepEqual(
    trayTags(tags, sets, [], { showBuiltin: false }).map((t) => t.id),
    [1, 2, 3],
    "built-in tags stay out while the sidebar hides them",
  );
});

test("tags with nothing to switch are left out", () => {
  const tags = [tag(1, "Empty"), tag(2, "System only"), tag(3, "Mixed")];
  const sets = new Map<number, Face[]>([
    [2, faces(font("Installed", INSTALLED))],
    [3, faces(font("Installed", INSTALLED), font("Mine"))],
  ]);
  assert.deepEqual(trayTags(tags, sets, [4, 1]), [{ id: 3, name: "Mixed", state: "off" }], "no fonts, or only fonts that are always on");
});

test("recently used tags always make the short list, and keep their sidebar place", () => {
  const tags = Array.from({ length: 14 }, (_, i) => tag(i + 1, `Tag ${String(i + 1).padStart(2, "0")}`));
  const sets = new Map(tags.map((t) => [t.id, faces(font(t.name))]));
  const list = trayTags(tags, sets, [13, 12, 99]);
  assert.equal(list.length, TRAY_TAG_LIMIT);
  assert.deepEqual(
    list.map((t) => t.id),
    [1, 2, 3, 4, 5, 6, 7, 8, 12, 13],
    "the two recent ones, then the first eight others; listed in sidebar order. A deleted tag (99) is skipped",
  );
  assert.deepEqual(trayTags(tags.slice(0, 3), sets, []).map((t) => t.id), [1, 2, 3], "few tags: all of them");
});

test("choosing a tag does what its sidebar switch does", () => {
  assert.equal(trayTagTurnsOn(faces(font("A"), font("B"))), true, "off: turns them on");
  assert.equal(trayTagTurnsOn(faces(font("A", ON), font("B"))), true, "some on: turns on the rest");
  assert.equal(trayTagTurnsOn(faces(font("A", ON), font("B", ON))), false, "all on: turns them off");
  assert.equal(trayTagTurnsOn(faces(font("A", { activated: true }))), false, "set to turn on counts as on");
});

test("recent tags: newest first, each once, at most eight", () => {
  assert.deepEqual(rememberTag([], 5), [5]);
  assert.deepEqual(rememberTag([3, 5, 7], 5), [5, 3, 7]);
  const full = rememberTag([1, 2, 3, 4, 5, 6, 7, 8], 9);
  assert.equal(full.length, RECENT_TAG_LIMIT);
  assert.deepEqual(full, [9, 1, 2, 3, 4, 5, 6, 7]);
});

test("Turn Off Temporary Fonts says what it did in plain words", () => {
  assert.deepEqual(temporaryOffMessage({ turnedOff: 12, failed: [], error: null }), { tone: "success", title: "Turned off 12 fonts that were on until logout" });
  assert.deepEqual(temporaryOffMessage({ turnedOff: 1, failed: [], error: null }), { tone: "success", title: "Turned off 1 font that was on until logout" });
  assert.equal(temporaryOffMessage({ turnedOff: 0, failed: [], error: null }), null, "nothing to do: nothing to say");
  assert.deepEqual(temporaryOffMessage({ turnedOff: 3, failed: [["/Volumes/Work/Fonts/Gone.otf", "macOS didn't load it"]], error: null }), {
    tone: "warning",
    title: "Turned off 3 fonts that were on until logout; 1 file couldn't be turned off",
    description: "Gone.otf: macOS didn't load it",
  });
  assert.equal(temporaryOffMessage({ turnedOff: 0, failed: [["C:\\Fonts\\A.otf", "Still on"]], error: null })?.description, "A.otf: Still on");
  assert.deepEqual(temporaryOffMessage({ turnedOff: 0, failed: [], error: "database lock poisoned" }), {
    tone: "error",
    title: "Couldn't turn off temporary fonts",
    description: "database lock poisoned",
  });
});
