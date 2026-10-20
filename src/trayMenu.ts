import type { TemporaryOffReport, TrayTag } from "./api.ts";
import { summarize, switchLook } from "./fontState.ts";
import type { Face } from "./library.ts";

/**
 * The page's side of the menu bar icon's menu (src-tauri/src/tray.rs): which tags its Tags menu
 * lists and what choosing one does, and what "Turn Off Temporary Fonts" says it did. Pure (no React, no DOM), so `npm run test:ui` covers it; src/tags/TrayTags.tsx sends
 * the list and runs the choice through the same tag switch as the sidebar (src/tags/switching.ts).
 *
 * **Which tags.** The menu stays short: at most `TRAY_TAG_LIMIT`. The tags turned on or off most
 * recently (from anywhere: the sidebar, a tag's menu, or this menu) always make it, then the
 * rest fill up in sidebar order. They're listed in sidebar order, so each keeps its place.
 * Tags with no fonts that can be switched (none in the library, or only fonts in the macOS font
 * folders) are left out, and so are built-in tags while the sidebar hides them.
 *
 * **What it shows.** What the tag's sidebar switch shows: "on" (checked) when all its fonts are
 * on or set to turn on, "some" when some are, else "off". Choosing it does what clicking that
 * switch does: "on" turns them all off, otherwise the rest are turned on.
 */

/** At most this many tags in the menu. Must match MAX_TAGS in src-tauri/src/tray.rs. */
export const TRAY_TAG_LIMIT = 10;
/** How many recently used tags are remembered. Must match RECENT_TAGS in src-tauri/src/settings.rs. */
export const RECENT_TAG_LIMIT = 8;

/** A tag as the sidebar lists it. */
export interface TrayTagSource {
  id: number;
  name: string;
  builtin: boolean;
}

/** Whether choosing a tag in the menu turns its fonts on (else off): as its sidebar switch. */
export function trayTagTurnsOn(set: readonly Face[]): boolean {
  return !switchLook(summarize(set)).checked;
}

/**
 * The menu's tags. `tags`: every tag in sidebar order (My tags, then Built-in). `sets`: each
 * tag's fonts (tagActions.facesByTag). `recent`: tag ids, newest first.
 */
export function trayTags(
  tags: readonly TrayTagSource[],
  sets: ReadonlyMap<number, readonly Face[]>,
  recent: readonly number[],
  { showBuiltin = true, limit = TRAY_TAG_LIMIT }: { showBuiltin?: boolean; limit?: number } = {},
): TrayTag[] {
  const listable = tags.filter((t) => (showBuiltin || !t.builtin) && summarize(sets.get(t.id) ?? []).total > 0);
  const byId = new Map(listable.map((t) => [t.id, t]));
  const picked = new Set<number>();
  for (const id of recent) if (picked.size < limit && byId.has(id)) picked.add(id);
  for (const t of listable) if (picked.size < limit) picked.add(t.id);
  return listable
    .filter((t) => picked.has(t.id))
    .map((t) => {
      const { checked, partial } = switchLook(summarize(sets.get(t.id) ?? []));
      return { id: t.id, name: t.name, state: checked ? "on" : partial ? "some" : "off" };
    });
}

/** `recent` with `id` put first (once), at most `RECENT_TAG_LIMIT`. */
export function rememberTag(recent: readonly number[], id: number): number[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, RECENT_TAG_LIMIT);
}

const fonts = (n: number) => `${n.toLocaleString()} ${n === 1 ? "font" : "fonts"}`;
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

/** What "Turn Off Temporary Fonts" did, as a message: null when there was nothing to do. */
export function temporaryOffMessage(r: TemporaryOffReport): { tone: "success" | "warning" | "error"; title: string; description?: string } | null {
  if (r.error) return { tone: "error", title: "Couldn't turn off temporary fonts", description: r.error };
  const why = r.failed
    .slice(0, 3)
    .map(([file, reason]) => `${fileName(file)}: ${reason}`)
    .join(" · ");
  if (r.failed.length && r.turnedOff === 0) return { tone: "error", title: "Couldn't turn off temporary fonts", description: why };
  if (r.failed.length) {
    const files = `${r.failed.length.toLocaleString()} ${r.failed.length === 1 ? "file" : "files"}`;
    return { tone: "warning", title: `Turned off ${fonts(r.turnedOff)} that were on until logout; ${files} couldn't be turned off`, description: why };
  }
  if (r.turnedOff === 0) return null;
  return { tone: "success", title: `Turned off ${fonts(r.turnedOff)} that ${r.turnedOff === 1 ? "was" : "were"} on until logout` };
}
