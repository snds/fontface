import { useEffect, useId, useRef, useState } from "react";
import type { PreviewOptions } from "@/api";
import {
  contrastText,
  isColor,
  isDefaultPreview,
  PREVIEW_ALIGNS,
  PREVIEW_CASES,
  PREVIEW_FEATURES,
  readableOn,
  resolveColors,
  THEME_COLORS,
} from "@/previewStyle";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { ChoiceGroup } from "./ChoiceGroup";
import { Tip } from "./Tip";

/** Ready-made inks and papers; the color well picks any other. */
const INKS = [
  { value: "#000000", label: "Black" },
  { value: "#3d3d3d", label: "Dark gray" },
  { value: "#ffffff", label: "White" },
  { value: "#b3261e", label: "Red" },
  { value: "#1d4ed8", label: "Blue" },
] as const;
const PAPERS = [
  { value: "#ffffff", label: "White" },
  { value: "#f4efe1", label: "Cream" },
  { value: "#e4e4e7", label: "Light gray" },
  { value: "#1d2a5a", label: "Navy" },
  { value: "#000000", label: "Black" },
] as const;

/** What picking each alignment and case does, for their tooltips. */
const ALIGN_TIPS: Record<PreviewOptions["align"], string> = {
  left: "Lines previews up on the left",
  center: "Centers previews",
  right: "Lines previews up on the right",
};
const CASE_TIPS: Record<PreviewOptions["case"], string> = {
  asTyped: "Shows previews as typed",
  upper: "Shows previews in capitals",
  lower: "Shows previews in small letters",
  title: "Starts each word in previews with a capital",
};

interface Props {
  preview: PreviewOptions;
  onPreview: (patch: Partial<PreviewOptions>) => void;
  /** The theme now: the theme's colors and the contrast depend on it. */
  dark: boolean;
}

/**
 * The View options' Preview section: alignment, case, outline and underline, a few features for
 * every preview, and ink and paper colors (the theme's unless chosen, with the contrast shown).
 * Every choice is saved as a setting at once and shows in every layout and on the font page.
 */
export function PreviewOptionsSection({ preview, onPreview, dark }: Props) {
  const id = useId();
  const colors = resolveColors(preview, dark);
  const theme = dark ? THEME_COLORS.dark : THEME_COLORS.light;
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-sm font-medium">
          Preview
        </h2>
        {/* Stays focusable once there's nothing to reset, so focus stays in the popover (and its
            tooltip still says why it's greyed out). */}
        <Tip
          tip="Puts alignment, case, lines, features and colors back to the defaults"
          disabledReason={isDefaultPreview(preview) && "Nothing to reset: the preview already uses the defaults"}
        >
          <Button
            variant="ghost"
            size="xs"
            disabled={isDefaultPreview(preview)}
            focusableWhenDisabled
            className="aria-disabled:opacity-50"
            onClick={() => onPreview({ align: "left", case: "asTyped", outline: false, underline: false, ink: null, paper: null, features: [] })}
          >
            Reset preview
          </Button>
        </Tip>
      </div>

      <Row label="Alignment" id={`${id}-align`}>
        <ChoiceGroup
          labelledBy={`${id}-align`}
          value={preview.align}
          onChange={(align) => onPreview({ align })}
          options={PREVIEW_ALIGNS.map((a) => ({
            value: a.id,
            label: (
              <span className="flex items-center gap-1">
                <Icon name={a.icon} size={14} />
                {a.label}
              </span>
            ),
            tip: ALIGN_TIPS[a.id],
          }))}
        />
      </Row>

      <Row label="Case" id={`${id}-case`}>
        <ChoiceGroup
          labelledBy={`${id}-case`}
          value={preview.case}
          onChange={(c) => onPreview({ case: c })}
          options={PREVIEW_CASES.map((c) => ({
            value: c.id,
            label:
              c.id === "asTyped" ? (
                c.label
              ) : (
                <>
                  <span aria-hidden>{c.short}</span>
                  <span className="sr-only">{c.label}</span>
                </>
              ),
            tip: CASE_TIPS[c.id],
          }))}
        />
      </Row>

      <div className="flex flex-wrap gap-x-5 gap-y-1.5" role="group" aria-label="Lines">
        <label className="flex items-center gap-2 text-sm">
          <Tip tip="Draws previews as outlines, with no fill">
            <Checkbox checked={preview.outline} onCheckedChange={(on) => onPreview({ outline: on })} />
          </Tip>
          Outline
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Tip tip="Underlines previews, with the font's own underline">
            <Checkbox checked={preview.underline} onCheckedChange={(on) => onPreview({ underline: on })} />
          </Tip>
          Underline
        </label>
      </div>

      <Row label="Features" id={`${id}-features`}>
        <div role="group" aria-labelledby={`${id}-features`} className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          {PREVIEW_FEATURES.map((f) => (
            <label key={f.id} className="flex items-center gap-2 text-sm">
              {/* Its description is already the same words. */}
              <Tip tip={f.description} describe={false}>
                <Checkbox
                  checked={preview.features.includes(f.id)}
                  onCheckedChange={(on) =>
                    onPreview({ features: PREVIEW_FEATURES.map((x) => x.id).filter((x) => (x === f.id ? on : preview.features.includes(x))) })
                  }
                  aria-describedby={`${id}-${f.id}`}
                />
              </Tip>
              {f.label}
              <span id={`${id}-${f.id}`} className="sr-only">
                {f.description}
              </span>
            </label>
          ))}
        </div>
      </Row>

      <ColorChoice
        label="Ink"
        value={preview.ink}
        theme={theme.ink}
        presets={INKS}
        onChange={(ink) => onPreview({ ink })}
      />
      <ColorChoice
        label="Paper"
        value={preview.paper}
        theme={theme.paper}
        presets={PAPERS}
        onChange={(paper) => onPreview({ paper })}
      />
      <p role="status" className={cn("flex items-start gap-1.5 text-xs", colors.low ? "text-destructive" : "text-muted-foreground")}>
        {colors.low && <Icon name="warning" size={14} className="mt-px shrink-0" />}
        <span>
          {colors.low
            ? `Hard to read: the contrast is ${contrastText(colors.contrast)}. Pick a darker ink or a lighter paper, or the other way round.`
            : colors.adapted
              ? `Contrast ${contrastText(colors.contrast)}. The ${preview.ink ? "paper" : "ink"} changes with it, so previews stay readable.`
              : `Contrast ${contrastText(colors.contrast)}.`}
        </span>
      </p>
    </section>
  );
}

