// Run with `npm run test:ui`. The sidebar's places, and saved views from before (places.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Folder, ServiceInfo, SidebarSections } from "./api.ts";
import type { LibraryView } from "./library.ts";
import {
  folderHolding,
  hiddenBySidebar,
  migrateView,
  parseView,
  placeLabel,
  restoreView,
  smartRows,
  sourceFolders,
  sourceOf,
  sourceRows,
  sourceView,
  stillThere,
  type PlaceContext,
  type SavedView,
} from "./places.ts";

const folder = (id: number, path: string, kind: Folder["kind"], label = path.split("/").pop()!): Folder => ({ id, path, kind, label, fontCount: 0, missing: false });

const FOLDERS: Folder[] = [
  folder(1, "/Users/me/Library/Fonts", "system", "My Fonts"),
  folder(2, "/Library/Fonts", "system", "Computer Fonts"),
  folder(3, "/System/Library/Fonts", "system", "macOS System Fonts"),
  folder(4, "/Users/me/Library/Application Support/fontface/google", "service", "google"),
  folder(5, "/Users/me/Library/Application Support/fontface/purchases", "service", "purchases"),
  folder(10, "/Users/me/Type/zebra", "user"),
  folder(11, "/Users/me/Type/Alpha", "user"),
  folder(12, "/Volumes/Drive/fonts 10", "user"),
  folder(13, "/Volumes/Drive/fonts 9", "user"),
];
const SERVICES: ServiceInfo[] = [
  { id: "google", folderId: 4 },
  { id: "adobe", folderId: null },
  { id: "purchases", folderId: 5 },
];
const ALL_ON: SidebarSections = { yours: true, recent: true, active: true, untagged: true, fontBook: true, google: true, adobe: true, purchases: true, tags: true, builtinTags: true };

const ctx = (sidebar: Partial<SidebarSections> = {}): PlaceContext => ({ folders: FOLDERS, services: SERVICES, sidebar: { ...ALL_ON, ...sidebar } });

test("SOURCES lists Font Book, the services, then your folders A to Z, one row each", () => {
  assert.deepEqual(sourceRows(FOLDERS, ALL_ON), ["fontbook", "google", "adobe", "purchases", "folder:11", "folder:13", "folder:12", "folder:10"]);
  // Hidden sources go; your folders always stay.
  assert.deepEqual(sourceRows(FOLDERS, { ...ALL_ON, fontBook: false, adobe: false }), ["google", "purchases", "folder:11", "folder:13", "folder:12", "folder:10"]);
});

test("LIBRARY lists All Fonts always, and each smart entry unless it's hidden", () => {
  assert.deepEqual(
    smartRows(ALL_ON).map((e) => e.label),
    ["All Fonts", "Your Fonts", "Recently Added", "Active", "Not Tagged"],
  );
  assert.deepEqual(
    smartRows({ ...ALL_ON, yours: false, recent: false, active: false, untagged: false }).map((e) => e.kind),
    ["all"],
  );
});

test("every view knows the source row it belongs to", () => {
  const of = (v: LibraryView) => sourceOf(v, FOLDERS, SERVICES);
  assert.equal(of({ kind: "installed" }), "fontbook");
  assert.equal(of({ kind: "folder", id: 2 }), "fontbook", "an OS font folder is part of Font Book");
  assert.equal(of({ kind: "service", id: "google" }), "google");
  assert.equal(of({ kind: "folder", id: 5 }), "purchases");
  assert.equal(of({ kind: "folder", id: 10 }), "folder:10");
  assert.equal(of({ kind: "folder", id: 99 }), "folder:99", "a folder that's gone");
  for (const kind of ["all", "yours", "recent", "active", "untagged"] as const) assert.equal(of({ kind }), null);
  assert.equal(of({ kind: "tag", id: 3 }), null);
});

test("a source's row opens the whole source, which covers its folders", () => {
  assert.deepEqual(sourceView("fontbook"), { kind: "installed" });
  assert.deepEqual(sourceView("purchases"), { kind: "service", id: "purchases" });
  assert.deepEqual(sourceView("folder:12"), { kind: "folder", id: 12 });
  assert.deepEqual(sourceFolders("fontbook", FOLDERS, SERVICES).map((f) => f.id), [1, 2, 3]);
  assert.deepEqual(sourceFolders("google", FOLDERS, SERVICES).map((f) => f.id), [4]);
  assert.deepEqual(sourceFolders("adobe", FOLDERS, SERVICES), []);
  assert.deepEqual(sourceFolders("google", FOLDERS, [{ id: "google", folderId: null }]), [], "nothing downloaded yet");
  assert.deepEqual(sourceFolders("folder:13", FOLDERS, SERVICES).map((f) => f.id), [13]);
});

test("the folder holding a path is the deepest one, by whole folder names", () => {
  assert.equal(folderHolding("/Volumes/Drive/fonts 10/x.otf", FOLDERS)?.id, 12);
  assert.equal(folderHolding("/Volumes/Drive/fonts 100/x.otf", FOLDERS), undefined, "not a folder just because its name starts the same");
  assert.equal(folderHolding("/Library/Fonts", FOLDERS)?.id, 2);
});

