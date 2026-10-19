import type { Face } from "./library";

/**
 * On, off and everything in between, for a style or a family. Pure (no React, no DOM), so `npm
 * run test:ui` covers it; components/StateMark.tsx draws it. In display order:
 *
 * - Part of macOS (a copy in /System/Library/Fonts): locked, always on.
 * - Installed (a copy in /Library/Fonts or ~/Library/Fonts): locked, always on while it's there.
 * - On until logout: Fontface turned it on for this login only (`temporary`).
 * - On.
 * - Partly on (a family): some of its styles are on.
 * - Set to turn on, but not on: Fontface was asked to turn it on (`activated`), and the system
 *   doesn't have it (its file is on a drive that isn't connected, or online-only).
 * - Turned on by another app: on, but not by Fontface.
 * - Off.
 *
 * A request in progress (busy) shows over all of these; that's the switch's own business.
 * Every state has a mark and words (`stateWords`, `stateDetails`), so color is never the only sign.
 */

export type LockKind = "macos" | "installed";

export type FaceState = LockKind | "temporary" | "on" | "elsewhere" | "waiting" | "off";

/** Where macOS keeps its own fonts. Fonts there are part of macOS. */
const MACOS_FONTS = "/System/Library/Fonts/";

/** Why a style can't be switched off here, if it can't: a copy is in one of the OS's font folders. */
export function lockOf(face: Face): LockKind | null {
  if (!face.installed) return null;
  return face.copies.some((c) => c.installed && c.path.startsWith(MACOS_FONTS)) ? "macos" : "installed";
}

/** One style's state. */
export function faceState(face: Face): FaceState {
  const lock = lockOf(face);
  if (lock) return lock;
  if (face.active) {
    // On: by Fontface (until logout, or to stay), or only by another app.
    const ours = face.copies.filter((c) => c.osActive && c.activated);
    if (!ours.length) return "elsewhere";
    return ours.every((c) => c.temporary) ? "temporary" : "on";
  }
  return face.copies.some((c) => c.activated) ? "waiting" : "off";
}

/** The states of some styles (one, or a family's), counted. */
export interface StateSummary {
  /** Every style is locked: why (part of macOS only if all of them are). Null when there's a switch. */
  lock: LockKind | null;
  /** Styles that can be switched. */
  total: number;
  /** Of those, on right now (by anyone). */
  on: number;
  /** On right now, or set to turn on: what the switch shows as on. */
  wanted: number;
  /** On until logout. */
  temporary: number;
  /** Set to turn on, but not on. */
  waiting: number;
  /** Turned on by another app. */
  elsewhere: number;
  /** Locked styles in a family that also has switchable ones (or every style, when `lock`). */
  locked: number;
  /** Of the locked ones, part of macOS. */
  macos: number;
}

export function summarize(faces: readonly Face[]): StateSummary {
  const s: StateSummary = { lock: null, total: 0, on: 0, wanted: 0, temporary: 0, waiting: 0, elsewhere: 0, locked: 0, macos: 0 };
  for (const face of faces) {
    const state = faceState(face);
    if (state === "macos" || state === "installed") {
      s.locked++;
      if (state === "macos") s.macos++;
      continue;
    }
    s.total++;
    if (state === "temporary" || state === "on" || state === "elsewhere") {
      s.on++;
      s.wanted++;
    }
    if (state === "waiting") {
      s.waiting++;
      s.wanted++;
    }
    if (state === "temporary") s.temporary++;
    if (state === "elsewhere") s.elsewhere++;
  }
  if (s.total === 0 && s.locked > 0) s.lock = s.macos === s.locked ? "macos" : "installed";
  return s;
}

/** How the switch looks: on when every style is on or set to turn on; partly on (with "n/total")
 *  when some are; dimmed when it's set to on but none of it is on yet. */
export function switchLook(s: StateSummary): { checked: boolean; partial: boolean; dim: boolean } {
  const checked = s.total > 0 && s.wanted === s.total;
  return { checked, partial: s.wanted > 0 && !checked, dim: checked && s.on === 0 };
}

