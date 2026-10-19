import { useEffect, useRef, useState } from "react";
import type { AppSettings, Folder, ServiceInfo } from "@/api";
import type { LibraryView, StatusFilter } from "@/library";
import { parseView, restoreView, type SavedView } from "@/places";

/**
 * "Open where you left off": the library view and its filters (All / Active / Inactive and
 * Variable) are kept in localStorage as they change, and reopened at launch when the setting
 * is on. A view saved before the sidebar's flat Sources (a macOS font folder, a service's
 * folder) or before the toolbar's folder picker went (a folder inside a source) opens as
 * today's equivalent (`migrateView` in places.ts); one whose folder or sidebar entry is gone
 * opens All Fonts instead. (A deleted tag is caught by the Tags section once tags load.)
 */

const KEY = "fontface.lastView";

export interface LastView {
  view: LibraryView;
  status: StatusFilter;
  variableOnly: boolean;
}

/** What storage holds: a view from an older version too, until `restoreView` brings it up to date. */
type Saved = Omit<LastView, "view"> & { view: SavedView };

function load(): Saved | null {
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

/**
 * Saves the view and filters as they change and, once settings and the library have loaded,
 * reopens the saved ones if "Open where you left off" is on. Nothing is reopened if the user
 * already moved somewhere else.
 */
export function useLastView({
  settings,
  libraryLoaded,
  folders,
  services,
  current,
  apply,
}: {
  settings: AppSettings | null;
  /** The first library read is done (folders, services and fonts), so saved places can be checked. */
  libraryLoaded: boolean;
  folders: Folder[];
  services: ServiceInfo[];
  current: LastView;
  apply: (last: LastView) => void;
}) {
  // Read before anything is saved over it.
  const saved = useRef<Saved | null | undefined>(undefined);
  if (saved.current === undefined) saved.current = load();
  const [decided, setDecided] = useState(false);
  const untouched = current.view.kind === "all" && current.status === "any" && !current.variableOnly;

  useEffect(() => {
    if (decided || !settings || !libraryLoaded) return;
    setDecided(true);
    const last = saved.current;
    if (!settings.restoreLastView || !last || !untouched) return;
    apply({ ...last, view: restoreView(last.view, { folders, services, sidebar: settings.sidebar }) });
  }, [decided, settings, libraryLoaded, folders, services, untouched, apply]);

  const { view, status, variableOnly } = current;
  useEffect(() => {
    if (decided) save({ view, status, variableOnly });
  }, [decided, view, status, variableOnly]);
}
