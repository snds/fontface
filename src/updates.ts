import type { UpdateStatus } from "./api.ts";

/**
 * Automatic updates: the words Settings › About shows, the same as every app on Sean's update
 * kit (snds/app-updates; Lockdown's update-model.ts), with Fontface's name. The status comes
 * from the shell (src-tauri/src/updater.rs) on "fontface://update". Pure (no React, no DOM), so
 * `npm run test:ui` covers it.
 */

/** The window event every change of the update status arrives on. */
export const UPDATE_EVENT = "fontface://update";

/** The label of the "Check automatically" switch. */
export const AUTO_CHECK_LABEL = "Check for updates automatically";

/** The one status line under "Check for updates". */
export function updateLine(s: UpdateStatus): string {
  if (!s.enabled) return s.off ?? "Updates are off in this build.";
  switch (s.state) {
    case "idle":
      return s.auto_check ? "Fontface checks for updates when it opens and every six hours." : "Automatic checks are off. Check whenever you like.";
    case "checking":
      return "Checking for updates…";
    case "up_to_date":
      return "Fontface is up to date.";
    case "downloading":
      return `Downloading version ${s.offered ?? "the update"}… ${s.percent ?? 0}%`;
    case "ready":
      return `Version ${s.offered ?? "the update"} is ready. Restart to update, or it installs when you quit.`;
    case "available":
      return `Version ${s.offered ?? "a newer build"} is out. ${s.link_why ?? ""}`.trim();
    case "failed":
      return s.error ?? "The update didn't work.";
  }
}

/** The channel as Settings names it. */
export function channelName(s: UpdateStatus): string {
  switch (s.channel) {
    case "main":
      return "main channel (every merged change)";
    case "local":
      return "local channel (this Mac's own builds)";
    default:
      return "stable channel";
  }
}

/** Whether "Check for updates" can be pressed now. */
export function canCheck(s: UpdateStatus): boolean {
  return s.enabled && s.state !== "checking" && s.state !== "downloading";
}
