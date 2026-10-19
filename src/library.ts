import type { FontSummary, SortOrder } from "./api";
import {
  activeRank,
  addedAt,
  compareVersions,
  designerOf,
  faceAddedAt,
  fileNameOf,
  fileSizeOf,
  formatsOf,
  foundryOf,
  hasVersionNumber,
  shortVersion,
  weightSpan,
} from "./familyFacts.ts";
import {
  autoGroups,
  compareNames,
  familyTraits,
  labelFor,
  NameIndex,
  namedCopy,
  namesAgree,
  planByName,
  placeFace,
  type AutoGroup,
  type AutoJoin,
  type GroupedBy,
  type GroupingOptions,
  type GroupPlan,
  type Traits,
} from "./familyGroups.ts";

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
  /** The copy whose family name it's grouped by, when its copies carry different ones and it
   *  isn't the primary (familyGroups.namedCopy, then planByName's step 3): "House-A-Rama",
   *  style Medium, for the House-A-Rama-Kingpin a per-style folder also holds. */
  named?: FontSummary;
  /** Its copies carry different family or style names (familyGroups.labelFor reads them all). */
  varied: boolean;
  /** The family name it was placed by (familyGroups.Placement.name): usually `primary.family`;
   *  another copy's when that one is grouped by, or your rule is for it. The Info tab's and the
   *  Family groups page's "from" text, and the name merging writes a rule for. */
  name: string;
  installed: boolean;
  active: boolean;
  /** The family it's listed under: its own name (`primary.family`), or the one grouping by
   *  name, an automatic group, your rule for its name or your choice for it gave it
   *  (familyGroups.ts). */
  family: string;
  /** Its style there: its own (`primary.subfamily`), or worked out from its name when it was
   *  grouped ("Black Italic" for AmintaBlackItalic in Aminta). */
  style: string;
  /** How it got its family. */
  groupedBy: GroupedBy;
  /** Your rule or choice keeps it under its own name (rather than moving it into a family). */
  kept: boolean;
  /** The name key of your rule that placed it (`groupedBy` "rule"): its own family name's, or
   *  one of its copies'. */
  ruleKey?: string;
  /** Set when an automatic group brought its family into this one (`groupedBy` "name"): the
   *  family it was in, and why (familyGroups.autoGroups). */
  auto?: AutoJoin;
  /** Weight, width and slope for sorting, from its style's words where its own numbers disagree. */
  traits: Traits;
}

export interface Family {
  /**
   * Stable for the same family from one list load to the next. Rows, the expanded set and
   * lookups use it, never the name, so that grouping families by name (more than one family
   * may then show the same name) doesn't break them. Today it's the grouping key: "n:" plus the
   * family name. Font pages are found by face key instead (see nav.ts).
   */
  id: string;
  name: string;
  faces: Face[];
  /** The face used for the family's preview line: one that can draw its name (so Lucida Math
   *  Std shows its Italic, not its Symbol face), then the one closest to Regular. */
  representative: Face;
  /** Faces that can be switched (not installed in a macOS font folder). */
  switchable: Face[];
  /** How many switchable faces are on right now. */
  activeCount: number;
  /** Set when "Group styles into families" is off and this item is one style on its own
   *  (`ungroup`): the name of the family it belongs to. `name` is then "Family Style". */
  ungroupedFrom?: string;
}

/**
 * A place in the sidebar. The smart entries narrow the whole library: everything ("all"), fonts
 * with a copy of your own ("yours"), added in the last 30 days ("recent"), on now ("active") and
 * with none of your own tags ("untagged"). The sources say where fonts come from: the OS's own
 * font folders ("installed", Font Book), a folder you added ("folder"), or a service ("service":
 * Google Fonts and Purchases list your library's fonts from them; Adobe Fonts has its own page).
 * A "location" is a folder inside a source (the toolbar's subfolder picker). A "tag" lists the
 * fonts with that tag, or one nested under it.
 *
 * Older saved views ("folder" for a macOS or service folder) are brought up to date by
 * `migrateView` (places.ts).
 */
export type LibraryView =
  | { kind: "all" }
  | { kind: "yours" }
  | { kind: "recent" }
  | { kind: "active" }
  | { kind: "untagged" }
  | { kind: "installed" }
  | { kind: "folder"; id: number }
  | { kind: "service"; id: "google" | "adobe" | "purchases" }
  | { kind: "tag"; id: number }
  | { kind: "location"; path: string };

