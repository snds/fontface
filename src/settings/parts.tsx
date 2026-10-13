import { useEffect, useRef, useState } from "react";
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
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** The ids that tie a row's control to its label and description. */
export interface RowIds {
  control: string;
  label: string;
  description: string;
}

/** One setting: a label and a line of plain words on the left, its control on the right. */
export interface RowDef {
  id: string;
  label: string;
  description: string;
  /** More words search should find it by. */
  keywords?: string;
  /** The control on the right. */
  control?: (ids: RowIds) => React.ReactNode;
  /** Full-width content under the words (choice cards, lists). */
  below?: (ids: RowIds) => React.ReactNode;
  /** The control is a form field (switch, text box) the label can point at, so clicking the label works it. */
  labelsControl?: boolean;
}

export interface GroupDef {
  id: string;
  title?: string;
  rows: RowDef[];
}

export type SectionId = "general" | "library" | "sidebar" | "activation" | "sync" | "purchases" | "backups" | "about";

/** The sections, in order, as the settings sidebar lists them. */
export const SECTION_LIST: { id: SectionId; label: string; icon: string }[] = [
  { id: "general", label: "General", icon: "tune" },
  { id: "library", label: "Library", icon: "folder_open" },
  { id: "sidebar", label: "Sidebar", icon: "side_navigation" },
  { id: "activation", label: "Activation", icon: "toggle_on" },
  { id: "sync", label: "Sync", icon: "sync" },
  { id: "purchases", label: "Purchases", icon: "shopping_bag" },
  { id: "backups", label: "Backups", icon: "backup" },
  { id: "about", label: "About", icon: "info" },
];

export interface SectionDef {
  id: SectionId;
  label: string;
  icon: string;
  /** A sentence under the title, when the section needs one. */
  intro?: string;
  groups: GroupDef[];
}

export const rowIds = (id: string): RowIds => ({
  control: `setting-${id}`,
  label: `setting-${id}-label`,
  description: `setting-${id}-desc`,
});

/** Spread on a control so screen readers hear the row's label and description with it. */
export const describe = (ids: RowIds) => ({ "aria-labelledby": ids.label, "aria-describedby": ids.description });

export function SettingRow({ row }: { row: RowDef }) {
  const ids = rowIds(row.id);
  const Label = row.labelsControl ? "label" : "div";
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <div className="flex items-center gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Label id={ids.label} htmlFor={row.labelsControl ? ids.control : undefined} className="text-sm font-medium">
            {row.label}
          </Label>
          <p id={ids.description} className="text-xs text-pretty text-muted-foreground">
            {row.description}
          </p>
        </div>
        {row.control && <div className="flex shrink-0 items-center gap-2">{row.control(ids)}</div>}
      </div>
      {row.below?.(ids)}
    </div>
  );
}

/** A card of rows, with an optional heading above it. */
export function SettingGroup({ id, title, children }: { id: string; title?: string; children: React.ReactNode }) {
  const headingId = `group-${id}`;
  return (
    <section aria-labelledby={title ? headingId : undefined} className="flex flex-col gap-2">
      {title && (
        <h3 id={headingId} className="px-1 text-xs font-medium text-muted-foreground">
          {title}
        </h3>
      )}
      <div className="divide-y rounded-xl border bg-muted/40">{children}</div>
    </section>
  );
}

/**
 * A whole number typed into a small box. It saves when you leave the box or press Return, pulled
 * into range; anything that isn't a number puts the saved value back, and so does Esc.
 */
export function NumberField({
  value,
  min,
  max,
  onCommit,
  className,
  ...props
}: { value: number; min: number; max: number; onCommit: (n: number) => void; className?: string } & Omit<
  React.ComponentProps<"input">,
  "value" | "onChange" | "min" | "max" | "type"
>) {
  const [draft, setDraft] = useState(String(value));
  // Esc puts the saved value back; the blur that follows mustn't save the draft.
  const cancelled = useRef(false);
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (draft.trim() === "" || !Number.isFinite(n)) return setDraft(String(value));
    const clamped = Math.min(max, Math.max(min, n));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <Input
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (cancelled.current) cancelled.current = false;
        else commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          cancelled.current = true;
          setDraft(String(value));
        }
      }}
      className={cn("w-20 text-right font-mono tabular-nums", className)}
      {...props}
    />
  );
}

/**
 * Text that saves shortly after you stop typing, and when you leave the box. While you type,
 * a change arriving from elsewhere doesn't overwrite what you're writing. A save still waiting
 * when the box goes away (settings closed with Esc right after typing) happens then: closing
 * sends no blur.
 */
export function TextSetting({
  value,
  onCommit,
  className,
  ...props
}: { value: string; onCommit: (text: string) => void; className?: string } & Omit<React.ComponentProps<"input">, "value" | "onChange">) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The text waiting to be saved (null: nothing is), and the latest props, for the save on unmount.
  const pending = useRef<string | null>(null);
  const latest = useRef({ value, onCommit });
  latest.current = { value, onCommit };
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  const flush = (text: string) => {
    clearTimeout(timer.current);
    pending.current = null;
    if (text !== latest.current.value) latest.current.onCommit(text);
  };
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      const text = pending.current;
      if (text !== null && text !== latest.current.value) latest.current.onCommit(text);
    },
    [],
  );
  return (
    <Input
      value={draft}
      onFocus={() => (editing.current = true)}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        clearTimeout(timer.current);
        pending.current = text;
        timer.current = setTimeout(() => flush(text), 500);
      }}
      onBlur={() => {
        editing.current = false;
        flush(draft);
      }}
      className={className}
      {...props}
    />
  );
}

/** A button that asks first. The question names what will happen; the action button repeats the verb. */
export function ConfirmButton({
  label,
  icon,
  title,
  description,
  confirm,
  disabled,
  variant = "outline",
  onConfirm,
  ...props
}: {
  label: string;
  icon?: string;
  title: string;
  description: React.ReactNode;
  confirm: string;
  disabled?: boolean;
  variant?: "outline" | "destructive";
  onConfirm: () => void;
} & Omit<React.ComponentProps<typeof Button>, "onClick" | "variant">) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant={variant} disabled={disabled} onClick={() => setOpen(true)} {...props}>
        {icon && <Icon name={icon} size={16} />}
        {label}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
