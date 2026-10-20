import { useEffect, useId, useRef, useState } from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Toolbar } from "@base-ui/react/toolbar";
import type { PreviewAlign, PreviewOptions } from "@/api";
import {
  DEFAULT_PREVIEW,
  isDefaultPreview,
  PREVIEW_ALIGNS,
  PREVIEW_CASES,
  PREVIEW_FEATURES,
  resolveColors,
  THEME_COLORS,
} from "@/previewStyle";
import {
  buttonStep,
  commitSize,
  discardSize,
  draftSize,
  keyStep,
  MAX_SIZE,
  MIN_SIZE,
  openDraft,
  sizeLabel,
  sizeOptions,
  typeSize,
  type SizeDraft,
} from "@/previewSize";
import { shortcutSaid, tipSaid } from "@/tips";
import { sizeShortcut } from "@/viewOptions";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ALIGN_TIPS, CASE_TIPS, ColorChoice, colorName, ContrastNote, INKS, PAPERS } from "./PreviewOptions";
import { Tip, TipShortcut } from "./Tip";
import { IS_MAC } from "./TitleBar";

/*
 * The preview bar: a pill that floats over the bottom of every list view (the library's
 * layouts, the sources and tags, the Google Fonts and Adobe Fonts views) with everything that
 * changes how previews look: your own text (a flyout), the size (a select of common sizes, or
 * "Custom…" for any size), alignment, case, outline, underline, OpenType features, ink and paper
 * colors (with the contrast), and Reset.
 *
 * It's a toolbar (role="toolbar"): one Tab stop, Left and Right move along it, Home and End go
 * to its ends. Every control is a button or toggle button with a tooltip; groups that don't fit
 * as one toggle open a small panel above the bar. The panels sit outside the toolbar (Base UI's
 * detached popover triggers), so their own keys and buttons stay theirs. The list keeps room
 * under its last row for the bar (PREVIEW_BAR_SPACE), so the bar never hides it.
 *
 * Every choice but the text and the size is saved as a setting at once (Settings › Reset covers
 * it); the text and the size last the session, starting from Settings' defaults.
 */

/** Room a list keeps under its last row and when it scrolls a row into view, so the bar (about
 *  40px tall, 12px up from the bottom) never covers it. */
export const PREVIEW_BAR_SPACE = 64;

/** Cmd+= and Cmd+- (Ctrl on Windows) step through the common sizes (App, and View › Bigger and
 *  Smaller Preview). */
const BIGGER = "Mod+=";
const SMALLER = "Mod+-";
const SIZE_TIP = "Sets the preview size";

/** One of the bar's buttons: round, the same size in every state, so nothing moves. Pressed
 *  toggles (data-pressed) and buttons whose panel holds a choice that isn't the default (`ON`)
 *  are shaded. */
const ITEM =
  "relative flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors select-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:opacity-40 aria-disabled:hover:bg-transparent data-pressed:bg-foreground/10 data-pressed:text-foreground data-popup-open:bg-foreground/5 data-popup-open:text-foreground";
const ON = "bg-foreground/10 text-foreground";
/** A choice in a panel: a toggle button with room for its check, so pressing it moves nothing. */
const CHOICE =
  "flex h-7 items-center gap-1 rounded-md border px-2 text-xs whitespace-nowrap text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-pressed:border-transparent data-pressed:bg-foreground/10 data-pressed:text-foreground";

interface Props {
  /** Your own text for every preview ("" shows each font's name). */
  previewText: string;
  onPreviewText: (text: string) => void;
  size: number;
  onSize: (size: number) => void;
  preview: PreviewOptions;
  onPreview: (patch: Partial<PreviewOptions>) => void;
  /** The theme now: the theme's colors and the contrast depend on it. */
  dark: boolean;
}

/** A panel above one of the bar's buttons: its handle, and whether it's open (the button's
 *  tooltip waits while it is, so it doesn't cover the panel). */
function usePanel() {
  const [handle] = useState(() => PopoverPrimitive.createHandle<undefined>());
  const [open, setOpen] = useState(false);
  return { handle, open, setOpen };
}
type Panel = ReturnType<typeof usePanel>;

/** "Hello there…": typed text, short enough for a tooltip. */
const shortText = (text: string) => (text.length > 40 ? `${text.slice(0, 39).trimEnd()}…` : text);

