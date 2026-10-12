import { useMemo } from "react";
import type { Folder, FontSummary, ServiceInfo } from "@/api";
import { INSTALLED_LABEL } from "@/library";
import type { TagColor } from "./api";
import { useOrganize } from "./store";

/**
 * Colors for library locations: Font Book and the macOS font folders, service folders, the
 * user's folders and any folder inside them.
 *
 * Each location has a default the user can change:
 * - Font Book and its folders: gray (the folders follow Font Book's color unless set).
 * - Services and cloud storage: a color people know them by (Google Fonts blue, Adobe red,
 *   Google Drive green, iCloud sky, Dropbox indigo…), recognised from the folder's path.
 *   Purchases (fonts imported from store downloads) are orange.
 * - Plain folders: amber, like a manila folder.
 * A folder inside a library folder takes the color of the nearest folder above it that has one.
 *
 * Windows plan: the same rules with `\` paths, plus OneDrive's default `%USERPROFILE%\OneDrive*`.
 */

export const FONT_BOOK_LOCATION = "fontbook";
export const ADOBE_LOCATION = "service:adobe";

export const DEFAULTS = {
  fontBook: "gray",
  folder: "amber",
  google: "blue",
  adobe: "red",
  purchases: "orange",
} as const satisfies Record<string, TagColor>;

/** Cloud storage folders, recognised by path. The first match wins. */
const CLOUD: { test: RegExp; label: string; color: TagColor }[] = [
  { test: /\/Library\/CloudStorage\/GoogleDrive-/i, label: "Google Drive", color: "green" },
  { test: /\/Library\/CloudStorage\/Dropbox/i, label: "Dropbox", color: "indigo" },
  { test: /^\/Users\/[^/]+\/Dropbox( \([^/]*\))?(\/|$)/i, label: "Dropbox", color: "indigo" },
  { test: /\/Library\/CloudStorage\/OneDrive/i, label: "OneDrive", color: "teal" },
  { test: /\/Library\/CloudStorage\/Box/i, label: "Box", color: "pink" },
  { test: /\/Library\/Mobile Documents\//i, label: "iCloud Drive", color: "sky" },
  { test: /\/Library\/CloudStorage\//i, label: "Cloud storage", color: "purple" },
];

export function cloudOf(path: string): { label: string; color: TagColor } | null {
  return CLOUD.find((c) => c.test.test(path.endsWith("/") ? path : `${path}/`)) ?? null;
}

export const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

export interface FolderKind {
  /** Where it comes from, in plain words ("Google Drive", "Font Book", "Folder"). */
  source: string;
  defaultColor: TagColor;
}

export function folderKind(folder: Folder, services: ServiceInfo[], fontBookColor: TagColor): FolderKind {
  if (folder.kind === "system") return { source: INSTALLED_LABEL, defaultColor: fontBookColor };
  if (folder.kind === "service") {
    const service = services.find((s) => s.folderId === folder.id)?.id;
    if (service === "google") return { source: "Google Fonts", defaultColor: DEFAULTS.google };
    if (service === "purchases") return { source: "Purchases", defaultColor: DEFAULTS.purchases };
    return { source: "Service", defaultColor: DEFAULTS.folder };
  }
  const cloud = cloudOf(folder.path);
  return cloud ? { source: cloud.label, defaultColor: cloud.color } : { source: "Folder", defaultColor: DEFAULTS.folder };
}

export interface Locations {
  /** The color a location shows: picked, inherited or default. */
  colorOf: (location: string) => TagColor;
  /** What a location's color is when nothing is picked for it (for "Reset to …"). */
  defaultOf: (location: string) => TagColor;
  /** A copy's color: its folder's, or the nearest folder inside it that has its own. */
  colorOfCopy: (copy: FontSummary) => TagColor;
  /** Where a copy lives, in words: "Google Drive › Fonts › Inter/static". */
  describeCopy: (copy: FontSummary) => string;
  folderById: Map<number, Folder>;
  kindOf: (folder: Folder) => FolderKind;
}

export function useLocations(folders: Folder[], services: ServiceInfo[]): Locations {
  const { locationColors } = useOrganize();
  return useMemo(() => {
    const folderById = new Map(folders.map((f) => [f.id, f]));
    const byPath = new Map(folders.map((f) => [f.path, f]));
    const fontBook = locationColors.get(FONT_BOOK_LOCATION) ?? DEFAULTS.fontBook;
    const kinds = new Map(folders.map((f) => [f.id, folderKind(f, services, fontBook)]));
    const kindOf = (f: Folder) => kinds.get(f.id) ?? folderKind(f, services, fontBook);

    /** The library folder holding a path, by longest prefix. */
    const rootOf = (path: string): Folder | undefined => {
      for (let dir = path; dir; dir = dirOf(dir)) {
        const f = byPath.get(dir);
        if (f) return f;
      }
      return undefined;
    };

    const defaultOf = (location: string): TagColor => {
      if (location === FONT_BOOK_LOCATION) return DEFAULTS.fontBook;
      if (location === ADOBE_LOCATION) return DEFAULTS.adobe;
      const root = rootOf(location);
      if (!root) return cloudOf(location)?.color ?? DEFAULTS.folder;
      if (location === root.path) return kindOf(root).defaultColor;
      // A folder inside a library folder takes the color of the nearest folder above it that has one.
      for (let dir = dirOf(location); dir.length >= root.path.length; dir = dirOf(dir)) {
        const picked = locationColors.get(dir);
        if (picked) return picked;
      }
      return kindOf(root).defaultColor;
    };
    const colorOf = (location: string): TagColor => locationColors.get(location) ?? defaultOf(location);

    const cache = new Map<string, TagColor>();
    const colorOfCopy = (copy: FontSummary): TagColor => {
      const folder = folderById.get(copy.folderId);
      const dir = dirOf(copy.path);
      const cacheKey = `${copy.folderId}|${dir}`;
      let color = cache.get(cacheKey);
      if (!color) {
        color = folder && (dir === folder.path || dir.startsWith(`${folder.path}/`)) ? colorOf(dir) : folder ? colorOf(folder.path) : DEFAULTS.folder;
        cache.set(cacheKey, color);
      }
      return color;
    };

    const describeCopy = (copy: FontSummary): string => {
      const folder = folderById.get(copy.folderId);
      if (!folder) return dirOf(copy.path);
      const kind = kindOf(folder);
      const dir = dirOf(copy.path);
      const inside = dir.startsWith(`${folder.path}/`) ? dir.slice(folder.path.length + 1) : "";
      const parts = [kind.source, folder.label, inside].filter(Boolean);
      // "Google Fonts › Google Fonts" says nothing twice.
      if (folder.kind === "service" || folder.kind === "system") parts.splice(1, 1);
      return parts.join(" › ");
    };

    return { colorOf, defaultOf, colorOfCopy, describeCopy, folderById, kindOf };
  }, [folders, services, locationColors]);
}
