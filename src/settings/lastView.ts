import { useEffect, useRef, useState } from "react";
import type { AppSettings, Folder, SidebarSections } from "@/api";
import type { Family, LibraryView, StatusFilter } from "@/library";

/**
 * "Open where you left off": the library view and its filters (All / Active / Inactive and
 * Variable) are kept in localStorage as they change, and reopened at launch when the setting
 * is on. A saved view whose folder, subfolder or sidebar section is gone opens All Fonts
 * instead. (A deleted tag is caught by the Tags section once tags load.)
 */

const KEY = "fontface.lastView";

export interface LastView {
  view: LibraryView;
  status: StatusFilter;
  variableOnly: boolean;
}

const isId = (v: unknown) => typeof v === "number" && Number.isInteger(v);

/** A view read back from storage, if it has the right shape. */
function parseView(v: unknown): LibraryView | null {
  if (!v || typeof v !== "object") return null;
  const view = v as Record<string, unknown>;
  switch (view.kind) {
    case "all":
    case "installed":
      return { kind: view.kind };
    case "folder":
    case "tag":
      return isId(view.id) ? { kind: view.kind, id: view.id as number } : null;
    case "service":
      return view.id === "google" || view.id === "adobe" || view.id === "purchases" ? { kind: "service", id: view.id } : null;
    case "location":
      return typeof view.path === "string" && view.path ? { kind: "location", path: view.path } : null;
    default:
      return null;
  }
}

function load(): LastView | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    const view = parseView(raw?.view);
    if (!view) return null;
    const status: StatusFilter = raw.status === "active" || raw.status === "inactive" ? raw.status : "any";
    return { view, status, variableOnly: raw.variableOnly === true };
  } catch {
    return null;
  }
}

function save(last: LastView) {
  try {
    localStorage.setItem(KEY, JSON.stringify(last));
  } catch {
    // Storage unavailable: launch opens All Fonts.
  }
}

/** True if the sidebar settings hide the place this view belongs to. */
export function hiddenBySidebar(view: LibraryView, sidebar: SidebarSections, folders: Folder[]): boolean {
  switch (view.kind) {
    case "installed":
      return !sidebar.fontBook;
    case "service":
      return !sidebar[view.id];
    case "tag":
      return !sidebar.tags;
    case "folder":
      // The macOS font folders sit under Font Book.
      return !sidebar.fontBook && folders.find((f) => f.id === view.id)?.kind === "system";
    default:
      return false;
  }
}

/** True if a saved view can still be shown: its folder or subfolder still exists, and the sidebar shows it. */
function stillThere(view: LibraryView, folders: Folder[], families: Family[], sidebar: SidebarSections): boolean {
  if (hiddenBySidebar(view, sidebar, folders)) return false;
  if (view.kind === "folder") return folders.some((f) => f.id === view.id);
  if (view.kind === "location") {
    const inside = `${view.path}/`;
    return (
      folders.some((f) => inside.startsWith(`${f.path}/`)) &&
      families.some((family) => family.faces.some((face) => face.copies.some((c) => c.path.startsWith(inside))))
    );
  }
  return true;
}

/**
 * Saves the view and filters as they change and, once settings and the library have loaded,
 * reopens the saved ones if "Open where you left off" is on. Nothing is reopened if the user
 * already moved somewhere else.
 */
export function useLastView({
  settings,
  libraryLoaded,
  folders,
  families,
  current,
  apply,
}: {
  settings: AppSettings | null;
  /** The first library read is done (folders and fonts), so saved places can be checked. */
  libraryLoaded: boolean;
  folders: Folder[];
  families: Family[];
  current: LastView;
  apply: (last: LastView) => void;
}) {
  // Read before anything is saved over it.
  const saved = useRef<LastView | null | undefined>(undefined);
  if (saved.current === undefined) saved.current = load();
  const [decided, setDecided] = useState(false);
  const untouched = current.view.kind === "all" && current.status === "any" && !current.variableOnly;

  useEffect(() => {
    if (decided || !settings || !libraryLoaded) return;
    setDecided(true);
    const last = saved.current;
    if (!settings.restoreLastView || !last || !untouched) return;
    apply({ ...last, view: stillThere(last.view, folders, families, settings.sidebar) ? last.view : { kind: "all" } });
  }, [decided, settings, libraryLoaded, folders, families, untouched, apply]);

  const { view, status, variableOnly } = current;
  useEffect(() => {
    if (decided) save({ view, status, variableOnly });
  }, [decided, view, status, variableOnly]);
}
