// Run with `npm run test:ui`. The sidebar's sections, menus and counts (sidebar.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { addMenu, countClass, countShown, dividerLabel, dividerMenu, ROW_ACTIONS_CLASS, SECTIONS, sourceRevealed, stylesSaid, type MenuLine } from "./sidebar.ts";

const labels = (lines: MenuLine[]) => lines.map((l) => (l === "-" ? "-" : l.label));

test("Library rows and the tag groups always show their counts; sources and tags only on hover or when viewed", () => {
  assert.equal(countShown("library", false), "always");
  assert.equal(countShown("group", false), "always");
  assert.equal(countShown("source", false), "hover");
  assert.equal(countShown("tag", false), "hover");
  assert.equal(countShown("source", true), "always", "the place being viewed shows its count");
  assert.equal(countShown("tag", true), "always");
});

test("a hidden count keeps its room, and a row with its own buttons swaps the count for them", () => {
  assert.equal(countClass("always", false), "");
  assert.equal(countClass("always", true), "group-has-[:focus-visible]/item:hidden group-hover/item:hidden");
  // Keyboard focus only: a click focuses the row's button on Windows and Linux, and the row just
  // picked must keep showing its count there.
  for (const shown of ["always", "hover"] as const)
    for (const swaps of [false, true]) assert.doesNotMatch(countClass(shown, swaps), /focus-within/);
  assert.doesNotMatch(ROW_ACTIONS_CLASS, /focus-within/);
  assert.match(ROW_ACTIONS_CLASS, /group-has-\[:focus-visible\]\/item:flex/);
  // Hidden but still taking its room, so names never move when it shows.
  assert.match(countClass("hover", false), /^invisible /);
  assert.match(countClass("hover", false), /group-hover\/item:visible/);
  assert.match(countClass("hover", false), /group-has-\[:focus-visible\]\/item:visible/);
  // With buttons of its own, hover and focus show the buttons, not the count.
  assert.match(countClass("hover", true), /^invisible /);
  assert.doesNotMatch(countClass("hover", true), /:visible/);
});

test("screen readers hear counts in words", () => {
  assert.equal(stylesSaid(1), "1 style");
  assert.equal(stylesSaid(0), "0 styles");
  assert.equal(stylesSaid(12345), `${(12345).toLocaleString()} styles`);
});

test("the + menu makes a tag, adds a folder, and imports fonts you bought and tags", () => {
  assert.deepEqual(labels(addMenu({ purchases: true, tags: true })), ["New Tag…", "Add Folder…", "-", "Import Purchased Fonts…", "Import Tags…"]);
  // Only what the sidebar shows (Settings › Sidebar).
  assert.deepEqual(labels(addMenu({ purchases: false, tags: true })), ["New Tag…", "Add Folder…", "-", "Import Tags…"]);
  assert.deepEqual(labels(addMenu({ purchases: true, tags: false })), ["Add Folder…", "-", "Import Purchased Fonts…"]);
  assert.deepEqual(labels(addMenu({ purchases: false, tags: false })), ["Add Folder…"]);
  for (const line of addMenu({ purchases: true, tags: true })) {
    if (line === "-") continue;
    // Menu items show their words, so they have no tooltip.
    assert.ok(!("tip" in line), `${line.label} has no tooltip`);
    assert.ok(line.icon, `${line.label} has an icon`);
  }
});

test("each divider's menu has its section's commands; only Sources collapses", () => {
  assert.deepEqual(labels(dividerMenu("sources", { open: true })), ["Add Folder…", "-", "Collapse Section"]);
  assert.deepEqual(labels(dividerMenu("sources", { open: false })), ["Add Folder…", "-", "Expand Section"]);
  assert.deepEqual(labels(dividerMenu("tags", { open: true, anyTags: true, anyNested: true })), [
    "New Tag…",
    "Import Tags…",
    "Export Tags…",
    "-",
    "Open All Tags",
    "Close All Tags",
  ]);
  // Open and Close All Tags only when some tag has tags inside it.
  assert.deepEqual(labels(dividerMenu("tags", { open: true, anyTags: true, anyNested: false })), ["New Tag…", "Import Tags…", "Export Tags…"]);
  // Export is greyed out with no tags.
  const none = dividerMenu("tags", { open: true, anyTags: false, anyNested: false });
  const exportTags = none.find((l) => l !== "-" && l.id === "exportTags");
  assert.ok(exportTags && exportTags !== "-" && exportTags.disabled);
});

test("the dividers' icon-only buttons are named in a word or two", () => {
  // The name is the button's aria-label and its tooltip: a label, not a sentence.
  assert.equal(dividerLabel("sources", { open: true, collapsible: true }), `Collapse ${SECTIONS.sources.label}`);
  assert.equal(dividerLabel("sources", { open: false, collapsible: true }), `Expand ${SECTIONS.sources.label}`);
  assert.equal(dividerLabel("tags", { open: true, collapsible: false }), SECTIONS.tags.label, "Tags doesn't collapse: a click opens its menu");
  for (const section of ["sources", "tags"] as const) {
    for (const open of [true, false]) {
      const label = dividerLabel(section, { open, collapsible: section === "sources" });
      assert.ok(label.split(" ").length <= 3 && !label.endsWith("."), label);
    }
  }
  assert.notEqual(SECTIONS.sources.openId, SECTIONS.tags.openId);
  // Plain outlined icons from the app's icon font.
  assert.match(SECTIONS.sources.icon, /^[a-z_0-9]+$/);
  assert.match(SECTIONS.tags.icon, /^[a-z_0-9]+$/);
});

test("the view moving to a source opens a collapsed Sources, so it keeps its row", () => {
  assert.equal(sourceRevealed(null, "folder:12"), true, "Add Folder… from All Fonts");
  assert.equal(sourceRevealed("fontbook", "purchases"), true, "Import Purchased Fonts… from another source");
  assert.equal(sourceRevealed("purchases", "purchases"), false, "collapsing Sources with a source in view keeps it collapsed");
  assert.equal(sourceRevealed("folder:12", null), false, "leaving for All Fonts or a tag");
  assert.equal(sourceRevealed(null, null), false);
});
