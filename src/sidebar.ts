/**
 * The sidebar's sections, its menus and when a row shows its count. Pure (no React, no DOM), so
 * `npm run test:ui` covers it; src/components/Sidebar.tsx and src/tags/TagsSection.tsx draw it.
 *
 * The sidebar has three sections and no headings. Library (All Fonts and the smart entries) comes
 * first. A thin divider with a small icon starts Sources, and another starts Tags. A divider is a
 * button: a click (or Left and Right) collapses or expands its section, and a right-click (or
 * Shift-F10) opens the section's menu. The Tags divider also has an (i) that explains tags. The
 * "+" at the bottom of the sidebar makes a new tag, adds a folder, or imports fonts or tags.
 */

export type SidebarSection = "sources" | "tags";

export interface SectionInfo {
  /** Its name: what screen readers hear for its divider and its group of rows. */
  label: string;
  /** "the sources": for the divider's tooltip. */
  what: string;
  /** Material Symbols name, drawn outlined on the divider. */
  icon: string;
  /** Its open state's id in the sidebar's open-rows store (src/tags/expanded.ts). Sections start
   *  open, so only a collapsed one is remembered. */
  openId: string;
}

export const SECTIONS: Record<SidebarSection, SectionInfo> = {
  sources: { label: "Sources", what: "the sources", icon: "input", openId: "section:sources" },
  tags: { label: "Tags", what: "the tags", icon: "label", openId: "section:tags" },
};

/** Sections start open. */
export const SECTION_STARTS_OPEN = true;

/** The divider's tooltip: what a click does, and where its other commands are. */
export function dividerTip(section: SidebarSection, open: boolean): string {
  const { what } = SECTIONS[section];
  return `${open ? "Hides" : "Shows"} ${what}. Right-click for more.`;
}

/** What screen readers hear for a divider: its section's name (its state comes from
 *  aria-expanded). */
export const dividerLabel = (section: SidebarSection) => SECTIONS[section].label;

/** The (i) on the Tags divider: one tooltip about the whole section, instead of one on every tag. */
export const TAGS_INFO_LABEL = "About tags";
export const TAGS_INFO =
  "Tags sort your fonts into groups you choose. Click a tag to see its fonts. Drag fonts onto a tag to add them, or drag a tag into another tag. My tags are yours to change. Built-in tags come from other apps and are read-only. To turn on every font in a tag, use its … menu or right-click it.";

// ------------------------------------------------------------------------------------- counts

/**
 * Where a row is. Library's rows (All Fonts and the smart entries) and the tag groups' headings
 * (My tags, Built-in, which count tags) always show their count. Sources and tags show theirs only
 * while the row is hovered, has keyboard focus or is the place being viewed, so the sidebar stays
 * quiet. Screen readers hear every count either way.
 */
export type CountPlace = "library" | "group" | "source" | "tag";

/** "always", or only on "hover" (keyboard focus and the place being viewed too). */
export type CountShown = "always" | "hover";

export function countShown(place: CountPlace, selected: boolean): CountShown {
  if (place === "library" || place === "group") return "always";
  return selected ? "always" : "hover";
}

/**
 * The classes for a row's count (the row is a Tailwind `group/item`). It keeps its room while it's
 * hidden (`invisible`), so names never move when it shows. `swaps`: the row shows its own buttons
 * (Rescan, Remove) on hover and focus, in the count's place, so the count hides then.
 */
export function countClass(shown: CountShown, swaps: boolean): string {
  if (shown === "always") return swaps ? "group-focus-within/item:hidden group-hover/item:hidden" : "";
  return swaps ? "invisible group-focus-within/item:hidden group-hover/item:hidden" : "invisible group-focus-within/item:visible group-hover/item:visible";
}

/** A style count in words, for screen readers: "1 style", "1,234 styles". */
export const stylesSaid = (n: number) => `${n.toLocaleString()} ${n === 1 ? "style" : "styles"}`;

// -------------------------------------------------------------------------------------- menus

/** A command in one of the sidebar's own menus. */
export type SidebarCommand =
  | "newTag"
  | "addFolder"
  | "importPurchases"
  | "importTags"
  | "exportTags"
  | "openAllTags"
  | "closeAllTags"
  | "toggleSection";

