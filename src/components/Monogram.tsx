import { cn } from "@/lib/utils";

/*
 * A brand-free mark for a source that is an online service: a letter ("G" for Google Fonts, "A"
 * for Adobe Fonts) in a rounded square, drawn in the app's own type (IBM Plex Sans) on the 24-unit
 * grid Material Symbols uses, with the same 2-unit stroke as the outlined icons around it, in the
 * text color. No company's logo: a plain letter names the service without borrowing its mark.
 */

/** IBM Plex Sans' cap height, as a share of the font size: the letter's baseline is placed so its
 *  capitals sit in the middle of the square. */
const CAP_HEIGHT = 0.698;
const LETTER_SIZE = 11;

/** A letter in a rounded square, at the size of an <Icon> (`size`, the box it sits in).
 *  Decorative: the row's name says which source it is. */
export function Monogram({ letter, size = 18, className }: { letter: string; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
      focusable={false}
      className={cn("shrink-0", className)}
      data-slot="icon"
    >
      <rect x={4} y={4} width={16} height={16} rx={3.5} fill="none" stroke="currentColor" strokeWidth={2} />
      <text
        x={12}
        y={12 + (LETTER_SIZE * CAP_HEIGHT) / 2}
        textAnchor="middle"
        fill="currentColor"
        fontSize={LETTER_SIZE}
        fontWeight={600}
        style={{ fontFamily: "var(--font-sans)" }}
      >
        {letter}
      </text>
    </svg>
  );
}
