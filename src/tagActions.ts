import type { ActivationMode, ActivationOutcome } from "./api.ts";
import { otherMode } from "./fontActions.ts";
import { summarize } from "./fontState.ts";
import { activationIds, type Face, type Family } from "./library.ts";

/**
 * What can be done to a tag, and what it covers: the tag's right-click and "…" menus (turning
 * its fonts on or off among them), and which tags take fonts or other tags by hand. One set of
 * rules and one set of words, so every place says the same thing. Pure (no React, no DOM), so
 * `npm run test:ui` covers it; src/tags/ draws it and src/tags/switching.ts turns the fonts on
 * or off.
 *
 * **A tag's set.** Turning a tag on or off works on every font tagged with it or with any tag
 * nested inside it: "Sci-Fi" covers "Sci-Fi/Star Trek" too, while "Sci-Fi/Star Trek" covers only
 * itself (and the tags inside it). That's the same set the sidebar counts and the tag's view
 * lists.
 *
 * **Turning off** turns off every font in the set, however it was turned on (its own switch, its
 * family's, another tag's). That's how a family switch works too: Fontface records whether a
 * font should be on, not why.
 *
 * **Built-in tags are read-only by hand.** They're a copy of what came with Font Book (its
 * starter collections) and Typeface (its automatic "Style"), and only imports add to them. So
 * they can be viewed, turned on and off, and exported, but not renamed, recolored, moved,
 * deleted, nested into, or given or relieved of fonts. "Make it my tag" moves one (with
 * everything in it) to My tags, where all of that works. The back end refuses the same changes
 * (src-tauri/src/tags/mod.rs, `check_edit`).
 */

// ----------------------------------------------------------------------------- a tag's set

/** What the tag code needs from the tag index (src/tags/model.ts, `TagIndex`). */
export interface TagLookup {
  /** Tag id → itself and every tag above it. */
  lineage: ReadonlyMap<number, readonly number[]>;
  /** The tags on a face (its own, plus any kept from an import for its PostScript name). */
  tagsOf: (face: Face) => readonly number[];
}

/**
 * Every tag's set: the styles tagged with it or with any tag nested under it, each once, in
 * library order. Tags with no styles in the library aren't in the map.
 */
export function facesByTag(families: readonly Family[], lookup: TagLookup): Map<number, Face[]> {
  const sets = new Map<number, Face[]>();
  for (const family of families) {
    for (const face of family.faces) {
      const ids = lookup.tagsOf(face);
      if (!ids.length) continue;
      const all = new Set<number>();
      for (const id of ids) for (const up of lookup.lineage.get(id) ?? [id]) all.add(up);
      for (const id of all) {
        let set = sets.get(id);
        if (!set) sets.set(id, (set = []));
        set.push(face);
      }
    }
  }
  return sets;
}

// ------------------------------------------------------------------------- the switch

/** One request of a tag switch: whole files, so the OS never sees a file twice. */
export interface TagSwitchBatch {
  ids: number[];
  /** Styles this request finishes (for the progress count). */
  faces: number;
}

export interface TagSwitchPlan {
  on: boolean;
  /** The styles to change: off ones to turn on, or ones that are on (or set to turn on) to turn off. */
  faces: Face[];
  batches: TagSwitchBatch[];
  /** Styles already as asked (on, or off), left alone. */
  already: number;
  /** Styles installed in a macOS font folder: always on, never switched here. */
  locked: number;
}

/**
 * How a tag's set is switched: the same font ids a family switch would send (`activationIds`:
 * one copy per style to turn on, every copy to turn off), in a few requests of whole files so
 * a big set can show progress. Each request has at least `minBatch` files; there are at most
 * `batches` of them.
 */
export function planTagSwitch(set: readonly Face[], on: boolean, { batches = 10, minBatch = 25 } = {}): TagSwitchPlan {
  const switchable = set.filter((f) => !f.installed);
  const faces = on ? switchable.filter((f) => !f.active) : switchable.filter((f) => f.active || f.copies.some((c) => c.osActive || c.activated));
  const ids = activationIds(faces, on);

  // Ids by file, in the order activationIds gave them.
  const pathOf = new Map<number, string>();
  for (const f of faces) for (const c of f.copies) pathOf.set(c.id, c.path);
  const files = new Map<string, number[]>();
  for (const id of ids) {
    const path = pathOf.get(id) ?? `#${id}`;
    files.set(path, [...(files.get(path) ?? []), id]);
  }
  const paths = [...files.keys()];
  const size = Math.max(minBatch, Math.ceil(paths.length / batches));
  const batchOf = new Map<string, number>();
  const out: TagSwitchBatch[] = [];
  for (let i = 0; i < paths.length; i += size) {
    const chunk = paths.slice(i, i + size);
    for (const p of chunk) batchOf.set(p, out.length);
    out.push({ ids: chunk.flatMap((p) => files.get(p)!), faces: 0 });
  }
  // A style is done when the request with its file is: turning on, the first file that has it;
  // turning off, the last of its copies.
  for (const f of faces) {
    const at = f.copies.map((c) => batchOf.get(c.path)).filter((b): b is number => b !== undefined);
    if (at.length) out[on ? Math.min(...at) : Math.max(...at)].faces++;
  }
  return { on, faces, batches: out, already: switchable.length - faces.length, locked: set.length - switchable.length };
}

