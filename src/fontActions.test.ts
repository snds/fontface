// Run with `npm run test:ui`. The font actions, their menus and shortcuts (fontActions.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FontSummary } from "./api.ts";
import {
  ACTION_ORDER,
  BACK_ITEM,
  BIGGER_ITEM,
  commandName,
  compareKeysOf,
  createShortcutGuard,
  FONT_ITEMS,
  fontActionStates,
  fontShortcut,
  GROUP_ITEM,
  LAYOUT_ITEMS,
  markName,
  MENU_IDS,
  menuCommand,
  menuStateKey,
  nativeMenuState,
  newTagsAsk,
  pageTarget,
  postScriptNames,
  removalPlan,
  removalSummary,
  revealFontOf,
  scopeOf,
  shortcutText,
  SMALLER_ITEM,
  SORT_ASC_ITEM,
  SORT_DESC_ITEM,
  SORT_ITEMS,
  SWITCH_TIP,
  switchScope,
  turnOnLabel,
  viewCommands,
  type ActionContext,
  type FontTarget,
  type ShortcutKey,
} from "./fontActions.ts";
import { groupFamilies } from "./library.ts";

let nextId = 1;
function font(family: string, subfamily: string, more: Partial<FontSummary> = {}): FontSummary {
  const id = nextId++;
  return {
    id,
    folderId: 1,
    path: `/fonts/${family}-${subfamily}.otf`,
    faceIndex: 0,
    family,
    subfamily,
    fullName: `${family} ${subfamily}`,
    postscriptName: `${family.replace(/\s/g, "")}-${subfamily.replace(/\s/g, "")}`,
    weight: subfamily.includes("Bold") ? 700 : 400,
    width: 5,
    italic: subfamily.includes("Italic"),
    monospace: false,
    variable: false,
    format: "OpenType CFF",
    activated: false,
    installed: false,
    mtime: 1,
    fileSize: 1000,
    osActive: false,
    glyphCount: 100,
    preview: null,
    ...more,
  };
}

/** Folder 1 is yours; folder 2 is Font Book (the OS's fonts); folder 3 is Google Fonts. */
const ctx: ActionContext = { mode: "persistent", removable: (f) => f.folderId === 1, revealLabel: "Show in Finder" };

const families = groupFamilies([
  font("Inter", "Regular"),
  font("Inter", "Bold", { activated: true, osActive: true }),
  font("Lora", "Regular"),
  font("Helvetica", "Regular", { folderId: 2, installed: true, osActive: true, path: "/System/Library/Fonts/Helvetica.ttc" }),
  font("Roboto", "Regular", { folderId: 3 }),
]);
const fam = (name: string) => families.find((f) => f.name === name)!;

/** A list target: these rows (family rows, or a style row for "Family/Style"). */
function listTarget(...rows: string[]): FontTarget {
  const items = rows.map((r) => {
    const [name, style] = r.split("/");
    const family = fam(name);
    const face = style ? family.faces.find((f) => f.style === style)! : family.representative;
    return { rowKey: style ? `s:${face.key}` : `f:${family.id}`, family, face, kind: style ? ("style" as const) : ("family" as const) };
  });
  const faces = [...new Set(items.flatMap((i) => (i.kind === "family" ? i.family.faces : [i.face])))];
  return { where: "list", items, faces };
}


test("the menus have every action the plan lists (3.5), Show Info after Open", () => {
  const ids = ACTION_ORDER.map((a) => a.id);
  for (const id of ["open", "info", "turnOn", "turnOnOther", "turnOff", "tags", "compare", "pair", "familyGroup", "reveal"] as const) assert.ok(ids.includes(id), id);
  assert.equal(ids.indexOf("info"), ids.indexOf("open") + 1);
  assert.deepEqual([...ids].sort(), Object.keys(FONT_ITEMS).sort(), "the Font menu has the same actions");
});

test("nothing selected: every action is off, with its usual name", () => {
  const s = fontActionStates(null, ctx);
  assert.ok(Object.values(s).every((a) => !a.enabled));
  assert.equal(s.turnOn.label, "Turn On");
  assert.equal(s.turnOnOther.label, "Turn On Until Logout");
  assert.equal(s.remove.label, "Remove from Library…");
});

