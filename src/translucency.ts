import type { TranslucencySetting, TranslucencyState } from "./api.ts";

/**
 * The see-through window (Settings › General › "Translucent window"): the words the setting
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
 *  `TRANSLUCENCY_BY_DEFAULT` in src-tauri/src/settings.rs. */
export const TRANSLUCENCY_BY_DEFAULT: TranslucencySetting = PLATFORM === "linux" ? "off" : "window";

export const TRANSLUCENCY_LABEL = "Translucent window";

/** What the setting does, under its name. */
export function translucencyDescription(platform: Platform, t: TranslucencyState): string {
  const contrast = "Font lists and pages stay nearly solid, so text keeps its contrast, and dialogs and menus stay solid.";
  const text =
    platform === "linux"
      ? "Your desktop shows through the window. Linux has no standard blur, so what's behind isn't softened and can make text harder to read, and some desktops can't show see-through windows at all. That's why it starts off."
      : platform === "windows"
        ? `Your desktop's colors show softly through the window, on Windows 11. ${contrast}`
        : `Your desktop shows softly through the window, blurred. ${contrast}`;
  return t.nextLaunch ? `${text} Open Fontface again to see it.` : text;
}

/** The choices, each with its tooltip. */
export function translucencyOptions(platform: Platform): { value: TranslucencySetting; label: string; tip: string }[] {
  const softly = platform === "linux" ? "show" : "show softly";
  return [
    { value: "off", label: "Off", tip: "Keeps the window solid" },
    { value: "sidebar", label: "Sidebar", tip: `Lets your desktop ${softly} through the sidebar only` },
    { value: "window", label: "Whole window", tip: `Lets your desktop ${softly} through the sidebar, and faintly behind font lists and pages` },
  ];
}

/** Why the choice is greyed out, or false when it isn't. */
export function translucencyDisabledReason(platform: Platform, t: TranslucencyState): string | false {
  if (t.unsupported) return "Needs Windows 11. Windows 10 has no blur that keeps up while you move the window.";
  if (!t.reduced) return false;
  if (platform === "windows") return "Transparency effects are off in Windows Settings › Personalization › Colors, so the window stays solid";
  if (platform === "mac") return "Reduce transparency is on in System Settings › Accessibility › Display, so the window stays solid";
  return "Your system asks apps to reduce transparency, so the window stays solid";
}

/** What the choice shows: Off while the system rules it out. */
export const translucencyShown = (setting: TranslucencySetting, t: TranslucencyState): TranslucencySetting =>
  t.unsupported || t.reduced ? "off" : setting;
