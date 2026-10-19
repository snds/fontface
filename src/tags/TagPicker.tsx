import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { Face } from "@/library";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { createTipHandle, Tip, TipHost } from "@/components/Tip";
import { cn } from "@/lib/utils";
import { BUILTIN_FONTS_TIP } from "@/tagActions";
import { colorVar } from "./api";
import { fold, GROUP_LABELS, tagCoverage, useTagIndex, type TagNode } from "./model";
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
 *
 * Each row's tooltip says what Enter or a click does to it. The rows share one tooltip (there
 * can be hundreds). Focus stays in the box, so moving the highlight with the arrow keys shows
 * the highlighted row's tooltip, as moving focus would.
 */
export function TagPicker({ faces, autoFocus = true }: { faces: Face[]; autoFocus?: boolean }) {
  const index = useTagIndex();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const [tips] = useState(createTipHandle);
  const coverage = useMemo(() => tagCoverage(faces, index), [faces, index]);

  const q = tidy(query);
  // My tags first, then Built-in, as the sidebar lists them. The group is named only when both
  // have tags to show.
  const groups = index.byGroup
    .map((g) => ({ group: g.group, nodes: q ? g.nodes.filter((n) => n.tag.name.toLowerCase().includes(q.toLowerCase())) : g.nodes }))
    .filter((g) => g.nodes.length);
  const shown = groups.flatMap((g) => g.nodes);
  const labelled = groups.length > 1;
  // Nothing new goes inside a built-in tag (they're read-only, src/tagActions.ts).
  const lockedParent = q.includes("/") ? index.tags.find((t) => t.builtin && fold(t.name) === fold(q.split("/")[0])) : undefined;
  const canCreate = !!q && !lockedParent && !index.tags.some((t) => fold(t.name) === fold(q));
  const count = shown.length + (canCreate ? 1 : 0);
  const at = Math.min(active, Math.max(0, count - 1));

  const toggle = (tagId: number) => {
    if (index.byId.get(tagId)?.builtin) return; // read-only: the row says so
    applyTags([tagId], faces, (coverage.get(tagId) ?? 0) < faces.length);
  };
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
  // Matching tags come first, so Enter picks the best match; "Create" is last.
  const createAt = shown.length;
  const choose = (i: number) => {
    if (canCreate && i === createAt) create();
    else {
      const node = shown[i];
      if (node) toggle(node.tag.id);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!count) return;
      const next = (at + (e.key === "ArrowDown" ? 1 : -1) + count) % count;
      setActive(next);
      // Every row is mounted, so its tooltip can open now.
      tips.open(optionId(next));
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
  const these = faces.length === 1 ? "this style" : `the ${faces.length.toLocaleString()} styles`;

  /** One tag in the list. `pos` is its place among all the options, for the keyboard highlight. */
  const option = (node: TagNode, pos: number) => {
    const n = coverage.get(node.tag.id) ?? 0;
    const state = n === 0 ? false : n === faces.length ? true : "mixed";
    const locked = node.tag.builtin;
    const name = node.tag.name;
    // What Enter or a click does (`toggle`): a tag only some have goes on the rest.
    const tip =
      state === true
        ? `Takes “${name}” off ${these}`
        : state === "mixed"
          ? `“${name}” is on ${n} of ${faces.length} styles. Adds it to the other ${faces.length - n}.`
          : `Adds “${name}” to ${these}`;
    // In a multi-select list "selected" means the fonts have the tag; the highlight is
    // conveyed by aria-activedescendant on the input.
    return (
      <Tip key={node.tag.id} handle={tips} tip={tip} shortcut="Enter" disabledReason={locked && BUILTIN_FONTS_TIP} side="right" contentClassName="max-w-64">
        <div
          id={optionId(pos)}
          role="option"
          aria-selected={state === true}
          aria-disabled={locked || undefined}
          className={cn("flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-sm", pos === at && "bg-accent", locked && "text-muted-foreground")}
          style={{ paddingLeft: q ? undefined : 8 + node.depth * 14 }}
          onMouseEnter={() => setActive(pos)}
          onClick={() => toggle(node.tag.id)}
        >
          <Icon name="label" size={16} filled={!locked} style={{ color: colorVar(node.tag.color) }} />
          <span className="flex-1 truncate">
            {q ? node.tag.name : node.label}
            {state === "mixed" && <span className="sr-only">, on {n} of {faces.length} styles</span>}
            {locked && <span className="sr-only">, built-in, read-only</span>}
          </span>
          {locked && <Icon name="lock" size={14} aria-hidden />}
          {/* The tooltip says what this is ("on 2 of 5 styles"). */}
          {state === "mixed" && (
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
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
      </Tip>
    );
  };

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
          // Typing isn't moving the highlight: no tooltip over the list as it changes.
          tips.close();
        }}
        onKeyDown={onKeyDown}
        onBlur={() => tips.close()}
      />
      <div id={listId} role="listbox" aria-multiselectable aria-label="Tags" className="-mx-1 max-h-72 overflow-y-auto">
        {groups.map((g) => {
          const first = shown.indexOf(g.nodes[0]);
          const rows = g.nodes.map((node, i) => option(node, first + i));
          if (!labelled) return rows;
          const labelId = `${listId}-${g.group}`;
          return (
            <div key={g.group} role="group" aria-labelledby={labelId}>
              <div id={labelId} className="flex items-center gap-1 px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
                {GROUP_LABELS[g.group]}
                {g.group === "builtin" && (
                  <>
                    <Icon name="lock" size={12} aria-hidden />
                    <span className="font-normal">read-only</span>
                  </>
                )}
              </div>
              {rows}
            </div>
          );
        })}
        {canCreate && (
          <Tip handle={tips} tip={`Makes the tag “${q}” and adds it to ${these}`} shortcut="Enter" side="right" contentClassName="max-w-64">
            <div
              id={optionId(createAt)}
              role="option"
              aria-selected={false}
              className={cn("flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-sm", at === createAt && "bg-accent")}
              onMouseEnter={() => setActive(createAt)}
              onClick={create}
            >
              <Icon name="add" size={16} className="text-muted-foreground" />
              <span className="truncate">
                Create “<span className="font-medium">{q}</span>”
              </span>
            </div>
          </Tip>
        )}
        {count === 0 && !lockedParent && <p className="px-2 py-1.5 text-xs text-muted-foreground">No tags yet. Type a name to create one.</p>}
        {lockedParent && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">“{lockedParent.name}” is a built-in tag, so new tags can't go inside it.</p>
        )}
      </div>
      <TipHost handle={tips} />
      <p className="px-0.5 text-[11px] text-muted-foreground">
        Nest tags with “/”, as in Sci-Fi/Star Trek. Changes apply to {what}.
      </p>
    </div>
  );
}
