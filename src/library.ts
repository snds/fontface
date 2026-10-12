import type { FontSummary } from "./api";

/**
 * One style of a family. Libraries often hold several copies of the same font (an .otf and a
 * .ttf, or the same file in two folders). Copies share a PostScript name and show as one row.
 * Fonts with no PostScript name are never merged: without it there's no reliable identity.
 */
export interface Face {
  key: string;
  /** The copy used for previews: an active copy if any, else the preferred file. */
  primary: FontSummary;
  copies: FontSummary[];
  installed: boolean;
  active: boolean;
}

export interface Family {
  name: string;
  faces: Face[];
  /** The face used for the family's preview line: closest to Regular. */
  representative: Face;
  /** Faces that can be switched (not installed in a macOS font folder). */
  switchable: Face[];
  /** How many switchable faces are on right now. */
  activeCount: number;
}

/** Where the fonts come from: everything, the OS-installed fonts ("Font Book"), one folder, or a
 *  font service's own page. Or how they're organized: a tag (with the tags nested under it), or
 *  a folder inside a library folder. */
export type LibraryView =
  | { kind: "all" }
  | { kind: "installed" }
  | { kind: "folder"; id: number }
  | { kind: "service"; id: "google" | "adobe" }
  | { kind: "tag"; id: number }
  | { kind: "location"; path: string };

/** A string that's the same for the same view (for comparing views and keying UI state). */
export function viewKey(v: LibraryView): string {
  switch (v.kind) {
    case "folder":
    case "service":
    case "tag":
      return `${v.kind}:${v.id}`;
    case "location":
      return `location:${v.path}`;
    default:
      return v.kind;
  }
}

/** What filtering needs to know about tags (see src/tags/model.ts). */
export interface FilterContext {
  /** Lowercased full names of a face's tags; search matches them too. */
  tagNames?: (face: Face) => string[];
  /** The face has this tag, or one nested under it. */
  inTag?: (face: Face, tagId: number) => boolean;
}

/** Narrows any view by on/off state. */
export type StatusFilter = "any" | "active" | "inactive";

/** What the OS calls its own installed-fonts library. */
export const INSTALLED_LABEL =
  typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent) ? "Windows Fonts" : "Font Book";

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

const regularness = (f: FontSummary) =>
  (f.italic ? 1000 : 0) + Math.abs(f.width - 5) * 100 + Math.abs(f.weight - 400);

const isCollection = (f: FontSummary) => f.format.endsWith("Collection");

/** Which copy to show or turn on: one already on, installed, a single-font file, CFF, newest. */
function preferred(a: FontSummary, b: FontSummary): number {
  return (
    Number(b.osActive) - Number(a.osActive) ||
    Number(b.installed) - Number(a.installed) ||
    Number(isCollection(a)) - Number(isCollection(b)) ||
    Number(b.format.startsWith("OpenType CFF")) - Number(a.format.startsWith("OpenType CFF")) ||
    b.mtime - a.mtime
  );
}

/**
 * Same PostScript name, same kind (variable or static) and same slant = the same font.
 * (Slant guards against unrelated files that reuse a name; weight is left out because true
 * duplicates sometimes disagree on it.)
 * Tags are stored under this key, so it must match `face_key` in src-tauri/src/tags/mod.rs.
 */
const faceKey = (f: FontSummary) =>
  f.postscriptName
    ? `ps:${f.postscriptName}|${f.variable ? "var" : "static"}|${f.italic ? "i" : "r"}`
    : `file:${f.path}#${f.faceIndex}`;

function groupFaces(fonts: FontSummary[]): Face[] {
  const map = new Map<string, FontSummary[]>();
  for (const f of fonts) {
    const key = faceKey(f);
    const list = map.get(key);
    if (list) list.push(f);
    else map.set(key, [f]);
  }
  return [...map.entries()].map(([key, copies]) => {
    copies.sort(preferred);
    return {
      key,
      primary: copies[0],
      copies,
      installed: copies.some((c) => c.installed),
      active: copies.some((c) => c.osActive),
    };
  });
}

const sortFaces = (faces: Face[]) =>
  faces.sort(
    (a, b) =>
      Number(a.primary.italic) - Number(b.primary.italic) ||
      a.primary.width - b.primary.width ||
      a.primary.weight - b.primary.weight ||
      Number(b.primary.variable) - Number(a.primary.variable),
  );