export function PreviewBar({ previewText, onPreviewText, size, onSize, preview, onPreview, dark }: Props) {
  const textPanel = usePanel();
  const casePanel = usePanel();
  const featuresPanel = usePanel();
  const inkPanel = usePanel();
  const paperPanel = usePanel();

  const colors = resolveColors(preview, dark);
  const theme = dark ? THEME_COLORS.dark : THEME_COLORS.light;
  const inkShown = colors.ink ?? theme.ink;
  const paperShown = colors.paper ?? theme.paper;
  const typed = previewText !== "";
  const plain = isDefaultPreview(preview);
  const currentCase = PREVIEW_CASES.find((c) => c.id === preview.case) ?? PREVIEW_CASES[0];
  const features = PREVIEW_FEATURES.filter((f) => preview.features.includes(f.id));
  const lowContrast = colors.low ? ". Hard to read with these colors" : "";

  return (
    <>
      <Toolbar.Root
        aria-label="Preview"
        // About 450px wide; a list area narrower than that scrolls the bar sideways rather than
        // painting it past the edges.
        className="absolute bottom-3 left-1/2 z-10 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-full border bg-popover p-1 text-popover-foreground shadow-lg [scrollbar-width:none]"
        // Keys from a select's list (portaled, but React still passes its events up) aren't the bar's.
        onKeyDown={(e) => {
          if (!e.currentTarget.contains(e.target as Node)) e.preventBaseUIHandler();
        }}
      >
        <Tip tip={typed ? `Previews show “${shortText(previewText)}”` : "Shows your own words in every preview"} hide={textPanel.open} contentClassName="max-w-72">
          <Toolbar.Button
            render={<PopoverTrigger handle={textPanel.handle} />}
            aria-label="Preview text"
            className={cn(ITEM, typed && ON)}
          >
            <Icon name="text_fields" size={18} />
          </Toolbar.Button>
        </Tip>
        <SizeField size={size} onSize={onSize} />

        <Toolbar.Separator className="mx-1 h-4 w-px shrink-0 bg-border" />

        {/* One alignment at a time: pressing the one already on leaves it on. */}
        <ToggleGroup
          aria-label="Alignment"
          value={[preview.align]}
          onValueChange={(value) => value[0] && onPreview({ align: value[0] as PreviewAlign })}
          className="flex shrink-0 gap-0.5"
        >
          {PREVIEW_ALIGNS.map((a) => (
            <Tip key={a.id} tip={ALIGN_TIPS[a.id]}>
              <Toolbar.Button render={<Toggle value={a.id} />} aria-label={`Align ${a.label.toLowerCase()}`} className={ITEM}>
                <Icon name={a.icon} size={18} />
              </Toolbar.Button>
            </Tip>
          ))}
        </ToggleGroup>
        <Tip tip="Changes the case of previews" hide={casePanel.open}>
          <Toolbar.Button
            render={<PopoverTrigger handle={casePanel.handle} />}
            aria-label={`Case: ${currentCase.label}`}
            className={cn(ITEM, "text-[13px] font-medium", preview.case !== "asTyped" && ON)}
          >
            <span aria-hidden>{preview.case === "asTyped" ? "Aa" : currentCase.short}</span>
          </Toolbar.Button>
        </Tip>
        <Tip tip="Draws previews as outlines, with no fill">
          <Toolbar.Button
            render={<Toggle pressed={preview.outline} onPressedChange={(on) => onPreview({ outline: on })} />}
            aria-label="Outline"
            className={ITEM}
          >
            {/* An outlined letter: what Outline does. */}
            <span aria-hidden className="text-[15px] leading-none font-semibold" style={{ WebkitTextStroke: "1px currentColor", WebkitTextFillColor: "transparent" }}>
              A
            </span>
          </Toolbar.Button>
        </Tip>
        <Tip tip="Underlines previews, with the font's own underline">
          <Toolbar.Button
            render={<Toggle pressed={preview.underline} onPressedChange={(on) => onPreview({ underline: on })} />}
            aria-label="Underline"
            className={ITEM}
          >
            <Icon name="format_underlined" size={18} />
          </Toolbar.Button>
        </Tip>
        <Tip
          tip={features.length ? `OpenType features: ${features.map((f) => f.label.toLowerCase()).join(", ")}` : "Turns on OpenType features for every preview"}
          hide={featuresPanel.open}
          contentClassName="max-w-64"
        >
          <Toolbar.Button
            render={<PopoverTrigger handle={featuresPanel.handle} />}
            aria-label="Features"
            className={cn(ITEM, "text-[13px] font-medium italic", features.length > 0 && ON)}
          >
            {/* "fi": the letters a ligature joins, for the features. */}
            <span aria-hidden>fi</span>
          </Toolbar.Button>
        </Tip>

        <Toolbar.Separator className="mx-1 h-4 w-px shrink-0 bg-border" />

        <Tip tip={`Changes the color of the letters${colors.low ? ". These colors are hard to read together" : ""}`} hide={inkPanel.open}>
          <Toolbar.Button
            render={<PopoverTrigger handle={inkPanel.handle} />}
            aria-label={`Ink: ${colorName(preview.ink, INKS)}${lowContrast}`}
            className={ITEM}
          >
            <span aria-hidden className="size-4 rounded-full border border-foreground/25" style={{ background: inkShown }} />
            {colors.low && <WarningDot />}
          </Toolbar.Button>
        </Tip>
        <Tip tip={`Changes the color behind previews${colors.low ? ". These colors are hard to read together" : ""}`} hide={paperPanel.open}>
          <Toolbar.Button
            render={<PopoverTrigger handle={paperPanel.handle} />}
            aria-label={`Paper: ${colorName(preview.paper, PAPERS)}${lowContrast}`}
            className={ITEM}
          >
            {/* The paper, with a letter in the ink on it. */}
            <span
              aria-hidden
              className="flex size-4.5 items-center justify-center rounded-[4px] border border-foreground/25 text-[10px] leading-none font-semibold"
              style={{ background: paperShown, color: inkShown }}
            >
              A
            </span>
            {colors.low && <WarningDot />}
          </Toolbar.Button>
        </Tip>

        <Toolbar.Separator className="mx-1 h-4 w-px shrink-0 bg-border" />

        {/* Stays focusable once there's nothing to reset, so its tooltip still says why it's greyed out. */}
        <Tip tip="Puts alignment, case, lines, features and colors back to the defaults" disabledReason={plain && "Nothing to reset: previews already use the defaults"}>
          <Toolbar.Button disabled={plain} aria-label="Reset preview" className={ITEM} onClick={() => !plain && onPreview({ ...DEFAULT_PREVIEW })}>
            <Icon name="format_clear" size={18} />
          </Toolbar.Button>
        </Tip>
      </Toolbar.Root>

      <TextPanel panel={textPanel} text={previewText} onText={onPreviewText} />

      <Popover handle={casePanel.handle} onOpenChange={casePanel.setOpen}>
        <PopoverContent side="top" sideOffset={8} className="w-auto gap-2 p-2.5">
          <PopoverTitle className="text-xs font-medium text-muted-foreground">Case</PopoverTitle>
          <div role="group" aria-label="Case" className="flex gap-1">
            {PREVIEW_CASES.map((c) => (
              <Tip key={c.id} tip={CASE_TIPS[c.id]}>
                <Toggle
                  pressed={preview.case === c.id}
                  // One case at a time: pressing the one already on leaves it on.
                  onPressedChange={(on) => on && onPreview({ case: c.id })}
                  aria-label={c.label}
                  className={cn(CHOICE, "min-w-9 justify-center")}
                >
                  {c.id === "asTyped" ? c.label : <span aria-hidden>{c.short}</span>}
                </Toggle>
              </Tip>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <Popover handle={featuresPanel.handle} onOpenChange={featuresPanel.setOpen}>
        <PopoverContent side="top" sideOffset={8} className="w-auto gap-2 p-2.5">
          <PopoverTitle className="text-xs font-medium text-muted-foreground">OpenType features</PopoverTitle>
          <div role="group" aria-label="OpenType features" className="grid grid-cols-2 gap-1">
            {PREVIEW_FEATURES.map((f) => (
              <Tip key={f.id} tip={f.description}>
                <Toggle
                  pressed={preview.features.includes(f.id)}
                  onPressedChange={(on) =>
                    onPreview({ features: PREVIEW_FEATURES.map((x) => x.id).filter((x) => (x === f.id ? on : preview.features.includes(x))) })
                  }
                  className={cn(CHOICE, "group/choice pr-2.5 pl-1.5")}
                >
                  <Icon name="check" size={14} className="invisible group-data-pressed/choice:visible" />
                  {f.label}
                </Toggle>
              </Tip>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <Popover handle={inkPanel.handle} onOpenChange={inkPanel.setOpen}>
        <PopoverContent side="top" sideOffset={8} className="w-auto gap-3 p-3">
          <PopoverTitle className="sr-only">Ink</PopoverTitle>
          <ColorChoice label="Ink" value={preview.ink} theme={theme.ink} presets={INKS} onChange={(ink) => onPreview({ ink })} />
          <div className="max-w-64">
            <ContrastNote colors={colors} inkChosen={!!preview.ink} />
          </div>
        </PopoverContent>
      </Popover>

      <Popover handle={paperPanel.handle} onOpenChange={paperPanel.setOpen}>
        <PopoverContent side="top" sideOffset={8} className="w-auto gap-3 p-3">
          <PopoverTitle className="sr-only">Paper</PopoverTitle>
          <ColorChoice label="Paper" value={preview.paper} theme={theme.paper} presets={PAPERS} onChange={(paper) => onPreview({ paper })} />
          <div className="max-w-64">
            <ContrastNote colors={colors} inkChosen={!!preview.ink} />
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

/** A small red dot on a color button: the ink and paper are hard to read together. */
function WarningDot() {
  return <span aria-hidden className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-destructive ring-1 ring-popover" />;
}

/**
 * Your own words, in a field that flies out above the bar. Previews follow as you type; Return
 * or Esc closes it (focus goes back to its button), and Clear goes back to font names.
 */
function TextPanel({ panel, text, onText }: { panel: Panel; text: string; onText: (text: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  return (
    <Popover handle={panel.handle} onOpenChange={panel.setOpen}>
      <PopoverContent side="top" sideOffset={8} initialFocus={inputRef} className="w-80 gap-2 p-2.5">
        <PopoverTitle className="sr-only">Preview text</PopoverTitle>
        <div className="relative">
          <Icon name="text_fields" size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={text}
            placeholder="Type to preview…"
            aria-label="Preview text"
            aria-describedby={hintId}
            onChange={(e) => onText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                panel.handle.close();
              }
            }}
            className="pr-8 pl-8"
          />
          {/* Always there, so the field never changes shape; greyed out with nothing to clear. */}
          <Tip tip="Clears your words, so previews show font names again" disabledReason={!text && "Nothing to clear: previews show font names"}>
            <button
              type="button"
              aria-label="Clear preview text"
              aria-disabled={!text || undefined}
              onClick={() => {
                if (!text) return;
                onText("");
                inputRef.current?.focus();
              }}
              className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:opacity-0"
            >
              <Icon name="close" size={14} />
            </button>
          </Tip>
        </div>
        <p id={hintId} className="text-xs text-muted-foreground">
          Every preview shows these words. Leave it empty to show each font&rsquo;s name.
        </p>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The size: a select of the common sizes (and the size in use, when it's another), with
 * "Custom…" at the end, which turns the same field into a number field with up and down
 * steppers (previewSize.ts has its keys). Cmd+= and Cmd+- step through the common sizes from
 * anywhere in the list view. The field is as wide in both forms, so nothing beside it moves.
 */
function SizeField({ size, onSize }: { size: number; onSize: (size: number) => void }) {
  const [draft, setDraft] = useState<SizeDraft | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** Set as the field closes from the keyboard: focus goes back to the select. */
  const refocus = useRef(false);
  /** Set once the field has closed, so a late blur doesn't close it twice. */
  const closed = useRef(true);
  const editing = draft !== null;

  useEffect(() => {
    if (editing) {
      closed.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (refocus.current) {
      refocus.current = false;
      triggerRef.current?.focus();
    }
  }, [editing]);

  // The size changed from elsewhere while the field is open (Cmd+= or Cmd+-): it shows the new one.
  useEffect(() => {
    setDraft((d) => (d && draftSize(d) !== size ? { ...d, text: String(size) } : d));
  }, [size]);

  const close = (to: number, focusSelect: boolean) => {
    if (closed.current) return;
    closed.current = true;
    refocus.current = focusSelect;
    onSize(to);
    setDraft(null);
  };
  const step = (d: SizeDraft, to: number) => {
    setDraft({ ...d, text: String(to) });
    onSize(to);
  };

  const sizeTip = (
    <>
      {SIZE_TIP}
      <TipShortcut shortcut={SMALLER} />
      <TipShortcut shortcut={BIGGER} />
    </>
  );
  const sizeSaid = tipSaid(SIZE_TIP, `${shortcutSaid(SMALLER, IS_MAC)}, ${shortcutSaid(BIGGER, IS_MAC)}`);

  if (draft) {
    const now = draftSize(draft);
    return (
      <div className="flex h-7 w-[4.75rem] shrink-0 items-center rounded-full pr-0.5 pl-2.5 ring-1 ring-ring/60 focus-within:ring-3 focus-within:ring-ring/50">
        <Tip tip="Type a size, or press Up and Down to change it. Return keeps it, Esc puts it back." contentClassName="max-w-64">
          <Toolbar.Input
            ref={inputRef}
            role="spinbutton"
            inputMode="numeric"
            aria-label="Preview size in pixels"
            aria-valuenow={now}
            aria-valuemin={MIN_SIZE}
            aria-valuemax={MAX_SIZE}
            aria-valuetext={sizeLabel(now)}
            value={draft.text}
            onChange={(e) => {
              const typed = typeSize(draft, e.target.value);
              setDraft(typed.draft);
              if (typed.apply !== undefined) onSize(typed.apply);
            }}
            onKeyDown={(e) => {
              // Cmd+= and Cmd+- go on to the list view's shortcut (the field then shows the new size).
              if (sizeShortcut(e, IS_MAC)) return;
              const to = keyStep(now, e);
              if (to !== null) {
                e.preventDefault();
                // Home and End are the field's here, not the bar's.
                e.stopPropagation();
                step(draft, to);
              } else if (e.key === "Enter") {
                e.preventDefault();
                close(commitSize(draft), true);
              } else if (e.key === "Escape") {
                e.preventDefault();
                close(discardSize(draft), true);
              }
            }}
            onBlur={() => close(commitSize(draft), false)}
            className="w-7 min-w-0 bg-transparent text-xs tabular-nums outline-none"
          />
        </Tip>
        <span aria-hidden className="text-xs text-muted-foreground">
          px
        </span>
        {/* Pointer only (the arrow keys do the same): pressing them keeps focus in the field. */}
        <span className="ml-auto flex flex-col">
          <Stepper label="Bigger preview" tip="Makes previews 1 px bigger" icon="keyboard_arrow_up" onStep={() => step(draft, buttonStep(now, 1))} />
          <Stepper label="Smaller preview" tip="Makes previews 1 px smaller" icon="keyboard_arrow_down" onStep={() => step(draft, buttonStep(now, -1))} />
        </span>
      </div>
    );
  }

  return (
    <Select
      value={String(size)}
      onValueChange={(value) => {
        if (value === "custom") setDraft(openDraft(size));
        else if (typeof value === "string" && Number.isFinite(Number(value))) onSize(Number(value));
      }}
    >
      <Tip tip={sizeTip} description={sizeSaid}>
        <Toolbar.Button
          ref={triggerRef}
          render={<SelectTrigger size="sm" />}
          aria-label="Preview size"
          className="h-7 w-[4.75rem] shrink-0 rounded-full border-transparent data-[size=sm]:rounded-full bg-transparent pr-1 pl-2.5 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground data-popup-open:bg-foreground/5 data-popup-open:text-foreground dark:bg-transparent dark:hover:bg-foreground/5"
        >
          <span className="min-w-0 flex-1 text-left tabular-nums">{sizeLabel(size)}</span>
        </Toolbar.Button>
      </Tip>
      <SelectContent side="top" align="center" sideOffset={8} className="min-w-28">
        {sizeOptions(size).map((n) => (
          <SelectItem key={n} value={String(n)} className="tabular-nums">
            {sizeLabel(n)}
          </SelectItem>
        ))}
        <SelectSeparator />
        <SelectItem value="custom">Custom…</SelectItem>
      </SelectContent>
    </Select>
  );
}

function Stepper({ label, tip, icon, onStep }: { label: string; tip: string; icon: string; onStep: () => void }) {
  return (
    <Tip tip={tip} describe={false}>
      <button
        type="button"
        tabIndex={-1}
        aria-label={label}
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onStep}
        className="flex h-3 w-4 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
      >
        <Icon name={icon} size={14} />
      </button>
    </Tip>
  );
}
