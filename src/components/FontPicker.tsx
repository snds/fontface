import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Family } from "@/library";
import { searchFamilies } from "@/compare";
import { usePreviewProfile } from "@/previewProfiles";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { FacePreview } from "./FacePreview";

/** Families listed before anything is typed, and at most while typing. */
const SHOWN = 60;

/** What a font picker is for: Compare's "Compare With…" and "Add Fonts…", Pair's two fonts. */
export interface PickRequest {
  title: string;
  description?: string;
  /** Pick several (Compare), confirmed with `confirm`; else one, picked with Return or a click. */
  multiple: boolean;
  /** The button that confirms several: "Compare". */
  confirm?: string;
  /** Families shown as already chosen and not offered again (by Family.id). */
  exclude?: readonly string[];
  /** The picked families, in the order picked. True when picking opens a page, whose heading
   *  then takes focus (the picker doesn't hand it back to where it was). */
  onPick: (families: Family[]) => boolean | void;
  /** What takes focus when it closes without opening a page: what had focus when it was asked
   *  for (App notes it: focusReturn.ts). Null or absent: the dialog's own choice. */
  returnFocus?: () => HTMLElement | null;
}

/** Opens the font picker (App hosts it). */
export const FontPickerContext = createContext<(request: PickRequest) => void>(() => {});
export const useFontPicker = () => useContext(FontPickerContext);

/**
 * The library search as a dialog: type to find a family, Up and Down move, Return picks (or,
 * picking several, ticks), and a click does the same. Each family shows its name in its own
 * preview style. Filters don't apply: it searches the whole library.
 */
export function FontPickerDialog({ request, families, onClose }: { request: PickRequest | null; families: readonly Family[]; onClose: () => void }) {
  // The last request stays drawn while the dialog closes (its animation, and where focus goes
  // afterwards); each new one starts afresh.
  const [shown, setShown] = useState<{ request: PickRequest; n: number } | null>(null);
  if (request && request !== shown?.request) setShown({ request, n: (shown?.n ?? 0) + 1 });
  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && onClose()}>
      {shown && <PickerBody key={shown.n} request={shown.request} families={families} onClose={onClose} />}
    </Dialog>
  );
}

function PickerBody({ request, families, onClose }: { request: PickRequest; families: readonly Family[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<Family[]>([]);
  const listId = useId();
  const opensPage = useRef(false);
  const excluded = useMemo(() => new Set(request.exclude ?? []), [request.exclude]);
  const shown = useMemo(() => searchFamilies(families, query, SHOWN).filter((f) => !excluded.has(f.id)), [families, query, excluded]);
  const at = Math.min(active, Math.max(0, shown.length - 1));
  const optionId = (i: number) => `${listId}-${i}`;

  useEffect(() => {
    document.getElementById(optionId(at))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);

  const finish = (chosen: Family[]) => {
    if (!chosen.length) return;
    opensPage.current = request.onPick(chosen) === true;
    onClose();
  };
  const choose = (family: Family | undefined) => {
    if (!family) return;
    if (!request.multiple) return finish([family]);
    setPicked((list) => (list.some((f) => f.id === family.id) ? list.filter((f) => f.id !== family.id) : [...list, family]));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = Math.max(1, shown.length);
      setActive((a) => (Math.min(a, n - 1) + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Picking several: Cmd+Return (or Return with nothing highlighted) confirms.
      if (request.multiple && (e.metaKey || e.ctrlKey)) finish(picked);
      else choose(shown[at]);
    }
  };

  return (
    <DialogContent
      className="flex flex-col sm:max-w-md"
      // A pick that opened a page leaves focus on that page's heading; otherwise focus goes back
      // to what had it (the picker opens from code, so Base UI can't tell what that was).
      finalFocus={() => (opensPage.current ? false : (request.returnFocus?.() ?? true))}
    >
      <DialogHeader>
        <DialogTitle>{request.title}</DialogTitle>
        <DialogDescription>
          {request.description ?? (request.multiple ? "Pick one or more fonts from your library." : "Pick a font from your library.")}
        </DialogDescription>
      </DialogHeader>
      <Input
        autoFocus
        type="search"
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={shown.length ? optionId(at) : undefined}
        aria-label="Search your fonts"
        placeholder="Search your fonts…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      <div id={listId} role="listbox" aria-label="Fonts" aria-multiselectable={request.multiple || undefined} className="-mx-1 max-h-80 min-h-0 overflow-y-auto">
        {shown.map((family, i) => (
          <PickerOption
            key={family.id}
            id={optionId(i)}
            family={family}
            highlighted={i === at}
            multiple={request.multiple}
            selected={picked.some((f) => f.id === family.id)}
            onHover={() => setActive(i)}
            onChoose={() => choose(family)}
          />
        ))}
        {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No fonts in your library match “{query.trim()}”.</p>}
      </div>
      {!query.trim() && families.length > SHOWN && (
        <p className="text-[11px] text-muted-foreground">Showing the first {SHOWN} of {families.length.toLocaleString()} families. Type to find others.</p>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        {request.multiple && (
          <Button disabled={!picked.length} onClick={() => finish(picked)}>
            {request.confirm ?? "Done"}
            {picked.length > 0 && ` (${picked.length})`}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}

function PickerOption({
  id,
  family,
  highlighted,
  multiple,
  selected,
  onHover,
  onChoose,
}: {
  id: string;
  family: Family;
  highlighted: boolean;
  multiple: boolean;
  selected: boolean;
  onHover: () => void;
  onChoose: () => void;
}) {
  const font = family.representative.primary;
  const preview = usePreviewProfile(font);
  const styles = `${family.faces.length} ${family.faces.length === 1 ? "style" : "styles"}`;
  return (
    <div
      id={id}
      role="option"
      aria-selected={multiple ? selected : highlighted}
      aria-label={`${family.name}, ${styles}`}
      className={cn("flex cursor-default items-center gap-2 rounded-md px-2 py-1", highlighted && "bg-accent")}
      onMouseEnter={onHover}
      onClick={onChoose}
    >
      {multiple && (
        <Icon name={selected ? "check_box" : "check_box_outline_blank"} size={18} filled={selected} className={selected ? "text-foreground" : "text-muted-foreground"} />
      )}
      <div className="min-w-0 flex-1" aria-hidden>
        <div className="truncate text-xs text-muted-foreground">
          {family.name} · {styles}
        </div>
        <FacePreview font={font} preview={preview} typed="" own="family" size={18} family={family.name} />
      </div>
    </div>
  );
}
