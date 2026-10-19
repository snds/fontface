import type { ActivationMode, FontSummary, LibraryLayout, SortKey, SortOrder } from "./api.ts";
import { INSTALLED_LABEL, type Face, type Family } from "./library.ts";
import { switchLook, type StateSummary } from "./fontState.ts";
import { LAYOUTS, SORTS, stepSize } from "./viewOptions.ts";

/**
 * What can be done to a font or a selection, wherever it's asked for: the list's right-click
 * menu, the font page's More and right-click menus, the selection bar, the keyboard, and the
 * macOS View and Font menus (src-tauri/src/window.rs). One set of actions, one set of words and
 * one rule for when each is available, so every place offers the same thing. Pure (no React, no
 * DOM), so `npm run test:ui` covers it; components/FontActions.tsx draws the menus and App runs
 * the actions.
 *
 * Also here: which way a switch turns fonts on (Option-click uses the other activation mode),
 * the native menus' ids and state, the keyboard shortcuts behind them, the guard that keeps a
 * shortcut from running twice (the page's own key handler and the menu's), and what Remove from
 * Library would remove.
 */

export type FontActionId =
  | "open"
  | "info"
  | "turnOn"
  | "turnOnOther"
  | "turnOff"
  | "tags"
  | "compare"
  | "pair"
  | "familyGroup"
  | "reveal"
  | "copyPostScript"
  | "remove";

/** The actions in menu order, with where the separators go (`gap` before it). */
export const ACTION_ORDER: readonly { id: FontActionId; gap?: boolean }[] = [
  { id: "open" },
  { id: "info" },
  { id: "turnOn", gap: true },
  { id: "turnOnOther" },
  { id: "turnOff" },
  { id: "tags", gap: true },
  { id: "compare" },
  { id: "pair" },
  { id: "familyGroup" },
  { id: "reveal", gap: true },
  { id: "copyPostScript" },
  { id: "remove", gap: true },
];

/** One thing an action covers: a row of the list, or the font page's family. */
export interface TargetItem {
  /** The list row it came from (focus goes back there after a page it opens), if any. */
  rowKey: string | null;
  /** Its whole family (filters don't narrow it). */
  family: Family;
  /** The style it stands for: a style row's own, a family row's preview style, or the font
   *  page's chosen style (or the "All styles" line right-clicked). */
  face: Face;
  /** A family (every style) or one style. */
  kind: "family" | "style";
}

/** What the actions work on: the selected rows, or the open font page. */
export interface FontTarget {
  where: "list" | "page";
  items: TargetItem[];
  /** Every style covered: turning on and off, tags, family groups and removing work on these. */
  faces: Face[];
}

/** The font page's target: its family (shown in its chosen style), or one style of it (a line
 *  of "All styles" that was right-clicked). */
export function pageTarget(family: Family, chosen: Face, line?: Face): FontTarget {
  if (line) return { where: "page", items: [{ rowKey: null, family, face: line, kind: "style" }], faces: [line] };
  return { where: "page", items: [{ rowKey: null, family, face: chosen, kind: "family" }], faces: family.faces };
}

export interface ActionContext {
  /** The saved activation mode (Settings › Activation). */
  mode: ActivationMode;
  /** Fonts turned on until logout go off when Fontface quits (Settings › Activation), so the
   *  words say "until Fontface quits". */
  untilQuit?: boolean;
  /** The font's file is in one of your folders, where Remove from Library works. */
  removable: (font: FontSummary) => boolean;
  /** "Show in Finder" on macOS, "Show in Explorer" on Windows. */
  revealLabel: string;
}

export interface ActionState {
  enabled: boolean;
  label: string;
}

export type ActionStates = Record<FontActionId, ActionState>;

// ------------------------------------------------------------------------- turning on

export const otherMode = (mode: ActivationMode): ActivationMode => (mode === "persistent" ? "temporary" : "persistent");

/** "Turn On" keeps fonts on until you turn them off; "Turn On Until Logout" until you log out
 *  (or, when quitting Fontface turns those fonts off, "Turn On Until Fontface Quits"). */
export function turnOnLabel(mode: ActivationMode, untilQuit = false): string {
  if (mode === "persistent") return "Turn On";
  return untilQuit ? "Turn On Until Fontface Quits" : "Turn On Until Logout";
}

