// Run with `npm run test:ui`. The subfolder picker's tree (subfolders.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Folder, FontSummary } from "./api.ts";
import { groupFamilies } from "./library.ts";
import { ancestorsOf, findNode, hasSubfolders, searchRows, sourceTree, treeRows, type DirNode } from "./subfolders.ts";

const folder = (id: number, path: string, kind: Folder["kind"] = "user", label = path.split("/").pop()!): Folder => ({ id, path, kind, label, fontCount: 0, missing: false });

let nextId = 1;
function font(path: string, folderId: number, postscriptName: string | null = path): FontSummary {
  return {
    id: nextId++,
    folderId,
    path,
    faceIndex: 0,
    family: path.split("/").pop()!,
    subfamily: "Regular",
    fullName: null,
    postscriptName,
    weight: 400,
    width: 5,
    italic: false,
    monospace: false,
    variable: false,
    format: "TrueType",
    activated: false,
    installed: false,
    mtime: 1,
    fileSize: 1,
    osActive: false,
    glyphCount: 1,
    preview: null,
  };
}

const TYPE = folder(1, "/T");
const library = groupFamilies([
  font("/T/top.otf", 1),
  font("/T/Sans/Inter/static/Inter-Bold.ttf", 1),
  font("/T/Sans/Inter/Inter.ttf", 1),
  font("/T/Sans/archive/Lato.ttf", 1),
  font("/T/serif/Lora.ttf", 1),
  // The same font in two subfolders: once in each, once in the folder above both.
  font("/T/Sans/dupes/Same.otf", 1, "Same"),
  font("/T/Sans/more/Same.otf", 1, "Same"),
  // Another library folder's font, inside nothing here.
  font("/Other/x/X.otf", 2),
]);

const shape = (nodes: DirNode[]): unknown => nodes.map((n) => [n.name, n.count, shape(n.children)]);

test("one folder: its subfolders at the top, A to Z, each style counted once per folder", () => {
  assert.deepEqual(shape(sourceTree([TYPE], library)), [
    [
      "Sans",
      4,
      [
        ["archive", 1, []],
        ["dupes", 1, []],
        ["Inter", 2, [["static", 1, []]]],
        ["more", 1, []],
      ],
    ],
    ["serif", 1, []],
  ]);
});

test("several folders (Font Book): each is a top-level entry under its own name", () => {
  const user = folder(1, "/U/Library/Fonts", "system", "My Fonts");
  const computer = folder(2, "/Library/Fonts", "system", "Computer Fonts");
  const system = folder(3, "/System/Library/Fonts", "system", "macOS System Fonts");
  const fonts = groupFamilies([font("/Library/Fonts/Arial.ttf", 2), font("/System/Library/Fonts/Supplemental/Courier.ttf", 3), font("/System/Library/Fonts/SF.ttf", 3)]);
  const tree = sourceTree([user, computer, system], fonts);
  assert.deepEqual(shape(tree), [
    ["My Fonts", 0, []],
    ["Computer Fonts", 1, []],
    ["macOS System Fonts", 2, [["Supplemental", 1, []]]],
  ]);
  assert.equal(tree[2].path, "/System/Library/Fonts");
  assert.ok(hasSubfolders([user, computer, system], fonts), "Font Book always offers its folders");
});

test("the picker shows only for a folder with fonts in folders inside it", () => {
  assert.ok(hasSubfolders([TYPE], library));
  const flat = groupFamilies([font("/F/a.otf", 9), font("/F/b.otf", 9)]);
  assert.ok(!hasSubfolders([folder(9, "/F")], flat));
  assert.ok(!hasSubfolders([], flat), "nothing to pick from (Adobe Fonts, or no Google folder yet)");
});

test("lines show the children of open folders only", () => {
  const tree = sourceTree([TYPE], library);
  const names = (open: string[]) => treeRows(tree, new Set(open)).map((r) => `${"  ".repeat(r.depth)}${r.node.name}${r.expandable ? (r.open ? " -" : " +") : ""}`);
  assert.deepEqual(names([]), ["Sans +", "serif"]);
  assert.deepEqual(names(["/T/Sans", "/T/Sans/Inter"]), ["Sans -", "  archive", "  dupes", "  Inter -", "    static", "  more", "serif"]);
  assert.deepEqual(names(["/T/Sans/Inter"]), ["Sans +", "serif"], "a folder inside a closed one stays out of sight");
});

test("search finds folders by name anywhere, saying what they're inside", () => {
  const tree = sourceTree([TYPE], library);
  const found = searchRows(tree, "  INTER ");
  assert.equal(found.total, 1);
  assert.deepEqual(
    found.rows.map((r) => [r.node.name, r.within]),
    [["Inter", "Sans"]],
  );
  assert.deepEqual(
    searchRows(tree, "s").rows.map((r) => [r.node.name, r.within ?? ""]),
    [
      ["Sans", ""],
      ["dupes", "Sans"],
      ["static", "Sans › Inter"],
      ["serif", ""],
    ],
  );
  const limited = searchRows(tree, "s", 2);
  assert.equal(limited.rows.length, 2);
  assert.equal(limited.total, 4, "the total still counts every match");
  assert.deepEqual(searchRows(tree, "   ").rows, []);
});

test("a subfolder can be found and opened into view", () => {
  const tree = sourceTree([TYPE], library);
  assert.deepEqual(ancestorsOf(tree, "/T/Sans/Inter/static"), ["/T/Sans", "/T/Sans/Inter"]);
  assert.deepEqual(ancestorsOf(tree, "/T/serif"), []);
  assert.deepEqual(ancestorsOf(tree, "/T/Sansx/y"), [], "whole folder names only");
  assert.equal(findNode(tree, "/T/Sans/Inter")?.count, 2);
  assert.equal(findNode(tree, "/T/nope"), undefined);
});
