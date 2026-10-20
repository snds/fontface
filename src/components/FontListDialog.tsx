import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, type ActivationMode, type FoundFace, type LineMatch } from "@/api";
import type { Face } from "@/library";
import { optionClickHint, otherMode, turnOnLabel } from "@/fontActions";
import {
  foundHowText,
  foundText,
  MAX_NAMES,
  notFoundText,
  parseFontList,
  rowStatus,
  statusText,
  summarize,
  summaryText,
  type FaceLookup,
  type ListEntry,
} from "@/fontList";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Tip } from "./Tip";
import { IS_MAC } from "./TitleBar";

/** The tooltip of what opens it: the sidebar's button by LIBRARY. (File › Turn On Fonts from a
 *  List… on macOS opens it too.) */
export const FONT_LIST_TIP = "Finds the fonts named in a list you paste, then turns them on or tags them";

/** How long typing pauses before the names are looked up. */
const LOOKUP_DELAY = 250;

const PLACEHOLDER = "Inter-Bold\nHelvetica Neue Light\nIBM Plex Sans SemiBold Italic\nfont-family: \"Lora\", serif;";

/** The names as the last lookup answered them, row by row. */
interface Lookup {
  entries: ListEntry[];
  matches: LineMatch[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** The library's styles by face key, for each row's on or off state. */
  faceByKey: ReadonlyMap<string, Face>;
  mode: ActivationMode;
  /** Fonts on until logout go off when Fontface quits (the tooltip says so). */
  untilQuit: boolean;
  /** Turns these styles on (`scope`: the other way, from Option-click; null: the saved way).
   *  Resolves once they're switched. */
  onTurnOn: (faces: FoundFace[], scope: ActivationMode | null) => Promise<void>;
  /** Closes this and opens the tag picker for these styles. */
  onAddToTag: (faces: FoundFace[]) => void;
  /** What takes focus when it closes (it opens from code too: focusReturn.ts). */
  returnFocus?: () => HTMLElement | null;
}

/**
 * Turn On Fonts from a List…: paste font names (PostScript names, full names, "Family Style"
 * lines, a CSS font-family list, or the Figma plugin's copied list), see which the library has,
 * then turn them on, tag them, or copy the names it doesn't have. Looking up changes nothing.
 * The text stays for next time while Fontface runs.
 */
export function FontListDialog({ open, onClose, faceByKey, mode, untilQuit, onTurnOn, onAddToTag, returnFocus }: Props) {
  const [text, setText] = useState("");
  const [lookup, setLookup] = useState<Lookup>({ entries: [], matches: [] });
  const [looking, setLooking] = useState(false);
  // The last lookup failed: nothing is shown, so nothing acts on an older list.
  const [failed, setFailed] = useState(false);
  const [turning, setTurning] = useState(false);
  const asked = useRef(0);
  const statusId = useId();
  const parsed = useMemo(() => parseFontList(text), [text]);

  // App clears `returnFocus` as this closes, but Base UI asks `finalFocus` only once the fade
  // ends: keep the one it opened with (as SkippedFilesDialog keeps its request).
  // (Held in an object: React would call a function passed to it on its own.)
  const [opener, setOpener] = useState({ returnFocus });
  if (open && returnFocus && returnFocus !== opener.returnFocus) setOpener({ returnFocus });
  // Add to Tag… hands focus to the tag picker, which gives it back to the same place itself.
  const handedOff = useRef(false);
  useEffect(() => {
    if (open) handedOff.current = false;
  }, [open]);

  // Looks the names up once typing pauses, and again each time the dialog opens (the library may
  // have changed). Only the newest answer is shown.
  useEffect(() => {
    if (!open) return;
    const mine = ++asked.current;
    const entries = parsed.entries;
    setFailed(false);
    if (!entries.length) {
      setLookup({ entries: [], matches: [] });
      setLooking(false);
      return;
    }
    setLooking(true);
    const timer = window.setTimeout(() => {
      api
        .matchFontNames(entries.map((e) => e.line))
        .then((matches) => mine === asked.current && setLookup({ entries, matches }))
        .catch((e) => {
          if (mine !== asked.current) return;
          // The answers shown are for the text as it was before: drop them.
          setLookup({ entries: [], matches: [] });
          setFailed(true);
          toast.error("Couldn't look up the names", { description: String(e) });
        })
        .finally(() => mine === asked.current && setLooking(false));
    }, LOOKUP_DELAY);
    return () => window.clearTimeout(timer);
  }, [open, parsed]);

  const state: FaceLookup = (key) => faceByKey.get(key);
  const summary = summarize(lookup.matches, state);
  const shown = lookup.entries.length > 0;
  const missing = notFoundText(lookup.entries, lookup.matches);

  const wait = looking ? "Wait: Fontface is still looking up the names" : null;
  const empty = !parsed.entries.length ? "Paste some font names first" : null;
  const lookupFailed = failed ? "Couldn't look up the names. Edit the list to try again" : null;
  const noneFound = shown && !summary.found ? "None of these names are in your library" : null;
  const turnOnWhy =
    empty ??
    wait ??
    lookupFailed ??
    (turning ? "Wait: Fontface is still turning these fonts on" : null) ??
    noneFound ??
    (summary.off.length ? null : "Nothing to turn on: every font found is on already");
  const tagWhy = empty ?? wait ?? lookupFailed ?? noneFound;
  const copyWhy = empty ?? wait ?? lookupFailed ?? (missing ? null : "Every name was found");

  const turnOn = async (alt: boolean) => {
    if (turnOnWhy) return;
    setTurning(true);
    try {
      await onTurnOn(summary.off, alt ? otherMode(mode) : null);
    } finally {
      setTurning(false);
    }
  };

  const copyMissing = () => {
    if (copyWhy) return;
    const n = missing.split("\n").length;
    void copyText(missing).then((ok) =>
      ok ? toast.success(`Copied ${n.toLocaleString()} ${n === 1 ? "name" : "names"} not found`, { description: "One per line." }) : toast.error("Couldn't copy the names"),
    );
  };

  const styles = (n: number) => `${n.toLocaleString()} ${n === 1 ? "style" : "styles"}`;
  const downloads = summary.downloads ? ` ${summary.downloads.toLocaleString()} of them download first.` : "";
  const turnOnTip = `Turns on the ${styles(summary.off.length)} found that are off.${downloads} ${optionClickHint(mode, IS_MAC, untilQuit)}`;

  // The line above the table: what the list holds, or why there's nothing to show.
  const notes = [parsed.repeats ? `${parsed.repeats.toLocaleString()} repeated ${parsed.repeats === 1 ? "name" : "names"} looked up once.` : "", parsed.over ? `Only the first ${MAX_NAMES.toLocaleString()} names are looked up.` : ""].filter(Boolean).join(" ");
  const status = parsed.badJson
    ? "This looks like part of a JSON list. Paste all of it, from the first { to the last }."
    : !parsed.entries.length
      ? "Paste names to see which fonts you have."
      : looking && !shown
        ? `Looking up ${parsed.entries.length.toLocaleString()} ${parsed.entries.length === 1 ? "name" : "names"}…`
        : lookupFailed
          ? `${lookupFailed}.`
          : `${summaryText(summary)}.${notes ? ` ${notes}` : ""}`;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {/* A flex column whose table scrolls, so the box, the summary and the buttons stay in view. */}
      <DialogContent className="flex flex-col sm:max-w-2xl" finalFocus={() => (handedOff.current ? false : (opener.returnFocus?.() ?? true))}>
        <DialogHeader>
          <DialogTitle>Turn On Fonts from a List</DialogTitle>
          <DialogDescription>
            Paste PostScript names, full names or “Family Style” lines, one per line. A CSS font-family list works too, and so does the list the Fontface plugin for
            Figma copies. Nothing changes until you choose what to do.
          </DialogDescription>
        </DialogHeader>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={PLACEHOLDER}
          aria-label="Font names, one per line"
          aria-describedby={statusId}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          rows={6}
          className="min-h-24 w-full shrink-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        />
        <p id={statusId} role="status" className={cn("text-xs", parsed.badJson || lookupFailed ? "text-destructive" : "text-muted-foreground")}>
          {status}
        </p>
        {shown && (
          // Focusable, so the keyboard can scroll a long list (the web view doesn't make scroll
          // areas focusable on its own).
          <div
            tabIndex={0}
            role="region"
            aria-label="What each name found"
            className={cn(
              "-mx-1 min-h-0 flex-1 overflow-y-auto rounded-lg border outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
              looking && "opacity-60",
            )}
            aria-busy={looking}
          >
            <table className="w-full table-fixed border-collapse text-xs">
              <thead className="sticky top-0 bg-popover text-left text-muted-foreground">
                <tr className="border-b">
                  <th scope="col" className="w-[38%] px-2 py-1.5 font-medium">
                    Name
                  </th>
                  <th scope="col" className="px-2 py-1.5 font-medium">
                    Found
                  </th>
                  <th scope="col" className="w-28 px-2 py-1.5 font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {lookup.entries.map((entry, i) => {
                  const m = lookup.matches[i];
                  if (!m) return null;
                  const row = rowStatus(m, state);
                  return (
                    <tr key={`${i}:${entry.label}`} className="border-b align-top last:border-b-0">
                      {/* Long names and the closest names wrap, so all of them can be read. */}
                      <td className="px-2 py-1 font-mono break-words">{entry.label}</td>
                      <td className={cn("px-2 py-1 break-words", row === "notFound" && "text-muted-foreground")}>
                        {foundText(m)}
                        {foundHowText(m) && <span className="text-muted-foreground"> · {foundHowText(m)}</span>}
                      </td>
                      <td className={cn("px-2 py-1 whitespace-nowrap", row === "notFound" ? "text-destructive" : row === "on" ? "text-muted-foreground" : "font-medium")}>
                        {statusText(m, state)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <DialogFooter className="sm:items-center">
          <Tip tip="Copies the names your library doesn't have, one per line" disabledReason={copyWhy}>
            <Button variant="outline" disabled={!!copyWhy} focusableWhenDisabled onClick={copyMissing}>
              <Icon name="content_copy" size={16} />
              Copy Not Found
            </Button>
          </Tip>
          <Tip tip={`Opens the tags for the ${styles(summary.faces.length)} found`} disabledReason={tagWhy}>
            <Button
              variant="outline"
              disabled={!!tagWhy}
              focusableWhenDisabled
              onClick={() => {
                if (tagWhy) return;
                handedOff.current = true;
                onAddToTag(summary.faces);
              }}
            >
              <Icon name="sell" size={16} />
              Add to Tag…
            </Button>
          </Tip>
          <span className="hidden flex-1 sm:block" />
          <Tip tip={turnOnTip} disabledReason={turnOnWhy} contentClassName="max-w-72">
            <Button disabled={!!turnOnWhy} focusableWhenDisabled onClick={(e: React.MouseEvent) => void turnOn(e.altKey)}>
              {turnOnLabel(mode, untilQuit)}
              {summary.off.length > 0 && !turnOnWhy && <span className="font-mono tabular-nums opacity-80">{summary.off.length.toLocaleString()}</span>}
            </Button>
          </Tip>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
