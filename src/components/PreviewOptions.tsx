import { useEffect, useId, useRef, useState } from "react";
import type { PreviewOptions } from "@/api";
import { contrastText, isColor, readableOn, type PreviewColors } from "@/previewStyle";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { Tip } from "./Tip";

/*
 * Words and color choices for the preview bar (PreviewBar.tsx): what each alignment and case
 * does, the ready-made inks and papers, the swatches that pick one, and the contrast line.
 */

/** Ready-made inks and papers; the color well picks any other. */
export const INKS = [
  { value: "#000000", label: "Black" },
  { value: "#3d3d3d", label: "Dark gray" },
  { value: "#ffffff", label: "White" },
  { value: "#b3261e", label: "Red" },
  { value: "#1d4ed8", label: "Blue" },
] as const;
export const PAPERS = [
  { value: "#ffffff", label: "White" },
  { value: "#f4efe1", label: "Cream" },
  { value: "#e4e4e7", label: "Light gray" },
  { value: "#1d2a5a", label: "Navy" },
  { value: "#000000", label: "Black" },
] as const;

/** What picking each alignment and case does, for their tooltips. */
export const ALIGN_TIPS: Record<PreviewOptions["align"], string> = {
  left: "Lines previews up on the left",
  center: "Centers previews",
  right: "Lines previews up on the right",
};
export const CASE_TIPS: Record<PreviewOptions["case"], string> = {
  asTyped: "Shows previews as typed",
  upper: "Shows previews in capitals",
  lower: "Shows previews in small letters",
  title: "Starts each word in previews with a capital",
};

/** A color's name for screen readers and tooltips: "the theme's", a ready-made one's ("cream"),
 *  or its code ("#1a2b3c"). */
export function colorName(value: string | null, presets: readonly { value: string; label: string }[]): string {
  if (!isColor(value)) return "the theme's";
  const preset = presets.find((p) => p.value === value.toLowerCase());
  return preset ? preset.label.toLowerCase() : value.toLowerCase();
}

/** How readable the colors are together: a warning under 3:1, else the contrast. A status line,
 *  so a change is read out. */
export function ContrastNote({ colors, inkChosen }: { colors: PreviewColors; inkChosen: boolean }) {
  return (
    <p role="status" className={cn("flex items-start gap-1.5 text-xs", colors.low ? "text-destructive" : "text-muted-foreground")}>
      {colors.low && <Icon name="warning" size={14} className="mt-px shrink-0" />}
      <span>
        {colors.low
          ? `Hard to read: the contrast is ${contrastText(colors.contrast)}. Pick a darker ink or a lighter paper, or the other way round.`
          : colors.adapted
            ? `Contrast ${contrastText(colors.contrast)}. The ${inkChosen ? "paper" : "ink"} changes with it, so previews stay readable.`
            : `Contrast ${contrastText(colors.contrast)}.`}
      </span>
    </p>
  );
}

/**
 * Ink or paper: the theme's, a ready-made color (a radio group of swatches: one Tab stop, arrows
 * move the choice), or any color from the color well. A color picked in the well is saved once
 * it stops changing for a moment, so dragging through the picker doesn't save every step; if
 * the popover closes before then, it's saved as it closes.
 */
export function ColorChoice({
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
                    // Theme: the theme's color, with a letter in the page's.
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
