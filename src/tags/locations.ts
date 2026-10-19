import { useMemo } from "react";
import type { Folder, FontSummary, ServiceInfo } from "@/api";
import { INSTALLED_LABEL } from "@/library";
import type { TagColor } from "./api";
import { useOrganize } from "./store";

/**
 * Colors for the sidebar's sources: Font Book, Adobe Fonts, the service folders (Google Fonts,
 * Purchases) and the user's folders. A font shows its source's color.
 *
 * Each source has a default the user can change (right-click its row):
 * - Font Book: gray. The macOS font folders are part of it and show its color.
 * - Services and cloud storage: a color people know them by (Google Fonts blue, Adobe red,
 *   Google Drive green, iCloud sky, Dropbox indigo…), recognised from the folder's path.
 *   Purchases (fonts imported from store downloads) are orange.
 * - Plain folders: amber, like a manila folder.
 *
 * Colors set before on a folder inside a source, or on one macOS font folder (from the sidebar's
 * old folder trees and the toolbar's old folder picker), stay in the library, its export and its
 * relocations, but nothing shows them any more: a font always takes its source's color.
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

const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

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
  /** The color a source shows (by its location: Font Book, Adobe Fonts or its folder's path):
   *  picked or default. */
  colorOf: (location: string) => TagColor;
  /** What a source's color is when nothing is picked for it (for "Reset to …"). */
  defaultOf: (location: string) => TagColor;
  /** A copy's color: its source's. */
  colorOfCopy: (copy: FontSummary) => TagColor;
  /** Where a copy lives, in words: "Google Drive › Fonts › Inter/static". */
  describeCopy: (copy: FontSummary) => string;
  /** Where a copy comes from, briefly (the Table's Source column): one of your folders by its
   *  name, else the source ("Font Book", "Google Fonts", "Purchases"). */
  sourceOf: (copy: FontSummary) => string;
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

    const defaultOf = (location: string): TagColor => {
      if (location === FONT_BOOK_LOCATION) return DEFAULTS.fontBook;
      if (location === ADOBE_LOCATION) return DEFAULTS.adobe;
      const folder = byPath.get(location);
      return folder ? kindOf(folder).defaultColor : (cloudOf(location)?.color ?? DEFAULTS.folder);
    };
    const colorOf = (location: string): TagColor => locationColors.get(location) ?? defaultOf(location);

    const colorOfCopy = (copy: FontSummary): TagColor => {
      const folder = folderById.get(copy.folderId);
      if (!folder) return DEFAULTS.folder;
      // The macOS font folders are all Font Book.
      return folder.kind === "system" ? fontBook : colorOf(folder.path);
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

    const sourceOf = (copy: FontSummary): string => {
      const folder = folderById.get(copy.folderId);
      if (!folder) return "";
      return folder.kind === "user" ? folder.label : kindOf(folder).source;
    };

    return { colorOf, defaultOf, colorOfCopy, describeCopy, sourceOf, folderById, kindOf };
  }, [folders, services, locationColors]);
}
