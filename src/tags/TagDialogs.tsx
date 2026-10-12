import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import type { Family } from "@/library";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Tag, TagColor } from "./api";
import { ColorSwatches } from "./ColorSwatches";
import { openTagDialog, useTagDialog } from "./dialogs";
import { ExportDialog } from "./ExportDialog";
import { ImportDialog } from "./ImportDialog";
import { countByTag, useTagIndex } from "./model";
import { createTag, deleteTag, renameTag, setFaceTags } from "./store";

const close = () => openTagDialog(null);

/** Shows whichever tag dialog is open. Mounted once, in the sidebar. */
export function TagDialogHost({ families, onDeleted }: { families: Family[]; onDeleted: (ids: number[]) => void }) {
  const dialog = useTagDialog();
  return (
    <>
      <NameDialog dialog={dialog?.kind === "create" || dialog?.kind === "rename" ? dialog : null} />
      <DeleteDialog tag={dialog?.kind === "delete" ? dialog.tag : null} families={families} onDeleted={onDeleted} />
      <ImportDialog open={dialog?.kind === "import"} onClose={close} />
      <ExportDialog open={dialog?.kind === "export"} tag={dialog?.kind === "export" ? dialog.tag : undefined} onClose={close} />
    </>
  );
}

function NameDialog({
  dialog,
}: {
  dialog: { kind: "create"; parent?: Tag; faces?: import("@/library").Face[] } | { kind: "rename"; tag: Tag } | null;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<TagColor | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const errorId = useId();

  useEffect(() => {
    if (!dialog) return;
    setError("");
    setSaving(false);
    if (dialog.kind === "rename") {
      setName(dialog.tag.name);
      setColor(dialog.tag.color);
    } else {
      setName(dialog.parent ? `${dialog.parent.name}/` : "");
      setColor(dialog.parent?.color ?? null);
    }
  }, [dialog]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dialog || saving) return;
    setSaving(true);
    try {
      if (dialog.kind === "rename") {
        await renameTag(dialog.tag.id, name);
      } else {
        const tag = await createTag(name, color ?? undefined);
        if (dialog.faces?.length) await setFaceTags([tag.id], dialog.faces, true);
      }
      close();
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  };

  const creating = dialog?.kind === "create";
  const count = dialog?.kind === "create" ? dialog.faces?.length ?? 0 : 0;
  return (
    <Dialog open={!!dialog} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{creating ? "New tag" : "Rename tag"}</DialogTitle>
            <DialogDescription>
              {creating
                ? count
                  ? `It goes on the ${count === 1 ? "chosen style" : `${count.toLocaleString()} chosen styles`}.`
                  : "Put a “/” in the name to nest it, as in Sci-Fi/Star Trek."
                : "Tags nested under it move with it. Use “/” to move it inside another tag."}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            aria-label="Tag name"
            aria-invalid={!!error}
            aria-describedby={error ? errorId : undefined}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
            placeholder="Tag name"
            maxLength={220}
          />
          {creating && (
            <div className="flex flex-col gap-2">
              <span className="text-xs text-muted-foreground">Color</span>
              <ColorSwatches value={color} onChange={setColor} />
              {!color && (
                <span className="text-[11px] text-muted-foreground">
                  If you don't pick one, a nested tag takes its parent's color, and any other tag gets the color used least.
                </span>
              )}
            </div>
          )}
          {error && (
            <p id={errorId} role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || saving}>
              {creating ? "Create" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ tag, families, onDeleted }: { tag: Tag | null; families: Family[]; onDeleted: (ids: number[]) => void }) {
  const index = useTagIndex();
  const nested = tag ? (index.subtree.get(tag.id)?.size ?? 1) - 1 : 0;
  const styles = tag ? countByTag(families, index).get(tag.id) ?? 0 : 0;
  return (
    <AlertDialog open={!!tag} onOpenChange={(o) => !o && close()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{tag?.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {nested > 0 && `The ${nested} ${nested === 1 ? "tag" : "tags"} inside it will be deleted too. `}
            {styles > 0
              ? `${styles.toLocaleString()} ${styles === 1 ? "style loses" : "styles lose"} the tag. The fonts themselves aren't touched.`
              : "No fonts have it."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={async () => {
              if (!tag) return;
              close();
              try {
                onDeleted(await deleteTag(tag.id));
              } catch (e) {
                toast.error("Couldn't delete the tag", { description: String(e) });
              }
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