test("one family in the list: Open, Show Info, Show in Finder, the With… forms of Compare and Pair", () => {
  const s = fontActionStates(listTarget("Inter"), ctx);
  assert.ok(s.open.enabled);
  assert.ok(s.info.enabled);
  assert.equal(s.info.label, "Show Info");
  assert.ok(s.reveal.enabled);
  assert.equal(s.compare.label, "Compare With…");
  assert.equal(s.pair.label, "Pair With…");
  assert.ok(s.compare.enabled && s.pair.enabled);
  assert.ok(s.turnOn.enabled, "Inter Regular is off");
  assert.ok(s.turnOff.enabled, "Inter Bold is on");
  assert.equal(s.copyPostScript.label, "Copy PostScript Names", "a family row covers each style's name");
  assert.deepEqual(postScriptNames(listTarget("Inter")), ["Inter-Regular", "Inter-Bold"]);
  assert.equal(revealFontOf(listTarget("Inter"))?.postscriptName, "Inter-Regular", "a family row shows its preview style");
});

test("two rows: Compare and Pair act at once; Open and Show in Finder need one", () => {
  const s = fontActionStates(listTarget("Inter", "Lora"), ctx);
  assert.equal(s.compare.label, "Compare");
  assert.equal(s.pair.label, "Pair");
  assert.ok(!s.open.enabled && !s.reveal.enabled);
  assert.ok(!s.info.enabled, "Show Info is for one font");
  const three = fontActionStates(listTarget("Inter", "Lora", "Roboto"), ctx);
  assert.ok(three.compare.enabled);
  assert.ok(!three.pair.enabled, "Pair takes one or two");
  assert.deepEqual(
    compareKeysOf(listTarget("Inter/Bold", "Lora", "Inter/Bold")),
    [fam("Inter").faces.find((f) => f.style === "Bold")!.key, fam("Lora").representative.key],
    "each style once, in order",
  );
});

test("turning on and off follows what's switchable", () => {
  const helvetica = fontActionStates(listTarget("Helvetica"), ctx);
  assert.ok(!helvetica.turnOn.enabled && !helvetica.turnOff.enabled, "a macOS font is always on");
  assert.ok(!helvetica.remove.enabled, "and stays in the library");
  const bold = fontActionStates(listTarget("Inter/Bold"), ctx);
  assert.ok(!bold.turnOn.enabled && bold.turnOff.enabled, "already on: only Turn Off");
  const lora = fontActionStates(listTarget("Lora"), ctx);
  assert.ok(lora.turnOn.enabled && !lora.turnOff.enabled);
  const waiting = groupFamilies([font("Waits", "Regular", { activated: true, osActive: false })]);
  const w = fontActionStates({ where: "list", items: [{ rowKey: "x", family: waiting[0], face: waiting[0].faces[0], kind: "family" }], faces: waiting[0].faces }, ctx);
  assert.ok(w.turnOn.enabled && w.turnOff.enabled, "set to turn on but not on: either way");
});

test("the saved activation mode goes first, by name", () => {
  const s = fontActionStates(listTarget("Lora"), { ...ctx, mode: "temporary" });
  assert.equal(s.turnOn.label, "Turn On Until Logout");
  assert.equal(s.turnOnOther.label, "Turn On");
  assert.equal(scopeOf("turnOn", "temporary"), null, "the saved way: the back end uses the setting");
  assert.equal(scopeOf("turnOnOther", "temporary"), "persistent");
  assert.equal(scopeOf("turnOnOther", "persistent"), "temporary");
});

test("Option-click turns on the other way; turning off is the same either way", () => {
  assert.equal(switchScope(true, false, "persistent"), null);
  assert.equal(switchScope(true, true, "persistent"), "temporary");
  assert.equal(switchScope(true, true, "temporary"), "persistent");
  assert.equal(switchScope(false, true, "persistent"), null);
});

