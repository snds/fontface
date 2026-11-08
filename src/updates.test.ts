// Run with `npm run test:ui`. Automatic updates: the words Settings › About shows (updates.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { UpdateStatus } from "./api.ts";
import { canCheck, channelName, updateLine } from "./updates.ts";

const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  version: "0.1.0-main.20261108093000",
  channel: "main",
  enabled: true,
  off: null,
  auto_check: true,
  state: "idle",
  percent: null,
  offered: null,
  error: null,
  link: null,
  link_why: null,
  asked: false,
  ...over,
});

test("a build without the key says why updates are off, and can't check", () => {
  const off = status({ enabled: false, off: "Updates are off in this build: it was made without the update key." });
  assert.equal(updateLine(off), "Updates are off in this build: it was made without the update key.");
  assert.equal(canCheck(off), false);
});

test("each state has its line", () => {
  assert.equal(updateLine(status()), "Fontface checks for updates when it opens and every six hours.");
  assert.equal(updateLine(status({ auto_check: false })), "Automatic checks are off. Check whenever you like.");
  assert.equal(updateLine(status({ state: "checking" })), "Checking for updates…");
  assert.equal(updateLine(status({ state: "up_to_date" })), "Fontface is up to date.");
  assert.equal(updateLine(status({ state: "downloading", offered: "0.1.0-main.2", percent: 40 })), "Downloading version 0.1.0-main.2… 40%");
  assert.equal(
    updateLine(status({ state: "ready", offered: "0.1.0-main.2" })),
    "Version 0.1.0-main.2 is ready. Restart to update, or it installs when you quit.",
  );
  assert.equal(
    updateLine(status({ state: "available", offered: "0.1.0-main.2", link_why: "Fontface can't update itself when installed from a Linux package." })),
    "Version 0.1.0-main.2 is out. Fontface can't update itself when installed from a Linux package.",
  );
  assert.equal(updateLine(status({ state: "failed", error: "no connection" })), "no connection");
  assert.equal(updateLine(status({ state: "failed" })), "The update didn't work.");
});

test("checking can't be pressed while a check or download runs", () => {
  assert.equal(canCheck(status()), true);
  assert.equal(canCheck(status({ state: "checking" })), false);
  assert.equal(canCheck(status({ state: "downloading" })), false);
  assert.equal(canCheck(status({ state: "ready" })), true);
});

test("the channel is named in plain words", () => {
  assert.equal(channelName(status()), "main channel (every merged change)");
  assert.equal(channelName(status({ channel: "stable" })), "stable channel");
  assert.equal(channelName(status({ channel: "local" })), "local channel (this Mac's own builds)");
});
