import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { api, type PendingRestore } from "@/api";

const TOAST_ID = "restore-pending";
const n = (v: number) => v.toLocaleString();

/** "Inter, Roboto Mono and 4 more" */
function familyList(families: string[]): string {
  if (families.length <= 3) return families.join(", ").replace(/, ([^,]*)$/, " and $1");
  return `${families.slice(0, 3).join(", ")} and ${n(families.length - 3)} more`;
}

/**
 * The "Ask me" choice for fonts turned off while Fontface was closed. Launch works out which
 * fonts those are, then this asks once, in a toast that stays until it's answered. The answer
 * goes to the back end, then `onDone` refreshes the library. Swiping the toast away answers
 * nothing: the back end keeps the question, and the next launch asks again.
 *
 * The toast must stay dismissible: sonner ignores a cancel button ("Keep off") on a toast that
 * isn't, so only "Turn back on" would work.
 *
 * The listener is registered before asking for the list, and activationPendingRestore waits
 * for launch to finish checking, so the question is never missed; the event and the answer
 * share one toast, so it's never asked twice.
 */
export function useRestorePrompt(onDone: () => void) {
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    let answered = false;

    const decide = async (restore: boolean) => {
      answered = true;
      try {
        const r = await api.activationRestoreDecide(restore);
        if (restore && r.failed) {
          toast.warning(`Turned ${n(r.restored)} back on; ${n(r.failed)} couldn't be turned on`, {
            description: "Their files may be missing, or on a drive that isn't connected.",
          });
        } else if (restore) {
          toast.success(r.restored === 1 ? "Turned 1 font back on" : `Turned ${n(r.restored)} fonts back on`);
        }
      } catch (e) {
        // Nothing was decided; the back end keeps the question, so ask again.
        answered = false;
        toast.error("Couldn't do that", { description: String(e) });
        api.activationPendingRestore().then(ask, () => {});
      } finally {
        done.current();
      }
    };

    const ask = (p: PendingRestore) => {
      if (answered || p.count === 0) return;
      toast(
        p.count === 1 ? "1 font was turned off while Fontface was closed." : `${n(p.count)} fonts were turned off while Fontface was closed.`,
        {
          id: TOAST_ID,
          duration: Infinity,
          description: p.families.length ? familyList(p.families) : undefined,
          action: { label: "Turn back on", onClick: () => decide(true) },
          cancel: { label: "Keep off", onClick: () => decide(false) },
        },
      );
    };

    const unlisten = listen<PendingRestore>("restore-pending", (e) => ask(e.payload));
    unlisten
      .then(() => api.activationPendingRestore())
      .then(ask)
      .catch(() => {});
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);
}
