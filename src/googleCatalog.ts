import type { GoogleFamily } from "./api.ts";
import { stateWords, summarize, type StateWording } from "./fontState.ts";
import { familyKey, type CatalogRef } from "./googlePreviews.ts";
import type { Face } from "./library.ts";

// The Google Fonts source's own view (components/GoogleFontsPanel.tsx): the whole catalog, as
// the place to get, remove, update and turn on Google Fonts. Which families the toolbar's
// filters keep, what you have of each family (downloaded here, or your own copy), and what
// each row offers. Pure (no React, no DOM), so `npm run test:ui` covers it.

// ------------------------------------------------------------------------------ filters

/**
 * The toolbar's filter on the Google Fonts view, in place of the library's All / Active /
 * Inactive. "Inactive" would list some 1,800 families you've never had; what's worth narrowing
 * to here is what you manage: what you downloaded, what's on, and what has an update.
 */
export type CatalogShow = "all" | "downloaded" | "active" | "updates";

export const CATALOG_SHOWS: readonly { value: CatalogShow; label: string; tip: string }[] = [
  { value: "all", label: "All", tip: "Shows every Google Fonts family" },
  { value: "downloaded", label: "Downloaded", tip: "Shows the families you downloaded with Fontface" },
  { value: "active", label: "Active", tip: "Shows families that are on, downloaded here or your own copy" },
  { value: "updates", label: "Updates", tip: "Shows downloaded families with a newer version" },
];

/** The catalog's categories, as the slim bar under the toolbar offers them ("" is all). */
export const CATEGORIES: readonly { value: string; label: string; tip: string }[] = [
  { value: "", label: "All", tip: "Shows families of every kind" },
  { value: "sans-serif", label: "Sans Serif", tip: "Shows only sans serif families" },
  { value: "serif", label: "Serif", tip: "Shows only serif families" },
  { value: "display", label: "Display", tip: "Shows only display families, for headings and big text" },
  { value: "handwriting", label: "Handwriting", tip: "Shows only handwriting and script families" },
  { value: "monospace", label: "Monospace", tip: "Shows only monospaced families, for code" },
  { value: "icons", label: "Icons", tip: "Shows only icon fonts" },
];

export const categoryLabel = (c: string) => CATEGORIES.find((x) => x.value === c)?.label ?? c;

// ------------------------------------------------------------------- what you have

/** What you have of one catalog family, as library styles (each with all of its copies). */
export interface Holding {
  /** Styles in the family's downloaded folder (Fontface's Google Fonts folder). */
  downloaded: Face[];
  /** Styles elsewhere in your library with the family's name ("Your copy"). */
  yours: Face[];
}

const trimDir = (dir: string) => dir.replace(/[\\/]+$/, "");
/** The folder `path` is in ("" for none). */
const parentOf = (path: string) => path.slice(0, Math.max(0, path.search(/[\\/][^\\/]*$/)));

/**
 * What you have of each catalog family, by catalog id: styles with a copy in its downloaded
 * folder, and styles elsewhere in your library whose family name matches it (ignoring case,
 * spaces and punctuation, as the previews' "Your copy" does). A style in a downloaded folder
 * is that family's, whatever its name. Families you have nothing of aren't in the map. Folders
 * and names are looked up once each, so a library of tens of thousands of styles stays quick.
 */
