import { useEffect, useRef, useState } from "react";
import type { AppSettings, Folder, ServiceInfo } from "@/api";
import type { Family, LibraryView, StatusFilter } from "@/library";
import { parseView, restoreView } from "@/places";

/**
 * "Open where you left off": the library view and its filters (All / Active / Inactive and
 * Variable) are kept in localStorage as they change, and reopened at launch when the setting
 * is on. A view saved before the sidebar's flat Sources (a macOS font folder, a service's
 * folder) opens as today's equivalent (`migrateView` in places.ts); one whose folder, subfolder
 * or sidebar entry is gone opens All Fonts instead. (A deleted tag is caught by the Tags section
 * once tags load.)
 */

const KEY = "fontface.lastView";

export interface LastView {
  view: LibraryView;
  status: StatusFilter;
  variableOnly: boolean;
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
  families,
  current,
  apply,
}: {
  settings: AppSettings | null;
  /** The first library read is done (folders, services and fonts), so saved places can be checked. */
  libraryLoaded: boolean;
  folders: Folder[];
  services: ServiceInfo[];
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
    apply({ ...last, view: restoreView(last.view, { folders, services, families, sidebar: settings.sidebar }) });
  }, [decided, settings, libraryLoaded, folders, services, families, untouched, apply]);

  const { view, status, variableOnly } = current;
  useEffect(() => {
    if (decided) save({ view, status, variableOnly });
  }, [decided, view, status, variableOnly]);
}
