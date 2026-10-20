// Run with `npm run test:ui`. The Axes tab's number field, and optical size following the text
// size (axisField.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  axisValuesAt,
  commitAxis,
  currentInstance,
  discardAxis,
  followsSize,
  namesOpticalSizes,
  opticalSize,
  pickNamedStyle,
  typeAxis,
  variationAt,
  type AxisDraft,
  type AxisInfo,
  type Instance,
} from "./axisField.ts";

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

const OPTICAL: AxisInfo[] = [
  { tag: "wght", min: 100, max: 900, default: 400 },
  { tag: "opsz", min: 8, max: 144, default: 14 },
];

test("optical size follows the text size, within the axis's range, until it's set by hand", () => {
  const opsz = OPTICAL[1];
  assert.equal(opticalSize(opsz, 24), 24);
  assert.equal(opticalSize(opsz, 6), 8, "below the range: its smallest");
  assert.equal(opticalSize(opsz, 200), 144, "above it: its largest");
  assert.equal(opticalSize(opsz, 17.333), 17.33);
  assert.ok(followsSize(OPTICAL, {}));
  assert.ok(followsSize(OPTICAL, { wght: 700 }), "other axes set by hand don't change it");
  assert.ok(!followsSize(OPTICAL, { opsz: 30 }), "set by hand");
  assert.ok(!followsSize([OPTICAL[0]], {}), "no optical size axis: nothing follows");
  assert.deepEqual(axisValuesAt(OPTICAL, { wght: 700 }, 96), { wght: 700, opsz: 96 });
  assert.deepEqual(axisValuesAt(OPTICAL, { opsz: 30 }, 96), { opsz: 30 }, "set by hand: as set, at every size");
  assert.deepEqual(axisValuesAt([OPTICAL[0]], { wght: 700 }, 96), { wght: 700 });
});

test("each preview size gets its own font-variation-settings while optical size follows", () => {
  const at = variationAt(OPTICAL, { wght: 650 });
  assert.equal(at(12), '"wght" 650, "opsz" 12');
  assert.equal(at(96), '"wght" 650, "opsz" 96');
  assert.equal(at(4), '"wght" 650, "opsz" 8');
  assert.equal(variationAt(OPTICAL, {})(40), '"opsz" 40', "at the defaults, optical size still follows");
  assert.equal(variationAt(OPTICAL, { opsz: 30 })(96), '"opsz" 30');
  assert.equal(variationAt([OPTICAL[0]], {})(40), undefined, "no axes set: the font's defaults");
  assert.equal(variationAt([], { wght: 500 })(12), '"wght" 500');
});

const SAME_SIZE: Instance[] = [
  { name: "Regular", values: [["wght", 400], ["opsz", 14]] },
  { name: "Bold", values: [["wght", 700], ["opsz", 14]] },
];
const NAMED_SIZES: Instance[] = [
  { name: "Caption", values: [["wght", 400], ["opsz", 8]] },
  { name: "Text", values: [["wght", 400], ["opsz", 14]] },
  { name: "Display", values: [["wght", 400], ["opsz", 72]] },
];

test("a named style sets optical size only when the font's named styles differ in it", () => {
  assert.ok(!namesOpticalSizes(SAME_SIZE, OPTICAL));
  assert.ok(namesOpticalSizes(NAMED_SIZES, OPTICAL));
  assert.ok(!namesOpticalSizes(NAMED_SIZES, [OPTICAL[0]]), "no optical size axis");
  assert.deepEqual(pickNamedStyle(SAME_SIZE[1], SAME_SIZE, OPTICAL, {}), { wght: 700 }, "optical size keeps following");
  assert.deepEqual(pickNamedStyle(SAME_SIZE[1], SAME_SIZE, OPTICAL, { opsz: 30 }), { wght: 700, opsz: 30 }, "or keeps the size set by hand");
  assert.deepEqual(pickNamedStyle(NAMED_SIZES[2], NAMED_SIZES, OPTICAL, {}), { wght: 400, opsz: 72 }, "Display sets its own optical size");
  assert.deepEqual(pickNamedStyle(SAME_SIZE[0], SAME_SIZE, [OPTICAL[0]], {}), { wght: 400 });
});

test("when the named styles share one optical size, the picker matches them on the other axes", () => {
  assert.equal(currentInstance(SAME_SIZE, OPTICAL, {}), 0);
  assert.equal(currentInstance(SAME_SIZE, OPTICAL, { wght: 700 }), 1);
  assert.equal(currentInstance(SAME_SIZE, OPTICAL, { wght: 700, opsz: 14 }), 1, "set by hand at the styles' own size");
  assert.equal(currentInstance(SAME_SIZE, OPTICAL, { wght: 700, opsz: 30 }), 1, "set by hand elsewhere: still Bold");
  // Picking a style keeps a hand-set optical size, and the picker then shows that style.
  const picked = pickNamedStyle(SAME_SIZE[1], SAME_SIZE, OPTICAL, { opsz: 36 });
  assert.equal(currentInstance(SAME_SIZE, OPTICAL, picked), 1, "Bold, not Custom");
  assert.equal(currentInstance(SAME_SIZE, OPTICAL, { wght: 650 }), -1, "between styles: none");
});

test("when the named styles are optical sizes, the picker matches optical size too", () => {
  assert.equal(currentInstance(NAMED_SIZES, OPTICAL, { opsz: 72 }), 2);
  assert.equal(currentInstance(NAMED_SIZES, OPTICAL, pickNamedStyle(NAMED_SIZES[0], NAMED_SIZES, OPTICAL, {})), 0);
  assert.equal(currentInstance(NAMED_SIZES, OPTICAL, { opsz: 30 }), -1, "between sizes: none");
  // Following the text size, each preview is at its own optical size: no one style is showing.
  assert.equal(currentInstance(NAMED_SIZES, OPTICAL, {}), -1);
  assert.equal(currentInstance(NAMED_SIZES, OPTICAL, { wght: 400 }), -1);
});
