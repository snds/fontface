// Run with `npm run test:ui`. What the menu bar icon's "Turn Off Temporary Fonts" says (trayMenu.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { temporaryOffMessage } from "./trayMenu.ts";

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
