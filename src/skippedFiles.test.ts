// Run with `npm run test:ui`. How a scan's skipped files are worded (skippedFiles.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SkippedFiles } from "./api.ts";
import { countOf, SKIPPED_WORDS, skippedEntries, skippedSummary, skippedTotal, sumSkipped } from "./skippedFiles.ts";

const none: SkippedFiles = {
  type1: 0,
  type1Metrics: 0,
  woff: 0,
  woff2: 0,
  dfont: 0,
  eot: 0,
  windowsBitmap: 0,
  suitcase: 0,
  noExtension: 0,
  unreadable: 0,
};
const skipped = (more: Partial<SkippedFiles>): SkippedFiles => ({ ...none, ...more });
const n = (v: number) => v.toLocaleString();

test("the line names up to three kinds, most files first", () => {
  assert.equal(
    skippedSummary(skipped({ suitcase: 12, type1: 1104, woff: 37 })),
    `Skipped ${n(1104)} Type 1 fonts, 37 WOFF files and 12 old Mac suitcases that Fontface can't use yet`,
  );
  assert.equal(skippedSummary(skipped({ woff2: 2, eot: 1 })), "Skipped 2 WOFF2 files and 1 EOT file that Fontface can't use yet");
  assert.equal(skippedSummary(skipped({ dfont: 1 })), "Skipped 1 .dfont file that Fontface can't use yet");
});

test("with more kinds, the line names two and counts the rest", () => {
  assert.equal(
    skippedSummary(skipped({ type1: 900, woff: 40, woff2: 30, eot: 2, windowsBitmap: 1 })),
    "Skipped 900 Type 1 fonts, 40 WOFF files and 33 other files that Fontface can't use yet",
  );
  assert.equal(
    skippedSummary(skipped({ type1: 5, woff: 4, woff2: 3, eot: 1 })),
    "Skipped 5 Type 1 fonts, 4 WOFF files and 4 other files that Fontface can't use yet",
  );
});

test("the line names metrics files only when there's nothing else", () => {
  assert.equal(skippedSummary(skipped({ type1: 10, type1Metrics: 30 })), "Skipped 10 Type 1 fonts that Fontface can't use yet");
  assert.equal(
    skippedSummary(skipped({ type1: 1104, type1Metrics: 2200, woff: 37, suitcase: 12, woff2: 4, noExtension: 3, eot: 2 })),
    `Skipped ${n(1104)} Type 1 fonts, 37 WOFF files and 21 other files that Fontface can't use yet`,
    "metrics files never swell the other files",
  );
  assert.equal(skippedSummary(skipped({ type1Metrics: 1 })), "Skipped 1 Type 1 metrics file that Fontface can't use yet");
});

test("files that couldn't be read get their own sentence, only when asked", () => {
  const some = skipped({ type1: 3, unreadable: 2 });
  assert.equal(skippedSummary(some), "Skipped 3 Type 1 fonts that Fontface can't use yet", "a scan's warning already counts them");
  assert.equal(skippedSummary(some, { unreadable: true }), "Skipped 3 Type 1 fonts that Fontface can't use yet. 2 files couldn't be read.");
  assert.equal(skippedSummary(skipped({ unreadable: 1 }), { unreadable: true }), "1 file couldn't be read");
  assert.equal(skippedSummary(skipped({ unreadable: 1 })), null);
});

test("nothing skipped, or never counted, says nothing", () => {
  assert.equal(skippedSummary(none), null);
  assert.equal(skippedSummary(undefined), null);
  assert.deepEqual(skippedEntries(null), []);
  assert.equal(skippedTotal(undefined), 0);
});

test("the list has every kind with files, with a title and a reason", () => {
  const entries = skippedEntries(skipped({ unreadable: 4, type1Metrics: 50, suitcase: 1, noExtension: 2, type1: 2 }));
  assert.deepEqual(
    entries.map((e) => [e.kind, e.count, e.title]),
    [
      ["type1", 2, "Type 1 fonts"],
      ["noExtension", 2, "Fonts with no file extension"],
      ["suitcase", 1, "Old Mac suitcase"],
      ["type1Metrics", 50, "Type 1 metrics files"],
      ["unreadable", 4, "Files that couldn't be read"],
    ],
    "fonts by count (ties in a fixed order), then metrics files, then unreadable ones",
  );
  for (const e of entries) assert.equal(e.why, SKIPPED_WORDS[e.kind].why);
  assert.equal(skippedTotal(skipped({ type1: 2, unreadable: 3 })), 5);
  assert.equal(skippedTotal(skipped({ type1: 2, unreadable: 3 }), { unreadable: false }), 2);
});

test("every kind has words and a reason that ends in a full stop", () => {
  for (const [kind, words] of Object.entries(SKIPPED_WORDS)) {
    assert.ok(words.one && words.many, kind);
    assert.match(words.why, /\.$/, `${kind}: two sentences, each with a period`);
  }
  assert.equal(countOf("windowsBitmap", 1), "1 Windows bitmap font");
  assert.equal(countOf("type1", 1104), `${n(1104)} Type 1 fonts`);
});

test("several folders add up, and uncounted folders don't count", () => {
  assert.equal(sumSkipped([undefined, null]), null);
  assert.deepEqual(sumSkipped([skipped({ type1: 1, woff: 2 }), undefined, skipped({ type1: 3, unreadable: 1 })]), skipped({ type1: 4, woff: 2, unreadable: 1 }));
});
