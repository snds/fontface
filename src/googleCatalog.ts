import type { GoogleFamily } from "./api.ts";
import { stateWords, summarize, type StateWording } from "./fontState.ts";
import { familyKey, type CatalogRef } from "./googlePreviews.ts";
import { activationIds, type Face } from "./library.ts";

// The Google Fonts source's own view (components/GoogleFontsPanel.tsx): the whole catalog, as
// the place to get, uninstall, update and turn on Google Fonts. How its loads take turns, which
// families the toolbar's filters keep, what you have of each family (downloaded here, or your
// own copy), and what each row offers. Pure (no React, no DOM), so `npm run test:ui` covers it.

// ------------------------------------------------------------------------------ loading

/**
 * Loads of the catalog (useGoogleView): `ask(refresh)` asks Rust for it, from the network when
 * `refresh` is set, else as saved (at once, while the saved copy is recent or a refresh holds the
 * network). Each load says whether it's still the newest one asked for (`newest`): only that one
 * should land. A load asked for while a refresh is under way (after a download, or each step of
 * Update all) waits for the refresh, then asks: asked at once, it would get the older saved copy
 * first and, being newer, drop the refresh's answer. What came of the refresh it waited for
 * (`waited`) goes with it, so the newest load can still say that a Refresh failed.
 */
export function catalogLoader<T>(ask: (refresh: boolean) => Promise<T>) {
  let seq = 0;
  let refreshing: Promise<T> | null = null;
  return (refresh = false): { result: Promise<T>; newest: () => boolean; waited: () => Waited<T> | null } => {
    const my = ++seq;
    let waited: Waited<T> | null = null;
    const before = refreshing;
    const result = (before
      ? before.then(
          (value) => void (waited = { value }),
          (error: unknown) => void (waited = { error }),
        )
      : Promise.resolve()
    ).then(() => ask(refresh));
    if (refresh) {
      refreshing = result;
      const done = () => {
        if (refreshing === result) refreshing = null;
      };
      result.then(done, done);
    }
    return { result, newest: () => my === seq, waited: () => waited };
  };
}

/** What came of a refresh a load waited for: its answer, or why it failed. */
export type Waited<T> = { value: T; error?: undefined } | { value?: undefined; error: unknown };

// ------------------------------------------------------------------------------ filters

/**
 * The toolbar's filter on the Google Fonts view, in place of the library's All / Active /
 * Inactive. "Inactive" would list some 1,800 families you've never had; what's worth narrowing
 * to here is what you manage: what you downloaded, what's on, and what has an update.
 */
export type CatalogShow = "all" | "downloaded" | "active" | "updates";

export const CATALOG_SHOWS: readonly { value: CatalogShow; label: string }[] = [
  { value: "all", label: "All" },
  { value: "downloaded", label: "Downloaded" },
  { value: "active", label: "Active" },
  { value: "updates", label: "Updates" },
];

/** The catalog's categories, as the slim bar under the toolbar offers them ("" is all). */
export const CATEGORIES: readonly { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "sans-serif", label: "Sans Serif" },
  { value: "serif", label: "Serif" },
  { value: "display", label: "Display" },
  { value: "handwriting", label: "Handwriting" },
  { value: "monospace", label: "Monospace" },
  { value: "icons", label: "Icons" },
];

export const categoryLabel = (c: string) => CATEGORIES.find((x) => x.value === c)?.label ?? c;

// ------------------------------------------------------------------- what you have