/** The scope a turn-on action asks the back end for: null for the saved mode, else the other one. */
export function scopeOf(action: "turnOn" | "turnOnOther", mode: ActivationMode): ActivationMode | null {
  return action === "turnOn" ? null : otherMode(mode);
}

/** A switch's scope: Option-click (Alt-click on Windows) turns fonts on the other way. Turning
 *  off is the same either way. */
export function switchScope(on: boolean, alt: boolean, mode: ActivationMode): ActivationMode | null {
  return on && alt ? otherMode(mode) : null;
}

/** What a switch's tooltip says while it would turn fonts on. `untilQuit`: fonts on until
 *  logout go off when Fontface quits, so the other way lasts until then. */
export function optionClickHint(mode: ActivationMode, mac: boolean, untilQuit = false): string {
  const click = mac ? "Option-click" : "Alt-click";
  if (mode === "temporary") return `${click} to turn on until you turn it off.`;
  return untilQuit ? `${click} to turn on until you quit Fontface.` : `${click} to turn on until you log out.`;
}

/** A font switch's tooltip while it's working on a request (it ignores clicks till then). */
export const SWITCH_BUSY_TIP = "Wait: Fontface is still switching these fonts";

/**
 * What a font's switch says it will do (its tooltip): turn the style or the family's styles off,
 * or on, with Option-click's other way. `single`: one style, else a family. Locked styles (in
 * macOS Fonts) aren't counted: the switch doesn't change them.
 */
export function switchTip(s: StateSummary, single: boolean, { mode, mac, untilQuit = false }: { mode: ActivationMode; mac: boolean; untilQuit?: boolean }): string {
  const { checked, partial } = switchLook(s);
  const count = (n: number) => `${n.toLocaleString()} ${n === 1 ? "style" : "styles"}`;
  const all = s.total === 1 ? (single ? "this style" : "its 1 style") : `all ${count(s.total)}`;
  if (checked) return `Turns off ${all}`;
  const hint = optionClickHint(mode, mac, untilQuit);
  const rest = s.total - s.wanted;
  if (partial) return `Turns on the other ${rest === 1 ? "style" : count(rest)}. ${hint}`;
  return `Turns on ${all}. ${hint}`;
}

// --------------------------------------------------------------------------- the actions

/** Styles that can be switched (not in an OS font folder). */
const switchable = (faces: readonly Face[]) => faces.filter((f) => !f.installed);

/** The PostScript names Copy PostScript Name copies: on the font page, the chosen style's (or
 *  the line right-clicked); in the list, every style the selection covers. */
export function postScriptNames(target: FontTarget | null): string[] {
  if (!target) return [];
  const faces = target.where === "page" ? target.items.map((i) => i.face) : target.faces;
  const names = faces.map((f) => f.primary.postscriptName).filter((n): n is string => !!n);
  return [...new Set(names)];
}

/** The font Show in Finder shows: the one item's style (a family row's preview style). */
export const revealFontOf = (target: FontTarget | null): FontSummary | null => (target?.items.length === 1 ? target.items[0].face.primary : null);

/** The styles Compare starts with: each item's style, each once. */
export const compareKeysOf = (target: FontTarget | null): string[] => [...new Set((target?.items ?? []).map((i) => i.face.key))];

/** Which actions are available for `target`, and what each is called. */
export function fontActionStates(target: FontTarget | null, ctx: ActionContext): ActionStates {
  const items = target?.items ?? [];
  const faces = target?.faces ?? [];
  const can = switchable(faces);
  const n = items.length;
  const offNow = can.some((f) => !f.active);
  const names = postScriptNames(target);
  const state = (enabled: boolean, label: string): ActionState => ({ enabled, label });
  return {
    open: state(target?.where === "list" && n === 1, "Open"),
    // The font page on its Info tab (on the font page: that tab, for the style it's on).
    info: state(n === 1, "Show Info"),
    turnOn: state(offNow, turnOnLabel(ctx.mode, ctx.untilQuit)),
    turnOnOther: state(offNow, turnOnLabel(otherMode(ctx.mode), ctx.untilQuit)),
    turnOff: state(
      can.some((f) => f.active || f.copies.some((c) => c.activated)),
      "Turn Off",
    ),
    tags: state(faces.length > 0, "Tags…"),
    // One font: pick what to compare it with. Two or more: compare them (more than the page
    // shows are left out, with a note).
    compare: state(n > 0, n > 1 ? "Compare" : "Compare With…"),
    // One font: pick the other. Two: pair them (the first is the heading).
    pair: state(n === 1 || n === 2, n === 2 ? "Pair" : "Pair With…"),
    familyGroup: state(faces.length > 0, "Family Group…"),
    reveal: state(n === 1, ctx.revealLabel),
    copyPostScript: state(names.length > 0, names.length > 1 ? "Copy PostScript Names" : "Copy PostScript Name"),
    remove: state(
      faces.some((f) => f.copies.some(ctx.removable)),
      "Remove from Library…",
    ),
  };
}

