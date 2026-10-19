// Run with `npm run test:ui`. The Axes tab's number field (axisField.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { commitAxis, discardAxis, typeAxis, type AxisDraft } from "./axisField.ts";

const WGHT = { min: 100, max: 900 };

/** Types `text` one character at a time from `value`, as the field would. */
function typeOut(text: string, value: number) {
  let draft: AxisDraft | null = null;
  const applied: number[] = [];
  for (let i = 1; i <= text.length; i++) {
    const step = typeAxis(draft, text.slice(0, i), value, WGHT);
    draft = step.draft;
    if (step.apply !== undefined) {
      applied.push(step.apply);
      value = step.apply;
    }
  }
  return { draft, applied, value };
}

test("values in range apply as they're typed; others wait", () => {
  const { draft, applied } = typeOut("700", 400);
  assert.deepEqual(applied, [700], "7 and 70 are out of range");
  assert.equal(draft?.before, 400, "the value from before typing is kept");
  assert.deepEqual(typeOut("1000", 400).applied, [100], "100 applies on the way to 1000");
});

test("Esc goes back to the value from before typing, even after values were applied", () => {
  assert.equal(discardAxis(typeOut("700", 400).draft), 400);
  assert.equal(discardAxis(typeOut("1000", 400).draft), 400, "not the 100 applied on the way");
  assert.equal(discardAxis(null), undefined, "nothing typed: nothing to undo");
});

test("Return or leaving the field applies what was typed, within the range", () => {
  assert.equal(commitAxis(typeOut("1000", 400).draft, WGHT), 900);
  assert.equal(commitAxis(typeOut("50", 400).draft, WGHT), 100);
  assert.equal(commitAxis(typeOut("650.5", 400).draft, WGHT), 650.5);
  assert.equal(commitAxis(null, WGHT), undefined, "nothing typed: nothing changes");
});

test("an empty field, or text that isn't a number, goes back to the value from before typing", () => {
  let { draft } = typeOut("700", 400);
  draft = typeAxis(draft, "", 700, WGHT).draft;
  assert.equal(draft.before, 400, "a draft keeps its starting value while typing goes on");
  assert.equal(commitAxis(draft, WGHT), 400);
  assert.equal(commitAxis(typeAxis(null, "-", 400, WGHT).draft, WGHT), 400);
});
