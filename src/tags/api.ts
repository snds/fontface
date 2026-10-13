import { invoke } from "@tauri-apps/api/core";

/** Palette names, in picker order. Must match src-tauri/src/tags/colors.rs. */
export const PALETTE = ["gray", "red", "orange", "amber", "green", "teal", "sky", "blue", "indigo", "purple", "pink", "brown"] as const;
export type TagColor = (typeof PALETTE)[number];

export const COLOR_NAMES: Record<TagColor, string> = {
  gray: "Gray", red: "Red", orange: "Orange", amber: "Amber", green: "Green", teal: "Teal",
  sky: "Sky", blue: "Blue", indigo: "Indigo", purple: "Purple", pink: "Pink", brown: "Brown",
};

/** The CSS color for a palette name (falls back to gray for anything unknown). */
export const colorVar = (c: string) => `var(--tag-${(PALETTE as readonly string[]).includes(c) ? c : "gray"})`;

export interface Tag {
  id: number;
  /** Full name; `/` nests ("Sci-Fi/Star Trek"). */
  name: string;
  color: TagColor;
  /** In the Built-in group (tags from Font Book and Typeface) rather than the user's own. Always
   *  the same as its top-level tag's: a group belongs to a top-level tag and everything in it. */
  builtin: boolean;
}

export interface Organize {
  tags: Tag[];
  /** Face key → ids of its tags. Keys are `Face.key`, or `ps:<name>` for fonts kept from an import. */
  assignments: Record<string, number[]>;
  /** Location (folder path, "fontbook" or "service:adobe") → color the user picked. */
  locationColors: Record<string, TagColor>;
}

export type ImportSource =
  | { kind: "typeface"; path: string }
  | { kind: "fontface"; path: string }
  | { kind: "finder" }
  | { kind: "fontBook" };

export interface PlannedTag {
  name: string;
  color: TagColor;
  exists: boolean;
  /** In Built-in, or will be once imported. When adding, an existing tag keeps its group; a
   *  replace's preview gives the group the restore creates it in. */
  builtin: boolean;
  fonts: number;
  matched: number;
  unmatched: number;
  new: number;
  suggested: boolean;
  note: string | null;
  merged: string[];
}

export interface MissingFont {
  /** PostScript name (or file, or family, as the source gives it). */
  name: string;
  tags: string[];
}

export interface ImportPreview {
  label: string;
  date: number | null;
  tags: PlannedTag[];
  fonts: number;
  matchedFonts: number;
  unmatchedFonts: number;
  /** Matched as named styles inside variable fonts. */
  namedStyleMatches: number;
  /** Matched once the name in the font file was tidied the way macOS writes it. */
  tidiedMatches: number;
  /** Fonts not in the library, with the tags that name them (capped; unmatchedFonts has the total). */
  missing: MissingFont[];
  notes: string[];
}

export interface Relocated {
  /** False when none of the folder's fonts are at the new place: nothing changed yet. */
  moved: boolean;
  found: number;
  checked: number;
  path: string;
  oldPath: string;
}

export interface ImportResult {
  tagsCreated: number;
  tagsUpdated: number;
  /** Tags added to styles (a style that got three tags counts three times). */
  added: number;
  /** Different styles that got a tag. */
  styles: number;
  /** Different fonts not in the library whose tags were kept for later. */
  kept: number;
  locationColors: number;
  /** Tags deleted first, when the import replaced the tags (restoring a backup). */
  tagsRemoved: number;
}

export type FileExportFormat = "json" | "csv" | "typeface";

export interface ExportSummary {
  tags: number;
  fonts: number;
  skipped: number;
}

export interface FileProblem {
  path: string;
  reason: string;
}

export interface FinderExport {
  changed: number;
  unchanged: number;
  skippedInstalled: number;
  failed: FileProblem[];
}

export interface FontBookExport {
  collections: number;
  added: number;
  skipped: number;
  failed: FileProblem[];
}

export const tagsApi = {
  list: () => invoke<Organize>("tags_list"),
  create: (name: string, color?: TagColor) => invoke<Tag>("tags_create", { name, color: color ?? null }),
  rename: (tagId: number, name: string) => invoke<Tag>("tags_rename", { tagId, name }),
  recolor: (tagId: number, color: TagColor) => invoke<void>("tags_recolor", { tagId, color }),
  /** Moves the tag's top-level tag and everything in it to Built-in or to My tags. Returns that top-level tag. */
  setGroup: (tagId: number, builtin: boolean) => invoke<Tag>("tags_set_group", { tagId, builtin }),
  remove: (tagId: number) => invoke<number[]>("tags_delete", { tagId }),
  assign: (tagIds: number[], keys: string[], on: boolean) => invoke<number>("tags_assign", { tagIds, keys, on }),
  setLocationColor: (location: string, color: TagColor | null) => invoke<void>("location_color_set", { location, color }),
  relocateFolder: (folderId: number, path: string, force: boolean) => invoke<Relocated>("folder_relocate", { folderId, path, force }),
  /** `replace`: what a replace (see importApply) would do, with the names, colors and groups it
   *  creates, rather than what adding would. */
  importPreview: (source: ImportSource, replace = false) => invoke<ImportPreview>("tags_import_preview", { source, replace }),
  /** `replace`: delete every tag and location color first, so they end up as in the file (a
   *  Fontface tags file only, e.g. a backup). Otherwise the tags are added to the ones there. */
  importApply: (source: ImportSource, tags: string[], keepUnmatched: boolean, replace = false) =>
    invoke<ImportResult>("tags_import_apply", { source, tags, keepUnmatched, replace }),
  exportFile: (format: FileExportFormat, path: string, tagIds: number[] | null) =>
    invoke<ExportSummary>("tags_export", { format, path, tagIds }),
  exportFinder: (tagIds: number[] | null) => invoke<FinderExport>("tags_export_finder", { tagIds }),
  exportFontBook: (tagIds: number[] | null) => invoke<FontBookExport>("tags_export_font_book", { tagIds }),
};
