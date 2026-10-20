import { useState } from "react";
import type { SkippedFiles } from "@/api";
import { skippedEntries } from "@/skippedFiles";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tip } from "./Tip";

/** What Show Skipped Files… shows: a source's name and its latest scan's counts. */
export interface SkippedRequest {
  name: string;
  skipped: SkippedFiles;
  /** What takes focus when it closes (it opens from code: focusReturn.ts). */
  returnFocus?: () => HTMLElement | null;
}

/** The tooltip of the buttons that open it: from a finished scan's message, and an empty folder. */
export const SKIPPED_DETAILS_TIP = "Lists each kind of file the scan skipped, and why";

/**
 * The files a source's latest scan found but didn't add, one row per kind: how many, what they
 * are, and why Fontface leaves them out. Nothing on disk changes.
 */
export function SkippedFilesDialog({ request, onClose }: { request: SkippedRequest | null; onClose: () => void }) {
  // The last request stays drawn while the dialog fades out.
  const [shown, setShown] = useState(request);
  if (request && request !== shown) setShown(request);
  const rows = skippedEntries(shown?.skipped);
  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && onClose()}>
      {/* A flex column whose list scrolls, so the heading and Done stay in view in a short window. */}
      <DialogContent className="flex flex-col sm:max-w-md" finalFocus={() => shown?.returnFocus?.() ?? true}>
        <DialogHeader>
          <DialogTitle>Files skipped in {shown?.name}</DialogTitle>
          <DialogDescription>The last scan found these files but didn't add them to your library. They stay where they are.</DialogDescription>
        </DialogHeader>
        <ul className="-m-1 flex min-h-0 flex-col gap-3 overflow-y-auto p-1">
          {rows.map((row) => (
            <li key={row.kind} className="flex gap-3">
              <span className="w-14 shrink-0 text-right font-mono text-sm tabular-nums">{row.count.toLocaleString()}</span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium">{row.title}</span>
                <span className="text-muted-foreground">{row.why}</span>
              </div>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Tip tip="Closes this list" describe={false}>
            <Button onClick={onClose}>Done</Button>
          </Tip>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
