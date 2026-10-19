import { useEffect, useRef, useState } from "react";
import type { ActivationMode } from "@/api";
import { pageTarget, type FontActionId } from "@/fontActions";
import { activationIds, type Face, type Family } from "@/library";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { summarize } from "@/fontState";
import { StateControl } from "@/components/ActivationSwitch";
import { FontActionItems } from "@/components/FontActions";
import { dragRegion, IS_MAC, useTitleBar } from "@/components/TitleBar";
import { TagPicker } from "@/tags/TagPicker";

const BACK_KEYS = IS_MAC ? "⌘[" : "Alt+Left";
const BACK_ARIA_KEYS = IS_MAC ? "Meta+[" : "Alt+ArrowLeft";

/** A style's name in its family (grouping by name may have worked it out), with "(Variable)". */
export const styleLabel = (face: Face) => `${face.style}${face.primary.variable ? " (Variable)" : ""}`;

/** The Back button at the left of a page's top row. */
export function BackButton({ placeName, onBack }: { placeName: string; onBack: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={`Back to ${placeName}`} aria-keyshortcuts={BACK_ARIA_KEYS} onClick={onBack} />}
      >
        <Icon name="arrow_back" size={20} />
      </TooltipTrigger>
      <TooltipContent>
        Back to {placeName} ({BACK_KEYS})
      </TooltipContent>
    </Tooltip>
  );
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
  /** Bumped by Cmd+T (or the Font menu's Tags…) to open the Tags popover. */
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
export function FontPageHeader({ family, face, placeName, headingRef, busy, onBack, onChoose, onActivate, tagsAsk = 0 }: Props) {
  const titleBar = useTitleBar();
  const styles = `${family.faces.length} ${family.faces.length === 1 ? "style" : "styles"}`;
  // Cmd+T opens Tags here (a new ask each time; the first render isn't one).
  const [tagsOpen, setTagsOpen] = useState(false);
  const seenAsk = useRef(tagsAsk);
  useEffect(() => {
    if (seenAsk.current === tagsAsk) return;
    seenAsk.current = tagsAsk;
    setTagsOpen(true);
  }, [tagsAsk]);
  return (
    <header className="@container/pagehead flex h-13 shrink-0 items-center gap-2 overflow-hidden border-b px-3 select-none" {...dragRegion(titleBar)}>
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
          <SelectTrigger size="sm" aria-label="Style" className="max-w-56 min-w-24">
            <SelectValue />
          </SelectTrigger>
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
        <PopoverTrigger render={<Button variant="ghost" size="sm" aria-label={`Tags for ${family.name}`} aria-keyshortcuts={IS_MAC ? "Meta+T" : "Control+T"} />}>
          <Icon name="sell" size={16} />
          <span className="@max-[640px]/pagehead:hidden">Tags</span>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80">
          <TagPicker faces={family.faces} />
        </PopoverContent>
      </Popover>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button id={FONT_PAGE_MORE_ID} variant="ghost" size="icon-sm" aria-label="More" />}>
          <Icon name="more_horiz" size={18} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <FontActionItems kind="dropdown" target={pageTarget(family, face)} only={MORE} returnTo={FONT_PAGE_MORE_ID} />
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
