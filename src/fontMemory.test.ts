// Run with `npm run test:ui`. Which loaded fonts the page lets go (fontMemory.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FaceMemory } from "./fontMemory.ts";

function memory(limit: number) {
  const released: string[] = [];
  const m = new FaceMemory<string>(limit, (name) => released.push(name));
  return { m, released };
}

test("faces a row shows are never let go", () => {
  const { m, released } = memory(1);
  for (const name of ["a", "b", "c"]) {
    m.use(name);
    m.loaded(name, name);
  }
  assert.equal(m.size, 3);
  assert.deepEqual(released, []);
});

test("past the limit, the face unused longest goes first", () => {
  const { m, released } = memory(2);
  for (const name of ["a", "b", "c", "d"]) {
    m.use(name);
    m.loaded(name, name);
  }
  m.unuse("b");
  m.unuse("a");
  m.unuse("c");
  assert.deepEqual(released, ["b"], "b went unused first");
  assert.equal(m.unused, 2);
  m.unuse("d");
  assert.deepEqual(released, ["b", "a"]);
  assert.equal(m.size, 2);
});

test("a face shown again stops being unused; when it's released again it's the newest", () => {
  const { m, released } = memory(2);
  for (const name of ["a", "b", "c"]) {
    m.use(name);
    m.loaded(name, name);
    m.unuse(name);
  }
  assert.deepEqual(released, ["a"]);
  m.use("b"); // back on screen
  m.unuse("b");
  m.use("d");
  m.loaded("d", "d");
  m.unuse("d");
  assert.deepEqual(released, ["a", "c"], "c had been unused longer than b");
});

test("two rows showing one face: it's unused only when both are gone", () => {
  const { m, released } = memory(0);
  m.use("a");
  m.use("a");
  m.loaded("a", "a");
  m.unuse("a");
  assert.deepEqual(released, []);
  assert.equal(m.usersOf("a"), 1);
  m.unuse("a");
  assert.deepEqual(released, ["a"]);
});

test("a face that finishes loading after its row scrolled away is unused at once", () => {
  const { m, released } = memory(1);
  m.use("a");
  m.unuse("a"); // scrolled away while loading
  m.loaded("a", "a");
  assert.equal(m.unused, 1);
  m.use("b");
  m.unuse("b");
  m.loaded("b", "b");
  assert.deepEqual(released, ["a"]);
});

test("a fast scroll through thousands of faces keeps at most the limit unused", () => {
  const { m, released } = memory(500);
  const onScreen: string[] = [];
  for (let i = 0; i < 12000; i++) {
    const name = `f${i}`;
    m.use(name);
    m.loaded(name, name);
    onScreen.push(name);
    if (onScreen.length > 40) m.unuse(onScreen.shift()!);
  }
  assert.equal(m.unused, 500);
  assert.equal(m.size, 540, "the 40 on screen plus the 500 kept");
  assert.equal(released.length, 12000 - 540);
  assert.equal(released[0], "f0", "the oldest first");
});
