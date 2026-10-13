import { useEffect, useMemo, useRef, useState } from "react";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { ChoiceGroup } from "@/components/ChoiceGroup";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { colorVar, tagsApi, type ImportPreview, type ImportSource } from "./api";
import { depthOf, leafOf } from "./model";

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** Tree order: each tag right after its parent, siblings by name. */
function byTree(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const c = collator.compare(x[i], y[i]);
    if (c) return c;
  }
  return x.length - y.length;
}
import { reload } from "./store";

const n = (v: number) => v.toLocaleString();
/** "12 Oct 2026, 2:30 pm" (in the user's own format). */
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** How a backup is restored: its tags added to the ones there, or in place of them. */
type RestoreMode = "add" | "replace";
const RESTORE_MODES: { value: RestoreMode; label: string; description: string }[] = [
  {
    value: "add",
    label: "Add to my tags",
    description: "Brings back the backup's tags and keeps all of yours. A tag you renamed since comes back under its old name too.",
  },
  {
    value: "replace",
    label: "Replace my tags",
    description:
      "Your tags become the ones ticked below, as they were in the backup. Tags you made since are deleted, and location colors go back to the backup's.",
  },
];

const SOURCES: { kind: ImportSource["kind"]; icon: string; title: string; hint: string }[] = [
  {
    kind: "typeface",
    icon: "backup",
    title: "Typeface backup…",
    hint: "A .typeface-backup file, from Typeface's File › Export › Backup Tags.",
  },
  { kind: "fontface", icon: "data_object", title: "Fontface tags file…", hint: "A .json file exported from Fontface." },
  { kind: "finder", icon: "sell", title: "Finder tags", hint: "Tags you added to font files in Finder." },
  { kind: "fontBook", icon: "auto_stories", title: "Font Book collections", hint: "Collections you made in Font Book." },
];

async function pickSource(kind: ImportSource["kind"]): Promise<ImportSource | null> {
  if (kind === "finder" || kind === "fontBook") return { kind };
  const typeface = kind === "typeface";
  const path = await openFile({
    multiple: false,
    directory: false,
    title: typeface ? "Choose a Typeface backup" : "Choose a Fontface tags file",
    filters: [typeface ? { name: "Typeface backup", extensions: ["typeface-backup"] } : { name: "Fontface tags", extensions: ["json"] }],
  });
  return typeof path === "string" ? { kind, path } : null;
}

