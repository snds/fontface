import type { Folder, ServiceInfo, SidebarSections } from "./api";
import type { Family, LibraryView, SmartKind } from "./library";

/**
 * The sidebar's places, and how a saved view maps onto them. Pure (no React, no DOM), so `npm
 * run test:ui` covers it.
 *
 * LIBRARY holds the smart entries (`SMART_ENTRIES`). SOURCES holds one row per source, flat, in
 * this order: Font Book (the OS's three font folders as one source), Google Fonts, Adobe Fonts,
 * Purchases, then your folders A to Z (`sourceRows`). There are no folder trees in the sidebar:
 * a folder inside a source is a "location" view, picked with the toolbar's subfolder picker
 * (subfolders.ts), and its source's row stays selected (`sourceOf`).
 *
 * Saved views from before (`lastView`) still open: a macOS font folder's view becomes Font Book
 * narrowed to that folder, and a service folder's view becomes that service's row
 * (`migrateView`). "service:google" used to open the catalog; it now lists your Google fonts,
 * and the catalog opens from there (Browse).
 */

export interface SmartEntry {
  kind: SmartKind;
  label: string;
  /** Material Symbols name. */
  icon: string;
  /** The row's tooltip. */
  hint: string;
  /** Its Settings › Sidebar switch. All Fonts has none: it always shows. */
  setting?: "yours" | "recent" | "active" | "untagged";
}

/** The OS's name, for plain words ("apart from the ones macOS always keeps on"). */
const OS = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent) ? "Windows" : "macOS";

export const SMART_ENTRIES: readonly SmartEntry[] = [
  { kind: "all", label: "All Fonts", icon: "font_download", hint: "Every font Fontface knows about" },
  { kind: "yours", label: "Your Fonts", icon: "person", hint: "Fonts you added: in your folders, Google Fonts or Purchases", setting: "yours" },
  { kind: "recent", label: "Recently Added", icon: "schedule", hint: "Fonts added in the last 30 days, newest first", setting: "recent" },
  { kind: "active", label: "Active", icon: "toggle_on", hint: `Fonts that are on right now, apart from the ones ${OS} always keeps on`, setting: "active" },
  { kind: "untagged", label: "Not Tagged", icon: "label_off", hint: "Fonts with none of your own tags (built-in tags don't count)", setting: "untagged" },
];

/** The smart entries the sidebar shows (Settings › Sidebar). All Fonts is always there. */
export const smartRows = (sidebar: SidebarSections) => SMART_ENTRIES.filter((e) => !e.setting || sidebar[e.setting]);

export type ServiceKey = "google" | "adobe" | "purchases";
/** A row in SOURCES. */
export type SourceKey = "fontbook" | ServiceKey | `folder:${number}`;

export const SERVICE_LABELS: Record<ServiceKey, string> = { google: "Google Fonts", adobe: "Adobe Fonts", purchases: "Purchases" };

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/**
 * The rows of SOURCES, in order: Font Book, Google Fonts, Adobe Fonts and Purchases (each unless
 * Settings › Sidebar hides it), then your folders A to Z. Your folders always show.
 */
export function sourceRows(folders: readonly Folder[], sidebar: SidebarSections): SourceKey[] {
  const out: SourceKey[] = [];
  if (sidebar.fontBook) out.push("fontbook");
  for (const service of ["google", "adobe", "purchases"] as const) if (sidebar[service]) out.push(service);
  const user = folders
    .filter((f) => f.kind === "user")
    .sort((a, b) => collator.compare(a.label, b.label) || collator.compare(a.path, b.path) || a.id - b.id);
  for (const f of user) out.push(`folder:${f.id}`);
  return out;
}

/** The library folder a path is in (or is): the one whose path is the longest start of it. */
export function folderHolding(path: string, folders: readonly Folder[]): Folder | undefined {
  let best: Folder | undefined;
  for (const f of folders) {
    if ((path === f.path || path.startsWith(`${f.path}/`)) && (!best || f.path.length > best.path.length)) best = f;
  }
  return best;
}

/** The service a managed folder belongs to (Google Fonts' downloads, Purchases' imports). */
export function serviceOfFolder(folder: Folder, services: readonly ServiceInfo[]): ServiceKey | undefined {
  if (folder.kind !== "service") return undefined;
  return services.find((s) => s.folderId === folder.id)?.id;
}

/** The source row a folder sits under: Font Book for the OS's font folders, a service for its
 *  managed folder, or the folder's own row. */
export function sourceOfFolder(folder: Folder, services: readonly ServiceInfo[]): SourceKey | null {
  if (folder.kind === "system") return "fontbook";
  if (folder.kind === "service") return serviceOfFolder(folder, services) ?? null;
  return `folder:${folder.id}`;
}

/** The source a view shows (its row in SOURCES is the selected one), or null for the smart
 *  entries and tags. A folder inside a source belongs to that source. */
export function sourceOf(view: LibraryView, folders: readonly Folder[], services: readonly ServiceInfo[]): SourceKey | null {
  switch (view.kind) {
    case "installed":
      return "fontbook";
    case "service":
      return view.id;
    case "folder": {
      const folder = folders.find((f) => f.id === view.id);
      return folder ? sourceOfFolder(folder, services) : `folder:${view.id}`;
    }
    case "location": {
      const folder = folderHolding(view.path, folders);
      return folder ? sourceOfFolder(folder, services) : null;
    }
    default:
      return null;
  }
}

