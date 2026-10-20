import type { PurchasesStatus, WatchChange } from "./api.ts";

/**
 * Watching for font purchases: the words the Purchases page and Settings share, and what they
 * show. Watching is off until the user turns it on, because on macOS the first look at Downloads
 * makes the system ask for access. While it's off, Fontface doesn't look at any watched folder.
 * Pure (no React, no DOM), so `npm run test:ui` covers it.
 */

export const WATCH_LABEL = "Watch for new font purchases";

/** What watching does, said before the user turns it on. */
export function watchExplainer(isMac: boolean): string {
  const what = "Fontface looks in Downloads for fonts you buy, and offers to add them.";
  return isMac ? `${what} When you turn this on, macOS asks once whether Fontface may see your Downloads folder.` : what;
}

/** The watch switch's tooltip. */
export function watchSwitchTip(watching: boolean, isMac: boolean): string {
  if (watching) return "Stops watching for font purchases. Fonts you've added stay.";
  return `Watches your download folders for fonts you buy.${isMac ? " macOS asks for access first." : ""}`;
}

/** Where to allow a folder on macOS: System Settings › Privacy & Security › Files and Folders. */
export const PRIVACY_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";
export const PRIVACY_SETTINGS_LABEL = "Open Privacy Settings";
export const PRIVACY_SETTINGS_TIP = "Opens System Settings at Files and Folders, where you can let Fontface see the folder";

const folderName = (path: string) => path.split(/[/\\]/).filter(Boolean).pop() || path;

const names = (paths: string[]) => {
  const all = paths.map(folderName);
  return all.length <= 1 ? all.join("") : `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`;
};

/** A calm note after turning watching on, when a folder couldn't be read; null when all went well. */
export function watchNotice(change: WatchChange, isMac: boolean): string | null {
  if (change.denied.length === 0) return null;
  const which = names(change.denied);
  const result = change.watching ? "so Fontface watches your other folders only" : "so watching is still off";
  const again = change.watching ? "turn watching off and on again" : "turn watching on again";
  if (!isMac) return `Fontface isn't allowed to read ${which}, ${result}. Check the folder's permissions, then ${again}.`;
  const onlyDownloads = change.denied.every((p) => folderName(p) === "Downloads");
  const allow = onlyDownloads ? "turn on Downloads Folder under Fontface" : "find Fontface and allow those folders";
  return `macOS didn't let Fontface see ${which}, ${result}. To allow it, open System Settings › Privacy & Security › Files and Folders, ${allow}, then ${again}.`;
}

/** The sidebar's "n new" count. None while watching is off. */
export function newPurchaseCount(status: Pick<PurchasesStatus, "watching" | "finds">): number {
  return status.watching ? status.finds.filter((f) => f.status === "new" && !f.missing).length : 0;
}

/** What the new downloads list says when it's empty. */
export function emptyFindsText(watching: boolean): string {
  return watching
    ? "Nothing new. Fonts you download will show up here."
    : "Watching is off. Turn it on to see new font downloads here, or import a zip or folder of fonts you've already bought.";
}

/** Why Check now is greyed out, or false when it can run. */
export function checkNowBlocked(watching: boolean, folders: number, checking: boolean): string | false {
  if (checking) return "Wait: Fontface is still checking";
  if (!watching) return "Turn on watching first";
  if (folders === 0) return "Add a folder to watch first";
  return false;
}

/** The label before the folder list. */
export const foldersLabel = (watching: boolean) => (watching ? "Watching:" : "Folders to watch:");