test("when quitting Fontface turns temporary fonts off, the words say so", () => {
  // Settings › Activation › "Turn temporary fonts off when Fontface quits".
  assert.equal(markName("temporary", { lock: null, total: 1, on: 1, wanted: 1, temporary: 1, waiting: 0, elsewhere: 0, locked: 0, macos: 0 }, true), "On until Fontface quits");
  assert.equal(turnOnLabel("temporary"), "Turn On Until Logout");
  assert.equal(turnOnLabel("temporary", true), "Turn On Until Fontface Quits");
  assert.equal(turnOnLabel("persistent", true), "Turn On");
  const s = fontActionStates(listTarget("Lora"), { ...ctx, untilQuit: true });
  assert.equal(s.turnOn.label, "Turn On");
  assert.equal(s.turnOnOther.label, "Turn On Until Fontface Quits");
  const t = fontActionStates(listTarget("Lora"), { ...ctx, mode: "temporary", untilQuit: true });
  assert.equal(t.turnOn.label, "Turn On Until Fontface Quits", "the saved way goes first");
});

test("on the font page: the family's styles, the chosen style's name and file", () => {
  const regular = fam("Lora").representative;
  assert.deepEqual(pageTarget(fam("Lora"), regular, regular).faces, [regular], "a right-clicked line covers its style");
  const inter = fam("Inter");
  const bold = inter.faces.find((f) => f.style === "Bold")!;
  const t = pageTarget(inter, bold);
  const s = fontActionStates(t, ctx);
  assert.ok(!s.open.enabled, "already open");
  assert.ok(s.info.enabled, "Show Info goes to the page's Info tab");
  assert.equal(s.copyPostScript.label, "Copy PostScript Name");
  assert.deepEqual(postScriptNames(t), ["Inter-Bold"]);
  assert.equal(revealFontOf(t)?.id, bold.primary.id);
  assert.equal(s.compare.label, "Compare With…");
  assert.ok(s.turnOn.enabled && s.turnOff.enabled, "the family is partly on");
});

test("Remove from Library is for fonts in your folders", () => {
  assert.ok(fontActionStates(listTarget("Lora"), ctx).remove.enabled);
  assert.ok(!fontActionStates(listTarget("Roboto"), ctx).remove.enabled, "Google Fonts have their own Uninstall");
});

test("the removal plan: what goes, what stays, and other styles in the same file", () => {
  const ttc = "/fonts/Family.ttc";
  const fams = groupFamilies([
    font("Gill", "Regular", { path: ttc }),
    font("Gill", "Bold", { path: ttc }),
    font("Gill", "Italic", { path: "/fonts/GillItalic.otf" }),
    // Also in Google Fonts: stays listed from that copy.
    font("Gill", "Light", { path: "/fonts/GillLight.otf" }),
    font("Gill", "Light", { path: "/google/GillLight.otf", folderId: 3 }),
    font("Arial", "Regular", { folderId: 2, installed: true, path: "/Library/Fonts/Arial.ttf" }),
  ]);
  const all = fams.flatMap((f) => f.faces);
  const gill = fams.find((f) => f.name === "Gill")!;
  const regular = gill.faces.find((f) => f.style === "Regular")!;
  const light = gill.faces.find((f) => f.style === "Light")!;
  const arial = fams.find((f) => f.name === "Arial")!.faces[0];
  const plan = removalPlan([regular, light, arial], all, ctx.removable);
  assert.deepEqual(plan.files.sort(), [ttc, "/fonts/GillLight.otf"].sort());
  assert.deepEqual(plan.folders, [1]);
  assert.equal(plan.leaving, 1, "Regular leaves");
  assert.equal(plan.staying, 1, "Light stays, from its Google copy");
  assert.equal(plan.blocked, 1, "Arial is installed");
  assert.equal(plan.others, 1, "Bold shares Regular's file");
  const bold = gill.faces.find((f) => f.style === "Bold")!;
  assert.ok(plan.ids.includes(bold.primary.id), "the whole file goes, so its other fonts are listed too");
  assert.ok(!plan.ids.includes(arial.primary.id));
  const words = removalSummary(plan, "macOS");
  assert.match(words[0], /turns off 2 font files in your folders/);
  assert.match(words[0], /Nothing is deleted/);
  assert.ok(words.some((w) => /1 other style is in the same files, so it goes too/.test(w)));
  assert.ok(words.some((w) => /1 style stays listed from its other copies/.test(w)));
  assert.ok(words.some((w) => /Fonts from macOS, Google Fonts and Purchases/.test(w)));
  assert.deepEqual(removalSummary(removalPlan([arial], all, ctx.removable), "macOS"), [], "nothing to remove: nothing to say");
});