/** Why some styles didn't switch, with how many. */
export interface TagSwitchProblem {
  /** The back end's words for one file. */
  error: string;
  count: number;
}

export interface TagSwitchResult {
  /** Styles now as asked. */
  done: number;
  /** The rest, by reason, most first. */
  problems: TagSwitchProblem[];
}

/**
 * What a tag switch did, in styles: from the outcomes of its requests, and the errors of any
 * request that failed as a whole. A style is on once any of its files is; off once all are.
 */
export function tagSwitchResult(plan: TagSwitchPlan, outcomes: readonly ActivationOutcome[], failures: readonly string[] = []): TagSwitchResult {
  const byId = new Map<number, ActivationOutcome>();
  for (const o of outcomes) for (const id of o.ids) byId.set(id, o);
  let done = 0;
  const why = new Map<string, number>();
  for (const face of plan.faces) {
    const seen = face.copies.map((c) => byId.get(c.id)).filter((o): o is ActivationOutcome => !!o);
    const ok = seen.length > 0 && (plan.on ? seen.some((o) => o.active) : seen.every((o) => !o.active));
    if (ok) {
      done++;
      continue;
    }
    const error = seen.find((o) => o.error)?.error ?? failures[0] ?? "Something went wrong.";
    why.set(error, (why.get(error) ?? 0) + 1);
  }
  const problems = [...why].map(([error, count]) => ({ error, count })).sort((a, b) => b.count - a.count);
  return { done, problems };
}

const fonts = (n: number) => `${n.toLocaleString()} ${n === 1 ? "font" : "fonts"}`;
const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** The back end's reasons (src-tauri/src/commands.rs), said for one font or for several. */
const REASONS: { starts: string; one: string; many: string }[] = [
  { starts: "macOS didn't load", one: "macOS didn't load it. It may be turned off in another app.", many: "macOS didn't load them. They may be turned off in another app." },
  {
    starts: "Still on: another app",
    one: "Another app keeps it on. Turn it off there.",
    many: "Another app keeps them on. Turn them off there.",
  },
  { starts: "Its folder was removed", one: "Its folder was removed from the library.", many: "Their folder was removed from the library." },
];

/** One problem in plain words: "3 fonts didn't turn on. macOS didn't load them. …" */
export function problemWords(p: TagSwitchProblem, on: boolean): string {
  const known = REASONS.find((r) => p.error.startsWith(r.starts));
  const why = known ? (p.count === 1 ? known.one : known.many) : sentence(p.error);
  return `${fonts(p.count)} didn't turn ${on ? "on" : "off"}. ${why}`;
}

export interface TagSwitchMessage {
  tone: "success" | "warning" | "error" | "info";
  title: string;
  /** Sentences to show under the title (may be empty). */
  details: string[];
}

/** How a tag switch is reported. `mode`: how fonts were turned on (the saved mode, or the other one). */
export function tagSwitchMessage(
  name: string,
  plan: TagSwitchPlan,
  result: TagSwitchResult,
  { mode = "persistent", untilQuit = false }: { mode?: ActivationMode; untilQuit?: boolean } = {},
): TagSwitchMessage {
  const verb = plan.on ? "on" : "off";
  const total = plan.faces.length;
  const notes: string[] = [];
  if (plan.on && plan.already > 0 && total > 0) notes.push(`${fonts(plan.already)} ${plan.already === 1 ? "was" : "were"} already on.`);
  if (plan.locked > 0) {
    notes.push(
      plan.on
        ? `${fonts(plan.locked)} ${plan.locked === 1 ? "is" : "are"} always on: installed in macOS's font folders.`
        : `${fonts(plan.locked)} ${plan.locked === 1 ? "stays" : "stay"} on: installed in macOS's font folders.`,
    );
  }
  if (total === 0) {
    if (plan.already + plan.locked === 0) return { tone: "info", title: `No fonts in your library have the tag “${name}”`, details: [] };
    if (plan.on && plan.already === 0) return { tone: "info", title: `The fonts in “${name}” are always on`, details: ["They're installed in macOS's font folders."] };
    return { tone: "info", title: plan.on ? `All fonts in “${name}” are already on` : `None of the fonts in “${name}” are on`, details: plan.on ? [] : notes };
  }
  const until = plan.on && mode === "temporary" ? (untilQuit ? " until Fontface quits" : " until logout") : "";
  const shown = result.problems.slice(0, 3).map((p) => problemWords(p, plan.on));
  const more = result.problems.slice(3).reduce((n, p) => n + p.count, 0);
  if (more) shown.push(`${fonts(more)} more didn't turn ${verb} for other reasons.`);
  if (result.done === total) return { tone: "success", title: `Turned ${verb} ${fonts(total)} in “${name}”${until}`, details: notes };
  if (result.done === 0) return { tone: "error", title: `Couldn't turn ${verb} the fonts in “${name}”`, details: [...shown, ...notes] };
  return { tone: "warning", title: `Turned ${verb} ${result.done.toLocaleString()} of ${fonts(total)} in “${name}”${until}`, details: [...shown, ...notes] };
}