/**
 * What a font action does, for its menu item's tooltip, or, when it's greyed out (`enabled`
 * false), why and what would make it work. `mode` and `untilQuit` are the saved activation
 * mode's (Settings › Activation): Turn On keeps fonts on that way, the other Turn On the other
 * way. `mac`: Finder, else Explorer.
 */
export function actionTip(
  id: FontActionId,
  enabled: boolean,
  target: FontTarget,
  { mode, untilQuit = false, mac }: { mode: ActivationMode; untilQuit?: boolean; mac: boolean },
): string {
  const one = target.items.length === 1 ? target.items[0] : null;
  const style = !!one && (one.kind === "style" || !!one.family.ungroupedFrom || one.family.faces.length === 1);
  const subject = !one ? "the selected fonts" : style ? "this style" : "this family";
  const it = one ? "it" : "them";
  const its = one ? "it's" : "they're";
  const page = target.where === "page";
  // Turning on and off only changes styles outside the OS's own font folders.
  const locked = target.faces.length > 0 && target.faces.every((f) => f.installed);
  const until = (m: ActivationMode) => (m === "persistent" ? `until you turn ${it} off` : untilQuit ? "until you quit Fontface" : "until you log out");
  const already = (state: "on" | "off") => (locked ? `Always on: ${its} in ${INSTALLED_LABEL}` : `${one ? "It's" : "They're"} already ${state}`);
  switch (id) {
    case "open":
      if (enabled) return "Opens this font's page";
      return page ? "This font's page is already open" : "Select just one font to open its page";
    case "info":
      if (!enabled) return "Select just one font to see its details";
      return page ? `Shows ${style ? "this style's" : "this font's"} details on the Info tab` : "Opens this font's page on the Info tab";
    case "turnOn":
    case "turnOnOther":
      return enabled ? `Turns ${subject} on ${until(id === "turnOn" ? mode : otherMode(mode))}` : already("on");
    case "turnOff":
      return enabled ? `Turns ${subject} off` : already("off");
    case "tags":
      return enabled ? `Adds or removes tags on ${subject}` : "Select a font to tag it";
    case "compare":
      if (!enabled) return "Select a font to compare it";
      return one ? `Picks fonts to compare ${subject} with` : "Shows the selected fonts side by side";
    case "pair":
      if (!enabled) return "Select one or two fonts to pair them";
      return one ? `Picks a body font to go with ${subject}` : "Pairs them: the first as heading, the second as body text";
    case "familyGroup":
      return enabled ? `Opens Family groups, to see or change how ${subject} ${one ? "is" : "are"} grouped` : "Select a font to see its family group";
    case "reveal": {
      // A family shows the file of the style it stands for (its preview, or the page's style).
      const where = mac ? "Finder" : "Explorer";
      if (!enabled) return "Select just one font to show its file";
      return style ? `Shows its font file in ${where}` : `Shows one of this family's files in ${where}`;
    }
    case "copyPostScript":
      if (!enabled) return `${one ? "It has" : "They have"} no PostScript name to copy`;
      return postScriptNames(target).length > 1 ? "Copies their PostScript names, one per line" : "Copies its PostScript name to the clipboard";
    case "remove":
      return enabled
        ? `Stops listing ${subject} and turns ${it} off, after asking. Nothing is deleted.`
        : "Only fonts in your own folders can be removed from the library";
  }
}

// ------------------------------------------------------------------------ keyboard