export function holdingsOf(families: readonly CatalogRef[], faces: readonly Face[]): Map<string, Holding> {
  const byDir = new Map<string, string>();
  const byKey = new Map<string, string>();
  for (const fam of families) {
    if (fam.installed) byDir.set(trimDir(fam.installed.dir), fam.id);
    const key = familyKey(fam.family);
    if (key && !byKey.has(key)) byKey.set(key, fam.id);
  }
  /** Folder → the downloaded family it's in (at any depth), or null. */
  const dirFamily = new Map<string, string | null>();
  const downloadedIn = (dir: string): string | null => {
    if (!dir) return null;
    let hit = dirFamily.get(dir);
    if (hit === undefined) {
      hit = byDir.get(dir) ?? downloadedIn(parentOf(dir));
      dirFamily.set(dir, hit);
    }
    return hit;
  };
  /** Family name → catalog id, or null. */
  const nameFamily = new Map<string, string | null>();
  const named = (name: string): string | null => {
    let id = nameFamily.get(name);
    if (id === undefined) {
      id = byKey.get(familyKey(name)) ?? null;
      nameFamily.set(name, id);
    }
    return id;
  };
  const out = new Map<string, Holding>();
  const holding = (id: string) => {
    let h = out.get(id);
    if (!h) out.set(id, (h = { downloaded: [], yours: [] }));
    return h;
  };
  for (const face of faces) {
    const dir = byDir.size ? face.copies.map((c) => downloadedIn(parentOf(c.path))).find((id) => id !== null) : undefined;
    if (dir) {
      holding(dir).downloaded.push(face);
      continue;
    }
    const id = face.copies.map((c) => named(c.family)).find((x) => x !== null);
    if (id) holding(id).yours.push(face);
  }
  return out;
}

/** The styles a family's switch turns on and off, and its font page shows: the downloaded ones
 *  if it's downloaded, else your own copy's. */
export const switchFaces = (h: Holding | undefined): Face[] => (!h ? [] : h.downloaded.length ? h.downloaded : h.yours);

/** Some style of the family is on now (for the Active filter). Fonts the OS always keeps on
 *  count, as they do for the library's Active filter. */
export const isActive = (h: Holding | undefined) => switchFaces(h).some((face) => face.active);

/** The family has a newer version to download: it's downloaded, and Fontface can get it. */
export const hasUpdate = (f: Pick<GoogleFamily, "updateAvailable" | "unavailable">) => f.updateAvailable && !f.unavailable;

/** The style a family's font page opens on: the most regular one (upright, normal width,
 *  nearest Regular, a plain style before a variant), as the library's family rows do. */
export function openFace(faces: readonly Face[]): Face | undefined {
  const irregular = ({ traits: t }: Face) => (t.italic ? 1000 : 0) + Math.abs(t.width - 5) * 100 + Math.abs(t.weight - 400) + (t.variant ? 50 : 0);
  let best: Face | undefined;
  for (const face of faces) if (!best || irregular(face) < irregular(best)) best = face;
  return best;
}

// ------------------------------------------------------------------------- the list

export type CatalogFamily = Pick<GoogleFamily, "id" | "family" | "category" | "variable" | "installed" | "updateAvailable" | "unavailable">;

export interface CatalogFilters {
  /** The toolbar's search text: part of the family's name. */
  query?: string;
  /** A category, or "" for every one. */
  category?: string;
  show?: CatalogShow;
  /** The toolbar's Variable: only families with a variable version. */
  variableOnly?: boolean;
}

/** True if `name` holds the search text: as typed (ignoring case), or with spaces and
 *  punctuation left out on both sides ("ibmplex" finds IBM Plex Sans). */
export function nameMatches(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (name.toLowerCase().includes(q)) return true;
  const key = familyKey(q);
  return key !== "" && familyKey(name).includes(key);
}

/** The families the toolbar and the category chips keep, in the catalog's order. */
export function filterCatalog<F extends CatalogFamily>(
  families: readonly F[],
  { query = "", category = "", show = "all", variableOnly = false }: CatalogFilters,
  holdings: ReadonlyMap<string, Holding>,
): F[] {
  return families.filter((f) => {
    if (category && f.category !== category) return false;
    if (variableOnly && !f.variable) return false;
    if (show === "downloaded" && !f.installed) return false;
    if (show === "active" && !isActive(holdings.get(f.id))) return false;
    if (show === "updates" && !hasUpdate(f)) return false;
    return nameMatches(f.family, query);
  });
}

/** How many families each of the toolbar's filters lists (before search and categories). */
export type CatalogCounts = Record<CatalogShow, number>;

export function catalogCounts(families: readonly CatalogFamily[], holdings: ReadonlyMap<string, Holding>): CatalogCounts {
  const counts: CatalogCounts = { all: families.length, downloaded: 0, active: 0, updates: 0 };
  for (const f of families) {
    if (f.installed) counts.downloaded++;
    if (isActive(holdings.get(f.id))) counts.active++;
    if (hasUpdate(f)) counts.updates++;
  }
  return counts;
}

