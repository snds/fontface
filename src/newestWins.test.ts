// Run with `npm run test:ui`. Loading the font list with "newest wins" (newestWins.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { newestWins } from "./newestWins.ts";

/** A loader whose requests the test answers by hand, in any order. */
function harness() {
  const requests: { answer: (list: string) => void; fail: (e: Error) => void }[] = [];
  const shown: string[] = [];
  let epoch = 0;
  const load = newestWins(
    () => new Promise<string>((answer, fail) => requests.push({ answer, fail })),
    (list) => shown.push(list),
    () => epoch,
  );
  return { requests, shown, load, change: () => epoch++ };
}

/** True if `p` has settled once pending callbacks have run. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((r) => setTimeout(r, 0));
  return done;
}

test("a request overtaken by a newer one settles only once the newest list is shown", async () => {
  // Launch loads the library; the preview backfill finishes and reloads before it answers.
  const h = harness();
  const launch = h.load();
  const reload = h.load();
  h.requests[0].answer("launch list");
  assert.equal(await settled(launch), false, "launch must not think the library is loaded yet");
  assert.deepEqual(h.shown, []);
  h.requests[1].answer("newer list");
  await launch;
  assert.deepEqual(h.shown, ["newer list"], "the list is on screen when launch goes on");
  await reload;
});

test("an older answer that comes last is never shown", async () => {
  const h = harness();
  const first = h.load();
  const second = h.load();
  h.requests[1].answer("new");
  await second;
  h.requests[0].answer("old");
  await first;
  assert.deepEqual(h.shown, ["new"]);
});

test("a change made while the list was on its way asks again", async () => {
  const h = harness();
  const load = h.load();
  h.change(); // a font switched on meanwhile
  h.requests[0].answer("before the switch");
  assert.equal(await settled(load), false);
  assert.equal(h.requests.length, 2, "asked again");
  h.requests[1].answer("after the switch");
  await load;
  assert.deepEqual(h.shown, ["after the switch"]);
});

test("an overtaken request that fails settles with the newest one", async () => {
  const h = harness();
  const first = h.load();
  const second = h.load();
  h.requests[0].fail(new Error("timed out"));
  assert.equal(await settled(first), false);
  h.requests[1].answer("list");
  await first;
  await second;
  assert.deepEqual(h.shown, ["list"]);
});

test("the newest request's failure reaches every caller waiting on it", async () => {
  const h = harness();
  const first = h.load();
  const second = h.load();
  const outcomes = Promise.all([assert.rejects(first, /no database/), assert.rejects(second, /no database/)]);
  h.requests[1].fail(new Error("no database"));
  h.requests[0].answer("old");
  await outcomes;
  assert.deepEqual(h.shown, []);
});

test("a lone request shows its answer", async () => {
  const h = harness();
  const load = h.load();
  h.requests[0].answer("list");
  await load;
  assert.deepEqual(h.shown, ["list"]);
});