/** What you have of one catalog family, as library styles (each with all of its copies). */
export interface Holding {
  /** Styles in the family's downloaded folder (Fontface's Google Fonts folder). One can also
   *  have a copy of yours elsewhere, with the same PostScript name: `files` says which copies
   *  are the download. */
  downloaded: Face[];
  /** Styles elsewhere in your library with the family's name ("Your copy"). */
  yours: Face[];
  /** The files of `downloaded` that are in the family's downloaded folder: what Uninstall turns
   *  off and removes, and what the switch turns on. */
  files: ReadonlySet<string>;
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
  const out = new Map<string, Holding & { files: Set<string> }>();
  const holding = (id: string) => {
    let h = out.get(id);
    if (!h) out.set(id, (h = { downloaded: [], yours: [], files: new Set() }));
    return h;
  };
  for (const face of faces) {
    const dirs = byDir.size ? face.copies.map((c) => downloadedIn(parentOf(c.path))) : [];
    const dir = dirs.find((id) => id !== null);
    if (dir) {
      const h = holding(dir);
      h.downloaded.push(face);
      face.copies.forEach((c, i) => {
        if (dirs[i] === dir) h.files.add(c.path);
      });
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

/**
 * What the row's switch sends (library.activationIds). Off: every copy of its styles, since a
 * style is on while any copy is. On, for a download: Google's copy of each style, never a copy
 * of yours with the same PostScript name (as Get turns it on).
 */
export function switchIds(h: Holding | undefined, on: boolean): number[] {
  return activationIds(on ? turnOnFaces(h) : switchFaces(h), on);
}

/**
 * The styles turning a family on uses (its row switch, the font menu, the Font menu): for a
 * download, each style with only Google's copy, so a copy of yours with the same PostScript
 * name is never the one turned on; else the switch's styles as they are.
 */
export function turnOnFaces(h: Holding | undefined): Face[] {
  const faces = switchFaces(h);
  if (!h?.downloaded.length) return faces;
  return faces.map((face) => {
    const here = face.copies.filter((c) => h.files.has(c.path));
    return here.length ? { ...face, primary: here[0], copies: here } : face;
  });
}

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

/** The catalog's count (the footer rail's, footerCounts.ts): "1,876 families", or "12 of 1,876 families" while something narrows it. */
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

/**
 * What a family's row offers. A Google family is installed here when it's downloaded with
 * Fontface: only then does its row have the on/off switch, and only then can it be uninstalled.
 * A family that's only your own copy (in your folders, not downloaded from Google) has no switch
 * here; its row offers Google's version instead.
 */
export interface RowPlan {
  /** You have styles of it in the library: downloaded here, or your own copy. Its font page
   *  (double-click or Return) and font menu work on those. */
  have: boolean;
  /** Downloaded with Fontface (into its Google Fonts folder). Only these have the switch, and
   *  only these can be uninstalled. */
  downloaded: boolean;
  /**
   * The control at the row's end: the on/off switch for a downloaded family, on its downloaded
   * styles; else Get, or (while it downloads) its progress, or why it can't be downloaded. Null:
   * your own copy, whose Get is the hover button; or downloaded, but its styles aren't in the
   * library yet (a scan is on its way).
   */
  main: "switch" | "get" | "working" | "unavailable" | null;
  /**
   * The quiet icon button just before it, shown while the row is hovered, focused or selected:
   * Uninstall for a download, Get (Google's version) beside your own copy. None while a
   * download, update or uninstall runs.
   */
  hover: "uninstall" | "getCopy" | null;
  /** Before those: Update when there's a newer version. "working" stands for it while an update
   *  or an uninstall runs on a download. */
  extras: ("update" | "working")[];
}

/** `working`: a download, update or uninstall of this family is running. */
export function rowPlan(f: CatalogFamily, h: Holding | undefined, working: boolean): RowPlan {
  const downloaded = !!f.installed;
  const have = switchFaces(h).length > 0;
  // The switch works on the downloaded styles alone, never on your own copy.
  const ready = downloaded && !!h?.downloaded.length;
  const main = ready ? "switch" : downloaded ? null : working ? "working" : f.unavailable ? "unavailable" : have ? null : "get";
  const hover = working ? null : downloaded ? "uninstall" : have && !f.unavailable ? "getCopy" : null;
  const extras: RowPlan["extras"] = [];
  if (working) {
    if (downloaded) extras.push("working");
  } else if (hasUpdate(f)) extras.push("update");
  return { have, downloaded, main, hover, extras };
}

/**
 * A row's name for screen readers: short, so the arrow keys move quickly. "Inter, downloaded,
 * 1 of 2 on, update available", "Roboto, your copy", "Lora, not downloaded". Only a row with the
 * switch says whether the family is on. The rest of what the row shows is its description.
 */
export function rowLabel(f: CatalogFamily, plan: RowPlan, h: Holding | undefined, wording: StateWording = {}): string {
  const parts = [f.family];
  if (plan.downloaded) parts.push("downloaded");
  else if (plan.have) parts.push("your copy");
  else parts.push(f.unavailable ? "can't be downloaded here" : "not downloaded");
  if (plan.main === "switch") parts.push(stateWords(summarize(switchFaces(h)), wording));
  if (plan.extras.includes("update")) parts.push("update available");
  if (plan.main === "working" || plan.extras.includes("working")) parts.push("working");
  return parts.join(", ");
}

// ------------------------------------------------------------------------ uninstall

/**
 * What Uninstall's confirmation says: the downloaded files are turned off and removed; a copy of
 * your own isn't touched, whether it's a style of its own or a copy of a downloaded style (the
 * same PostScript name) outside the downloaded folder; and the family can be downloaded again.
 * (The message after it offers Undo.)
 */
export function uninstallWords(family: string, h: Holding | undefined): string[] {
  const files = h?.files.size ?? 0;
  const what = files ? `its ${files.toLocaleString("en-US")} downloaded font ${files === 1 ? "file" : "files"}` : "its downloaded files";
  const out = [`Fontface turns off ${what} and removes ${files === 1 ? "it" : "them"} from its Google Fonts folder.`];
  const yoursToo = !!h && (h.yours.length > 0 || h.downloaded.some((face) => face.copies.some((c) => !h.files.has(c.path))));
  if (yoursToo) out.push(`Your own copy of ${family} stays in your library, as it is.`);
  out.push(`You can get ${family} from Google again at any time.`);
  return out;
}