/** The parts of a key press the shortcuts look at. */
export interface ShortcutKey {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The font actions with a shortcut. */
export type ShortcutAction = "info" | "tags" | "turnOn" | "turnOnOther" | "turnOff";

/** Shortcut text for menus, by action: Cmd on macOS, Ctrl on Windows. */
export function shortcutText(action: FontActionId, mac: boolean): string | undefined {
  const cmd = mac ? "⌘" : "Ctrl+";
  const opt = mac ? "⌥" : "Alt+";
  const shift = mac ? "⇧" : "Shift+";
  const ret = mac ? "↩" : "Enter";
  switch (action) {
    case "info":
      return `${cmd}I`;
    case "tags":
      return `${cmd}T`;
    case "turnOn":
      return `${cmd}${ret}`;
    case "turnOnOther":
      return mac ? `${opt}${cmd}${ret}` : `${cmd}${opt}${ret}`;
    case "turnOff":
      return mac ? `${shift}${cmd}${ret}` : `${cmd}${shift}${ret}`;
    default:
      return undefined;
  }
}

/** Cmd+I: Show Info. Cmd+T: Tags. Cmd+Return: turn on (the saved way); Option-Cmd+Return: the
 *  other way; Shift-Cmd+Return: turn off. Ctrl on Windows (Alt for Option). */
export function fontShortcut(e: ShortcutKey, mac: boolean): ShortcutAction | null {
  const command = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!command) return null;
  const plain = !e.altKey && !e.shiftKey;
  // The letter typed decides (Dvorak's Cmd+C sits where QWERTY's I is, and must stay Copy). The
  // key's position counts only when the layout types no Latin letter there (Cyrillic, say).
  const letter = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : e.code === "KeyI" ? "i" : e.code === "KeyT" ? "t" : "";
  if (letter === "i" && plain) return "info";
  if (letter === "t" && plain) return "tags";
  if (e.key !== "Enter") return null;
  if (e.altKey && e.shiftKey) return null;
  if (e.altKey) return "turnOnOther";
  if (e.shiftKey) return "turnOff";
  return "turnOn";
}

/**
 * Keeps one shortcut from running twice. On macOS a menu item's key (Cmd+[ for Back, say) can
 * reach both the page's own key handler and the menu, which sends its own event. Each command
 * notes where it came from: if the same command arrives from the other source within
 * `windowMs`, it's the same key press, and it's dropped. The same source twice (two presses, or
 * a held key) runs both times.
 */
export function createShortcutGuard(windowMs = 250) {
  const last = new Map<string, { source: "key" | "menu"; at: number }>();
  return {
    /** True if the command should run now. */
    allow(command: string, source: "key" | "menu", now: number): boolean {
      const before = last.get(command);
      if (before && before.source !== source && now - before.at < windowMs) {
        // The echo of a press already handled; the next press from either source runs.
        last.delete(command);
        return false;
      }
      last.set(command, { source, at: now });
      return true;
    },
  };
}

export type ShortcutGuard = ReturnType<typeof createShortcutGuard>;

/**
 * Cmd+T on a font page opens that page's Tags popover. App counts the asks (the count only
 * grows) and hands the count to the page that was asked; every other font page gets undefined,
 * including one still mounted under Compare or Family groups. A page opens its popover only for
 * an ask newer than the last one it saw, so an ask for another page never opens it.
 */
export function newTagsAsk(seen: number, ask: number | undefined): boolean {
  return ask !== undefined && ask > seen;
}

// ---------------------------------------------------------------------- macOS menus

/**
 * The ids of the View and Font menus' items. They must match MENU_ITEMS in
 * src-tauri/src/window.rs (menuIds.test.ts checks).
 */
export const LAYOUT_ITEMS: Record<LibraryLayout, string> = { tiles: "view.tiles", rows: "view.rows", table: "view.table" };
export const GROUP_ITEM = "view.group";
/** The View options' main sort keys, as items of View › Sort By. */
export const SORT_ITEMS: Partial<Record<SortKey, string>> = Object.fromEntries(SORTS.filter((s) => s.main).map((s) => [s.key, `sort.${s.key}`]));
export const SORT_ASC_ITEM = "sort.asc";
export const SORT_DESC_ITEM = "sort.desc";
export const BIGGER_ITEM = "view.bigger";
export const SMALLER_ITEM = "view.smaller";
export const BACK_ITEM = "view.back";
export const FONT_ITEMS: Record<FontActionId, string> = {
  open: "font.open",
  info: "font.info",
  turnOn: "font.turnOn",
  turnOnOther: "font.turnOnOther",
  turnOff: "font.turnOff",
  tags: "font.tags",
  compare: "font.compare",
  pair: "font.pair",
  familyGroup: "font.familyGroup",
  reveal: "font.reveal",
  copyPostScript: "font.copyPostScript",
  remove: "font.remove",
};