/** The one extra mark an item shows beside its switch (or instead of it, for a lock), by
 *  priority: the lock, on until logout, set to turn on but not on, turned on by another app. */
export type StateMark = LockKind | "temporary" | "waiting" | "elsewhere";

export function markOf(s: StateSummary): StateMark | null {
  if (s.lock) return s.lock;
  if (s.temporary) return "temporary";
  if (s.waiting) return "waiting";
  if (s.elsewhere) return "elsewhere";
  return null;
}

/** Each mark's Material Symbols icon. */
export const MARK_ICONS: Record<StateMark, string> = {
  macos: "lock",
  installed: "lock",
  temporary: "timer",
  waiting: "link_off",
  elsewhere: "info",
};

/** The lock's short name, on its badge. */
export const LOCK_LABELS: Record<LockKind, string> = { macos: "Part of macOS", installed: "Installed" };

/**
 * Short words for an item's accessible name, after its name: "on", "off", "3 of 12 on", "on
 * until logout", "always on, part of macOS". `stateDetails` says the rest.
 */
export function stateWords(s: StateSummary): string {
  if (s.lock === "macos") return "always on, part of macOS";
  if (s.lock === "installed") return "always on, installed";
  if (s.total === 0) return "off";
  const { checked } = switchLook(s);
  if (checked) {
    if (s.on === 0) return "set to turn on, not on yet";
    if (s.temporary === s.total) return "on until logout";
    if (s.elsewhere === s.total) return "on, turned on by another app";
    return "on";
  }
  if (s.wanted === 0) return "off";
  return `${s.on} of ${s.total} on`;
}

const styles = (n: number) => `${n.toLocaleString()} ${n === 1 ? "style" : "styles"}`;
const are = (n: number) => (n === 1 ? "is" : "are");

/**
 * What a mark's tooltip says, and screen readers hear in the item's description: one sentence
 * per thing worth knowing. `single`: one style (else a family, which counts its styles).
 */
export function stateDetails(s: StateSummary, single: boolean): string[] {
  if (s.lock === "macos") return ["Part of macOS. Always on."];
  if (s.lock === "installed") {
    return [
      s.macos > 0
        ? "Installed in macOS's font folders, some as part of macOS. Always on while they're there."
        : "Installed in a Library Fonts folder. Always on while it's there.",
    ];
  }
  const out: string[] = [];
  if (s.temporary) out.push(single ? "On until you log out or restart." : `${styles(s.temporary)} ${are(s.temporary)} on until you log out or restart.`);
  if (s.waiting) {
    out.push(
      single
        ? "Set to turn on, but it isn't on right now. Its file may be on a drive that isn't connected, or online-only."
        : s.waiting === 1
          ? "1 style is set to turn on, but it isn't on right now. Its file may be on a drive that isn't connected, or online-only."
          : `${styles(s.waiting)} are set to turn on, but they aren't on right now. Their files may be on a drive that isn't connected, or online-only.`,
    );
  }
  if (s.elsewhere) {
    out.push(single ? "Turned on by another app." : `${styles(s.elsewhere)} ${s.elsewhere === 1 ? "was" : "were"} turned on by another app.`);
  }
  if (s.locked) {
    const why = s.macos === s.locked ? "part of macOS" : "installed in macOS's font folders";
    out.push(`${styles(s.locked)} ${are(s.locked)} always on (${why}).`);
  }
  return out;
}

/** One copy's state in words, for the font page's list of copies. */
export function copyWords(copy: { installed: boolean; osActive: boolean; activated: boolean; temporary?: boolean; path: string }): string {
  if (copy.installed) return copy.path.startsWith(MACOS_FONTS) ? "Always on (part of macOS)" : "Always on (installed)";
  if (copy.osActive) {
    if (!copy.activated) return "On (another app)";
    return copy.temporary ? "On until logout" : "On";
  }
  return copy.activated ? "Set to turn on" : "Off";
}