function makeFamily(name: string, faces: Face[]): Family {
  const switchable = faces.filter((face) => !face.installed);
  return {
    name,
    faces,
    representative: faces.reduce((best, face) => (regularness(face.primary) < regularness(best.primary) ? face : best)),
    switchable,
    activeCount: switchable.filter((face) => face.active).length,
  };
}

/**
 * Groups the whole library. Views filter the result, so every Face always holds all its copies.
 * Copies are matched across family names too ("Abaddon" vs "Abaddon™" in different downloads);
 * each face is listed under the family name of its preferred copy.
 */
export function groupFamilies(fonts: FontSummary[]): Family[] {
  const byFamily = new Map<string, Face[]>();
  for (const face of groupFaces(fonts)) {
    const list = byFamily.get(face.primary.family);
    if (list) list.push(face);
    else byFamily.set(face.primary.family, [face]);
  }
  return [...byFamily.entries()].map(([name, faces]) => makeFamily(name, sortFaces(faces))).sort((a, b) => collator.compare(a.name, b.name));
}

const matches = (f: FontSummary, q: string) =>
  f.family.toLowerCase().includes(q) ||
  f.subfamily.toLowerCase().includes(q) ||
  (f.fullName?.toLowerCase().includes(q) ?? false) ||
  (f.postscriptName?.toLowerCase().includes(q) ?? false);

/**
 * Filters at the face level, keeping each Face whole (all copies), so a switch always reflects
 * and acts on every copy in the library, not only the copies visible in this view.
 */
export function filterFamilies(
  families: Family[],
  view: LibraryView,
  status: StatusFilter,
  query: string,
  ctx: FilterContext = {},
): Family[] {
  const q = query.trim().toLowerCase();
  const inside = view.kind === "location" ? `${view.path}/` : "";
  const keep = (face: Face) => {
    if (view.kind === "installed" && !face.installed) return false;
    if (view.kind === "folder" && !face.copies.some((c) => c.folderId === view.id)) return false;
    if (view.kind === "location" && !face.copies.some((c) => c.path.startsWith(inside))) return false;
    if (view.kind === "tag" && !ctx.inTag?.(face, view.id)) return false;
    if (status === "active" && !face.active) return false;
    if (status === "inactive" && face.active) return false;
    return !q || face.copies.some((c) => matches(c, q)) || (ctx.tagNames?.(face).some((n) => n.includes(q)) ?? false);
  };
  if (view.kind === "all" && status === "any" && !q) return families;
  const out: Family[] = [];
  for (const family of families) {
    const faces = family.faces.filter(keep);
    if (faces.length) out.push(faces.length === family.faces.length ? family : makeFamily(family.name, faces));
  }
  return out;
}

/**
 * Font ids to send when switching faces.
 *
 * Turning off covers every copy of every face, so nothing is left on by accident.
 *
 * Turning on registers each requested face once, and every requested face ends up on (so a
 * family switch reads "on" after one click):
 * - Faces already on are left alone.
 * - The OS turns on whole files. Faces that exist only inside a collection (.ttc) pick the
 *   collection first: the one covering the most requested faces, then the one bringing in the
 *   fewest faces that are already on through other files. Its other faces count as covered.
 * - Everything else uses a single-font file.
 */
export function activationIds(faces: Face[], on: boolean): number[] {
  if (!on) return faces.flatMap((face) => face.copies.map((c) => c.id));

  const todo = faces.filter((f) => !f.active && !f.installed);
  const ids: number[] = [];
  const covered = new Set<Face>();
  const inFile = (list: Face[], path: string) => list.filter((f) => f.copies.some((c) => c.path === path));
  const alreadyOn = faces.filter((f) => f.active);

  for (const face of todo) {
    if (covered.has(face) || face.copies.some((c) => !isCollection(c))) continue;
    const best = [...face.copies].sort(
      (a, b) =>
        inFile(todo, b.path).length - inFile(todo, a.path).length ||
        inFile(alreadyOn, a.path).length - inFile(alreadyOn, b.path).length ||
        preferred(a, b),
    )[0];
    ids.push(best.id);
    for (const f of inFile(todo, best.path)) covered.add(f);
  }
  for (const face of todo) {
    if (covered.has(face)) continue;
    const single = face.copies.filter((c) => !isCollection(c)).sort(preferred)[0] ?? face.primary;
    ids.push(single.id);
    covered.add(face);
  }
  return ids;
}

export const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium",
  600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black",
};
