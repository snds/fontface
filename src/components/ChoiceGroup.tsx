import { useId, useRef } from "react";
import { cn } from "@/lib/utils";
import type { ShortcutSpec } from "@/tips";
import { Tip } from "./Tip";

interface Props<T extends string> {
  /** The group's name for screen readers. Leave it out when `labelledBy` names it. */
  label?: string;
  /** Id of a visible element that names the group (e.g. a settings row's label). */
  labelledBy?: string;
  /** Id of an element that describes the group. */
  describedBy?: string;
  value: T;
  /** `description` shows only with the "cards" look. `tip`: the option's tooltip, what picking
   *  it does ("Shows fonts as a grid of cards"); also its description for screen readers.
   *  `shortcut`: the key that picks it from anywhere ("Mod+1"), shown after the tip. */
  options: { value: T; label: React.ReactNode; description?: React.ReactNode; tip: string; shortcut?: ShortcutSpec }[];
  onChange: (value: T) => void;
  /** "segments": joined buttons in a frame. "chips": separate rounded pills. "cards": one
   *  full-width row per choice, with a radio dot and a description. */
  look?: "segments" | "chips" | "cards";
  /** Set while the choice can't be changed: why, and what would make it work. Every option is
   *  greyed out but still takes the pointer and focus, so its tooltip says this instead. */
  disabledReason?: string | false | null;
}

/**
 * A single-choice control (WAI-ARIA radio group): one tab stop, arrow keys move the choice,
 * Home/End jump to the ends. Each option has a design-system tooltip (components/Tip).
 */
export function ChoiceGroup<T extends string>({ label, labelledBy, describedBy, value, options, onChange, look = "segments", disabledReason }: Props<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = Math.max(0, options.findIndex((o) => o.value === value));
  const base = useId();

  const disabled = !!disabledReason;
  const move = (to: number) => {
    if (disabled) return;
    const i = (to + options.length) % options.length;
    onChange(options[i].value);
    refs.current[i]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowRight: () => move(current + 1),
      ArrowDown: () => move(current + 1),
      ArrowLeft: () => move(current - 1),
      ArrowUp: () => move(current - 1),
      Home: () => move(0),
      End: () => move(options.length - 1),
    };
    const action = keys[e.key];
    if (action) {
      e.preventDefault();
      action();
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      className={cn(
        "flex shrink-0",
        look === "segments" && "rounded-lg border p-0.5",
        look === "chips" && "flex-wrap gap-2",
        look === "cards" && "flex-col gap-1.5",
      )}
    >
      {options.map((o, i) => {
        const checked = i === current;
        const ref = (el: HTMLButtonElement | null) => {
          refs.current[i] = el;
        };
        // The option in its tooltip (the button itself is unchanged).
        const tipped = (button: React.ReactElement) => (
          <Tip key={o.value} tip={o.tip} shortcut={o.shortcut} disabledReason={disabledReason}>
            {button}
          </Tip>
        );
        if (look === "cards") {
          const id = `${base}-${i}`;
          return tipped(
            <button
              key={o.value}
              ref={ref}
              role="radio"
              aria-checked={checked}
              aria-labelledby={`${id}-label`}
              aria-describedby={o.description ? `${id}-desc` : undefined}
              tabIndex={checked ? 0 : -1}
              aria-disabled={disabled || undefined}
              onClick={() => !disabled && onChange(o.value)}
              className={cn(
                "flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:opacity-50",
                checked ? "border-primary/40 bg-background" : "border-transparent hover:bg-background/60",
              )}
            >
              {/* The radio dot. */}
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                  checked ? "border-primary bg-primary" : "border-input bg-background",
                )}
              >
                {checked && <span className="size-1.5 rounded-full bg-primary-foreground" />}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span id={`${id}-label`} className="text-sm font-medium">
                  {o.label}
                </span>
                {o.description && (
                  <span id={`${id}-desc`} className="text-xs text-muted-foreground">
                    {o.description}
                  </span>
                )}
              </span>
            </button>,
          );
        }
        return tipped(
          <button
            key={o.value}
            ref={ref}
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            aria-disabled={disabled || undefined}
            onClick={() => !disabled && onChange(o.value)}
            className={cn(
              "text-xs whitespace-nowrap aria-disabled:opacity-50",
              look === "segments" ? "h-6 rounded-md px-2.5" : "h-7 rounded-full border px-3",
              checked
                ? cn("bg-secondary font-medium text-secondary-foreground", look === "chips" && "border-transparent")
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {/* Each option is as wide as its label in the chosen (medium) weight, chosen or not,
                so picking one never moves what's beside the group. */}
            <span className="inline-grid justify-items-center">
              <span className="col-start-1 row-start-1">{o.label}</span>
              <span aria-hidden className="invisible col-start-1 row-start-1 font-medium">
                {o.label}
              </span>
            </span>
          </button>,
        );
      })}
    </div>
  );
}
