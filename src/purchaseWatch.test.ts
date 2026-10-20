// Run with `npm run test:ui`. Watching for font purchases: its words and decisions (purchaseWatch.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PurchaseFind } from "./api.ts";
import { canCheckNow, emptyFindsText, foldersLabel, newPurchaseCount, watchExplainer, watchNotice } from "./purchaseWatch.ts";

const find = (status: string, missing = false) => ({ status, missing }) as PurchaseFind;

test("no 'n new' badge while watching is off", () => {
  const finds = [find("new"), find("new", true), find("imported")];
  assert.equal(newPurchaseCount({ watching: true, finds }), 1, "new and still there");
  assert.equal(newPurchaseCount({ watching: false, finds }), 0);
});

test("turning on says macOS asks first, on the Mac only", () => {
  assert.match(watchExplainer(true), /macOS asks once whether Fontface may see your Downloads folder/);
  assert.doesNotMatch(watchExplainer(false), /macOS/);
});

test("no notice when every folder could be read", () => {
  assert.equal(watchNotice({ watching: true, denied: [] }, true), null);
});

test("refused: watching stays off, and the notice says where to allow it", () => {
  const note = watchNotice({ watching: false, denied: ["/Users/me/Downloads"] }, true)!;
  assert.match(note, /^macOS didn't let Fontface see Downloads, so watching is still off\./);
  assert.match(note, /System Settings › Privacy & Security › Files and Folders, turn on Downloads Folder under Fontface/);
  assert.match(note, /then turn watching on again\.$/);
});

test("partly refused: the other folders are watched", () => {
  const note = watchNotice({ watching: true, denied: ["/Users/me/Downloads", "/Volumes/Work/Fonts"] }, true)!;
  assert.match(note, /see Downloads and Fonts, so Fontface watches your other folders only/);
  assert.match(note, /find Fontface and allow those folders, then turn watching off and on again/);
});

test("other systems point at the folder's permissions", () => {
  const note = watchNotice({ watching: false, denied: ["C:\\Users\\me\\Downloads"] }, false)!;
  assert.equal(note, "Fontface isn't allowed to read Downloads, so watching is still off. Check the folder's permissions, then turn watching on again.");
});

test("Check now waits for watching, then for a folder", () => {
  assert.equal(canCheckNow(true, 1, true), false, "still checking");
  assert.equal(canCheckNow(false, 1, false), false, "watching is off");
  assert.equal(canCheckNow(true, 0, false), false, "no folder to look in");
  assert.equal(canCheckNow(true, 1, false), true);
});

test("the list and folders say whether watching is on", () => {
  assert.match(emptyFindsText(false), /^Watching is off\./);
  assert.match(emptyFindsText(true), /^Nothing new\./);
  assert.equal(foldersLabel(true), "Watching:");
  assert.equal(foldersLabel(false), "Folders to watch:");
});