// ------------------------------------------------------------------------ keyboard

const key = (k: string, mods: Partial<ShortcutKey> = {}): ShortcutKey => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test("font shortcuts: Cmd+I, Cmd+T, Cmd+Return, Option-Cmd+Return, Shift-Cmd+Return", () => {
  assert.equal(fontShortcut(key("i", { metaKey: true }), true), "info");
  assert.equal(fontShortcut(key("ˆ", { metaKey: true, code: "KeyI" }), true), "info", "the physical I key");
  assert.equal(fontShortcut(key("c", { metaKey: true, code: "KeyI" }), true), null, "Dvorak's Cmd+C (on QWERTY's I key) stays Copy");
  assert.equal(fontShortcut(key("и", { metaKey: true, code: "KeyI" }), true), "info", "a non-Latin layout uses the key's place");
  assert.equal(fontShortcut(key("y", { metaKey: true, code: "KeyT" }), true), null, "Dvorak's Cmd+Y isn't Tags");
  assert.equal(fontShortcut(key("i", { metaKey: true, shiftKey: true }), true), null);
  assert.equal(fontShortcut(key("i", { ctrlKey: true }), false), "info", "Ctrl on Windows");
  assert.equal(shortcutText("info", true), "⌘I");
  assert.equal(fontShortcut(key("t", { metaKey: true }), true), "tags");
  assert.equal(fontShortcut(key("†", { metaKey: true, code: "KeyT" }), true), "tags", "the physical T key");
  assert.equal(fontShortcut(key("t", { ctrlKey: true }), true), null, "Ctrl isn't Cmd on macOS");
  assert.equal(fontShortcut(key("t", { ctrlKey: true }), false), "tags", "Ctrl on Windows");
  assert.equal(fontShortcut(key("T", { metaKey: true, shiftKey: true }), true), null);
  assert.equal(fontShortcut(key("Enter", { metaKey: true }), true), "turnOn");
  assert.equal(fontShortcut(key("Enter", { metaKey: true, altKey: true }), true), "turnOnOther");
  assert.equal(fontShortcut(key("Enter", { metaKey: true, shiftKey: true }), true), "turnOff");
  assert.equal(fontShortcut(key("Enter"), true), null, "Return alone opens");
  assert.equal(shortcutText("turnOnOther", true), "⌥⌘↩");
  assert.equal(shortcutText("tags", false), "Ctrl+T");
  assert.equal(shortcutText("open", true), undefined);
});

test("a Cmd+T ask opens only the page it was for, and only once", () => {
  // Page A was asked (count 1) and has seen it. Then font page B, opened over A from Compare,
  // is asked (count 2): A gets no count (undefined), so its Tags popover stays shut.
  assert.equal(newTagsAsk(1, undefined), false, "an ask for another page");
  assert.equal(newTagsAsk(0, 2), true, "B's first ask");
  assert.equal(newTagsAsk(2, 2), false, "the same ask again (a re-render)");
  assert.equal(newTagsAsk(1, 3), true, "A asked again later");
  assert.equal(newTagsAsk(3, 1), false, "never an older ask");
  assert.equal(newTagsAsk(0, 0), false, "the first render isn't an ask");
});

