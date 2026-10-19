/**
 * The words around a tooltip that aren't React, so `npm run test:ui` covers them: a keyboard
 * shortcut as the app shows it (the way the menus do: ⌘ on macOS, Ctrl+ on Windows), as a screen
 * reader should say it, and as `aria-keyshortcuts` wants it; and what a tooltip adds to its
 * control's description. The tooltip parts themselves are components/Tip.tsx.
 */

/**
 * A keyboard shortcut, written once for both platforms: "Mod+1", "Shift+Mod+Enter",
 * "Alt+Mod+Enter", "Mod+,". `Mod` is Command on macOS and Ctrl on Windows; `Alt` is Option on
 * macOS; `Ctrl` is the Control key on both. The key comes last; modifiers can be in any order
 * (they're shown in the platform's order). Write "Plus" for the + key. When the platforms use
 * different keys, give both: `{ mac: "Mod+[", other: "Alt+Left" }`.
 */
export type ShortcutSpec = string | { mac: string; other: string };

type Modifier = "ctrl" | "alt" | "shift" | "mod";

const MODIFIERS: Record<string, Modifier> = {
  mod: "mod",
  cmd: "mod",
  command: "mod",
  meta: "mod",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

interface KeyWords {
  /** Shown on macOS (a glyph where the menus use one). */
  mac: string;
  /** Shown on Windows. */
  other: string;
  /** The `aria-keyshortcuts` key name (a UI Events key value). */
  aria: string;
  /** Said on macOS. */
  macSaid: string;
  /** Said on Windows. */
  otherSaid: string;
}

const key = (mac: string, other: string, aria: string, macSaid = other, otherSaid = macSaid): KeyWords => ({ mac, other, aria, macSaid, otherSaid });

const KEYS: Record<string, KeyWords> = {
  enter: key("↩", "Enter", "Enter", "Return", "Enter"),
  return: key("↩", "Enter", "Enter", "Return", "Enter"),
  esc: key("Esc", "Esc", "Escape", "Escape"),
  escape: key("Esc", "Esc", "Escape", "Escape"),
  space: key("Space", "Space", "Space"),
  tab: key("⇥", "Tab", "Tab", "Tab"),
  backspace: key("⌫", "Backspace", "Backspace", "Delete", "Backspace"),
  delete: key("⌦", "Delete", "Delete", "Forward Delete", "Delete"),
  del: key("⌦", "Delete", "Delete", "Forward Delete", "Delete"),
  left: key("←", "Left", "ArrowLeft", "Left Arrow"),
  arrowleft: key("←", "Left", "ArrowLeft", "Left Arrow"),
  right: key("→", "Right", "ArrowRight", "Right Arrow"),
  arrowright: key("→", "Right", "ArrowRight", "Right Arrow"),
  up: key("↑", "Up", "ArrowUp", "Up Arrow"),
  arrowup: key("↑", "Up", "ArrowUp", "Up Arrow"),
  down: key("↓", "Down", "ArrowDown", "Down Arrow"),
  arrowdown: key("↓", "Down", "ArrowDown", "Down Arrow"),
  home: key("Home", "Home", "Home"),
  end: key("End", "End", "End"),
  pageup: key("Page Up", "Page Up", "PageUp"),
  pagedown: key("Page Down", "Page Down", "PageDown"),
  plus: key("+", "+", "Plus", "Plus"),
  // The menus show a real minus sign, not a hyphen.
  "-": key("−", "−", "-", "Minus"),
  minus: key("−", "−", "-", "Minus"),
  "=": key("=", "=", "=", "Equals"),
  ",": key(",", ",", ",", "Comma"),
  ".": key(".", ".", ".", "Period"),
  "/": key("/", "/", "/", "Slash"),
  "\\": key("\\", "\\", "\\", "Backslash"),
  ";": key(";", ";", ";", "Semicolon"),
  "'": key("'", "'", "'", "Quote"),
  "`": key("`", "`", "`", "Backtick"),
  "[": key("[", "[", "[", "Left Bracket"),
  "]": key("]", "]", "]", "Right Bracket"),
};

/** A key with no entry above: a letter (shown upper case), a digit or F1–F12, as typed. */
const plainKey = (k: string): KeyWords => {
  const shown = k.length === 1 ? k.toUpperCase() : k;
  return key(shown, shown, shown, shown);
};

/** Reads a spec for one platform. Anything it doesn't know as a modifier is part of the key. */
function parse(spec: ShortcutSpec, mac: boolean): { mods: Set<Modifier>; key: KeyWords } {
  const text = typeof spec === "string" ? spec : mac ? spec.mac : spec.other;
  const parts = text.split("+").map((p) => p.trim());
  const mods = new Set<Modifier>();
  let i = 0;
  for (; i < parts.length - 1; i++) {
    const m = MODIFIERS[parts[i].toLowerCase()];
    if (!m) break;
    mods.add(m);
  }
  const rest = parts.slice(i).join("+");
  return { mods, key: KEYS[rest.toLowerCase()] ?? plainKey(rest) };
}

/** Modifiers in each platform's order: ⌃⌥⇧⌘ on macOS (as its menus show them), Ctrl, Alt, Shift on Windows. */
const MAC_ORDER: Modifier[] = ["ctrl", "alt", "shift", "mod"];
const OTHER_ORDER: Modifier[] = ["mod", "ctrl", "alt", "shift"];

/**
 * The shortcut as the app shows it, the way its menus do: "⇧⌘↩" on macOS, "Ctrl+Shift+Enter" on
 * Windows.
 */
export function shortcutLabel(spec: ShortcutSpec, mac: boolean): string {
  const { mods, key: k } = parse(spec, mac);
  if (mac) {
    const glyph: Record<Modifier, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", mod: "⌘" };
    return MAC_ORDER.filter((m) => mods.has(m)).map((m) => glyph[m]).join("") + k.mac;
  }
  const word: Record<Modifier, string> = { mod: "Ctrl", ctrl: "Ctrl", alt: "Alt", shift: "Shift" };
  const names = [...new Set(OTHER_ORDER.filter((m) => mods.has(m)).map((m) => word[m]))];
  return [...names, k.other].join("+");
}

/** The shortcut as a screen reader should say it: "Command-Shift-Return", "Ctrl+Shift+Enter". */
export function shortcutSaid(spec: ShortcutSpec, mac: boolean): string {
  const { mods, key: k } = parse(spec, mac);
  if (mac) {
    const word: Record<Modifier, string> = { ctrl: "Control", alt: "Option", shift: "Shift", mod: "Command" };
    return [...MAC_ORDER.filter((m) => mods.has(m)).map((m) => word[m]), k.macSaid].join("-");
  }
  const word: Record<Modifier, string> = { mod: "Ctrl", ctrl: "Ctrl", alt: "Alt", shift: "Shift" };
  const names = [...new Set(OTHER_ORDER.filter((m) => mods.has(m)).map((m) => word[m]))];
  return [...names, k.otherSaid].join("+");
}

/** The shortcut for `aria-keyshortcuts`: "Meta+Shift+Enter" on macOS, "Control+Shift+Enter" on Windows. */
export function shortcutAria(spec: ShortcutSpec, mac: boolean): string {
  const { mods, key: k } = parse(spec, mac);
  const word: Record<Modifier, string> = { ctrl: "Control", alt: "Alt", shift: "Shift", mod: mac ? "Meta" : "Control" };
  const names = [...new Set((mac ? MAC_ORDER : OTHER_ORDER).filter((m) => mods.has(m)).map((m) => word[m]))];
  return [...names, k.aria].join("+");
}

/**
 * What a tooltip adds to its control's description for screen readers: its words, then the
 * shortcut as said ("Shows fonts as tiles (Command-1)").
 */
export function tipSaid(words: string, said?: string): string {
  return said ? `${words} (${said})` : words;
}

/** Ids for `aria-describedby`, the control's own first; undefined when there are none. */
export function joinIds(...ids: (string | null | undefined | false)[]): string | undefined {
  const all = ids.filter((id): id is string => !!id);
  return all.length ? all.join(" ") : undefined;
}