/** Every id the page sends state for and acts on. */
export const MENU_IDS: readonly string[] = [
  ...Object.values(LAYOUT_ITEMS),
  GROUP_ITEM,
  ...Object.values(SORT_ITEMS).filter((id): id is string => !!id),
  SORT_ASC_ITEM,
  SORT_DESC_ITEM,
  BIGGER_ITEM,
  SMALLER_ITEM,
  BACK_ITEM,
  ...Object.values(FONT_ITEMS),
];

/** What a menu item asks for. */
export type MenuCommand =
  | { kind: "layout"; layout: LibraryLayout }
  | { kind: "group" }
  | { kind: "sort"; key: SortKey }
  | { kind: "direction"; desc: boolean }
  | { kind: "size"; step: 1 | -1 }
  | { kind: "back" }
  | { kind: "font"; action: FontActionId };

export function menuCommand(id: string): MenuCommand | null {
  const layout = LAYOUTS.find((l) => LAYOUT_ITEMS[l.id] === id);
  if (layout) return { kind: "layout", layout: layout.id };
  if (id === GROUP_ITEM) return { kind: "group" };
  const sort = SORTS.find((s) => SORT_ITEMS[s.key] === id);
  if (sort) return { kind: "sort", key: sort.key };
  if (id === SORT_ASC_ITEM || id === SORT_DESC_ITEM) return { kind: "direction", desc: id === SORT_DESC_ITEM };
  if (id === BIGGER_ITEM || id === SMALLER_ITEM) return { kind: "size", step: id === BIGGER_ITEM ? 1 : -1 };
  if (id === BACK_ITEM) return { kind: "back" };
  const action = (Object.keys(FONT_ITEMS) as FontActionId[]).find((a) => FONT_ITEMS[a] === id);
  return action ? { kind: "font", action } : null;
}

/** The guard's name for a command, shared by its shortcut and its menu item. */
export function commandName(c: MenuCommand): string {
  switch (c.kind) {
    case "layout":
      return `layout:${c.layout}`;
    case "sort":
      return `sort:${c.key}`;
    case "direction":
      return `direction:${c.desc}`;
    case "size":
      return `size:${c.step}`;
    case "font":
      return `font:${c.action}`;
    default:
      return c.kind;
  }
}

/** What the macOS menus show: which items are enabled and checked, and items' changing names.
 *  Must match MenuState in src-tauri/src/window.rs. */
export interface NativeMenuState {
  enabled: string[];
  checked: string[];
  texts: Record<string, string>;
}

export interface MenuInput {
  /** The library list is showing and takes commands: no page, settings or Adobe Fonts' own page over it. */
  list: boolean;
  /** The list showing is the Google Fonts view: one layout and the catalog's own order, so only
   *  the preview size takes commands. */
  catalog?: boolean;
  /** Back would close a page. */
  back: boolean;
  layout: LibraryLayout;
  groupStyles: boolean;
  sort: SortOrder;
  /** The preview size, for Bigger and Smaller. */
  size: number;
  /** The font actions for whatever they'd work on now (fontActionStates). */
  actions: ActionStates;
}

/** The menus' state for the page as it is now. Menu enablement follows the selection and page. */
export function nativeMenuState(m: MenuInput): NativeMenuState {
  const enabled: string[] = [];
  const checked: string[] = [LAYOUT_ITEMS[m.layout]];
  const texts: Record<string, string> = {};
  if (m.groupStyles) checked.push(GROUP_ITEM);
  const sortItem = SORT_ITEMS[m.sort.key];
  if (sortItem) checked.push(sortItem);
  checked.push(m.sort.desc ? SORT_DESC_ITEM : SORT_ASC_ITEM);
  const [up, down] = SORTS.find((s) => s.key === m.sort.key)?.directions ?? ["A to Z", "Z to A"];
  texts[SORT_ASC_ITEM] = up;
  texts[SORT_DESC_ITEM] = down;
  if (m.list) {
    if (!m.catalog) enabled.push(...Object.values(LAYOUT_ITEMS), GROUP_ITEM, ...MENU_IDS.filter((id) => id.startsWith("sort.")));
    if (stepSize(m.size, 1) !== m.size) enabled.push(BIGGER_ITEM);
    if (stepSize(m.size, -1) !== m.size) enabled.push(SMALLER_ITEM);
  }
  if (m.back) enabled.push(BACK_ITEM);
  for (const id of Object.keys(FONT_ITEMS) as FontActionId[]) {
    texts[FONT_ITEMS[id]] = m.actions[id].label;
    if (m.actions[id].enabled) enabled.push(FONT_ITEMS[id]);
  }
  return { enabled, checked, texts };
}

