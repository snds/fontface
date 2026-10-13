// Run with `npm run test:ui`. The queue behind on-demand preview profiles (previewQueue.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestQueue } from "./previewQueue.ts";

/** A queue whose calls and frames the test runs by hand. */
function harness(max = 64) {
  const calls: { items: string[]; finish: () => void; fail: () => void }[] = [];
  const frames: (() => void)[] = [];
  const queue = new RequestQueue<string>(
    (items) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ items, finish: resolve, fail: reject });
      }),
    (run) => frames.push(run),
    max,
  );
  const frame = () => frames.splice(0).forEach((run) => run());
  const settle = async (i: number, how: "finish" | "fail" = "finish") => {
    calls[i][how]();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { queue, calls, frames, frame, settle };
}

test("rows that scroll away before their turn are never asked for", () => {
  const { queue, calls, frame } = harness();
  const leave = Array.from({ length: 100 }, (_, i) => queue.want(`f${i}`, `f${i}`));
  for (const release of leave.slice(0, 90)) release();
  frame();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].items, ["f99", "f98", "f97", "f96", "f95", "f94", "f93", "f92", "f91", "f90"], "newest first");
});

test("one call at a time: what comes up meanwhile waits for the next", async () => {
  const { queue, calls, frames, frame, settle } = harness();
  queue.want("a", "a");
  frame();
  queue.want("b", "b");
  queue.want("c", "c");
  assert.equal(frames.length, 0, "nothing scheduled while a call is in flight");
  frame();
  assert.equal(calls.length, 1);
  await settle(0);
  frame();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].items, ["c", "b"]);
  // A failed call frees the queue too.
  queue.want("d", "d");
  await settle(1, "fail");
  frame();
  assert.deepEqual(calls[2].items, ["d"]);
});

test("a call carries at most the limit; the rest follow", async () => {
  const { queue, calls, frame, settle } = harness(64);
  for (let i = 0; i < 70; i++) queue.want(`f${i}`, `f${i}`);
  frame();
  assert.equal(calls[0].items.length, 64);
  assert.equal(queue.size, 6);
  await settle(0);
  frame();
  assert.equal(calls[1].items.length, 6);
  assert.equal(queue.size, 0);
});

test("a key two rows want stays until both have gone", () => {
  const { queue, calls, frame } = harness();
  const first = queue.want("k", "k");
  const second = queue.want("k", "k");
  first();
  first(); // releasing twice counts once
  assert.ok(queue.has("k"));
  second();
  assert.ok(!queue.has("k"));
  frame();
  assert.equal(calls.length, 0, "nothing left to ask for");
});
