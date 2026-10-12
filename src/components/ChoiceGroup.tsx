import { useRef } from "react";
import { cn } from "@/lib/utils";

interface Props<T extends string> {
  label: string;
  value: T;
  options: { value: T; label: React.ReactNode }[];
  onChange: (value: T) => void;
  /** "segments": joined buttons in a frame. "chips": separate rounded pills. */
  look?: "segments" | "chips";
}

/**
 * A single-choice control (WAI-ARIA radio group): one tab stop, arrow keys move the choice,
 * Home/End jump to the ends.
 */
export function ChoiceGroup<T extends string>({ label, value, options, onChange, look = "segments" }: Props<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = Math.max(0, options.findIndex((o) => o.value === value));

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
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("flex shrink-0", look === "segments" ? "rounded-lg border p-0.5" : "flex-wrap gap-2")}
    >
      {options.map((o, i) => {
        const checked = i === current;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
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
