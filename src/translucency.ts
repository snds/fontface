import type { TranslucencySetting, TranslucencyState } from "./api.ts";

/**
 * The see-through window (Settings › General › "Translucent window"): the words the setting
 * shows on each system, and when it's greyed out and why. Pure (no React, no DOM), so `npm run test:ui`
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

/** What the setting does, under its name, and while the system rules it out, why (the choice
 *  is greyed out then, and this is the only place that says so). */
export function translucencyDescription(platform: Platform, t: TranslucencyState): string {
  const contrast = "Font lists and pages stay nearly solid, so text keeps its contrast, and dialogs and menus stay solid.";
  const text =
    platform === "linux"
      ? "Your desktop shows through the window. Linux has no standard blur, so what's behind isn't softened and can make text harder to read, and some desktops can't show see-through windows at all. That's why it starts off."
      : platform === "windows"
        ? `Your desktop's colors show softly through the window, on Windows 11. ${contrast}`
        : `Your desktop shows softly through the window, blurred. ${contrast}`;
  const why = translucencyDisabledReason(platform, t);
  if (why) return `${text} ${why}`;
  return t.nextLaunch ? `${text} Open Fontface again to see it.` : text;
}

/** The choices. Their words say what each does, so they have no tooltips. */
export const TRANSLUCENCY_OPTIONS: readonly { value: TranslucencySetting; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "sidebar", label: "Sidebar" },
  { value: "window", label: "Whole window" },
];

/** Why the choice is greyed out, or false when it isn't. It ends the setting's description. */
export function translucencyDisabledReason(platform: Platform, t: TranslucencyState): string | false {
  if (t.unsupported) return "Needs Windows 11. Windows 10 has no blur that keeps up while you move the window.";
  if (!t.reduced) return false;
  if (platform === "windows") return "Transparency effects are off in Windows Settings › Personalization › Colors, so the window stays solid.";
  if (platform === "mac") return "Reduce transparency is on in System Settings › Accessibility › Display, so the window stays solid.";
  return "Your system asks apps to reduce transparency, so the window stays solid.";
}

/** What the choice shows: Off while the system rules it out. */
export const translucencyShown = (setting: TranslucencySetting, t: TranslucencyState): TranslucencySetting =>
  t.unsupported || t.reduced ? "off" : setting;
