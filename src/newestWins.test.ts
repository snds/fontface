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

test("a request settles once its list is on screen, even when a newer one is on its way", async () => {
  // Launch loads the library; the preview backfill finishes and reloads before it answers.
  const h = harness();
  const launch = h.load();
  const reload = h.load();
  h.requests[0].answer("launch list");
  await launch;
  assert.deepEqual(h.shown, ["launch list"], "the list is on screen when launch goes on");
  h.requests[1].answer("newer list");
  await reload;
  assert.deepEqual(h.shown, ["launch list", "newer list"]);
});

test("a request never waits on requests made after it", async () => {
  // A long scan reloads more often than a list takes to arrive.
  const h = harness();
  const first = h.load();
  const loads = [first];
  for (let i = 0; i < 5; i++) loads.push(h.load());
  h.requests[0].answer("list 0");
  assert.equal(await settled(first), true, "the first caller goes on with its own list");
  for (let i = 1; i < 6; i++) h.requests[i].answer(`list ${i}`);
  await Promise.all(loads);
  assert.deepEqual(h.shown, ["list 0", "list 1", "list 2", "list 3", "list 4", "list 5"]);
});

test("a request whose answer comes after a newer list is shown settles without showing it", async () => {
  const h = harness();
  const first = h.load();
  const second = h.load();
  h.requests[1].answer("new");
  await second;
  assert.equal(await settled(first), false, "first still waits for its own answer");
  h.requests[0].answer("old");
  await first;
  assert.deepEqual(h.shown, ["new"]);
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

test("the newest request's failure reaches its caller and overtaken callers that failed too", async () => {
  const h = harness();
  const first = h.load();
  const second = h.load();
  const outcomes = Promise.all([assert.rejects(first, /no database/), assert.rejects(second, /no database/)]);
  h.requests[0].fail(new Error("no database"));
  h.requests[1].fail(new Error("no database"));
  await outcomes;
  assert.deepEqual(h.shown, []);
});

test("an older request's list is still shown when the newest one fails", async () => {
  const h = harness();
  const first = h.load();
  const second = h.load();
  const failed = assert.rejects(second, /no database/);
  h.requests[1].fail(new Error("no database"));
  await failed;
  h.requests[0].answer("old");
  await first;
  assert.deepEqual(h.shown, ["old"], "better an older list than none");
});

test("a lone request shows its answer", async () => {
  const h = harness();
  const load = h.load();
  h.requests[0].answer("list");
  await load;
  assert.deepEqual(h.shown, ["list"]);
});
