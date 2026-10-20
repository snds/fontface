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

/** Where to allow a folder on macOS: System Settings › Privacy & Security › Files and Folders. */
export const PRIVACY_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";
export const PRIVACY_SETTINGS_LABEL = "Open Privacy Settings";

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

/** Whether Check now can run: watching is on, there's a folder to look in, and no check is
 *  running. Otherwise it's greyed out; the switch and the folder list beside it show why. */
export function canCheckNow(watching: boolean, folders: number, checking: boolean): boolean {
  return watching && folders > 0 && !checking;
}

/** The label before the folder list. */
export const foldersLabel = (watching: boolean) => (watching ? "Watching:" : "Folders to watch:");