test("the shortcut guard drops a menu echo of a key press, once", () => {
  const guard = createShortcutGuard(250);
  assert.ok(guard.allow("back", "key", 1000));
  assert.ok(!guard.allow("back", "menu", 1100), "the menu's event for the same press");
  assert.ok(guard.allow("back", "menu", 1150), "a real menu click after it runs");
  assert.ok(guard.allow("back", "key", 1600));
  assert.ok(guard.allow("back", "key", 1610), "two key presses both run");
  assert.ok(!guard.allow("back", "menu", 1700));
  assert.ok(guard.allow("back", "menu", 2000), "long after: a new command");
  assert.ok(guard.allow("size:1", "menu", 3000));
  assert.ok(!guard.allow("size:1", "key", 3010), "either way round");
  assert.ok(guard.allow("layout:rows", "key", 3010), "commands are guarded one by one");
});

// ---------------------------------------------------------------------- macOS menus

test("every menu id parses back to its command, and names it for the guard", () => {
  assert.equal(new Set(MENU_IDS).size, MENU_IDS.length, "ids are unique");
  for (const id of MENU_IDS) assert.ok(menuCommand(id), `${id} is a command`);
  assert.deepEqual(menuCommand(LAYOUT_ITEMS.table), { kind: "layout", layout: "table" });
  assert.deepEqual(menuCommand(SORT_ITEMS.added!), { kind: "sort", key: "added" });
  assert.deepEqual(menuCommand(SORT_DESC_ITEM), { kind: "direction", desc: true });
  assert.deepEqual(menuCommand(SMALLER_ITEM), { kind: "size", step: -1 });
  assert.deepEqual(menuCommand(BACK_ITEM), { kind: "back" });
  assert.deepEqual(menuCommand(FONT_ITEMS.remove), { kind: "font", action: "remove" });
  assert.deepEqual(menuCommand(FONT_ITEMS.info), { kind: "font", action: "info" });
  assert.equal(menuCommand("settings"), null, "the app menu's own items aren't the page's");
  assert.equal(commandName({ kind: "back" }), "back");
  assert.equal(commandName({ kind: "size", step: 1 }), "size:1");
  assert.equal(commandName({ kind: "font", action: "tags" }), "font:tags");
});

test("menu state: the list's commands only while it shows; Back only with a page; font items by target", () => {
  const actions = fontActionStates(listTarget("Lora"), ctx);
  const base = { layout: "rows" as const, groupStyles: true, sort: { key: "name" as const, desc: false }, size: 32, actions };
  const list = nativeMenuState({ ...base, list: true, back: false });
  assert.ok(list.enabled.includes(LAYOUT_ITEMS.tiles) && list.enabled.includes(BIGGER_ITEM) && list.enabled.includes(SMALLER_ITEM));
  assert.ok(!list.enabled.includes(BACK_ITEM));
  assert.ok(list.checked.includes(LAYOUT_ITEMS.rows) && list.checked.includes(GROUP_ITEM));
  assert.ok(list.checked.includes(SORT_ITEMS.name!) && list.checked.includes(SORT_ASC_ITEM));
  assert.equal(list.texts[SORT_ASC_ITEM], "A to Z");
  assert.equal(list.texts[FONT_ITEMS.turnOn], "Turn On");
  assert.ok(list.enabled.includes(FONT_ITEMS.open) && list.enabled.includes(FONT_ITEMS.turnOn));
  assert.ok(!list.enabled.includes(FONT_ITEMS.turnOff), "Lora is off");

  const page = nativeMenuState({ ...base, list: false, back: true, actions: fontActionStates(null, ctx) });
  assert.ok(page.enabled.includes(BACK_ITEM));
  assert.ok(!page.enabled.includes(LAYOUT_ITEMS.tiles), "layouts wait for the list");
  assert.ok(page.checked.includes(LAYOUT_ITEMS.rows), "but still show which is picked");
  assert.ok(!page.enabled.some((id) => id.startsWith("font.")));

  const biggest = nativeMenuState({ ...base, list: true, back: false, size: 128 });
  assert.ok(!biggest.enabled.includes(BIGGER_ITEM) && biggest.enabled.includes(SMALLER_ITEM));
  const newest = nativeMenuState({ ...base, list: true, back: false, sort: { key: "added", desc: true } });
  assert.ok(newest.checked.includes(SORT_DESC_ITEM));
  assert.equal(newest.texts[SORT_DESC_ITEM], "Newest first");
  const byFormat = nativeMenuState({ ...base, list: true, back: false, sort: { key: "format", desc: false } });
  assert.ok(!Object.values(SORT_ITEMS).some((id) => byFormat.checked.includes(id!)), "a Table-only sort checks no key item");

  // The Google Fonts view: one layout and the catalog's order, so only the size steps.
  const catalog = nativeMenuState({ ...base, list: true, catalog: true, back: false });
  assert.ok(catalog.enabled.includes(BIGGER_ITEM) && catalog.enabled.includes(SMALLER_ITEM));
  assert.ok(!catalog.enabled.includes(LAYOUT_ITEMS.tiles) && !catalog.enabled.includes(LAYOUT_ITEMS.rows) && !catalog.enabled.includes(GROUP_ITEM));
  assert.ok(!catalog.enabled.some((id) => id.startsWith("sort.")));
  assert.ok(catalog.enabled.includes(FONT_ITEMS.open), "the font menu follows the selected family");

  assert.equal(menuStateKey(list), menuStateKey({ ...list, enabled: [...list.enabled].reverse() }), "order doesn't matter");
  assert.notEqual(menuStateKey(list), menuStateKey(page));
});

