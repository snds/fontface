import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { tagsApi, type FileExportFormat, type Tag } from "./api";

const n = (v: number) => v.toLocaleString();

type Format = FileExportFormat | "finder" | "fontBook";

const FORMATS: { value: Format; title: string; hint: string; ext?: string }[] = [
  {
    value: "json",
    title: "Fontface tags file (.json)",
    hint: "Tags, their colors and their fonts. Fontface can import it again, on this Mac or another.",
    ext: "json",
  },
  { value: "csv", title: "Spreadsheet (.csv)", hint: "One row for each font and tag. Opens in Numbers or Excel.", ext: "csv" },
  {
    value: "typeface",
    title: "Typeface backup (.typeface-backup)",
    hint: "The same layout as Typeface's own backups, for restoring into Typeface. Not yet tried in Typeface.",
    ext: "typeface-backup",
  },
  {
    value: "finder",
    title: "Finder tags on the font files",
    hint: "Adds each tag to the font files, so Finder and Spotlight can find them. Tags already on a file stay. Fonts in the macOS font folders are left alone. Files in cloud folders sync their tags too.",
  },
  {
    value: "fontBook",
    title: "Font Book collections",
    hint: "Adds a Font Book collection for each tag. Fonts already in a collection stay. Font Book only lists fonts that are turned on.",
  },
];

const today = () => new Date().toISOString().slice(0, 10);

/** Export tags (all, or one tag and the tags inside it) to a file, to Finder tags or to Font Book. */
export function ExportDialog({ open, tag, onClose }: { open: boolean; tag?: Tag; onClose: () => void }) {
  const [format, setFormat] = useState<Format>("json");
  // Stays on until the export finishes, even if the dialog is closed and reopened meanwhile.
  const [working, setWorking] = useState(false);

  const ids = tag ? [tag.id] : null;
  const run = async () => {
    setWorking(true);
    try {
      if (format === "finder") {
        const r = await tagsApi.exportFinder(ids);
        const parts = [`${n(r.changed)} files tagged`, r.unchanged && `${n(r.unchanged)} already had them`, r.skippedInstalled && `${n(r.skippedInstalled)} in macOS font folders left alone`].filter(Boolean);
        if (r.failed.length) {
          toast.warning(`${n(r.failed.length)} files couldn't be tagged`, { description: parts.join(" · ") });
          for (const f of r.failed) console.warn("finder tags", f.path, f.reason);
        } else toast.success("Finder tags added", { description: parts.join(" · ") });
      } else if (format === "fontBook") {
        const r = await tagsApi.exportFontBook(ids);
        const parts = [`${n(r.added)} fonts added to ${n(r.collections)} collections`, r.skipped && `${n(r.skipped)} without a PostScript name left out`].filter(Boolean);
        if (r.failed.length) {
          toast.warning(`${n(r.failed.length)} collections couldn't be saved`, { description: r.failed.map((f) => `${f.path}: ${f.reason}`).join("\n") });
        } else toast.success(r.added ? "Font Book collections updated" : "Font Book already had these", { description: parts.join(" · ") });
      } else {
        const spec = FORMATS.find((f) => f.value === format)!;
        const base = tag ? tag.name.replace(/[/:]/g, "-") : "fontface-tags";
        const path = await save({
          title: "Export tags",
          defaultPath: `${base}-${today()}.${spec.ext}`,
          filters: [{ name: spec.title, extensions: [spec.ext!] }],
        });
        if (!path) return;
        const r = await tagsApi.exportFile(format, path, ids);
        toast.success("Tags exported", {
          description: [`${n(r.tags)} tags covering ${n(r.fonts)} fonts`, r.skipped && `${n(r.skipped)} without a PostScript name left out`].filter(Boolean).join(" · "),
        });
      }
      onClose();
    } catch (e) {
      toast.error("Couldn't export", { description: String(e) });
    } finally {
      setWorking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Export tags</DialogTitle>
          <DialogDescription>{tag ? `“${tag.name}” and the tags inside it.` : "All your tags."}</DialogDescription>
        </DialogHeader>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="sr-only">Format</legend>
          {FORMATS.map((f) => (
            <label
              key={f.value}
              className={cn("flex cursor-default items-start gap-3 rounded-lg border p-3", format === f.value ? "border-ring bg-muted/60" : "hover:bg-muted/40")}
            >
              <input type="radio" name="export-format" value={f.value} checked={format === f.value} onChange={() => setFormat(f.value)} className="mt-1 accent-primary" />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{f.title}</span>
                <span className="text-xs text-muted-foreground">{f.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={run} disabled={working}>
            {working ? "Exporting…" : format === "finder" ? "Add Finder tags" : format === "fontBook" ? "Add to Font Book" : "Export…"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
