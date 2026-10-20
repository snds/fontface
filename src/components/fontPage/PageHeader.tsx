import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ActivationMode } from "@/api";
import { newTagsAsk, pageTarget, type FontActionId } from "@/fontActions";
import { activationIds, type Face, type Family } from "@/library";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tip } from "@/components/Tip";
import { summarize } from "@/fontState";
import { StateControl } from "@/components/ActivationSwitch";
import { FontActionItems } from "@/components/FontActions";
import { dragRegion, useTitleBar } from "@/components/TitleBar";
import { TagPicker } from "@/tags/TagPicker";

/** Back: Cmd+[ on macOS, Alt+Left on Windows (App runs it). */
export const BACK_SHORTCUT = { mac: "Mod+[", other: "Alt+Left" };

/** A style's name in its family (grouping by name may have worked it out), with "(Variable)". */
export const styleLabel = (face: Face) => `${face.style}${face.primary.variable ? " (Variable)" : ""}`;

/** The Back button at the left of a page's top row: an icon, so its tooltip is its name. */
export function BackButton({ placeName, onBack }: { placeName: string; onBack: () => void }) {
  return (
    // The shortcut goes on aria-keyshortcuts.
    <Tip tip={`Back to ${placeName}`} shortcut={BACK_SHORTCUT}>
      <Button variant="ghost" size="icon-sm" aria-label={`Back to ${placeName}`} onClick={onBack}>
        <Icon name="arrow_back" size={20} />
      </Button>
    </Tip>
  );
}

/**
 * Whether a page's top row (`ref`) is narrower than `px`: the width at which its container query
 * (`@max-[px]/pagehead`) hides a button's words and leaves its icon. Such a button has a tooltip
 * with its name only while its words are hidden.
 */
export function useNarrowerThan(ref: React.RefObject<HTMLElement | null>, px: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The content box, as container queries measure it.
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < px));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, px]);
  return narrow;
}

interface Props {
  family: Family;
  /** The chosen style. */
  face: Face;
  placeName: string;
  headingRef: React.Ref<HTMLHeadingElement>;
  busy: Set<string>;
  onBack: () => void;
  onChoose: (faceKey: string) => void;
  onActivate: (ids: number[], active: boolean, scope?: ActivationMode | null) => void;
  /** Bumped by Cmd+T (or the Font menu's Tags…) to open the Tags popover; undefined while the
   *  ask is for another page (see `newTagsAsk`). */
  tagsAsk?: number;
}

/** What the More menu offers: the font actions the header doesn't show already. */
const MORE: readonly FontActionId[] = ["compare", "pair", "familyGroup", "reveal", "copyPostScript", "remove"];

/** The font page's More button: focus comes back to it from Family groups, Compare and Pair. */
export const FONT_PAGE_MORE_ID = "font-page-more";

/**
 * The font page's top row, 52px like the toolbar it replaces; on macOS it's part of the title
 * bar (drag it to move the window, double-click it to zoom). Back, the family name (the page's
 * heading) and style count, the style picker, the family switch or lock, Tags (Cmd+T), and More
 * (Compare With…, Pair With…, Family Group…, Show in Finder, Copy PostScript Name, Remove from
 * Library…). As it narrows, the count and the Tags label go first.
 */
export function FontPageHeader({ family, face, placeName, headingRef, busy, onBack, onChoose, onActivate, tagsAsk }: Props) {
  const titleBar = useTitleBar();
  const headerRef = useRef<HTMLElement>(null);
  // Below 640px the Tags button is an icon only.
  const narrow = useNarrowerThan(headerRef, 640);
  const styles = `${family.faces.length} ${family.faces.length === 1 ? "style" : "styles"}`;
  // Cmd+T opens Tags here: only an ask for this page that's newer than the last one seen (an
  // ask for a font page opened over this one leaves it alone; the first render isn't one).
  const [tagsOpen, setTagsOpen] = useState(false);
  // Each button's tooltip stays away while its own popup is open.
  const [moreOpen, setMoreOpen] = useState(false);
  const seenAsk = useRef(tagsAsk ?? 0);
  useEffect(() => {
    if (!newTagsAsk(seenAsk.current, tagsAsk)) return;
    seenAsk.current = tagsAsk!;
    setTagsOpen(true);
  }, [tagsAsk]);
  return (
    <header ref={headerRef} className="@container/pagehead flex h-13 shrink-0 items-center gap-2 overflow-hidden border-b px-3 select-none" {...dragRegion(titleBar)}>
      <BackButton placeName={placeName} onBack={onBack} />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        {/* Focused when the page opens, so screen readers start here. */}
        <h1 ref={headingRef} tabIndex={-1} className="truncate text-base font-semibold outline-none">
          {family.name}
        </h1>
        <span className="shrink-0 text-xs text-muted-foreground @max-[560px]/pagehead:sr-only">{styles}</span>
      </div>
      {family.faces.length > 1 ? (
        <Select
          value={face.key}
          onValueChange={(key) => typeof key === "string" && onChoose(key)}
          items={family.faces.map((f) => ({ value: f.key, label: styleLabel(f) }))}
        >
          {/* It shows the style, not its own name, so its tooltip names it. */}
          <Tip tip="Style">
            <SelectTrigger size="sm" aria-label="Style" className="max-w-56 min-w-24">
              <SelectValue />
            </SelectTrigger>
          </Tip>
          <SelectContent className="max-h-80">
            {family.faces.map((f) => (
              <SelectItem key={f.key} value={f.key}>
                <span className="truncate">{styleLabel(f)}</span>
                <span className="ml-auto pl-3 font-mono text-xs text-muted-foreground">{f.primary.weight}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className="max-w-56 truncate text-sm text-muted-foreground">{styleLabel(face)}</span>
      )}
      <StateControl
        state={summarize(family.faces)}
        single={family.faces.length === 1}
        label={`Activate ${family.name}`}
        busy={family.switchable.some((f) => f.copies.some((c) => busy.has(c.path)))}
        srId="font-page-state"
        onSwitch={(on, scope) => onActivate(activationIds(family.switchable, on), on, scope)}
      />
      <Popover open={tagsOpen} onOpenChange={setTagsOpen}>
        {/* A tooltip only while its word is hidden; it puts Cmd+T on aria-keyshortcuts either way. */}
        <Tip tip="Tags" shortcut="Mod+T" hide={tagsOpen || !narrow}>
          <PopoverTrigger render={<Button variant="ghost" size="sm" aria-label={`Tags for ${family.name}`} />}>
            <Icon name="sell" size={16} />
            <span className="@max-[640px]/pagehead:hidden">Tags</span>
          </PopoverTrigger>
        </Tip>
        <PopoverContent align="end" className="w-80">
          <TagPicker faces={family.faces} />
        </PopoverContent>
      </Popover>
      <DropdownMenu onOpenChange={setMoreOpen}>
        <Tip tip="More" hide={moreOpen}>
          {/* The id is on the trigger, so the tooltip, the menu and the button share it. */}
          <DropdownMenuTrigger id={FONT_PAGE_MORE_ID} render={<Button variant="ghost" size="icon-sm" aria-label="More" />}>
            <Icon name="more_horiz" size={18} />
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="end" className="min-w-56">
          <FontActionItems kind="dropdown" target={pageTarget(family, face)} only={MORE} returnTo={FONT_PAGE_MORE_ID} />
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