test("view commands: the size wherever the preview bar's size applies, the layouts and sort only in the library list", () => {
  assert.deepEqual(viewCommands({ covered: false, service: null }), { size: true, arrange: true });
  assert.deepEqual(viewCommands({ covered: false, service: "google" }), { size: true, arrange: false });
  // Adobe Fonts' previews follow the bar's size too, once there are fonts (and so a bar).
  assert.deepEqual(viewCommands({ covered: false, service: "adobe", adobeFonts: true }), { size: true, arrange: false });
  assert.deepEqual(viewCommands({ covered: false, service: "adobe", adobeFonts: false }), { size: false, arrange: false });
  for (const service of [null, "google", "adobe"] as const)
    assert.deepEqual(viewCommands({ covered: true, service, adobeFonts: true }), { size: false, arrange: false }, "nothing under Settings or a page");

  // What App sends the menus for Adobe Fonts: Bigger and Smaller on, the layouts and sort off.
  const adobe = viewCommands({ covered: false, service: "adobe", adobeFonts: true });
  const actions = fontActionStates(null, ctx);
  const menus = nativeMenuState({ list: adobe.size, catalog: !adobe.arrange, back: false, layout: "rows", groupStyles: true, sort: { key: "name", desc: false }, size: 32, actions });
  assert.ok(menus.enabled.includes(BIGGER_ITEM) && menus.enabled.includes(SMALLER_ITEM));
  assert.ok(!menus.enabled.includes(LAYOUT_ITEMS.tiles) && !menus.enabled.includes(GROUP_ITEM));
  assert.ok(!menus.enabled.some((id) => id.startsWith("sort.")));
});

test("a switch and the marks beside it have short names for their tooltips, not sentences", () => {
  const off = { lock: null, total: 12, on: 0, wanted: 0, temporary: 0, waiting: 0, elsewhere: 0, locked: 0, macos: 0 };
  assert.equal(SWITCH_TIP, "Activate", "as the switch's name starts: Activate Inter");
  assert.equal(markName("macos", { ...off, lock: "macos" }), "Part of macOS");
  assert.equal(markName("installed", { ...off, lock: "installed" }), "Installed");
  assert.equal(markName("temporary", { ...off, on: 12, wanted: 12, temporary: 12 }), "On until logout");
  assert.equal(markName("waiting", { ...off, wanted: 12, waiting: 12 }), "Not on yet");
  assert.equal(markName("elsewhere", { ...off, on: 12, wanted: 12, elsewhere: 12 }), "Turned on by another app");
  assert.equal(markName("partial", { ...off, on: 3, wanted: 3 }), "3 of 12 on");
  for (const mark of ["macos", "installed", "temporary", "waiting", "elsewhere", "partial"] as const) {
    const name = markName(mark, { ...off, on: 3, wanted: 3 });
    assert.ok(!name.endsWith(".") && name.split(" ").length <= 5, `${mark}: ${name}`);
  }
});