/** The toolbar's count: "1,876 families", or "12 of 1,876 families" while something narrows it. */
export function countText(shown: number, total: number): string {
  const families = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "family" : "families"}`;
  return shown === total ? families(total) : `${shown.toLocaleString("en-US")} of ${families(total)}`;
}

/** What an empty list says: which families were asked for, e.g. "No downloaded variable families
 *  match “inter”." */
export function noMatchText({ query = "", category = "", show = "all", variableOnly = false }: CatalogFilters): string {
  const kinds = [
    show === "downloaded" && "downloaded",
    show === "active" && "active",
    variableOnly && "variable",
    category && categoryLabel(category).toLowerCase(),
    "families",
  ]
    .filter(Boolean)
    .join(" ");
  const what = show === "updates" ? `No ${kinds} have updates` : `No ${kinds}`;
  return query.trim() ? `${what} match “${query.trim()}”.` : show === "updates" ? `${what}.` : `${what} here.`;
}

// ------------------------------------------------------------------------- one row

/** What a family's row offers. */
export interface RowPlan {
  /** You have styles of it in the library: downloaded here, or your own copy. Its switch, font
   *  page (double-click or Return) and font menu work on those. */
  have: boolean;
  /** Downloaded with Fontface (into its Google Fonts folder). Only these can be removed. */
  downloaded: boolean;
  /**
   * The control at the row's end: the on/off switch for a family you have; else Get, or (while
   * it downloads) its progress, or why it can't be downloaded. Null: downloaded, but its styles
   * aren't in the library yet (a scan is on its way).
   */
  main: "switch" | "get" | "working" | "unavailable" | null;
  /** The quieter buttons before it: Update when there's a newer version, Remove for a download,
   *  Get (Google's copy) beside your own copy. "working" stands for them while a download,
   *  update or removal runs. */
  extras: ("update" | "remove" | "getCopy" | "working")[];
}

/** `working`: a download, update or removal of this family is running. */
export function rowPlan(f: CatalogFamily, h: Holding | undefined, working: boolean): RowPlan {
  const downloaded = !!f.installed;
  const have = switchFaces(h).length > 0;
  const main = have ? "switch" : working ? "working" : downloaded ? null : f.unavailable ? "unavailable" : "get";
  const extras: RowPlan["extras"] = [];
  if (working) {
    if (have || downloaded) extras.push("working");
  } else {
    if (hasUpdate(f)) extras.push("update");
    if (downloaded) extras.push("remove");
    else if (have && !f.unavailable) extras.push("getCopy");
  }
  return { have, downloaded, main, extras };
}

/**
 * A row's name for screen readers: short, so the arrow keys move quickly. "Inter, downloaded,
 * on, update available", "Roboto, your copy, 3 of 12 on", "Lora, not downloaded". The rest of
 * what the row shows is its description.
 */
export function rowLabel(f: CatalogFamily, plan: RowPlan, h: Holding | undefined, wording: StateWording = {}): string {
  const parts = [f.family];
  if (plan.downloaded) parts.push("downloaded");
  else if (plan.have) parts.push("your copy");
  else parts.push(f.unavailable ? "can't be downloaded here" : "not downloaded");
  if (plan.have) parts.push(stateWords(summarize(switchFaces(h)), wording));
  if (plan.extras.includes("update")) parts.push("update available");
  if (plan.main === "working" || plan.extras.includes("working")) parts.push("working");
  return parts.join(", ");
}

// --------------------------------------------------------------------------- remove

/**
 * What Remove's confirmation says: the downloaded files are turned off and deleted, and a copy
 * of your own isn't touched. (The message after it offers Undo.)
 */
export function removalWords(family: string, h: Holding | undefined): string[] {
  const files = new Set((h?.downloaded ?? []).flatMap((face) => face.copies.map((c) => c.path))).size;
  const what = files ? `its ${files.toLocaleString("en-US")} downloaded font ${files === 1 ? "file" : "files"}` : "its downloaded files";
  const out = [`Fontface turns off ${what} and deletes them from its Google Fonts folder.`];
  if (h?.yours.length) out.push(`Your own copy of ${family} stays in your library, as it is.`);
  return out;
}