/** A stable key for a menu state, to send it only when it changed. */
export const menuStateKey = (s: NativeMenuState) =>
  JSON.stringify([[...s.enabled].sort(), [...s.checked].sort(), Object.entries(s.texts).sort(([a], [b]) => a.localeCompare(b))]);

// -------------------------------------------------------------------- removing fonts

/** What Remove from Library would do (see `removalPlan`). */
export interface RemovalPlan {
  /** Fonts in the files that go (every font in a file goes: the OS treats a file as one). */
  ids: number[];
  /** The files Fontface stops listing: copies in your folders. */
  files: string[];
  /** Their folders, scanned again on Undo. */
  folders: number[];
  /** Chosen styles that leave the library (every copy is in your folders). */
  leaving: number;
  /** Chosen styles that stay listed from a copy elsewhere (Font Book, Google Fonts, Purchases). */
  staying: number;
  /** Chosen styles with no copy in your folders: nothing to remove. */
  blocked: number;
  /** Other styles in the same files (a collection holds several): they go too. */
  others: number;
}

/**
 * What removing `faces` from the library would remove. Only copies in your folders are removed:
 * Font Book's fonts are part of the OS, and Google Fonts and Purchases have their own Remove.
 * `library` is every style in the library, to find others that share a file.
 */
export function removalPlan(faces: readonly Face[], library: readonly Face[], removable: (font: FontSummary) => boolean): RemovalPlan {
  const chosen = new Set(faces.map((f) => f.key));
  const files = new Set<string>();
  const folders = new Set<number>();
  const ids = new Set<number>();
  let leaving = 0;
  let staying = 0;
  let blocked = 0;
  for (const face of faces) {
    const mine = face.copies.filter(removable);
    if (!mine.length) blocked++;
    else if (mine.length === face.copies.length) leaving++;
    else staying++;
    for (const c of mine) {
      files.add(c.path);
      folders.add(c.folderId);
      ids.add(c.id);
    }
  }
  let others = 0;
  for (const face of library) {
    if (chosen.has(face.key)) continue;
    const shared = face.copies.filter((c) => files.has(c.path));
    if (!shared.length) continue;
    others++;
    for (const c of shared) ids.add(c.id);
  }
  return { ids: [...ids], files: [...files], folders: [...folders], leaving, staying, blocked, others };
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The confirmation's words: what goes, what stays, and that files aren't touched. `os` names
 *  the system ("macOS"). Empty when there's nothing to remove. */
export function removalSummary(plan: RemovalPlan, os: string): string[] {
  if (!plan.files.length) return [];
  const one = plan.files.length === 1;
  const out = [
    `Fontface turns off ${count(plan.files.length, "font file", "font files")} in your folders and stops listing ${one ? "it" : "them"}. Nothing is deleted: the ${one ? "file stays" : "files stay"} where ${one ? "it is" : "they are"}, and you can put ${one ? "it" : "them"} back from Settings › Library.`,
  ];
  if (plan.others) out.push(`${count(plan.others, "other style is", "other styles are")} in the same ${one ? "file" : "files"}, so ${plan.others === 1 ? "it goes" : "they go"} too.`);
  if (plan.staying) out.push(`${count(plan.staying, "style stays", "styles stay")} listed from ${plan.staying === 1 ? "its" : "their"} other copies.`);
  if (plan.blocked) {
    out.push(
      `${count(plan.blocked, "style isn't", "styles aren't")} in your folders, so ${plan.blocked === 1 ? "it stays" : "they stay"}. Fonts from ${os}, Google Fonts and Purchases are removed where they came from.`,
    );
  }
  return out;
}
