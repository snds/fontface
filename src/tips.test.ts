// Run with `npm run test:ui`. Shortcut words for tooltips, and their screen-reader description (tips.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { shortcutText } from "./fontActions.ts";
import { joinIds, shortcutAria, shortcutLabel, shortcutSaid, tipSaid } from "./tips.ts";

test("Mod is Command on macOS and Ctrl on Windows", () => {
  assert.equal(shortcutLabel("Mod+1", true), "⌘1");
  assert.equal(shortcutLabel("Mod+1", false), "Ctrl+1");
  assert.equal(shortcutLabel("Mod+,", true), "⌘,");
  assert.equal(shortcutLabel("Mod+,", false), "Ctrl+,");
  assert.equal(shortcutLabel("Cmd+T", true), "⌘T", "Cmd works as Mod");
  assert.equal(shortcutLabel("mod+t", false), "Ctrl+T", "any case; letters show upper case");
});

test("modifiers come in each platform's order, whatever order they're written in", () => {
  assert.equal(shortcutLabel("Mod+Shift+Enter", true), "⇧⌘↩");
  assert.equal(shortcutLabel("Shift+Mod+Enter", true), "⇧⌘↩");
  assert.equal(shortcutLabel("Mod+Shift+Enter", false), "Ctrl+Shift+Enter");
  assert.equal(shortcutLabel("Shift+Alt+Ctrl+Mod+K", true), "⌃⌥⇧⌘K");
  assert.equal(shortcutLabel("Shift+Alt+Mod+K", false), "Ctrl+Alt+Shift+K");
  assert.equal(shortcutLabel("Ctrl+Mod+K", false), "Ctrl+K", "Ctrl and Mod are the same key on Windows");
});

test("the same text the menus show for the font actions", () => {
  const specs = { info: "Mod+I", tags: "Mod+T", turnOn: "Mod+Enter", turnOnOther: "Alt+Mod+Enter", turnOff: "Shift+Mod+Enter" } as const;
  for (const [action, spec] of Object.entries(specs)) {
    for (const mac of [true, false]) {
      assert.equal(shortcutLabel(spec, mac), shortcutText(action as keyof typeof specs, mac), `${action}, mac: ${mac}`);
    }
  }
});

test("keys with a glyph or a word", () => {
  assert.equal(shortcutLabel("Mod+-", true), "⌘−", "a real minus sign, like View options");
  assert.equal(shortcutLabel("Mod+=", false), "Ctrl+=");
  assert.equal(shortcutLabel("Mod+Plus", false), "Ctrl++");
  assert.equal(shortcutLabel("Esc", true), "Esc");
  assert.equal(shortcutLabel("Mod+Backspace", true), "⌘⌫");
  assert.equal(shortcutLabel("Alt+Left", false), "Alt+Left");
  assert.equal(shortcutLabel("Alt+Left", true), "⌥←");
  assert.equal(shortcutLabel("Shift+F10", false), "Shift+F10");
  assert.equal(shortcutLabel("Space", true), "Space");
});

test("different keys on each platform", () => {
  const back = { mac: "Mod+[", other: "Alt+Left" };
  assert.equal(shortcutLabel(back, true), "⌘[");
  assert.equal(shortcutLabel(back, false), "Alt+Left");
  assert.equal(shortcutAria(back, true), "Meta+[");
  assert.equal(shortcutAria(back, false), "Alt+ArrowLeft");
  assert.equal(shortcutSaid(back, true), "Command-Left Bracket");
});

test("aria-keyshortcuts uses key values: Meta on macOS, Control on Windows", () => {
  assert.equal(shortcutAria("Mod+1", true), "Meta+1");
  assert.equal(shortcutAria("Mod+1", false), "Control+1");
  assert.equal(shortcutAria("Mod+,", true), "Meta+,");
  assert.equal(shortcutAria("Shift+Mod+Enter", true), "Shift+Meta+Enter");
  assert.equal(shortcutAria("Alt+Mod+Enter", false), "Control+Alt+Enter");
  assert.equal(shortcutAria("Ctrl+Mod+K", false), "Control+K");
  assert.equal(shortcutAria("Esc", true), "Escape");
  assert.equal(shortcutAria("Mod+Plus", true), "Meta+Plus");
  assert.equal(shortcutAria("Mod+-", true), "Meta+-");
});

test("said the way each platform names the keys", () => {
  assert.equal(shortcutSaid("Shift+Mod+Enter", true), "Shift-Command-Return");
  assert.equal(shortcutSaid("Alt+Mod+Enter", true), "Option-Command-Return");
  assert.equal(shortcutSaid("Shift+Mod+Enter", false), "Ctrl+Shift+Enter");
  assert.equal(shortcutSaid("Mod+,", true), "Command-Comma");
  assert.equal(shortcutSaid("Mod+=", true), "Command-Equals");
  assert.equal(shortcutSaid("Mod+-", false), "Ctrl+Minus");
  assert.equal(shortcutSaid("Mod+Backspace", true), "Command-Delete");
  assert.equal(shortcutSaid("Mod+1", true), "Command-1");
});

test("a key it doesn't know is shown as written", () => {
  assert.equal(shortcutLabel("Mod+Foo", false), "Ctrl+Foo");
  assert.equal(shortcutLabel("Hyper+K", false), "Hyper+K", "an unknown modifier is part of the key");
});

test("the description adds the shortcut as said", () => {
  assert.equal(tipSaid("Shows fonts as tiles"), "Shows fonts as tiles");
  assert.equal(tipSaid("Shows fonts as tiles", "Command-1"), "Shows fonts as tiles (Command-1)");
});

test("description ids keep the control's own first", () => {
  assert.equal(joinIds("own", "tip"), "own tip");
  assert.equal(joinIds(undefined, "tip"), "tip");
  assert.equal(joinIds("own", undefined), "own");
  assert.equal(joinIds(undefined, null, false, ""), undefined);
});
