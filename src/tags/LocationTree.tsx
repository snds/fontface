import { memo, useMemo } from "react";
import type { Folder } from "@/api";
import { viewKey, type Family, type LibraryView } from "@/library";
import { Button, buttonVariants } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { colorVar } from "./api";
import { toggleOpen, useOpenRows } from "./expanded";
import type { Locations } from "./locations";
import { LocationsMenu } from "./menus";

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

/** True if any of the folder's fonts sit in a folder inside it. Cheaper than the whole tree. */
function hasSubfolders(folder: Folder, families: Family[]): boolean {
  const prefix = `${folder.path}/`;
  return families.some((family) =>
    family.faces.some((face) => face.copies.some((c) => c.folderId === folder.id && c.path.startsWith(prefix) && c.path.indexOf("/", prefix.length) >= 0)),
  );
}

/** A folder's subfolder tree, built only while it's open (it can hold thousands of folders). */
export function useSubfolders(folder: Folder, families: Family[]): { nodes: DirNode[]; hasChildren: boolean } {
  const open = useOpenRows().has(openId(folder.path));
  const nodes = useMemo(() => (open ? buildTree(folder, families) : []), [open, folder, families]);
  const any = useMemo(() => !open && hasSubfolders(folder, families), [open, folder, families]);
  return { nodes, hasChildren: open ? nodes.length > 0 : any };
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

interface RowsProps {
  nodes: DirNode[];
  depth: number;
  open: Set<string>;
  selected: string;
  onView: (v: LibraryView) => void;
  locations: Locations;
}

/** Plain rows (no hooks, no menus of their own): a large folder can have thousands. */
function DirRows({ nodes, depth, open, selected, onView, locations }: RowsProps) {
  return (
    <div role="group">
      {nodes.map((node) => {
        const target: LibraryView = { kind: "location", path: node.path };
        const isSelected = selected === viewKey(target);
        const isOpen = open.has(openId(node.path));
        return (
          <div key={node.path}>
            <div className={rowClass(isSelected)} style={{ paddingLeft: 8 + depth * 14 }} data-location={node.path}>
              {node.children.length > 0 ? (
                <button
                  className={cn(buttonVariants({ variant: "ghost", size: "icon-xs" }), "-ml-1 size-5 shrink-0")}
                  aria-label={isOpen ? `Hide folders in ${node.name}` : `Show folders in ${node.name}`}
                  aria-expanded={isOpen}
                  onClick={() => toggleOpen(openId(node.path))}
                >
                  <Icon name="chevron_right" size={16} className={cn("transition-transform", isOpen && "rotate-90")} />
                </button>
              ) : (
                <span className="w-4 shrink-0" aria-hidden />
              )}
              <button
                className="flex min-w-0 flex-1 items-center gap-2"
                aria-current={isSelected ? "page" : undefined}
                title={node.path}
                onClick={() => onView(target)}
              >
                <Icon name="folder" size={16} filled style={{ color: colorVar(locations.colorOf(node.path)) }} />
                <span className="truncate">{node.name}</span>
              </button>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">{n(node.count)}</span>
            </div>
            {isOpen && node.children.length > 0 && <DirRows {...{ open, selected, onView, locations }} nodes={node.children} depth={depth + 1} />}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A user folder's subfolders, shown under its row when it's open. Each one is a view, and
 * right-clicking one picks its color.
 */
export const SubfolderTree = memo(function SubfolderTree({
  nodes,
  root,
  view,
  onView,
  locations,
}: {
  nodes: DirNode[];
  root: string;
  view: LibraryView;
  onView: (v: LibraryView) => void;
  locations: Locations;
}) {
  const open = useOpenRows();
  if (!open.has(openId(root)) || !nodes.length) return null;
  return (
    <LocationsMenu locations={locations}>
      <DirRows nodes={nodes} depth={1} open={open} selected={viewKey(view)} onView={onView} locations={locations} />
    </LocationsMenu>
  );
});