export interface MenuEntry {
  id: SidebarCommand;
  label: string;
  /** Material Symbols name. */
  icon: string;
  /** Its tooltip: what it does or, when it's greyed out, why. */
  tip: string;
  disabled?: boolean;
}

/** A menu: its entries in order, with "-" for a separator. */
export type MenuLine = MenuEntry | "-";

export const ADD_FOLDER_TIP = "Picks a folder of fonts to add to your library";
export const NEW_TAG_TIP = "Makes a new tag. Then drag fonts onto it, or use a font's right-click menu.";
export const IMPORT_TAGS_TIP = "Brings in tags from Finder, this Mac's font collections, another font manager's backup, or a Fontface tags file";
export const IMPORT_PURCHASES_TIP = "Opens Purchases, where you can add a zip, font files or a folder of fonts you bought";

const NEW_TAG: MenuEntry = { id: "newTag", label: "New Tag…", icon: "new_label", tip: NEW_TAG_TIP };
const ADD_FOLDER: MenuEntry = { id: "addFolder", label: "Add Folder…", icon: "create_new_folder", tip: ADD_FOLDER_TIP };
const IMPORT_TAGS: MenuEntry = { id: "importTags", label: "Import Tags…", icon: "download", tip: IMPORT_TAGS_TIP };

/** What the sidebar shows, as far as its menus care (Settings › Sidebar). */
export interface MenuContext {
  /** The Purchases source is shown. */
  purchases: boolean;
  /** The Tags section is shown. */
  tags: boolean;
}

/** The "+" at the bottom of the sidebar: make a tag, add a folder, or import fonts or tags. Tag
 *  commands only while Tags shows, Purchases' only while Purchases does. */
export function addMenu({ purchases, tags }: MenuContext): MenuLine[] {
  const make: MenuEntry[] = [...(tags ? [NEW_TAG] : []), ADD_FOLDER];
  const imports: MenuEntry[] = [
    ...(purchases ? [{ id: "importPurchases", label: "Import Purchased Fonts…", icon: "shopping_bag", tip: IMPORT_PURCHASES_TIP } as const] : []),
    ...(tags ? [IMPORT_TAGS] : []),
  ];
  return imports.length ? [...make, "-", ...imports] : make;
}

/** "Collapse Section" or "Expand Section", last in a divider's menu. */
function toggleEntry(section: SidebarSection, open: boolean): MenuEntry {
  const { what } = SECTIONS[section];
  return open
    ? { id: "toggleSection", label: "Collapse Section", icon: "collapse_content", tip: `Hides ${what} until you expand them again. A click on the divider does the same.` }
    : { id: "toggleSection", label: "Expand Section", icon: "expand_content", tip: `Shows ${what} again` };
}

export interface DividerMenuContext {
  /** The section's rows show. */
  open: boolean;
  /** Tags: there's at least one tag (Export needs one). */
  anyTags?: boolean;
  /** Tags: some tag has tags inside it (Open and Close All Tags need one). */
  anyNested?: boolean;
}

/** A divider's right-click menu. Sources: Add Folder…; Tags: New Tag…, Import Tags…, Export
 *  Tags…, Open and Close All Tags; then Collapse (or Expand) Section. */
export function dividerMenu(section: SidebarSection, ctx: DividerMenuContext): MenuLine[] {
  if (section === "sources") return [ADD_FOLDER, "-", toggleEntry(section, ctx.open)];
  const out: MenuLine[] = [
    NEW_TAG,
    IMPORT_TAGS,
    {
      id: "exportTags",
      label: "Export Tags…",
      icon: "ios_share",
      tip: ctx.anyTags ? "Saves all your tags to a file, to Finder tags, or to this Mac's font collections" : "There are no tags to export yet. Make one first.",
      disabled: !ctx.anyTags,
    },
  ];
  if (ctx.anyNested) {
    out.push(
      "-",
      { id: "openAllTags", label: "Open All Tags", icon: "unfold_more", tip: "Shows the tags inside every tag" },
      { id: "closeAllTags", label: "Close All Tags", icon: "unfold_less", tip: "Hides the tags inside other tags" },
    );
  }
  out.push("-", toggleEntry(section, ctx.open));
  return out;
}