/** The smart entries at the top of the sidebar. */
export type SmartKind = "all" | "yours" | "recent" | "active" | "untagged";

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

/** What filtering needs to know beyond the fonts: tags, the time, and where services keep fonts. */
export interface FilterContext {
  /** Lowercased full names of a face's tags; search matches them too. */
  tagNames?: (face: Face) => string[];
  /** The face has this tag, or one nested under it. */
  inTag?: (face: Face, tagId: number) => boolean;
  /** The face has one of your own tags (built-in ones don't count): Not Tagged leaves it out. */
  hasOwnTag?: (face: Face) => boolean;
  /** Recently Added lists fonts added at or after this time, Unix seconds (`recentSince`). */
  recentSince?: number;
  /** The library folder a service keeps its fonts in (Google Fonts, Purchases), if it has one yet. */
  serviceFolder?: (id: "google" | "purchases") => number | undefined;
}

/** How far back Recently Added goes. */
export const RECENT_DAYS = 30;

/** The start of Recently Added for a moment (`now` in Unix seconds). */
export const recentSince = (now: number) => now - RECENT_DAYS * 86400;

/** Narrows any view by on/off state. */
export type StatusFilter = "any" | "active" | "inactive";

/** What narrows a view, on top of where its fonts come from. A field left out doesn't filter. */
export interface Filters {
  /** On/off state. */
  status?: StatusFilter;
  /** Search text: family, style, full or PostScript name, or a tag name. */
  query?: string;
  /** Only variable fonts: families with a variable version, showing just their variable styles. */
  variableOnly?: boolean;
  /** All Fonts leaves out fonts that are only in the OS's own font folders (a setting); a font
   *  with a copy in one of the user's folders or services stays. Other views, Font Book among
   *  them, still list them. */
  hideInstalled?: boolean;
}

/** Every copy is in an OS font folder: what All Fonts leaves out when it hides installed fonts. */
export const onlyInOsFolders = (face: Face) => face.copies.every((c) => c.installed);

/** Your Fonts: at least one copy outside the OS's own font folders (your folders, Google Fonts,
 *  Purchases). */
export const isYours = (face: Face) => !onlyInOsFolders(face);

/** Recently Added: came into the library at or after `since` (its earliest copy's date). Fonts
 *  with no date yet aren't listed. */
export const isRecent = (face: Face, since: number) => {
  const at = faceAddedAt(face);
  return at !== undefined && at >= since;
};

/** Active: on right now, leaving out the fonts the OS always keeps on. */
export const isOnNow = (face: Face) => face.active && !face.installed;

/** What the OS calls its own installed-fonts library. */
export const INSTALLED_LABEL =
  typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent) ? "Windows Fonts" : "Font Book";

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** How far a style is from the family's Regular: slope, then width, then weight; a variant (Alt,
 *  Caps, LF) a little further than the plain style of its weight. */
const regularness = ({ traits: t }: Face) => (t.italic ? 1000 : 0) + Math.abs(t.width - 5) * 100 + Math.abs(t.weight - 400) + (t.variant ? 50 : 0);

const isCollection = (f: FontSummary) => f.format.endsWith("Collection");

/**
 * Which copy to show or turn on: one already on, installed, a single-font file, CFF, newest, one
 * whose names agree with its PostScript name, one that names its own family (name ID 16), then
 * by its names A to Z, and only for copies named alike by path. Never by the order the list
 * sends rows in: a copy's id changes when its folder is removed and added again. Which family a
 * face is in, and its style there, don't depend on this choice (familyGroups.namedCopy and
 * labelFor read every copy's names), only what "keep it under its own name" keeps.
 */
