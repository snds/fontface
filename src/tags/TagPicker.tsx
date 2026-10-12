import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { Face } from "@/library";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { colorVar } from "./api";
import { fold, tagCoverage, useTagIndex } from "./model";
import { createTag, setFaceTags } from "./store";

const tidy = (s: string) =>
  s
    .split("/")
    .map((p) => p.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("/");

/** Adds or removes tags on fonts, and shows a toast if saving fails. */
export async function applyTags(tagIds: number[], faces: Face[], on: boolean) {
  try {
    await setFaceTags(tagIds, faces, on);
  } catch (e) {
    toast.error(on ? "Couldn't add the tag" : "Couldn't remove the tag", { description: String(e) });
  }
}

/**
 * Pick tags for some fonts: type to filter, Enter or click to add or remove, or create a new
 * tag from what you typed. A tick means every chosen font has the tag; a dash means some do.
 */
export function TagPicker({ faces, autoFocus = true }: { faces: Face[]; autoFocus?: boolean }) {
  const index = useTagIndex();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const coverage = useMemo(() => tagCoverage(faces, index), [faces, index]);

  const q = tidy(query);
  const shown = q ? index.ordered.filter((n) => n.tag.name.toLowerCase().includes(q.toLowerCase())) : index.ordered;
  const canCreate = !!q && !index.tags.some((t) => fold(t.name) === fold(q));
  const count = shown.length + (canCreate ? 1 : 0);
  const at = Math.min(active, Math.max(0, count - 1));

  const toggle = (tagId: number) => applyTags([tagId], faces, (coverage.get(tagId) ?? 0) < faces.length);
  const creating = useRef(false);
  const create = async () => {
    if (creating.current) return; // Enter pressed twice before the first one finished
    creating.current = true;
    try {
      const tag = await createTag(q);
      await setFaceTags([tag.id], faces, true);
      setQuery("");
    } catch (e) {
      toast.error("Couldn't create the tag", { description: String(e) });
    } finally {
      creating.current = false;
    }
  };
  const choose = (i: number) => {
    if (canCreate && i === 0) create();
    else {
      const node = shown[i - (canCreate ? 1 : 0)];
      if (node) toggle(node.tag.id);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (Math.min(a, count - 1) + (e.key === "ArrowDown" ? 1 : -1) + count) % Math.max(1, count));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (count) choose(at);
    }
  };

  const optionId = (i: number) => `${listId}-${i}`;
  // Keep the highlighted tag in sight as the arrow keys move it.
  useEffect(() => {
    document.getElementById(optionId(at))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);
  const what = faces.length === 1 ? "this style" : `${faces.length.toLocaleString()} styles`;

  return (
    <div className="flex flex-col gap-2">
      <Input
        autoFocus={autoFocus}
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={count ? optionId(at) : undefined}
        aria-label={`Tags for ${what}`}
        placeholder="Find or create a tag…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      <div id={listId} role="listbox" aria-multiselectable aria-label="Tags" className="-mx-1 max-h-72 overflow-y-auto">
        {canCreate && (
          <div
            id={optionId(0)}
            role="option"
            aria-selected={false}
            className={cn("flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-sm", at === 0 && "bg-accent")}
            onMouseEnter={() => setActive(0)}
            onClick={create}
          >
            <Icon name="add" size={16} className="text-muted-foreground" />
            <span className="truncate">
              Create “<span className="font-medium">{q}</span>”
            </span>
          </div>
        )}
        {shown.map((node, i) => {
          const pos = i + (canCreate ? 1 : 0);
          const n = coverage.get(node.tag.id) ?? 0;
          const state = n === 0 ? false : n === faces.length ? true : "mixed";
          // In a multi-select list "selected" means the fonts have the tag; the highlight is
          // conveyed by aria-activedescendant on the input.
          return (
            <div
              key={node.tag.id}
              id={optionId(pos)}
              role="option"
              aria-selected={state === true}
              title={node.tag.name}
              className={cn("flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-sm", pos === at && "bg-accent")}
              style={{ paddingLeft: q ? undefined : 8 + node.depth * 14 }}
              onMouseEnter={() => setActive(pos)}
              onClick={() => toggle(node.tag.id)}
            >
              <Icon name="label" size={16} filled style={{ color: colorVar(node.tag.color) }} />
              <span className="flex-1 truncate">
                {q ? node.tag.name : node.label}
                {state === "mixed" && <span className="sr-only">, on {n} of {faces.length} styles</span>}
              </span>
              {state === "mixed" && (
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums" title={`${n} of ${faces.length} styles`}>
                  {n}/{faces.length}
                </span>
              )}
              <Icon
                name={state === true ? "check_box" : state === "mixed" ? "indeterminate_check_box" : "check_box_outline_blank"}
                size={18}
                filled={state !== false}
                className={state === false ? "text-muted-foreground" : "text-foreground"}
              />
            </div>
          );
        })}
        {count === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No tags yet. Type a name to create one.</p>}
      </div>
      <p className="px-0.5 text-[11px] text-muted-foreground">
        Nest tags with “/”, as in Sci-Fi/Star Trek. Changes apply to {what}.
      </p>
    </div>
  );
}
