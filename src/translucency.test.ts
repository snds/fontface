// Run with `npm run test:ui`. The see-through sidebar's words and when its switch is greyed out (translucency.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Translucency } from "./api.ts";
import {
  platformOf,
  translucentDescription,
  translucentDisabledReason,
  translucentSwitchOn,
  translucentSwitchTip,
  type Platform,
} from "./translucency.ts";

const t = (over: Partial<Translucency> = {}): Translucency => ({ look: null, reduced: false, unsupported: false, nextLaunch: false, ...over });
const PLATFORMS: Platform[] = ["mac", "windows", "linux"];

test("each system is told apart from the web view's user agent", () => {
  assert.equal(platformOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"), "mac");
  assert.equal(platformOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/130.0"), "windows");
  assert.equal(platformOf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15"), "linux");
});

test("Linux says why it starts off, in plain words", () => {
  const linux = translucentDescription("linux", t());
  assert.match(linux, /Linux has no standard blur/);
  assert.match(linux, /starts off/);
  for (const p of ["mac", "windows"] as const) {
    assert.match(translucentDescription(p, t()), /Font lists, previews and dialogs stay solid\./, p);
    assert.doesNotMatch(translucentDescription(p, t()), /starts off/, p);
  }
});

test("turned on after a solid window was made, it says to open Fontface again", () => {
  assert.match(translucentDescription("linux", t({ nextLaunch: true })), /Open Fontface again to see it\.$/);
  assert.match(translucentDescription("windows", t({ nextLaunch: true })), /Open Fontface again to see it\.$/);
  assert.doesNotMatch(translucentDescription("mac", t({ look: "blur" })), /again/);
});

test("the system's reduce-transparency choice greys the switch out and says where it is", () => {
  assert.equal(translucentDisabledReason("mac", t({ look: "blur" })), false);
  assert.match(translucentDisabledReason("mac", t({ reduced: true })) || "", /System Settings › Accessibility › Display/);
  assert.match(translucentDisabledReason("windows", t({ reduced: true })) || "", /Transparency effects are off/);
  assert.match(translucentDisabledReason("linux", t({ reduced: true })) || "", /reduce transparency/);
  assert.match(translucentDisabledReason("windows", t({ unsupported: true })) || "", /^Needs Windows 11/);
});

test("the switch shows on only while the sidebar can be see-through", () => {
  assert.equal(translucentSwitchOn(true, t({ look: "blur" })), true);
  assert.equal(translucentSwitchOn(true, t({ nextLaunch: true })), true, "on, waiting for the next launch");
  assert.equal(translucentSwitchOn(true, t({ reduced: true })), false);
  assert.equal(translucentSwitchOn(true, t({ unsupported: true })), false);
  assert.equal(translucentSwitchOn(false, t()), false);
});

test("the tooltip says what a click does", () => {
  for (const p of PLATFORMS) {
    assert.equal(translucentSwitchTip(true, p), "Makes the sidebar solid");
    assert.match(translucentSwitchTip(false, p), /^Lets your desktop show/);
  }
});

test("index.html and the page keep the same first-paint key and looks", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const page = readFileSync(new URL("./settings/translucent.ts", import.meta.url), "utf8");
  assert.match(html, /localStorage\.getItem\("fontface\.translucent"\)/);
  assert.match(page, /const KEY = "fontface\.translucent";/);
  assert.match(html, /look === "blur" \|\| look === "plain"/);
});

test("both Rust and the page start off on Linux only", () => {
  const rust = readFileSync(new URL("../src-tauri/src/settings.rs", import.meta.url), "utf8");
  assert.match(rust, /pub const TRANSLUCENT_BY_DEFAULT: bool = !cfg!\(target_os = "linux"\);/);
  const page = readFileSync(new URL("./translucency.ts", import.meta.url), "utf8");
  assert.match(page, /export const TRANSLUCENT_BY_DEFAULT = PLATFORM !== "linux";/);
});
