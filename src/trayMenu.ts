import type { TemporaryOffReport } from "./api.ts";

/**
 * The page's side of the menu bar icon's menu (src-tauri/src/tray.rs): what "Turn Off
 * Temporary Fonts" says it did. Pure (no React, no DOM), so `npm run test:ui` covers it; App
 * shows it when "activation-changed" arrives.
 */

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
