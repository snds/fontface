// Run with `npm run test:ui`. The see-through window: its words, when it's greyed out
// (translucency.ts), and whether its tints keep text readable (src/index.css).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { TranslucencyState } from "./api.ts";
import {
  platformOf,
  translucencyDescription,
  translucencyDisabledReason,
  translucencyOptions,
  translucencyShown,
  type Platform,
} from "./translucency.ts";
import { THEME_COLORS, luminance } from "./previewStyle.ts";

const t = (over: Partial<TranslucencyState> = {}): TranslucencyState => ({
  look: null,
  window: false,
  reduced: false,
  unsupported: false,
  nextLaunch: false,
  ...over,
});
const PLATFORMS: Platform[] = ["mac", "windows", "linux"];

test("each system is told apart from the web view's user agent", () => {
  assert.equal(platformOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"), "mac");
  assert.equal(platformOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/130.0"), "windows");
  assert.equal(platformOf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15"), "linux");
});

test("Linux says why it starts off, in plain words", () => {
  const linux = translucencyDescription("linux", t());
  assert.match(linux, /Linux has no standard blur/);
  assert.match(linux, /starts off/);
  for (const p of ["mac", "windows"] as const) {
    assert.match(translucencyDescription(p, t()), /so text keeps its contrast/, p);
    assert.doesNotMatch(translucencyDescription(p, t()), /starts off/, p);
  }
});

test("turned on after a solid window was made, it says to open Fontface again", () => {
  assert.match(translucencyDescription("linux", t({ nextLaunch: true })), /Open Fontface again to see it\.$/);
  assert.match(translucencyDescription("windows", t({ nextLaunch: true })), /Open Fontface again to see it\.$/);
  assert.doesNotMatch(translucencyDescription("mac", t({ look: "blur" })), /again/);
});

test("the system's reduce-transparency choice greys the choice out and says where it is", () => {
  assert.equal(translucencyDisabledReason("mac", t({ look: "blur", window: true })), false);
  assert.match(translucencyDisabledReason("mac", t({ reduced: true })) || "", /System Settings › Accessibility › Display/);
  assert.match(translucencyDisabledReason("windows", t({ reduced: true })) || "", /Transparency effects are off/);
  assert.match(translucencyDisabledReason("linux", t({ reduced: true })) || "", /reduce transparency/);
  assert.match(translucencyDisabledReason("windows", t({ unsupported: true })) || "", /^Needs Windows 11/);
});

test("the choice shows Off while the system rules it out", () => {
  assert.equal(translucencyShown("window", t({ look: "blur", window: true })), "window");
  assert.equal(translucencyShown("sidebar", t({ nextLaunch: true })), "sidebar", "chosen, waiting for the next launch");
  assert.equal(translucencyShown("window", t({ reduced: true })), "off");
  assert.equal(translucencyShown("sidebar", t({ unsupported: true })), "off");
});

test("three choices, each with a tooltip saying what it does", () => {
  for (const p of PLATFORMS) {
    const options = translucencyOptions(p);
    assert.deepEqual(
      options.map((o) => [o.value, o.label]),
      [
        ["off", "Off"],
        ["sidebar", "Sidebar"],
        ["window", "Whole window"],
      ],
    );
    assert.equal(options[0].tip, "Keeps the window solid");
    assert.match(options[1].tip, /through the sidebar only$/);
    assert.match(options[2].tip, /faintly behind font lists and pages$/);
  }
  assert.doesNotMatch(translucencyOptions("linux")[2].tip, /softly/, "nothing softens it on Linux");
});

test("index.html and the page keep the same first-paint key and states", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const page = readFileSync(new URL("./settings/translucent.ts", import.meta.url), "utf8");
  assert.match(html, /localStorage\.getItem\("fontface\.translucent"\)/);
  assert.match(page, /const KEY = "fontface\.translucent";/);
  assert.match(html, /shown\[0\] === "blur" \|\| shown\[0\] === "plain"/);
  assert.match(html, /shown\[1\] === "window"/);
  assert.match(page, /"\+window"/);
});

test("both Rust and the page start off on Linux only", () => {
  const rust = readFileSync(new URL("../src-tauri/src/settings.rs", import.meta.url), "utf8");
  assert.match(rust, /TRANSLUCENCY_BY_DEFAULT: Translucency = if cfg!\(target_os = "linux"\) \{ Translucency::Off \} else \{ Translucency::Window \};/);
  const page = readFileSync(new URL("./translucency.ts", import.meta.url), "utf8");
  assert.match(page, /TRANSLUCENCY_BY_DEFAULT: TranslucencySetting = PLATFORM === "linux" \? "off" : "window";/);
});

// ---------------------------------------------------------------------------------- contrast

// The tints in src/index.css, checked against the worst desktop each look can sit on: with
// "plain" (Linux) the raw desktop, so pure black under the light theme and pure white under the
// dark one. With "blur" the OS's own material sits between the desktop and the page, so the
// worst is that material over a black or white desktop. These are cautious guesses at it
// (macOS's sidebar material and Windows 11's Mica are lighter than this in light mode and darker
// in dark mode), so the real window should do better than what's checked here.
const WORST_BACKDROP = {
  light: { blur: 0x99 / 255, plain: 0 },
  dark: { blur: 0x73 / 255, plain: 1 },
} as const;

/** WCAG AA for body text, and AAA for the main text colors. */
const FAINT_TEXT = 4.5;
const MAIN_TEXT = 7;

type Gray = { l: number; alpha: number };

/** Every custom property in the `:root` blocks, then (for dark) the `.dark` blocks over them. */
function tokens(css: string, theme: "light" | "dark"): Map<string, string> {
  const out = new Map<string, string>();
  const blocks = [...css.matchAll(/(^|\n)(:root|\.dark) \{([^}]*)\}/g)];
  for (const wanted of theme === "light" ? [":root"] : [":root", ".dark"]) {
    for (const [, , selector, body] of blocks) {
      if (selector !== wanted) continue;
      for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out.set(name, value.trim());
    }
  }
  return out;
}

/** A grey oklch(L 0 0) or oklch(L 0 0 / A%). The theme is all greys, so that's all there is. */
function gray(map: Map<string, string>, name: string): Gray {
  const value = map.get(name);
  const m = value?.match(/^oklch\(([\d.]+) 0 0(?: \/ ([\d.]+)%)?\)$/);
  assert.ok(m, `${name} should be a grey oklch() in index.css, not ${value}`);
  return { l: Number(m[1]), alpha: m[2] === undefined ? 1 : Number(m[2]) / 100 };
}

// A grey's OKLab lightness L gives linear sRGB L³ on each channel; the page blends in encoded sRGB.
const encode = (y: number) => (y <= 0.0031308 ? 12.92 * y : 1.055 * y ** (1 / 2.4) - 0.055);
const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const encoded = (g: Gray) => encode(g.l ** 3);
const over = (top: Gray, back: number) => top.alpha * encoded(top) + (1 - top.alpha) * back;
const ratio = (a: number, b: number) => {
  const [hi, lo] = [decode(a), decode(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("faint text stays at WCAG AA, and main text at AAA, wherever the desktop shows through", () => {
  const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");
  for (const theme of ["light", "dark"] as const) {
    const map = tokens(css, theme);
    const faint = encoded(gray(map, "--muted-foreground-glass"));
    const faintInPane = encoded(gray(map, "--muted-foreground-pane-glass"));
    const main = encoded(gray(map, "--foreground"));
    const sidebarText = encoded(gray(map, "--sidebar-foreground"));
    for (const look of ["blur", "plain"] as const) {
      const back = WORST_BACKDROP[theme][look];
      const suffix = look === "plain" ? "-plain" : "";
      const sidebar = over(gray(map, `--sidebar-glass${suffix}`), back);
      const selected = over(gray(map, "--sidebar-glass-accent"), sidebar);
      const pane = over(gray(map, `--pane-glass${suffix}`), back);
      const where = `${theme}, ${look}`;
      for (const [place, text, bg] of [
        ["sidebar", faint, sidebar],
        ["selected sidebar row", faint, selected],
        ["font lists and pages", faintInPane, pane],
      ] as const) {
        assert.ok(ratio(text, bg) >= FAINT_TEXT, `${where}: faint text on the ${place} is ${ratio(text, bg).toFixed(2)}:1`);
      }
      assert.ok(ratio(sidebarText, sidebar) >= MAIN_TEXT, `${where}: sidebar text is ${ratio(sidebarText, sidebar).toFixed(2)}:1`);
      assert.ok(ratio(sidebarText, selected) >= MAIN_TEXT, `${where}: selected row text is ${ratio(sidebarText, selected).toFixed(2)}:1`);
      assert.ok(ratio(main, pane) >= MAIN_TEXT, `${where}: text in font lists is ${ratio(main, pane).toFixed(2)}:1`);
    }
  }
});

test("the see-through font lists stay within the surfaces preview colors are checked against", () => {
  // previewStyle.ts warns about an ink that's hard to read on the theme's surfaces. The pane,
  // even at its worst, must look like one of them, so those warnings still hold.
  const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");
  const hex = (v: number) => `#${Math.round(v * 255).toString(16).padStart(2, "0").repeat(3)}`;
  for (const theme of ["light", "dark"] as const) {
    const map = tokens(css, theme);
    const surfaces = THEME_COLORS[theme].surfaces.map(luminance);
    const [lo, hi] = [Math.min(...surfaces), Math.max(...surfaces)];
    for (const look of ["blur", "plain"] as const) {
      const pane = hex(over(gray(map, `--pane-glass${look === "plain" ? "-plain" : ""}`), WORST_BACKDROP[theme][look]));
      assert.ok(luminance(pane) >= lo && luminance(pane) <= hi, `${theme}, ${look}: the pane at worst is ${pane}`);
    }
  }
});

test("the faint text color only changes where the desktop shows through", () => {
  const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");
  assert.match(css, /\[data-translucent\] aside \{\s*--muted-foreground: var\(--muted-foreground-glass\);/);
  assert.match(css, /\[data-translucent\]\[data-translucent-window\] main \{\s*--muted-foreground: var\(--muted-foreground-pane-glass\);/);
});

test("the contrast check itself: solid white under the theme's own faint grey is just over AA", () => {
  // Today's solid light theme: oklch(0.556) on white. A known value keeps the math honest.
  const r = ratio(encoded({ l: 0.556, alpha: 1 }), encoded({ l: 1, alpha: 1 }));
  assert.ok(r > 4.6 && r < 4.8, `got ${r}`);
});
