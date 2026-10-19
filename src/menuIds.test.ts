// Run with `npm run test:ui`. The macOS View and Font menus (src-tauri/src/window.rs) and the
// page (fontActions.ts) agree on every item's id, and each item's key is the page's own shortcut,
// so the two handle the same key press (and the guard can drop the second).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fontShortcut, MENU_IDS, menuCommand, type ShortcutKey } from "./fontActions.ts";
import { isBackShortcut } from "./nav.ts";
import { layoutShortcut, sizeShortcut } from "./viewOptions.ts";

const rust = readFileSync(new URL("../src-tauri/src/window.rs", import.meta.url), "utf8");
/** Each `item(...)` and `check(...)` in VIEW_MENU and FONT_MENU: id and accelerator. */
const menus = rust.slice(rust.indexOf("pub const VIEW_MENU"), rust.indexOf("/// Every item of the View and Font menus"));
const entries = [...menus.matchAll(/\b(?:item|check)\("([^"]+)",\s*"[^"]*",\s*(None|Some\("([^"]+)"\))\)/g)].map((m) => ({ id: m[1], accelerator: m[3] ?? null }));

test("window.rs and fontActions.ts list the same menu items", () => {
  assert.ok(entries.length > 20, "found the menus in window.rs");
  assert.deepEqual(
    entries.map((e) => e.id).sort(),
    [...MENU_IDS].sort(),
  );
});

/** The key press a menu accelerator stands for, on macOS. */
function press(accelerator: string): ShortcutKey {
  const parts = accelerator.split("+");
  const key = parts.pop()!;
  const code = /^\d$/.test(key) ? `Digit${key}` : key === "=" ? "Equal" : key === "-" ? "Minus" : key === "[" ? "BracketLeft" : /^[A-Z]$/.test(key) ? `Key${key}` : undefined;
  return {
    key: /^[A-Z]$/.test(key) ? key.toLowerCase() : key,
    code,
    metaKey: parts.includes("CmdOrCtrl"),
    ctrlKey: false,
    altKey: parts.includes("Alt"),
    shiftKey: parts.includes("Shift"),
  };
}

test("each menu shortcut is the page's own shortcut for the same command", () => {
  for (const { id, accelerator } of entries) {
    if (!accelerator) continue;
    const command = menuCommand(id)!;
    const e = press(accelerator);
    switch (command.kind) {
      case "layout":
        assert.equal(layoutShortcut(e, true), command.layout, id);
        break;
      case "size":
        assert.equal(sizeShortcut(e, true), command.step, id);
        break;
      case "back":
        assert.ok(isBackShortcut(e, true), id);
        break;
      case "font":
        assert.equal(fontShortcut(e, true), command.action, id);
        break;
      default:
        assert.fail(`${id} has a shortcut the page doesn't handle`);
    }
  }
});
