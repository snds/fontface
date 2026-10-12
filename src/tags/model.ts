import { useMemo } from "react";
import type { Face, Family, FilterContext } from "@/library";
import type { Tag } from "./api";
import { looseKey, useOrganize } from "./store";

/** One tag in the nested tree. "Sci-Fi/Star Trek" is the child "Star Trek" of "Sci-Fi". */
export interface TagNode {
  tag: Tag;
  /** The last level of the name. */
  label: string;
  depth: number;
  children: TagNode[];
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** Letter case folded the way SQLite's NOCASE does (ASCII only), so names match the database. */
export const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

export const depthOf = (name: string) => name.split("/").length - 1;
export const leafOf = (name: string) => name.slice(name.lastIndexOf("/") + 1);
export const parentOf = (name: string) => (name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : null);
/** `name` is `ancestor` or nested somewhere under it (ignoring letter case, like the database). */
export const isWithin = (name: string, ancestor: string) => fold(name) === fold(ancestor) || fold(name).startsWith(`${fold(ancestor)}/`);

export function tagTree(tags: Tag[]): TagNode[] {
  const byName = new Map<string, TagNode>();
  const roots: TagNode[] = [];
  for (const tag of [...tags].sort((a, b) => depthOf(a.name) - depthOf(b.name))) {
    const node: TagNode = { tag, label: leafOf(tag.name), depth: depthOf(tag.name), children: [] };
    byName.set(fold(tag.name), node);
    const parent = parentOf(tag.name);
    const into = parent === null ? undefined : byName.get(fold(parent));
    (into ? into.children : roots).push(node);
  }
  const sort = (nodes: TagNode[]) => {
    nodes.sort((a, b) => collator.compare(a.label, b.label));
    for (const n of nodes) sort(n.children);
  };
  sort(roots);
  return roots;
}

/** The tree in reading order (parents before children). */
export function flatten(nodes: TagNode[], out: TagNode[] = []): TagNode[] {
  for (const n of nodes) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
}

export interface TagIndex {
  tags: Tag[];
  byId: Map<number, Tag>;
  tree: TagNode[];
  /** Every tag in tree order. */
  ordered: TagNode[];
  /** Tag id → itself and every tag above it. */
  lineage: Map<number, number[]>;
  /** Tag id → itself and every tag nested under it. */
  subtree: Map<number, Set<number>>;
  /** The tags on a face: its own, plus any kept from an import for its PostScript name. */
  tagsOf: (face: Face) => number[];
}

export function buildIndex(tags: Tag[], byKey: Map<string, number[]>): TagIndex {
  const byId = new Map(tags.map((t) => [t.id, t]));
  const tree = tagTree(tags);
  const ordered = flatten(tree);
  const lineage = new Map<number, number[]>();
  const subtree = new Map<number, Set<number>>();
  const walk = (node: TagNode, above: number[]) => {
    const line = [node.tag.id, ...above];
    lineage.set(node.tag.id, line);
    for (const id of line) {
      let set = subtree.get(id);
      if (!set) subtree.set(id, (set = new Set()));
      set.add(node.tag.id);
    }
    for (const c of node.children) walk(c, line);
  };
  for (const root of tree) walk(root, []);

  const order = new Map(ordered.map((n, i) => [n.tag.id, i]));
  const cache = new WeakMap<Face, number[]>();
  const tagsOf = (face: Face) => {
    let ids = cache.get(face);
    if (!ids) {
      const own = byKey.get(face.key) ?? [];
      const loose = looseKey(face);
      const kept = loose ? byKey.get(loose) ?? [] : [];
      ids = [...new Set([...own, ...kept])].filter((id) => byId.has(id)).sort((a, b) => order.get(a)! - order.get(b)!);
      cache.set(face, ids);
    }
    return ids;
  };
  return { tags, byId, tree, ordered, lineage, subtree, tagsOf };
}

export function useTagIndex(): TagIndex {
  const { tags, byKey } = useOrganize();
  return useMemo(() => buildIndex(tags, byKey), [tags, byKey]);
}

/** Styles per tag, counting a tag's nested tags too, and each style once. */
export function countByTag(families: Family[], index: TagIndex): Map<number, number> {
  const counts = new Map<number, number>();
  for (const family of families) {
    for (const face of family.faces) {
      const ids = index.tagsOf(face);
      if (!ids.length) continue;
      const all = new Set<number>();
      for (const id of ids) for (const up of index.lineage.get(id) ?? [id]) all.add(up);
      for (const id of all) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/** How the library list filters by tag and searches tag names. */
export function useFilterContext(): FilterContext {
  const index = useTagIndex();
  return useMemo(() => {
    const lower = new Map(index.tags.map((t) => [t.id, t.name.toLowerCase()]));
    return {
      tagNames: (face) => index.tagsOf(face).map((id) => lower.get(id) ?? ""),
      inTag: (face, tagId) => {
        const within = index.subtree.get(tagId);
        return !!within && index.tagsOf(face).some((id) => within.has(id));
      },
    };
  }, [index]);
}

/** Every face a set of faces covers, without repeats (selection, family rows). */
export function uniqueFaces(faces: Iterable<Face>): Face[] {
  const seen = new Map<string, Face>();
  for (const f of faces) if (!seen.has(f.key)) seen.set(f.key, f);
  return [...seen.values()];
}

/** For each tag: how many of `faces` have it (directly). */
export function tagCoverage(faces: Face[], index: TagIndex): Map<number, number> {
  const counts = new Map<number, number>();
  for (const face of faces) for (const id of index.tagsOf(face)) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}
