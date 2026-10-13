import { useId, useRef } from "react";
import { cn } from "@/lib/utils";

interface Props<T extends string> {
  /** The group's name for screen readers. Leave it out when `labelledBy` names it. */
  label?: string;
  /** Id of a visible element that names the group (e.g. a settings row's label). */
  labelledBy?: string;
  /** Id of an element that describes the group. */
  describedBy?: string;
  value: T;
  /** `description` shows only with the "cards" look. */
  options: { value: T; label: React.ReactNode; description?: React.ReactNode }[];
  onChange: (value: T) => void;
  /** "segments": joined buttons in a frame. "chips": separate rounded pills. "cards": one
   *  full-width row per choice, with a radio dot and a description. */
  look?: "segments" | "chips" | "cards";
}

/**
 * A single-choice control (WAI-ARIA radio group): one tab stop, arrow keys move the choice,
 * Home/End jump to the ends.
 */
export function ChoiceGroup<T extends string>({ label, labelledBy, describedBy, value, options, onChange, look = "segments" }: Props<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = Math.max(0, options.findIndex((o) => o.value === value));
  const base = useId();

  const move = (to: number) => {
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
        if (look === "cards") {
          const id = `${base}-${i}`;
          return (
            <button
              key={o.value}
              ref={ref}
              role="radio"
              aria-checked={checked}
              aria-labelledby={`${id}-label`}
              aria-describedby={o.description ? `${id}-desc` : undefined}
              tabIndex={checked ? 0 : -1}
              onClick={() => onChange(o.value)}
              className={cn(
                "flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
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
            </button>
          );
        }
        return (
          <button
            key={o.value}
            ref={ref}
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              "text-xs whitespace-nowrap",
              look === "segments" ? "h-6 rounded-md px-2.5" : "h-7 rounded-full border px-3",
              checked
                ? cn("bg-secondary font-medium text-secondary-foreground", look === "chips" && "border-transparent")
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
