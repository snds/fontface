import { useMemo } from "react";
import type { Folder } from "@/api";
import { viewKey, type Family, type LibraryView } from "@/library";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { colorVar } from "./api";
import { toggleOpen, useOpenRows } from "./expanded";
import type { Locations } from "./locations";
import { LocationMenu } from "./menus";

/** A folder inside a library folder, with how many styles live anywhere under it. */
interface DirNode {
  path: string;
  name: string;
  count: number;
  children: DirNode[];
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const n = (v: number) => v.toLocaleString();

/** Builds a folder's subfolder tree from where its fonts are. Each style counts once per folder. */
function buildTree(folder: Folder, families: Family[]): DirNode[] {
  const root: DirNode = { path: folder.path, name: "", count: 0, children: [] };
  const nodes = new Map<string, DirNode>([[folder.path, root]]);
  const nodeFor = (path: string): DirNode => {
    let node = nodes.get(path);
    if (node) return node;
    const cut = path.lastIndexOf("/");
    node = { path, name: path.slice(cut + 1), count: 0, children: [] };
    nodes.set(path, node);
    nodeFor(path.slice(0, cut)).children.push(node);
    return node;
  };
  const prefix = `${folder.path}/`;
  for (const family of families) {
    for (const face of family.faces) {
      const dirs = new Set<string>();
      for (const c of face.copies) {
        if (c.folderId !== folder.id || !c.path.startsWith(prefix)) continue;
        for (let dir = c.path.slice(0, c.path.lastIndexOf("/")); dir.length > folder.path.length; dir = dir.slice(0, dir.lastIndexOf("/"))) {
          dirs.add(dir);
        }
      }
      for (const dir of dirs) nodeFor(dir).count++;
    }
  }
  const sort = (list: DirNode[]) => {
    list.sort((a, b) => collator.compare(a.name, b.name));
    for (const c of list) sort(c.children);
  };
  sort(root.children);
  return root.children;
}

export function useSubfolders(folder: Folder, families: Family[]): DirNode[] {
  return useMemo(() => buildTree(folder, families), [folder, families]);
}

const openId = (path: string) => `loc:${path}`;

/** The chevron that shows or hides a folder's subfolders. Takes up the same space when there are none. */
export function SubfolderToggle({ path, label, hasChildren }: { path: string; label: string; hasChildren: boolean }) {
  const open = useOpenRows().has(openId(path));
  if (!hasChildren) return <span className="w-4 shrink-0" aria-hidden />;
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="-ml-1 size-5 shrink-0"
      aria-label={open ? `Hide folders in ${label}` : `Show folders in ${label}`}
      aria-expanded={open}
      onClick={(e) => {
        e.stopPropagation();
        toggleOpen(openId(path));
      }}
    >
      <Icon name="chevron_right" size={16} className={cn("transition-transform", open && "rotate-90")} />
    </Button>
  );
}

const rowClass = (selected: boolean) =>
  cn(
    "group/item flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-sm",
    selected ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "hover:bg-sidebar-accent/60",
  );

/** A user folder's subfolders, shown under its row when it's open. Each one is a view. */
export function SubfolderTree({
  nodes,
  root,
  depth = 1,
  view,
  onView,
  locations,
}: {
  nodes: DirNode[];
  root: string;
  depth?: number;
  view: LibraryView;
  onView: (v: LibraryView) => void;
  locations: Locations;
}) {
  const open = useOpenRows();
  if (!open.has(openId(root))) return null;
  return (
    <div role="group">
      {nodes.map((node) => {
        const view_: LibraryView = { kind: "location", path: node.path };
        const selected = viewKey(view) === viewKey(view_);
        const color = locations.colorOf(node.path);
        return (
          <div key={node.path}>
            <LocationMenu location={node.path} color={color} defaultColor={locations.defaultOf(node.path)}>
              <div className={rowClass(selected)} style={{ paddingLeft: 8 + depth * 14 }}>
                <SubfolderToggle path={node.path} label={node.name} hasChildren={node.children.length > 0} />
                <button
                  className="flex min-w-0 flex-1 items-center gap-2"
                  aria-current={selected ? "page" : undefined}
                  title={node.path}
                  onClick={() => onView(view_)}
                >
                  <Icon name="folder" size={16} filled style={{ color: colorVar(color) }} />
                  <span className="truncate">{node.name}</span>
                </button>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">{n(node.count)}</span>
              </div>
            </LocationMenu>
            {node.children.length > 0 && (
              <SubfolderTree nodes={node.children} root={node.path} depth={depth + 1} view={view} onView={onView} locations={locations} />
            )}
          </div>
        );
      })}
    </div>
  );
}