test("saved views from before still open, in today's terms", () => {
  const migrate = (v: SavedView) => migrateView(v, FOLDERS, SERVICES);
  // A macOS font folder under Font Book: Font Book.
  assert.deepEqual(migrate({ kind: "folder", id: 3 }), { kind: "installed" });
  // A service folder: that service's row.
  assert.deepEqual(migrate({ kind: "folder", id: 4 }), { kind: "service", id: "google" });
  // A folder inside a source (the toolbar's old folder picker): the whole source.
  assert.deepEqual(migrate({ kind: "location", path: "/System/Library/Fonts" }), { kind: "installed" });
  assert.deepEqual(migrate({ kind: "location", path: "/Library/Fonts/Supplemental" }), { kind: "installed" });
  assert.deepEqual(migrate({ kind: "location", path: "/Users/me/Library/Application Support/fontface/google/Inter" }), { kind: "service", id: "google" });
  assert.deepEqual(migrate({ kind: "location", path: "/Users/me/Type/Alpha/Sans" }), { kind: "folder", id: 11 });
  assert.deepEqual(migrate({ kind: "location", path: "/Elsewhere/x" }), { kind: "all" }, "no source holds it any more");
  // Unchanged: your folders, Font Book, services (Google Fonts now lists your Google fonts), tags.
  for (const v of [
    { kind: "folder", id: 10 },
    { kind: "folder", id: 99 },
    { kind: "installed" },
    { kind: "service", id: "google" },
    { kind: "service", id: "adobe" },
    { kind: "tag", id: 7 },
    { kind: "all" },
  ] as LibraryView[]) {
    assert.deepEqual(migrate(v), v);
  }
});

test("saved views are read back only in a shape that makes sense", () => {
  for (const kind of ["all", "yours", "recent", "active", "untagged", "installed"]) assert.deepEqual(parseView({ kind }), { kind });
  assert.deepEqual(parseView({ kind: "folder", id: 4 }), { kind: "folder", id: 4 });
  assert.deepEqual(parseView({ kind: "service", id: "purchases" }), { kind: "service", id: "purchases" });
  assert.deepEqual(parseView({ kind: "location", path: "/a/b" }), { kind: "location", path: "/a/b" });
  for (const bad of [null, "all", { kind: "folder", id: "4" }, { kind: "folder", id: 1.5 }, { kind: "service", id: "dropbox" }, { kind: "location", path: "" }, { kind: "nope" }]) {
    assert.equal(parseView(bad), null, JSON.stringify(bad));
  }
});

test("a view whose place Settings › Sidebar hides is hidden", () => {
  const hidden = (v: LibraryView, sidebar: Partial<SidebarSections>) => hiddenBySidebar(v, { ...ALL_ON, ...sidebar }, FOLDERS, SERVICES);
  for (const kind of ["yours", "recent", "active", "untagged"] as const) {
    assert.ok(hidden({ kind }, { [kind]: false }));
    assert.ok(!hidden({ kind }, {}));
  }
  assert.ok(hidden({ kind: "installed" }, { fontBook: false }));
  assert.ok(hidden({ kind: "folder", id: 2 }, { fontBook: false }), "a macOS folder goes with Font Book");
  assert.ok(hidden({ kind: "service", id: "google" }, { google: false }));
  assert.ok(hidden({ kind: "tag", id: 1 }, { tags: false }));
  assert.ok(!hidden({ kind: "folder", id: 10 }, { fontBook: false, google: false, tags: false }), "your folders always show");
  assert.ok(!hidden({ kind: "all" }, { yours: false, recent: false, active: false, untagged: false }));
});

test("a saved view opens if it's still there, else All Fonts", () => {
  assert.deepEqual(restoreView({ kind: "folder", id: 2 }, ctx()), { kind: "installed" }, "a macOS folder: Font Book");
  assert.deepEqual(restoreView({ kind: "folder", id: 99 }, ctx()), { kind: "all" }, "a folder that was removed");
  assert.deepEqual(restoreView({ kind: "location", path: "/Users/me/Type/Alpha/Sans" }, ctx()), { kind: "folder", id: 11 }, "a folder inside a source: the source");
  assert.deepEqual(restoreView({ kind: "location", path: "/Library/Fonts" }, ctx({ fontBook: false })), { kind: "all" }, "its source is hidden");
  assert.deepEqual(restoreView({ kind: "recent" }, ctx()), { kind: "recent" });
  assert.deepEqual(restoreView({ kind: "recent" }, ctx({ recent: false })), { kind: "all" }, "hidden in the sidebar");
  assert.deepEqual(restoreView({ kind: "folder", id: 2 }, ctx({ fontBook: false })), { kind: "all" });
  assert.ok(stillThere({ kind: "service", id: "google" }, ctx()));
});

test("Back says where it goes back to", () => {
  const label = (v: LibraryView) => placeLabel(v, { folders: FOLDERS, fontBook: "Font Book", tagName: (id) => (id === 1 ? "Serif" : undefined) });
  assert.equal(label({ kind: "untagged" }), "Not Tagged");
  assert.equal(label({ kind: "recent" }), "Recently Added");
  assert.equal(label({ kind: "installed" }), "Font Book");
  assert.equal(label({ kind: "service", id: "purchases" }), "Purchases");
  assert.equal(label({ kind: "folder", id: 11 }), "Alpha");
  assert.equal(label({ kind: "tag", id: 1 }), "Serif");
  assert.equal(label({ kind: "tag", id: 2 }), "the tag");
});