function Row({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span id={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * Ink or paper: the theme's, a ready-made color (a radio group: one Tab stop, arrows move the
 * choice), or any color from the color well. A color picked in the well is saved once it stops
 * changing for a moment, so dragging through the picker doesn't save every step; if the popover
 * closes before then, it's saved as it closes.
 */
function ColorChoice({
  label,
  value,
  theme,
  presets,
  onChange,
}: {
  label: string;
  value: string | null;
  /** The theme's color, shown on the Theme choice. */
  theme: string;
  presets: readonly { value: string; label: string }[];
  onChange: (color: string | null) => void;
}) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The color waiting to be saved, and the latest onChange to save it with.
  const pending = useRef<string | null>(null);
  const save = useRef(onChange);
  useEffect(() => {
    save.current = onChange;
  });
  const commit = () => {
    clearTimeout(timer.current);
    const color = pending.current;
    pending.current = null;
    if (color) save.current(color);
  };
  // Closing the popover unmounts this: a color still waiting is saved, not dropped.
  useEffect(() => () => commit(), []);
  // A choice made meanwhile wins over the well's color still waiting.
  const choose = (color: string | null) => {
    clearTimeout(timer.current);
    pending.current = null;
    setDraft(null);
    onChange(color);
  };
  const shown = draft ?? value;
  const choices = [{ value: null as string | null, label: "Theme" }, ...presets];
  const checked = choices.findIndex((c) => c.value === (isColor(shown) ? shown.toLowerCase() : null));
  const pick = (i: number) => {
    const n = (i + choices.length) % choices.length;
    choose(choices[n].value);
    refs.current[n]?.focus();
  };
  const custom = isColor(shown) && checked < 0;
  /** "ink", "paper", in the tooltips' words. */
  const kind = label.toLowerCase();
  return (
    <div className="flex flex-col gap-1.5">
      <span id={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <div className="flex items-center gap-1.5">
        <div
          role="radiogroup"
          aria-labelledby={id}
          className="flex items-center gap-1.5"
          onKeyDown={(e) => {
            const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
            const at = Math.max(0, checked);
            if (step !== undefined) {
              e.preventDefault();
              pick(at + step);
            } else if (e.key === "Home" || e.key === "End") {
              e.preventDefault();
              pick(e.key === "Home" ? 0 : choices.length - 1);
            }
          }}
        >
          {choices.map((c, i) => {
            const on = i === checked;
            return (
              <Tip key={c.label} tip={c.value ? `Uses ${c.label.toLowerCase()} ${kind}` : `Uses the theme's ${kind} color`}>
                <button
                  ref={(el) => {
                    refs.current[i] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={c.value ? c.label : "Theme's color"}
                  // One Tab stop: the chosen color, or Theme while a color from the well is chosen.
                  tabIndex={on || (checked < 0 && i === 0) ? 0 : -1}
                  onClick={() => choose(c.value)}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    on ? "ring-2 ring-primary ring-offset-1 ring-offset-popover" : "",
                  )}
                >
                  {c.value ? (
                    <span className="size-5 rounded-full border border-foreground/20" style={{ background: c.value }} />
                  ) : (
                    // Theme: half the theme's color, half the page's.
                    <span
                      className="flex size-5 items-center justify-center rounded-full border border-foreground/20 text-[9px] font-semibold"
                      style={{ background: theme, color: readableOn(theme) }}
                    >
                      A
                    </span>
                  )}
                </button>
              </Tip>
            );
          })}
        </div>
        <label
          className={cn(
            "relative ml-1 flex size-6 cursor-pointer items-center justify-center rounded-full has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
            custom && "ring-2 ring-primary ring-offset-1 ring-offset-popover",
          )}
        >
          <span
            className="flex size-5 items-center justify-center rounded-full border border-foreground/20"
            style={{ background: custom ? shown! : "conic-gradient(#e11d48, #f59e0b, #22c55e, #0ea5e9, #8b5cf6, #e11d48)" }}
          >
            {!custom && <Icon name="add" size={12} className="text-white mix-blend-difference" />}
          </span>
          {/* The color well covers the whole circle, so it takes the pointer. */}
          <Tip tip={`Picks any other ${kind} color`}>
            <input
              type="color"
              aria-label={`Another ${kind} color`}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
              value={isColor(shown) ? shown.toLowerCase() : theme}
              onChange={(e) => {
                const next = e.target.value;
                setDraft(next);
                pending.current = next;
                clearTimeout(timer.current);
                timer.current = setTimeout(() => {
                  commit();
                  setDraft(null);
                }, 200);
              }}
            />
          </Tip>
        </label>
      </div>
    </div>
  );
}
