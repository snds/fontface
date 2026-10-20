import type { Translucency } from "./api.ts";

/**
 * The see-through sidebar (Settings › General › "Translucent sidebar"): the words the setting
 * shows on each system, and when it's greyed out. Pure (no React, no DOM), so `npm run test:ui`
 * covers it. The back end decides what shows (src-tauri/src/translucency.rs); the page follows
 * (src/settings/translucent.ts).
 */

export type Platform = "mac" | "windows" | "linux";

export function platformOf(userAgent: string): Platform {
  if (/Macintosh|Mac OS X/.test(userAgent)) return "mac";
  if (/Windows/.test(userAgent)) return "windows";
  return "linux";
}

export const PLATFORM: Platform = typeof navigator === "undefined" ? "mac" : platformOf(navigator.userAgent);

/** Linux has no standard blur, so what's behind the window would show through sharp. Must match
 *  `TRANSLUCENT_BY_DEFAULT` in src-tauri/src/settings.rs. */
export const TRANSLUCENT_BY_DEFAULT = PLATFORM !== "linux";

export const TRANSLUCENT_LABEL = "Translucent sidebar";

/** What the setting does, under its name. */
export function translucentDescription(platform: Platform, t: Translucency): string {
  const solid = "Font lists, previews and dialogs stay solid.";
  const text =
    platform === "linux"
      ? "Your desktop shows through the sidebar. Linux has no standard blur, so what's behind isn't softened and can make the sidebar harder to read, and some desktops can't show see-through windows at all. That's why it starts off."
      : platform === "windows"
        ? `Your desktop's colors show softly through the sidebar, on Windows 11. ${solid}`
        : `Your desktop shows softly through the sidebar, blurred. ${solid}`;
  return t.nextLaunch ? `${text} Open Fontface again to see it.` : text;
}

/** Why the switch is greyed out, or false when it isn't. */
export function translucentDisabledReason(platform: Platform, t: Translucency): string | false {
  if (t.unsupported) return "Needs Windows 11. Windows 10 has no blur that keeps up while you move the window.";
  if (!t.reduced) return false;
  if (platform === "windows") return "Transparency effects are off in Windows Settings › Personalization › Colors, so the sidebar stays solid";
  if (platform === "mac") return "Reduce transparency is on in System Settings › Accessibility › Display, so the sidebar stays solid";
  return "Your system asks apps to reduce transparency, so the sidebar stays solid";
}

/** The switch's tooltip, saying what a click does. */
export function translucentSwitchTip(on: boolean, platform: Platform): string {
  if (on) return "Makes the sidebar solid";
  return platform === "linux" ? "Lets your desktop show through the sidebar" : "Lets your desktop show softly through the sidebar";
}

/** What the switch shows: on only while the sidebar can be see-through. */
export const translucentSwitchOn = (setting: boolean, t: Translucency) => setting && !t.unsupported && !t.reduced;