/** The fonts the source names that aren't in the library, opened on request, with a way to copy them. */
function MissingFonts({ preview }: { preview: ImportPreview }) {
  const [open, setOpen] = useState(false);
  const total = preview.unmatchedFonts;
  const copy = () => {
    const text = preview.missing.map((m) => `${m.name}\t${m.tags.join(", ")}`).join("\n");
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(`Copied ${n(preview.missing.length)} font names`, { description: "One per line, with their tags after a tab." }))
      .catch((e) => toast.error("Couldn't copy", { description: String(e) }));
  };
  return (
    <details className="rounded-lg border text-xs" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="cursor-default px-3 py-2 select-none">
        Show the {n(total)} {total === 1 ? "font" : "fonts"} not in your library
      </summary>
      {open && (
        <div className="flex flex-col gap-2 border-t p-2">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-muted-foreground">
              Most are fonts you don't have here, such as Google Fonts that Typeface downloaded itself.
              {preview.missing.length < total && ` The first ${n(preview.missing.length)} are listed.`}
            </span>
            <Button variant="outline" size="xs" onClick={copy}>
              <Icon name="content_copy" size={14} />
              Copy list
            </Button>
          </div>
          <ul className="max-h-48 overflow-y-auto font-mono" aria-label="Fonts not in your library">
            {preview.missing.map((m, i) => (
              <li key={`${i}:${m.name}`} className="flex gap-2 px-1 py-0.5">
                <span className="truncate">{m.name}</span>
                <span className="ml-auto shrink-0 truncate font-sans text-muted-foreground">{m.tags.join(", ")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}

/**
 * Import tags: pick a source, see what it holds and how it matches the library, tick the tags
 * to bring in, then apply. Running it again adds nothing new. Given a `source`, it opens straight
 * on that file's preview. Given a backup's date too (Restore…, from settings), it restores: it
 * names the backup, and offers to add its tags to yours or to replace yours with them.
 */
export function ImportDialog({
  open,
  source: given,
  backupMadeAt,
  onClose,
}: {
  open: boolean;
  source?: ImportSource;
  /** When the backup in `source` was made (Unix ms). */
  backupMadeAt?: number;
  onClose: () => void;
}) {
  const [source, setSource] = useState<ImportSource | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [keep, setKeep] = useState(true);
  const [applying, setApplying] = useState(false);
  const restoring = !!given && backupMadeAt !== undefined;
  const backupName = restoring ? `the backup made on ${when(backupMadeAt)}` : "";
  const [mode, setMode] = useState<RestoreMode>("add");
  /** Why the backup couldn't be read (restoring only; other sources go back to the list). */
  const [failed, setFailed] = useState<string | null>(null);
  const replace = restoring && mode === "replace";
  // Each preview request gets a number. Closing the dialog or starting another request makes
  // older answers stale, so a slow one can't land in a dialog that has moved on.
  const request = useRef(0);

  useEffect(() => {
    if (open) return;
    request.current++;
    setSource(null);
    setPreview(null);
    setLoading(false);
    setApplying(false);
    setMode("add");
    setFailed(null);
  }, [open]);

  const choose = async (kind: ImportSource["kind"]) => {
    const id = ++request.current;
    const picked = await pickSource(kind).catch(() => null);
    if (!picked || id !== request.current) return;
    await load(picked, id);
  };

  const load = async (picked: ImportSource, id = ++request.current) => {
    setSource(picked);
    setLoading(true);
    setFailed(null);
    try {
      const p = await tagsApi.importPreview(picked);
      if (id !== request.current) return;
      p.tags.sort((a, b) => byTree(a.name, b.name));
      setPreview(p);
      setChosen(new Set(p.tags.filter((t) => t.suggested).map((t) => t.name)));
    } catch (e) {
      if (id !== request.current) return;
      if (restoring) {
        setFailed(String(e));
      } else {
        toast.error("Couldn't read that", { description: String(e) });
        setSource(null);
      }
    } finally {
      if (id === request.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (open && given) load(given);
    // Only when it opens with a file; `load` is recreated each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, given]);

  const apply = async () => {
    if (!source || !preview) return;
    setApplying(true);
    try {
      const r = await tagsApi.importApply(source, [...chosen], keep, replace);
      await reload();
      const parts = [
        r.tagsCreated && `${n(r.tagsCreated)} ${replace ? "" : "new "}${r.tagsCreated === 1 ? "tag" : "tags"}`,
        `${n(r.styles)} ${r.styles === 1 ? "style" : "styles"} tagged`,
        r.kept && `tags kept for ${n(r.kept)} ${r.kept === 1 ? "font" : "fonts"} you don't have yet`,
        r.locationColors && `${n(r.locationColors)} location colors`,
      ].filter(Boolean);
      const title = !restoring
        ? `Imported from ${preview.label}`
        : replace
          ? `Your tags are back to ${backupName}`
          : `Added tags from ${backupName}`;
      toast.success(title, { description: parts.join(" · ") });
      onClose();
    } catch (e) {
      toast.error(restoring ? "Couldn't restore the tags" : "Couldn't import", { description: String(e) });
      setApplying(false);
    }
  };

  const picked = useMemo(() => preview?.tags.filter((t) => chosen.has(t.name)) ?? [], [preview, chosen]);
  const pendingFonts = picked.reduce((sum, t) => sum + t.unmatched, 0);
  const toggle = (name: string, on: boolean) =>
    setChosen((s) => {
      const next = new Set(s);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {/* Header, one middle part, footer: the middle gives way and scrolls when the window is short. */}
      <DialogContent className={cn("flex flex-col", (preview || restoring) && "sm:max-w-2xl")}>
        <DialogHeader>
          <DialogTitle className="leading-snug">{restoring ? `Restore tags from ${backupName}` : "Import tags"}</DialogTitle>
          <DialogDescription>
            {restoring
              ? "It holds your tags and location colors as they were then. Nothing changes until you restore."
              : preview
                ? `${preview.label}${preview.date ? `, made ${when(preview.date * 1000)}` : ""}. Nothing changes until you import.`
                : "Nothing changes until you've seen what each source holds and chosen what to bring in."}
          </DialogDescription>
        </DialogHeader>

        {/* A backup opens on its own preview: while it's read there's no list of sources to show. */}
        {restoring && !preview && (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground" role="status">
            {failed ? (
              <>
                <Icon name="error" size={18} className="text-destructive" />
                Couldn't read this backup. {failed}
              </>
            ) : (
              <>
                <Icon name="progress_activity" size={18} className="animate-spin" />
                Reading the backup…
              </>
            )}
          </p>
        )}

        {!restoring && !preview && (
          <div className="-m-1 flex min-h-0 flex-col gap-1.5 overflow-y-auto p-1">
            {SOURCES.map((s) => (
              <button
                key={s.kind}
                disabled={loading}
                onClick={() => choose(s.kind)}
                className="flex items-start gap-3 rounded-lg border p-3 text-left hover:bg-muted disabled:opacity-50"
              >
                <Icon name={loading && source?.kind === s.kind ? "progress_activity" : s.icon} size={20} className={cn("mt-0.5 text-muted-foreground", loading && source?.kind === s.kind && "animate-spin")} />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{s.title}</span>
                  <span className="text-xs text-muted-foreground">{s.hint}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {preview && (
          // -m-1 p-1: room for focus rings inside the scrolling area.
          <div className="-m-1 flex min-h-0 flex-col gap-3 overflow-y-auto p-1">
            {restoring && preview.tags.length > 0 && (
              <ChoiceGroup look="cards" label="How to restore" value={mode} options={RESTORE_MODES} onChange={setMode} />
            )}
            <p className="text-sm">
              {preview.tags.length ? (
                <>
                  {n(preview.tags.length)} tags naming {n(preview.fonts)} fonts. <strong className="font-medium">{n(preview.matchedFonts)}</strong> are
                  in your library{preview.unmatchedFonts > 0 && <>; {n(preview.unmatchedFonts)} aren't</>}.
                </>
              ) : (
                "There are no tags here."
              )}
            </p>
            {preview.tags.length > 0 && (
              // When space is short the table gives way first, down to about three rows; then
              // the whole middle scrolls. Two rows or fewer are smaller than that, so they keep
              // their height.
              <div className={cn("max-h-[50vh] overflow-y-auto rounded-lg border", preview.tags.length > 2 ? "min-h-32" : "shrink-0")}>
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-popover text-muted-foreground">
                    <tr className="border-b text-left">
                      <th className="w-8 p-2">
                        <Checkbox
                          aria-label="All tags"
                          checked={chosen.size === preview.tags.length}
                          indeterminate={chosen.size > 0 && chosen.size < preview.tags.length}
                          onCheckedChange={(on) => setChosen(on ? new Set(preview.tags.map((t) => t.name)) : new Set())}
                        />
                      </th>
                      <th className="p-2 font-medium">Tag</th>
                      <th className="p-2 text-right font-medium" title="Styles in your library that get this tag">In library</th>
                      {/* Replacing starts from no tags, so every style in the library is new. */}
                      {!replace && (
                        <th className="p-2 text-right font-medium" title="Styles that don't have it yet">New</th>
                      )}
                      <th className="p-2 text-right font-medium" title="Fonts not in your library">Missing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.tags.map((t) => {
                      const id = `import-${t.name}`;
                      return (
                        <tr key={t.name} className="border-b last:border-0">
                          <td className="p-2 align-top">
                            <Checkbox id={id} checked={chosen.has(t.name)} onCheckedChange={(on) => toggle(t.name, !!on)} />
                          </td>
                          <td className="p-2 align-top">
                            <label htmlFor={id} className="flex flex-col gap-0.5" style={{ paddingLeft: depthOf(t.name) * 12 }} title={t.name}>
                              <span className="flex items-center gap-1.5">
                                <Icon name="label" size={14} filled style={{ color: colorVar(t.color) }} />
                                <span className="truncate font-medium">{depthOf(t.name) ? leafOf(t.name) : t.name}</span>
                                {t.exists && !replace && <span className="text-muted-foreground">(you have this tag)</span>}
                              </span>
                              {t.note && <span className="text-muted-foreground italic">{t.note}</span>}
                              {t.merged.length > 0 && (
                                <span className="text-muted-foreground">Also includes “{t.merged.join("”, “")}”</span>
                              )}
                            </label>
                          </td>
                          <td className="p-2 text-right align-top font-mono tabular-nums">{n(t.matched)}</td>
                          {!replace && <td className="p-2 text-right align-top font-mono tabular-nums">{t.new ? n(t.new) : "–"}</td>}
                          <td className="p-2 text-right align-top font-mono text-muted-foreground tabular-nums">{t.unmatched ? n(t.unmatched) : "–"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {pendingFonts > 0 && (
              <label className="flex items-start gap-2 text-xs">
                <Checkbox checked={keep} onCheckedChange={(on) => setKeep(!!on)} className="mt-0.5" />
                <span>
                  Remember the tags of fonts that aren't in your library yet. They'll have them when you add the fonts, for
                  example from Google Fonts.
                </span>
              </label>
            )}
            {preview.missing.length > 0 && <MissingFonts preview={preview} />}
            {preview.notes.map((note) => (
              <p key={note} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Icon name="info" size={14} className="mt-px" />
                {note}
              </p>
            ))}
          </div>
        )}

        <DialogFooter>
          {preview && !restoring && (
            <Button variant="ghost" className="mr-auto" onClick={() => setPreview(null)} disabled={applying}>
              Back
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {preview && (
            <Button variant={replace ? "destructive" : "default"} onClick={apply} disabled={!chosen.size || applying}>
              {applying
                ? restoring
                  ? "Restoring…"
                  : "Importing…"
                : replace
                  ? "Replace my tags"
                  : `${restoring ? "Add" : "Import"} ${n(chosen.size)} ${chosen.size === 1 ? "tag" : "tags"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