function preferred(a: FontSummary, b: FontSummary): number {
  const alike = a.family === b.family && a.subfamily === b.subfamily;
  return (
    Number(b.osActive) - Number(a.osActive) ||
    Number(b.installed) - Number(a.installed) ||
    Number(isCollection(a)) - Number(isCollection(b)) ||
    Number(b.format.startsWith("OpenType CFF")) - Number(a.format.startsWith("OpenType CFF")) ||
    b.mtime - a.mtime ||
    (alike ? 0 : namesAgree(b) - namesAgree(a)) ||
    Number(b.hasTypoFamily === true) - Number(a.hasTypoFamily === true) ||
    (alike ? 0 : compareNames(a.family, b.family) || compareNames(a.subfamily, b.subfamily)) ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
    a.faceIndex - b.faceIndex
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

/** Every face's traits until `groupLibrary` works them out (it always does). */
const NO_TRAITS: Traits = Object.freeze({ weight: 400, width: 5, italic: false, variant: false });

/** Variable or static, upright or italic: the face key's other parts. */
const kindOf = (f: FontSummary) => (f.variable ? 2 : 0) + (f.italic ? 1 : 0);

function groupFaces(fonts: FontSummary[], index: NameIndex): Face[] {
  // By PostScript name (a string the list already has), then by kind and slant (`faceKey`),
  // without making and hashing a key for every row.
  const byName = new Map<string, FontSummary[]>();
  const lists: FontSummary[][] = [];
  for (const f of fonts) {
    if (!f.postscriptName) {
      lists.push([f]);
      continue;
    }
    const list = byName.get(f.postscriptName);
    if (list) list.push(f);
    else {
      const fresh = [f];
      byName.set(f.postscriptName, fresh);
      lists.push(fresh);
    }
  }
  // Seldom, one PostScript name is both kinds or slants: those are faces of their own.
  for (let i = 0, n = lists.length; i < n; i++) {
    const list = lists[i];
    if (list.length < 2) continue;
    const first = kindOf(list[0]);
    if (list.every((f) => kindOf(f) === first)) continue;
    const parts = new Map<number, FontSummary[]>();
    for (const f of list) {
      const part = parts.get(kindOf(f));
      if (part) part.push(f);
      else parts.set(kindOf(f), [f]);
    }
    const [head, ...rest] = parts.values();
    lists[i] = head;
    lists.push(...rest);
  }
  const faces: Face[] = [];
  for (const copies of lists) {
    const key = faceKey(copies[0]);
    const primary = copies.length > 1 ? copies.sort(preferred)[0] : copies[0];
    let installed = primary.installed;
    let active = primary.osActive;
    let varied = false;
    for (let i = 1; i < copies.length; i++) {
      const c = copies[i];
      installed ||= c.installed;
      active ||= c.osActive;
      varied ||= c.family !== primary.family || c.subfamily !== primary.subfamily;
    }
    // Every field there from the start (one shape for every face).
    const face: Face = {
      key,
      primary,
      copies,
      named: varied ? namedCopy(copies) : undefined,
      varied,
      installed,
      active,
      family: primary.family,
      style: primary.subfamily,
      name: primary.family,
      groupedBy: "own",
      kept: false,
      ruleKey: undefined,
      auto: undefined,
      traits: NO_TRAITS,
    };
    faces.push(face);
    index.add(face);
  }
  return faces;
}

/** A family's styles: upright before italic, narrow to wide, light to heavy (by what the style's
 *  name says where the font's own numbers are wrong), variable first, a plain style before its
 *  variants (Alt, Caps), then by style name. */
const sortFaces = (faces: Face[]) =>
  faces.sort(
    (a, b) =>
      Number(a.traits.italic) - Number(b.traits.italic) ||
      a.traits.width - b.traits.width ||
      a.traits.weight - b.traits.weight ||
      Number(b.primary.variable) - Number(a.primary.variable) ||
      Number(a.traits.variant) - Number(b.traits.variant) ||
      compareNames(a.style, b.style) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

/** The face's preview reads as its name: drawn as is, tidied or in one case. Unknown counts too
 *  (no profile yet). A face that needs a sample of characters (symbols, an expert set) doesn't. */
const drawsItsName = (f: FontSummary) => !f.preview || f.preview.kind === "name" || f.preview.kind === "trim" || f.preview.kind === "case";

/** Is `a` a better family representative than `b`? One that can draw its name, then the most regular. */
const betterRepresentative = (a: Face, b: Face) =>
  drawsItsName(a.primary) !== drawsItsName(b.primary) ? drawsItsName(a.primary) : regularness(a) < regularness(b);

/** The id of the family grouped under this name (see Family.id). */
export const familyId = (name: string) => `n:${name}`;

function makeFamily(id: string, name: string, faces: Face[]): Family {
  const switchable: Face[] = [];
  let representative = faces[0];
  let activeCount = 0;
  for (const face of faces) {
    if (face !== representative && betterRepresentative(face, representative)) representative = face;
    if (face.installed) continue;
    switchable.push(face);
    if (face.active) activeCount++;
  }
  return { id, name, faces, representative, switchable, activeCount };
}

/** Grouping by name on, and none of your choices: what tests and one-off groupings use. */
export const BY_NAME: GroupingOptions = { byName: true };

/** The library grouped into families, what grouping by name made of its names, and the
 *  automatic groups it joined (the Family groups page lists them). */
export interface Library {
  families: Family[];
  plan: GroupPlan;
  /** Each family as grouping by name left it, under the family it joined. */
  auto: AutoGroup<Family>[];
}

/**
 * Groups the whole library. Views filter the result, so every Face always holds all its copies.
 * Copies are matched across family names too ("Abaddon" vs "Abaddon™" in different downloads).
 * Each face goes under a family by familyGroups.ts's rules: your choice for it, your rule for its
 * name, grouping by name (while that's on), else its own family name (when its copies carry
 * different names of one family, the better one, or the one more of the library's fonts carry
 * when that keeps a family whole: familyGroups.namedCopy and planByName). Then, while grouping
 * by name is on, whole families join others automatically (familyGroups.autoGroups: width and
 * size words, and names grouping by name held back). Folders play no part. Families are sorted
 * A to Z, their styles light to heavy (sortFaces).
 */
export function groupLibrary(fonts: FontSummary[], grouping: GroupingOptions = BY_NAME): Library {
  const index = new NameIndex(grouping.choices);
  const faces = groupFaces(fonts, index);
  const plan = planByName(faces, grouping.rules, grouping.choices, index, grouping.byName);
  const byFamily = new Map<string, Face[]>();
  // Faces come mostly A to Z: a face's family is mostly the one before's, so no lookup for those.
  let lastFamily: string | undefined;
  let lastList: Face[] = [];
  for (const face of faces) {
    // Its family, style, how it got them, and the name it went by, written into the face.
    placeFace(face, plan, grouping, face);
    if (face.family !== lastFamily) {
      lastFamily = face.family;
      const list = byFamily.get(lastFamily);
      if (list) lastList = list;
      else byFamily.set(lastFamily, (lastList = []));
    }
    lastList.push(face);
  }
  const families: Family[] = [];
  for (const [name, list] of byFamily) families.push(styledFamily(name, list));
  families.sort(nameOrder);
  // Sorted first: the same library always makes the same automatic groups.
  const auto = autoGroups(families, plan, grouping);
  return { families: auto.length ? joinAuto(families, auto) : families, plan, auto };
}

const nameOrder = (a: Family, b: Family) => compareNames(a.name, b.name);

/** A family of these faces, their traits worked out together and their styles sorted. */
function styledFamily(name: string, faces: Face[]): Family {
  // A family whose own weight numbers tell its styles apart keeps them (BB Strata Pro's 250
  // Semi Regular); one whose numbers are shown wrong (all 400) goes by its styles' names.
  const traits = familyTraits(faces);
  for (let i = 0; i < faces.length; i++) faces[i].traits = traits[i];
  return makeFamily(familyId(name), name, faces.length > 1 ? sortFaces(faces) : faces);
}

/**
 * The families with the automatic groups joined (`families` A to Z, and still so after). A
 * joining face is listed in the group's family, with its style there and where it came from
 * (`Face.auto`). The groups keep the families as they were, for the Family groups page.
 */
function joinAuto(families: readonly Family[], groups: readonly AutoGroup<Family>[]): Family[] {
  const gone = new Set<Family>();
  const made: Family[] = [];
  for (const g of groups) {
    const parts = g.existing ? [g.existing, ...g.sources.map((s) => s.family)] : g.sources.map((s) => s.family);
    // A family is in one group at most (autoGroups); never placed twice anyway.
    if (parts.some((f) => gone.has(f))) continue;
    const faces: Face[] = g.existing ? [...g.existing.faces] : [];
    for (const { family, reason, word } of g.sources) {
      const auto: AutoJoin = { from: family.name, reason, word };
      for (const face of family.faces) {
        face.family = g.into;
        face.style = labelFor(face, g.into);
        face.groupedBy = "name";
        face.auto = auto;
        faces.push(face);
      }
    }
    for (const f of parts) gone.add(f);
    made.push(styledFamily(g.into, faces));
  }
  // The families left are still A to Z: the new ones go in among them.
  made.sort(nameOrder);
  const out: Family[] = [];
  let j = 0;
  for (const f of families) {
    if (gone.has(f)) continue;
    while (j < made.length && nameOrder(made[j], f) < 0) out.push(made[j++]);
    out.push(f);
  }
  while (j < made.length) out.push(made[j++]);
  return out;
}

let warmed = false;

/**
 * Groups a made-up library once, so that the first real grouping (about 12,000 fonts, at launch)
 * runs code that's already compiled and has seen every kind of name: families whose names carry
 * styles, PostScript names, foundries, spellings, "SC", numbered and width names, and fonts with
 * copies in a family folder and a per-style one. App calls it while the first list is still on
 * its way from the library (about 6 ms in JavaScriptCore, 7 in Node). Nothing it makes is kept,
 * beyond about two thousand entries in the name caches. On a copy of Sean's library the first
 * grouping then takes about 20 ms in JavaScriptCore instead of 24, and 28 in Node instead of 32.
 */
export function warmUpGrouping(): void {
  if (warmed) return;
  warmed = true;
  const fonts: FontSummary[] = [];
  const add = (family: string, subfamily: string, postscriptName: string | null, more: Partial<FontSummary> = {}) =>
    fonts.push({
      id: -1 - fonts.length,
      folderId: 0,
      path: `/warm-up/${fonts.length % 7}/${fonts.length}.otf`,
      faceIndex: 0,
      family,
      subfamily,
      fullName: null,
      postscriptName,
      weight: 400,
      width: 5,
      italic: false,
      monospace: false,
      variable: false,
      format: fonts.length % 5 ? "OpenType CFF" : "TrueType",
      activated: false,
      installed: false,
      mtime: fonts.length % 3,
      fileSize: 0,
      osActive: false,
      glyphCount: 200,
      manufacturer: ["Warm Type Foundry", "The Warm Type Corporation", undefined, "Cold Fonts Inc."][fonts.length % 4],
      designer: fonts.length % 6 ? undefined : "Warm Designer",
      preview: null,
      ...more,
    });
  const weights: [string, number][] = [
    ["Thin", 100], ["ExtraLight", 200], ["Light", 300], ["Book", 380], ["Regular", 400], ["Medium", 500],
    ["SemiBold", 600], ["Demi", 600], ["Bold", 700], ["ExtraBold", 800], ["Heavy", 800], ["Black", 900],
  ];
  const ends = ["", " Italic", "Italic", "-Oblique", " OSF", "LF", " SC", " Expert", "Alt", " Swash", " It", "Obl"];
  const sep = [" ", "", "-", "_"];
  for (let i = 0; i < 24; i++) {
    const base = `Warm${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(97 + ((i * 7) % 26))}${["", " Pro", " Sans", "Serif", " Text"][i % 5]}${i}`;
    const ps = base.replace(/ /g, "");
    // A family with its own name (some), and names that carry styles in every way.
    if (i % 3) add(base, "Regular", `${ps}-Regular`);
    if (i % 4) add(base, "Bold Italic", `${ps}-BoldItalic`, { weight: 700, italic: true });
    for (let j = 0; j < 9; j++) {
      const [w, n] = weights[(i + j * 5) % weights.length];
      const end = ends[(i * 3 + j) % ends.length];
      const style = j % 3 ? "Regular" : ["Italic", "Medium", "Roman"][i % 3];
      add(`${base}${sep[(i + j) % 4]}${w}${end}`, style, `${ps}-${w}${end.replace(/[ -]/g, "")}`, { weight: (i + j) % 4 ? n : 400, italic: /It|Obl/.test(end) });
    }
    // Spellings, numbers, widths and sizes, names nothing else shares.
    add(`${base.slice(0, 5)} ${base.slice(5)}`, "Medium", `${ps}-Medium`, { weight: 500 });
    add(`${base} ${45 + (i % 4) * 10} Light`, "Regular", `${ps}-${45 + (i % 4) * 10}Light`, { weight: 300 });
    add(`${base} ${["Condensed", "Narrow", "Display", "Caption"][i % 4]}`, "Bold", `${ps}${["Cond", "Nar", "Disp", "Cap"][i % 4]}-Bold`, { weight: 700 });
    add(`Warm${i}Solo${["Ink", "Stamp", "Moonlight"][i % 3]}`, "Regular", `Warm${i}Solo`);
    add(`${base} Display`, "Regular", null);
    // Copies in a family folder and in a per-style one.
    for (const cut of ["Kingpin", "Tenpin"]) {
      add(`${base}-${cut}`, "Regular", `${ps}-${cut}`);
      add(base, i % 2 ? "Medium" : cut, `${ps}-${cut}`);
    }
    add(base, "Light", `${ps}-Light`, { weight: 300 });
    add(`${base} VF`, "Regular", `${ps}VF`, { variable: true });
  }
  groupLibrary(fonts, BY_NAME);
}

/** `groupLibrary`'s families. */
export const groupFamilies = (fonts: FontSummary[], grouping: GroupingOptions = BY_NAME): Family[] => groupLibrary(fonts, grouping).families;

/**
 * "Group styles into families" off: every style becomes its own item, named "Family Style", in
 * the order the families list them (so each family's styles stay together, lightest first).
 * Each item's id is "u:" plus its face key, so it never matches a family's id.
 */
export function ungroup(families: readonly Family[]): Family[] {
  const out: Family[] = [];
  for (const family of families) {
    const base = family.ungroupedFrom ?? family.name;
    for (const face of family.faces) {
      out.push({ ...makeFamily(`u:${face.key}`, `${base} ${face.style}`, [face]), ungroupedFrom: base });
    }
  }
  return out;
}

/** Where a family's fonts come from, in words: the place the Table's Source column names first
 *  (familySources). Only the "source" sort needs it. */
export interface SortContext {
  sourceOf?: (family: Family) => string;
}

/** The family name an item sorts under: its own, or for a single style its family's. */
const nameKey = (f: Family) => f.ungroupedFrom ?? f.name;

type SortValue = string | number | undefined;

/** What each sort compares. Empty text and unknown values come back undefined: they go last. */
function sortValue(f: Family, key: SortOrder["key"], ctx: SortContext): SortValue {
  const text = (s: string | undefined) => s || undefined;
  switch (key) {
    case "name":
      return nameKey(f);
    case "added":
      return addedAt(f.faces);
    case "styles":
      return f.faces.length;
    case "weight": {
      const span = weightSpan(f.faces);
      // Lightest weight first, then the heaviest.
      return span ? span.min * 2000 + span.max : undefined;
    }
    case "foundry":
      return text(foundryOf(f));
    case "active":
      return activeRank(f);
    case "format":
      return text(formatsOf(f.faces));
    case "source":
      return text(ctx.sourceOf?.(f));
    case "version":
      return text(shortVersion(f.representative.primary.version));
    case "designer":
      return text(designerOf(f));
    case "file":
      return text(fileNameOf(f.representative.primary));
    case "size":
      return fileSizeOf(f.faces);
    case "glyphs":
      return f.representative.primary.glyphCount;
  }
}

const compareValues = (a: string | number, b: string | number) =>
  typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b));

/** Where an item goes whichever way the sort runs: 0 for most, 1 for a version with no number
 *  in front (after the numbered ones), 2 for an unknown value (last). */
function rankOf(value: SortValue, key: SortOrder["key"]): number {
  if (value === undefined) return 2;
  return key === "version" && !hasVersionNumber(String(value)) ? 1 : 0;
}

/**
 * The library's sort, run after filtering (and `ungroup`). `desc` turns the key's order round;
 * unknown values (no foundry, no added date yet) always go last. Versions compare as decimals
 * (compareVersions). Ties go by name A to Z, then keep the order they came in, so a family's
 * styles stay lightest first. Name A to Z on a list that's already in that order (as
 * `groupFamilies` leaves it) comes back as the same array.
 */
export function sortFamilies(families: Family[], sort: SortOrder, ctx: SortContext = {}): Family[] {
  if (sort.key === "name" && !sort.desc && families.every((f, i) => i === 0 || collator.compare(nameKey(families[i - 1]), nameKey(f)) <= 0)) {
    return families;
  }
  const sign = sort.desc ? -1 : 1;
  const compare = sort.key === "version" ? (a: string | number, b: string | number) => compareVersions(String(a), String(b)) : compareValues;
  const items = families.map((family, at) => {
    const value = sortValue(family, sort.key, ctx);
    return { family, at, value, rank: rankOf(value, sort.key), name: nameKey(family) };
  });
  items.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.value !== undefined && b.value !== undefined && a.value !== b.value) {
      const by = compare(a.value, b.value);
      if (by !== 0) return sign * by;
    }
    return (sort.key === "name" ? 0 : collator.compare(a.name, b.name)) || a.at - b.at;
  });
  return items.map((i) => i.family);
}

