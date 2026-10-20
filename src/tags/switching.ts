import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { ActivationMode, ActivationOutcome } from "@/api";
import type { Face } from "@/library";
import { planTagSwitch, tagSwitchMessage, tagSwitchProgress, tagSwitchResult } from "@/tagActions";
import type { Tag } from "./api";

/**
 * Turning a whole tag on or off (from its sidebar row's More and right-click menus). The rules
 * and words are in src/tagActions.ts; this runs them through App's own on/off path, so a tag switch
 * gets everything a font switch does: the request queue (one request at a time, in click order),
 * busy marks on every file, the activation modes (Option-click for the other one), sync, and
 * the list updating as each request finishes.
 *
 * A big set goes in about ten requests, with a toast that counts up, and ends with one toast
 * that says what happened, including how many fonts didn't switch and why.
 */

/** App's on/off path (its `setActivation`), told to hand back what happened instead of showing
 *  a message per file: `report` gets each request's outcomes, or the error if it failed. */
export type SwitchFonts = (
  ids: number[],
  on: boolean,
  scope: ActivationMode | null,
  report: (outcomes: readonly ActivationOutcome[], error?: unknown) => void,
) => Promise<unknown>;

let switchFonts: SwitchFonts | null = null;

/** Set by the tag host in App (TagDialogHost) on every render, so it's always the current one. */
export function setSwitchFonts(fn: SwitchFonts | null) {
  switchFonts = fn;
}

/** A tag switch in progress: which way, and how many of its fonts are done. */
export interface TagRun {
  on: boolean;
  done: number;
  total: number;
}

let runs = new Map<number, TagRun>();
const listeners = new Set<() => void>();

function setRun(id: number, run: TagRun | null) {
  runs = new Map(runs);
  if (run) runs.set(id, run);
  else runs.delete(id);
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The switch running for this tag, if one is. */
export function useTagRun(id: number): TagRun | undefined {
  return useSyncExternalStore(subscribe, () => runs.get(id));
}

/** How the result is worded: the saved activation mode, and whether fonts on until logout go
 *  off when Fontface quits. */
export interface SwitchWording {
  mode: ActivationMode;
  untilQuit?: boolean;
}

/**
 * Turns on (or off) every font in `set`: a tag's fonts and the fonts of the tags inside it
 * (tagActions.facesByTag). `scope`: turn them on the other way from the saved mode (Option-click).
 * Does nothing while this tag's last switch is still running.
 */
export async function switchTag(tag: Tag, set: readonly Face[], on: boolean, scope: ActivationMode | null, wording: SwitchWording): Promise<void> {
  if (runs.has(tag.id)) return;
  const run = switchFonts;
  const plan = planTagSwitch(set, on);
  const name = tag.name;
  const mode = scope ?? wording.mode;
  const say = (m: ReturnType<typeof tagSwitchMessage>, id?: string | number) => {
    const description = m.details.length ? m.details.join(" ") : undefined;
    const show = { success: toast.success, warning: toast.warning, error: toast.error, info: toast.info }[m.tone];
    show(m.title, { id, description, duration: m.tone === "success" || m.tone === "info" ? undefined : 12_000 });
  };
  if (!plan.batches.length) {
    say(tagSwitchMessage(name, plan, tagSwitchResult(plan, []), { mode, untilQuit: wording.untilQuit }));
    return;
  }
  if (!run) {
    toast.error(`Couldn't turn ${on ? "on" : "off"} the fonts in “${name}”`, { description: "Fontface isn't ready yet. Try again in a moment." });
    return;
  }

  const total = plan.faces.length;
  let done = 0;
  setRun(tag.id, { on, done, total });
  // A count that moves, for sets that take more than one request.
  const progress = () => tagSwitchProgress(name, on, done, total);
  const toastId = plan.batches.length > 1 ? toast.loading(progress().title, { description: progress().detail }) : undefined;
  const outcomes: ActivationOutcome[] = [];
  const failures: string[] = [];
  try {
    // All requests are queued at once, so a click made meanwhile waits its turn after them.
    await Promise.allSettled(
      plan.batches.map((batch) =>
        run(batch.ids, on, scope, (o, error) => {
          outcomes.push(...o);
          if (error !== undefined) failures.push(String(error));
          done += batch.faces;
          setRun(tag.id, { on, done, total });
          if (toastId !== undefined) toast.loading(progress().title, { id: toastId, description: progress().detail });
        }),
      ),
    );
  } finally {
    setRun(tag.id, null);
  }
  say(tagSwitchMessage(name, plan, tagSwitchResult(plan, outcomes, failures), { mode, untilQuit: wording.untilQuit }), toastId);
}
