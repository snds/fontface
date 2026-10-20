import { useRef } from "react";
import { Icon } from "@/components/ui/icon";
import { Tip } from "@/components/Tip";
import { cn } from "@/lib/utils";
import { COLOR_NAMES, PALETTE, colorVar, type TagColor } from "./api";

interface Props {
  value: TagColor | null;
  onChange: (color: TagColor) => void;
  label?: string;
  /** Marks the default color, so people can see what "reset" goes back to. */
  defaultColor?: TagColor;
}

/** The fixed palette as a radio group: one tab stop, arrow keys move, names for screen readers.
 *  Each swatch's tooltip shows its name ("Blue", "Gray (default)"), since the dot alone doesn't. */
export function ColorSwatches({ value, onChange, label = "Color", defaultColor }: Props) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = value ? PALETTE.indexOf(value) : -1;
  const move = (to: number) => {
    const i = (to + PALETTE.length) % PALETTE.length;
    onChange(PALETTE[i]);
    refs.current[i]?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step: Record<string, number> = { ArrowRight: 1, ArrowDown: 6, ArrowLeft: -1, ArrowUp: -6 };
    if (e.key in step) {
      e.preventDefault();
      move(Math.max(0, current) + step[e.key]);
    }
  };
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className="grid grid-cols-6 gap-1.5">
      {PALETTE.map((c, i) => {
        const checked = c === value;
        const name = COLOR_NAMES[c] + (c === defaultColor ? " (default)" : "");
        // The tooltip is the swatch's name (aria-label), so it isn't its description too.
        return (
          <Tip key={c} tip={name}>
            <button
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={name}
              tabIndex={checked || (current < 0 && i === 0) ? 0 : -1}
              onClick={() => onChange(c)}
              className={cn(
                "flex size-6 items-center justify-center rounded-full ring-offset-2 ring-offset-popover outline-none focus-visible:ring-2 focus-visible:ring-foreground",
                checked && "ring-2 ring-foreground/60",
              )}
              style={{ background: colorVar(c) }}
            >
              {/* The page background contrasts with every swatch: white on the light-mode colors,
                  near-black on the dark-mode ones. */}
              {checked && <Icon name="check" size={14} weight={600} className="text-background" />}
              {!checked && c === defaultColor && <span className="size-1.5 rounded-full bg-background/80" />}
            </button>
          </Tip>
        );
      })}
    </div>
  );
}