const matches = (f: FontSummary, q: string) =>
  f.family.toLowerCase().includes(q) ||
  f.subfamily.toLowerCase().includes(q) ||
  (f.fullName?.toLowerCase().includes(q) ?? false) ||
  (f.postscriptName?.toLowerCase().includes(q) ?? false);

/**
 * Filters at the face level, keeping each Face whole (all copies), so a switch always reflects
 * and acts on every copy in the library, not only the copies visible in this view.
 * A family is listed when any of its faces is kept, with only those faces.
 */
export function filterFamilies(
  families: Family[],
  view: LibraryView,
  { status = "any", query = "", variableOnly = false, hideInstalled = false }: Filters = {},
  ctx: FilterContext = {},
): Family[] {
  const q = query.trim().toLowerCase();
  const inside = view.kind === "location" ? `${view.path}/` : "";
  // A service's list is its folder's fonts; none while it has no folder (nothing downloaded
  // yet), and none for Adobe Fonts, whose fonts aren't in the library.
  const serviceFolder = view.kind === "service" && view.id !== "adobe" ? (ctx.serviceFolder?.(view.id) ?? null) : null;
  const since = ctx.recentSince ?? recentSince(Date.now() / 1000);
  const inView = (face: Face): boolean => {
    switch (view.kind) {
      case "all":
        return !(hideInstalled && onlyInOsFolders(face));
      case "yours":
        return isYours(face);
      case "recent":
        return isRecent(face, since);
      case "active":
        return isOnNow(face);
      case "untagged":
        return !ctx.hasOwnTag?.(face);
      case "installed":
        return face.installed;
      case "folder":
        return face.copies.some((c) => c.folderId === view.id);
      case "service":
        return serviceFolder !== null && face.copies.some((c) => c.folderId === serviceFolder);
      case "location":
        return face.copies.some((c) => c.path.startsWith(inside));
      case "tag":
        return !!ctx.inTag?.(face, view.id);
    }
  };
  const keep = (face: Face) => {
    if (!inView(face)) return false;
    if (status === "active" && !face.active) return false;
    if (status === "inactive" && face.active) return false;
    // Copies of a face are all variable or all static (it's part of the face key).
    if (variableOnly && !face.primary.variable) return false;
    return (
      !q ||
      face.copies.some((c) => matches(c, q)) ||
      // The family and style it's listed under, when grouping gave it others.
      (face.groupedBy !== "own" && `${face.family} ${face.style}`.toLowerCase().includes(q)) ||
      (ctx.tagNames?.(face).some((n) => n.includes(q)) ?? false)
    );
  };
  if (view.kind === "all" && status === "any" && !q && !variableOnly && !hideInstalled) return families;
  const out: Family[] = [];
  for (const family of families) {
    const faces = family.faces.filter(keep);
    // A narrowed family keeps its id, so its row, expanded state and selection carry over.
    if (faces.length) out.push(faces.length === family.faces.length ? family : makeFamily(family.id, family.name, faces));
  }
  return out;
}

/** Style counts for the sidebar's smart entries and Font Book: each face once. */
export interface PlaceCounts {
  all: number;
  yours: number;
  recent: number;
  active: number;
  untagged: number;
  installed: number;
}

/**
 * How many styles each smart entry (and Font Book) lists, matching what `filterFamilies` shows
 * there with no filters on. All Fonts follows "Show installed fonts in All Fonts".
 */
export function placeCounts(
  families: readonly Family[],
  { hideInstalled = false, recentSince: since = recentSince(Date.now() / 1000), hasOwnTag }: { hideInstalled?: boolean; recentSince?: number; hasOwnTag?: (face: Face) => boolean } = {},
): PlaceCounts {
  const counts: PlaceCounts = { all: 0, yours: 0, recent: 0, active: 0, untagged: 0, installed: 0 };
  for (const family of families) {
    for (const face of family.faces) {
      const yours = isYours(face);
      if (yours || !hideInstalled) counts.all++;
      if (yours) counts.yours++;
      if (isRecent(face, since)) counts.recent++;
      if (isOnNow(face)) counts.active++;
      if (!hasOwnTag?.(face)) counts.untagged++;
      if (face.installed) counts.installed++;
    }
  }
  return counts;
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
