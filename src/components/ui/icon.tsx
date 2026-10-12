import { cn } from "@/lib/utils"

interface IconProps extends React.ComponentProps<"span"> {
  /** Material Symbols ligature name, e.g. "folder", "toggle_on". */
  name: string
  size?: number
  filled?: boolean
  weight?: 300 | 400 | 500 | 600
}

/** Google Material Symbols (Rounded), served from the bundled variable font. Decorative by default. */
function Icon({ name, size = 18, filled = false, weight = 400, className, style, ...props }: IconProps) {
  return (
    <span
      aria-hidden
      data-slot="icon"
      className={cn("material-symbols-rounded shrink-0 leading-none select-none", className)}
      style={{
        fontSize: size,
        fontVariationSettings: `"FILL" ${filled ? 1 : 0}, "wght" ${weight}, "GRAD" 0, "opsz" ${Math.min(48, Math.max(20, size))}`,
        ...style,
      }}
      {...props}
    >
      {name}
    </span>
  )
}

export { Icon }