/** What a source's row opens: the whole source. */
export function sourceView(source: SourceKey): LibraryView {
  if (source === "fontbook") return { kind: "installed" };
  if (source === "google" || source === "adobe" || source === "purchases") return { kind: "service", id: source };
  return { kind: "folder", id: Number(source.slice("folder:".length)) };
}

/** The library folders a source's fonts are in: the OS's font folders for Font Book, a service's
 *  managed folder (none until it has one), or the folder itself. Adobe Fonts has none here. */
export function sourceFolders(source: SourceKey, folders: readonly Folder[], services: readonly ServiceInfo[]): Folder[] {
  if (source === "fontbook") return folders.filter((f) => f.kind === "system");
  if (source === "adobe") return [];
  if (source === "google" || source === "purchases") {
    const id = services.find((s) => s.id === source)?.folderId;
    return id == null ? [] : folders.filter((f) => f.id === id);
  }
  const id = Number(source.slice("folder:".length));
  return folders.filter((f) => f.id === id);
}

/**
 * A saved view in today's terms. A macOS font folder's view (from when those folders sat under
 * Font Book in the sidebar) becomes Font Book narrowed to that folder; a service folder's view
 * becomes that service's row. Everything else is unchanged, including views of folders that are
 * gone (`stillThere` turns those into All Fonts).
 */
export function migrateView(view: LibraryView, folders: readonly Folder[], services: readonly ServiceInfo[]): LibraryView {
  if (view.kind !== "folder") return view;
  const folder = folders.find((f) => f.id === view.id);
  if (!folder) return view;
  if (folder.kind === "system") return { kind: "location", path: folder.path };
  if (folder.kind === "service") {
    const service = serviceOfFolder(folder, services);
    return service ? { kind: "service", id: service } : view;
  }
  return view;
}

const isId = (v: unknown) => typeof v === "number" && Number.isInteger(v);

/** A view read back from storage, if it has the right shape. */
export function parseView(v: unknown): LibraryView | null {
  if (!v || typeof v !== "object") return null;
  const view = v as Record<string, unknown>;
  switch (view.kind) {
    case "all":
    case "yours":
    case "recent":
    case "active":
    case "untagged":
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

/** True if Settings › Sidebar hides the place this view belongs to: its smart entry, its source
 *  (Font Book, a service), or Tags. Your folders are always shown. */
export function hiddenBySidebar(view: LibraryView, sidebar: SidebarSections, folders: readonly Folder[], services: readonly ServiceInfo[]): boolean {
  switch (view.kind) {
    case "yours":
    case "recent":
    case "active":
    case "untagged":
      return !sidebar[view.kind];
    case "tag":
      return !sidebar.tags;
    case "installed":
    case "service":
    case "folder":
    case "location": {
      const source = sourceOf(view, folders, services);
      if (source === "fontbook") return !sidebar.fontBook;
      if (source === "google" || source === "adobe" || source === "purchases") return !sidebar[source];
      return false;
    }
    default:
      return false;
  }
}

export interface PlaceContext {
  folders: readonly Folder[];
  services: readonly ServiceInfo[];
  sidebar: SidebarSections;
  /** The whole library, so a saved subfolder can be checked for fonts. */
  families: readonly Family[];
}

/** True if a view can still be shown: its folder or subfolder (with fonts in it) still exists,
 *  and the sidebar shows its place. */
export function stillThere(view: LibraryView, { folders, services, sidebar, families }: PlaceContext): boolean {
  if (hiddenBySidebar(view, sidebar, folders, services)) return false;
  if (view.kind === "folder") return folders.some((f) => f.id === view.id);
  if (view.kind === "location") {
    const inside = `${view.path}/`;
    return !!folderHolding(view.path, folders) && families.some((family) => family.faces.some((face) => face.copies.some((c) => c.path.startsWith(inside))));
  }
  return true;
}

/** "Open where you left off": the saved view brought up to date, or All Fonts if it's gone. */
export function restoreView(saved: LibraryView, ctx: PlaceContext): LibraryView {
  const view = migrateView(saved, ctx.folders, ctx.services);
  return stillThere(view, ctx) ? view : { kind: "all" };
}

/** A view's name in words, as Back says it ("Back to Recently Added"). */
export function placeLabel(
  view: LibraryView,
  { folders, fontBook, tagName }: { folders: readonly Folder[]; fontBook: string; tagName: (id: number) => string | undefined },
): string {
  switch (view.kind) {
    case "all":
    case "yours":
    case "recent":
    case "active":
    case "untagged":
      return SMART_ENTRIES.find((e) => e.kind === view.kind)!.label;
    case "installed":
      return fontBook;
    case "service":
      return SERVICE_LABELS[view.id];
    case "folder":
      return folders.find((f) => f.id === view.id)?.label || "the folder";
    case "tag":
      return tagName(view.id) ?? "the tag";
    case "location":
      // One of the OS's font folders by its own name ("Computer Fonts"), else the folder's name.
      return folders.find((f) => f.path === view.path)?.label || view.path.split("/").pop() || "the folder";
  }
}
