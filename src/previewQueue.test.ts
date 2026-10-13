// Run with `npm run test:ui`. The queue behind on-demand preview profiles (previewQueue.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestQueue } from "./previewQueue.ts";

/** A queue whose calls, frames and timers the test runs by hand. With `timeoutMs`, a call
 *  times out when the test runs `timeUp`. */
function harness(max = 64, timeoutMs?: number) {
  const calls: { items: string[]; finish: () => void; fail: () => void }[] = [];
  const frames: (() => void)[] = [];
  const timers: { ms: number; run: () => void; cancelled: boolean }[] = [];
  const timedOut: string[][] = [];
  const queue = new RequestQueue<string>(
    (items) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ items, finish: resolve, fail: reject });
      }),
    (run) => frames.push(run),
    max,
    timeoutMs === undefined
      ? undefined
      : {
          ms: timeoutMs,
          timedOut: (items) => timedOut.push(items),
          after: (ms, run) => {
            const timer = { ms, run, cancelled: false };
            timers.push(timer);
            return () => {
              timer.cancelled = true;
            };
          },
        },
  );
  const frame = () => frames.splice(0).forEach((run) => run());
  const settle = async (i: number, how: "finish" | "fail" = "finish") => {
    calls[i][how]();
    await new Promise((r) => setTimeout(r, 0));
  };
  /** Runs the timers still set. */
  const timeUp = () => timers.splice(0).forEach((t) => !t.cancelled && t.run());
  const live = () => timers.filter((t) => !t.cancelled).length;
  return { queue, calls, frames, frame, settle, timeUp, live, timedOut };
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

test("a row whose request was sent can't drop a newer row's request for the same key", async () => {
  const { queue, calls, frame, settle } = harness();
  // A family row asks for its face, and the call goes.
  const releaseOld = queue.want("K", "K");
  frame();
  assert.deepEqual(calls[0].items, ["K"]);
  await settle(0); // say "retry": the family row stays mounted, drawing the name
  // Later, the detail panel wants the same face, while another call holds the queue.
  queue.want("other", "other");
  frame();
  assert.equal(calls.length, 2);
  const releaseNew = queue.want("K", "K");
  // The family row unmounts: its want ended when its call went, so it drops nothing.
  releaseOld();
  assert.ok(queue.has("K"), "the newer want is still waiting");
  await settle(1);
  frame();
  assert.deepEqual(calls[2].items, ["K"], "and is asked for");
  // Releasing after its own call went drops nothing either.
  releaseNew();
  queue.want("L", "L");
  await settle(2);
  frame();
  assert.deepEqual(calls[3].items, ["L"]);
});

test("each want is released on its own", () => {
  const { queue } = harness();
  const a = queue.want("k", "k");
  const b = queue.want("k", "k");
  b();
  b();
  assert.ok(queue.has("k"), "a's want stays");
  a();
  assert.ok(!queue.has("k"));
});

test("a call that doesn't settle in time stops holding the queue", async () => {
  const { queue, calls, frame, settle, timeUp, timedOut } = harness(64, 3000);
  queue.want("hung", "hung");
  frame();
  queue.want("next", "next");
  frame();
  assert.equal(calls.length, 1, "waits while the call is in time");
  timeUp();
  assert.deepEqual(timedOut, [["hung"]], "its rows are told, so they draw their names");
  frame();
  assert.deepEqual(calls[1].items, ["next"], "the next call goes");
  // The late answer doesn't free the queue while the newer call is in flight.
  queue.want("later", "later");
  await settle(0);
  frame();
  assert.equal(calls.length, 2);
  await settle(1);
  frame();
  assert.deepEqual(calls[2].items, ["later"]);
  assert.equal(timedOut.length, 1, "a call that answered in time never times out");
});

test("a call that settles in time cancels its timeout", async () => {
  const { queue, calls, frame, settle, timeUp, live, timedOut } = harness(64, 3000);
  queue.want("a", "a");
  frame();
  assert.equal(live(), 1);
  await settle(0, "fail");
  assert.equal(live(), 0);
  timeUp();
  assert.deepEqual(timedOut, []);
  queue.want("b", "b");
  frame();
  assert.equal(calls.length, 2, "the queue is free once, not twice");
  queue.want("c", "c");
  frame();
  assert.equal(calls.length, 2);
});

test("one stuck call after another never stops later rows being asked for", async () => {
  const { queue, calls, frame, timeUp, timedOut } = harness(64, 3000);
  for (let i = 0; i < 3; i++) {
    queue.want(`f${i}`, `f${i}`);
    frame();
    assert.deepEqual(calls[i].items, [`f${i}`]);
    timeUp();
  }
  assert.deepEqual(timedOut, [["f0"], ["f1"], ["f2"]]);
});
