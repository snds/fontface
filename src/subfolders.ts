import type { Folder } from "./api";
import type { Family } from "./library";

/**
 * The folders inside a source, for the toolbar's subfolder picker (components/SubfolderPicker.tsx),
 * worked out from where the source's fonts are. Pure (no React, no DOM), so `npm run test:ui`
 * covers it.
 *
 * A source with one library folder (one of yours, Google Fonts, Purchases) lists that folder's
 * subfolders at the top. Font Book has three (the OS's font folders): each is a top-level entry
 * under its own name, with its subfolders inside. Picking an entry shows a "location" view.
 */

/** A folder with how many styles live anywhere under it (each style once). */
export interface DirNode {
  path: string;
  name: string;
  count: number;
  children: DirNode[];
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const lastPart = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The folders inside a source's library folders (`roots`), with counts. See the module comment for the shape. */
export function sourceTree(roots: readonly Folder[], families: readonly Family[]): DirNode[] {
  const rootById = new Map(roots.map((r) => [r.id, r]));
  const rootNode = new Map<number, DirNode>(roots.map((r) => [r.id, { path: r.path, name: r.label || lastPart(r.path), count: 0, children: [] }]));
  const nodes = new Map<string, DirNode>();
  for (const [id, node] of rootNode) nodes.set(rootById.get(id)!.path, node);
  const nodeFor = (path: string): DirNode => {
    let node = nodes.get(path);
    if (node) return node;
    node = { path, name: lastPart(path), count: 0, children: [] };
    nodes.set(path, node);
    nodeFor(dirOf(path)).children.push(node);
    return node;
  };
  for (const family of families) {
    for (const face of family.faces) {
      const dirs = new Set<string>();
      const hit = new Set<DirNode>();
      for (const c of face.copies) {
        const root = rootById.get(c.folderId);
        if (!root || !c.path.startsWith(`${root.path}/`)) continue;
        hit.add(rootNode.get(root.id)!);
        for (let dir = dirOf(c.path); dir.length > root.path.length; dir = dirOf(dir)) dirs.add(dir);
      }
      for (const node of hit) node.count++;
      for (const dir of dirs) nodeFor(dir).count++;
    }
  }
  const sort = (list: DirNode[]) => {
    list.sort((a, b) => collator.compare(a.name, b.name));
    for (const c of list) sort(c.children);
  };
  const tops = roots.map((r) => rootNode.get(r.id)!);
  for (const top of tops) sort(top.children);
  return tops.length === 1 ? tops[0].children : tops;
}

/** True if the picker has something to offer: several folders (Font Book), or fonts in a folder
 *  inside the one. Cheaper than the whole tree. */
export function hasSubfolders(roots: readonly Folder[], families: readonly Family[]): boolean {
  if (roots.length > 1) return true;
  const root = roots[0];
  if (!root) return false;
  const prefix = `${root.path}/`;
  return families.some((family) =>
    family.faces.some((face) => face.copies.some((c) => c.folderId === root.id && c.path.startsWith(prefix) && c.path.indexOf("/", prefix.length) >= 0)),
  );
}

/** One line of the picker. */
export interface TreeRow {
  node: DirNode;
  /** 0 at the top. */
  depth: number;
  expandable: boolean;
  open: boolean;
  /** In search results: the folders it's inside ("Inter › static"), else undefined. */
  within?: string;
}

/** The tree as lines, showing the children of open folders (by path) only. */
export function treeRows(nodes: readonly DirNode[], open: ReadonlySet<string>, depth = 0, out: TreeRow[] = []): TreeRow[] {
  for (const node of nodes) {
    const expandable = node.children.length > 0;
    const isOpen = expandable && open.has(node.path);
    out.push({ node, depth, expandable, open: isOpen });
    if (isOpen) treeRows(node.children, open, depth + 1, out);
  }
  return out;
}

/**
 * Folders whose name has `query` in it (ignoring case), in tree order, at most `limit` of them,
 * each saying which folders it's inside. `total` counts every match.
 */
export function searchRows(nodes: readonly DirNode[], query: string, limit = 200): { rows: TreeRow[]; total: number } {
  const q = query.trim().toLowerCase();
  const rows: TreeRow[] = [];
  let total = 0;
  if (!q) return { rows, total };
  const walk = (list: readonly DirNode[], above: string[]) => {
    for (const node of list) {
      if (node.name.toLowerCase().includes(q)) {
        total++;
        if (rows.length < limit) rows.push({ node, depth: 0, expandable: false, open: false, within: above.join(" › ") || undefined });
      }
      walk(node.children, [...above, node.name]);
    }
  };
  walk(nodes, []);
  return { rows, total };
}

/** The folders above `path` in the tree (their paths, from the top), so it can be opened into
 *  view; empty if it's at the top or not in the tree. */
export function ancestorsOf(nodes: readonly DirNode[], path: string): string[] {
  for (const node of nodes) {
    if (node.path === path) return [];
    if (path.startsWith(`${node.path}/`)) {
      const below = ancestorsOf(node.children, path);
      return [node.path, ...below];
    }
  }
  return [];
}

/** The node for a path, if the tree has it. */
export function findNode(nodes: readonly DirNode[], path: string): DirNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (path.startsWith(`${node.path}/`)) return findNode(node.children, path);
  }
  return undefined;
}