/** While a tag switch runs: "Turning on “Sci-Fi”…" and how far it is. */
export function tagSwitchProgress(name: string, on: boolean, done: number, total: number): { title: string; detail: string } {
  return { title: `Turning ${on ? "on" : "off"} “${name}”…`, detail: `${done.toLocaleString()} of ${fonts(total)}` };
}

// ------------------------------------------------------------------------------ menu items

/** An action's state where it's offered: whether it can run now, and what it's called. Menu items
 *  show their words, so they have no tooltip. */
export interface TagActionState {
  enabled: boolean;
  label: string;
}

export interface TagSwitchContext {
  /** The saved activation mode (Settings › Activation). */
  mode: ActivationMode;
  /** Fonts on until logout go off when Fontface quits (Settings › Activation). */
  untilQuit?: boolean;
}

/** "Turn on all fonts", or "… until logout" ("… until Fontface quits") for the temporary mode. */
export function tagTurnOnLabel(mode: ActivationMode, untilQuit = false): string {
  if (mode === "persistent") return "Turn on all fonts";
  return untilQuit ? "Turn on all fonts until Fontface quits" : "Turn on all fonts until logout";
}

/**
 * The tag menu's Turn on (the saved mode), Turn on (the other mode) and Turn off, for a tag whose
 * set is `set`. Turn on is greyed out when every font it could turn on is on already (or it has
 * none: no fonts, or only ones that are always on); Turn off, when none is on or set to turn on.
 */
export function tagSwitchStates(set: readonly Face[], ctx: TagSwitchContext): Record<"turnOn" | "turnOnOther" | "turnOff", TagActionState> {
  const s = summarize(set);
  const turnOn = (mode: ActivationMode): TagActionState => ({ enabled: s.total > s.on, label: tagTurnOnLabel(mode, ctx.untilQuit) });
  return { turnOn: turnOn(ctx.mode), turnOnOther: turnOn(otherMode(ctx.mode)), turnOff: { enabled: s.wanted > 0, label: "Turn off all fonts" } };
}

// ------------------------------------------------------------------------ editing a tag

/** Enough of a tag for the rules. */
export interface TagLike {
  name: string;
  builtin: boolean;
}

export type TagEditId = "rename" | "color" | "newInside" | "moveTo" | "export" | "delete" | "makeMine";

/**
 * The tag menu's editing actions for `tag` (`top`: its top-level tag, which decides its group).
 * A built-in tag can only be exported or made the user's own; the rest are greyed out (the menu
 * says "Built-in tag, read-only" above them). "Make it my tag" only shows on built-in tags
 * (`enabled` false elsewhere); on a nested one it names the top-level tag, whose whole branch it
 * makes yours.
 */
export function tagEditStates(tag: TagLike, top: TagLike): Record<TagEditId, TagActionState> {
  const locked = tag.builtin || top.builtin;
  const state = (enabled: boolean, label: string): TagActionState => ({ enabled, label });
  return {
    rename: state(!locked, "Rename…"),
    color: state(!locked, "Color"),
    newInside: state(!locked, "New tag inside…"),
    moveTo: state(!locked, "Move to"),
    export: state(true, "Export…"),
    delete: state(!locked, "Delete…"),
    makeMine: state(locked, locked && top.name !== tag.name ? `Make “${top.name}” my tag` : "Make it my tag"),
  };
}

/**
 * Whether a tag can be moved inside another (dragged onto it, or picked in "Move to"). Only your
 * own tags move, and only into your own tags; not onto itself, into itself, or where it already
 * is. (A tag's `builtin` is always its top-level tag's.)
 */
export function canNestIn(moving: TagLike, into: TagLike): boolean {
  if (moving.builtin || into.builtin) return false;
  const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const within = fold(into.name) === fold(moving.name) || fold(into.name).startsWith(`${fold(moving.name)}/`);
  const parent = moving.name.includes("/") ? moving.name.slice(0, moving.name.lastIndexOf("/")) : "";
  return !within && fold(parent) !== fold(into.name);
}
