import type { ActivationOutcome, FontSummary } from "./api";
import type { Face } from "./library";

/**
 * On, off and everything in between, for a style or a family. Pure (no React, no DOM), so `npm
 * run test:ui` covers it; components/ActivationSwitch.tsx draws it (`StateControl`). In display
 * order:
 *
 * - System font (a copy in /System/Library/Fonts): locked, always on.
 * - Installed (a copy in /Library/Fonts or ~/Library/Fonts): locked, always on while it's there.
 * - On until logout: Fontface turned it on for this login only (`temporary`).
 * - On.
 * - Partly on (a family): some of its styles are on.
 * - Set to turn on, but not on: Fontface was asked to turn it on (`activated`), and the system
 *   doesn't have it. Its file may be on a drive that isn't connected, or online-only, or macOS
 *   didn't load it (it may be turned off in Font Book, say).
 * - Turned on by another app: on, but not by Fontface.
 * - Off.
 *
 * A request in progress (busy) shows over all of these: its spinner takes the mark's place.
 * Every state has a mark and words (`stateWords`, `stateDetails`), so color is never the only sign.
 */

/** How the words put "on until logout". `untilQuit`: Fontface turns those fonts off when it
 *  quits (the "Turn temporary fonts off when Fontface quits" setting), so they say so. */
export interface StateWording {
  untilQuit?: boolean;
}

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
 *  priority: the lock, on until logout, set to turn on but not on, turned on by another app,
 *  and in Tiles and Table (`compact`, where there's no room for "n/total"), partly on. */
export type StateMark = LockKind | "temporary" | "waiting" | "elsewhere" | "partial";

export function markOf(s: StateSummary, { compact = false }: { compact?: boolean } = {}): StateMark | null {
  if (s.lock) return s.lock;
  if (s.temporary) return "temporary";
  if (s.waiting) return "waiting";
  if (s.elsewhere) return "elsewhere";
  if (compact && switchLook(s).partial) return "partial";
  return null;
}

/** Each mark's Material Symbols icon. */
export const MARK_ICONS: Record<StateMark, string> = {
  macos: "lock",
  installed: "lock",
  temporary: "timer",
  waiting: "link_off",
  elsewhere: "info",
  partial: "radio_button_partial",
};

/** The lock's short name, on its badge. */
export const LOCK_LABELS: Record<LockKind, string> = { macos: "System font", installed: "Installed" };

/**
 * Short words for an item's accessible name, after its name: "on", "off", "3 of 12 on", "on
 * until logout", "always on, a system font". `stateDetails` says the rest.
 */
export function stateWords(s: StateSummary, wording: StateWording = {}): string {
  if (s.lock === "macos") return "always on, a system font";
  if (s.lock === "installed") return "always on, installed";
  if (s.total === 0) return "off";
  const { checked } = switchLook(s);
  if (checked) {
    if (s.on === 0) return "set to turn on, not on yet";
    if (s.temporary === s.total) return wording.untilQuit ? "on until Fontface quits" : "on until logout";
    if (s.elsewhere === s.total) return "on, turned on by another app";
    return "on";
  }
  if (s.wanted === 0) return "off";
  return `${s.on} of ${s.total} on`;
}

const styles = (n: number) => `${n.toLocaleString()} ${n === 1 ? "style" : "styles"}`;
const are = (n: number) => (n === 1 ? "is" : "are");

/** When a font that's on until logout goes off. */
const untilWhen = (wording: StateWording) => (wording.untilQuit ? "until you quit Fontface, log out or restart" : "until you log out or restart");

/** Why a font that's set to turn on may not be on. It's only ever "may": Fontface can't tell a
 *  file that isn't there yet from one macOS chose not to load. */
const WAITING_WHY = {
  one: "Its file may be on a drive that isn't connected, or online-only. Or macOS may not have loaded it, for example if it's turned off in another app.",
  many: "Their files may be on a drive that isn't connected, or online-only. Or macOS may not have loaded them, for example if they're turned off in another app.",
};

/**
 * What screen readers hear in the item's description about its state, and the font page's Info
 * tab shows: one sentence per thing worth knowing. A mark's tooltip is only its name (`markName`
 * in fontActions.ts). `single`: one style (else a family, which counts its styles).
 * `count: false` leaves out the "n of N styles are on" sentence, for an item whose name already
 * says it (stateWords), so screen readers don't hear it twice.
 */
export function stateDetails(
  s: StateSummary,
  single: boolean,
  wording: StateWording = {},
  { count = true }: { count?: boolean } = {},
): string[] {
  if (s.lock === "macos") return ["System font. Always on."];
  if (s.lock === "installed") {
    return [
      s.macos > 0
        ? "In System Fonts, some of them system fonts. Always on while they're there."
        : "Installed in a Library Fonts folder. Always on while it's there.",
    ];
  }
  const out: string[] = [];
  // Partly on: how many, which the switch alone doesn't say (and Tiles and Table don't show).
  if (count && switchLook(s).partial) {
    out.push(s.on === 0 ? `None of its ${styles(s.total)} are on.` : `${s.on.toLocaleString()} of ${styles(s.total)} ${are(s.on)} on.`);
  }
  const until = untilWhen(wording);
  if (s.temporary) out.push(single ? `On ${until}.` : `${styles(s.temporary)} ${are(s.temporary)} on ${until}.`);
  if (s.waiting) {
    out.push(
      single
        ? `Set to turn on, but it isn't on right now. ${WAITING_WHY.one}`
        : s.waiting === 1
          ? `1 style is set to turn on, but it isn't on right now. ${WAITING_WHY.one}`
          : `${styles(s.waiting)} are set to turn on, but they aren't on right now. ${WAITING_WHY.many}`,
    );
  }
  if (s.elsewhere) {
    out.push(single ? "Turned on by another app." : `${styles(s.elsewhere)} ${s.elsewhere === 1 ? "was" : "were"} turned on by another app.`);
  }
  if (s.locked) {
    const why = s.macos === s.locked ? (s.locked === 1 ? "a system font" : "system fonts") : "in System Fonts";
    out.push(`${styles(s.locked)} ${are(s.locked)} always on (${why}).`);
  }
  return out;
}

/** One copy's state in words, for the font page's list of copies. */
export function copyWords(
  copy: { installed: boolean; osActive: boolean; activated: boolean; temporary?: boolean; path: string },
  wording: StateWording = {},
): string {
  if (copy.installed) return copy.path.startsWith(MACOS_FONTS) ? "Always on (system font)" : "Always on (installed)";
  if (copy.osActive) {
    if (!copy.activated) return "On (another app)";
    if (!copy.temporary) return "On";
    return wording.untilQuit ? "On until Fontface quits" : "On until logout";
  }
  return copy.activated ? "Set to turn on" : "Off";
}

/**
 * The list after an on/off request, without reading it again: every font in a file the request
 * reached takes what the OS has now (`osActive`), what Fontface has recorded (`activated`) and
 * whether it's on until logout. The two differ when another app keeps a font on, or macOS
 * didn't load it, so "turned on by another app" and "set to turn on, not on" show at once.
 */
export function applyOutcomes(fonts: FontSummary[], outcomes: readonly ActivationOutcome[]): FontSummary[] {
  const now = new Map<number, ActivationOutcome>();
  for (const o of outcomes) for (const id of o.ids) now.set(id, o);
  if (!now.size) return fonts;
  return fonts.map((f) => {
    const o = now.get(f.id);
    return o ? { ...f, activated: o.activated, osActive: o.active, temporary: o.temporary } : f;
  });
}
