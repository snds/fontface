import { cloneElement, useId } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/*
 * A stand-in for the app-wide `Tip` (components/Tip.tsx, which the tooltips work is adding),
 * with the same props for what the Google Fonts view uses. Switching over is a change of import
 * (`@/components/Tip`), after which this file goes.
 *
 * A design-system tooltip on one control, never the browser's `title`: the control is rendered
 * as it is, with the words as its description for screen readers. A greyed-out control says
 * why (`disabledReason`), and must stay hoverable and focusable for that: on a Button,
 * `disabled` with `focusableWhenDisabled`.
 */

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

export interface TipProps {
  /** What the control does, in plain words. */
  tip: React.ReactNode;
  /** Set when the control is greyed out: why. Shown (and said) instead of `tip`. */
  disabledReason?: string | false | null;
  side?: Side;
  align?: Align;
  /** Only for a big target the pointer crosses on its way elsewhere. */
  delay?: number;
  /** false: the control's name already says exactly the same. */
  describe?: boolean;
  /** Keeps the tooltip from showing (the control is unchanged). */
  hide?: boolean;
  contentClassName?: string;
  children: React.ReactElement;
}

export function Tip({ tip, disabledReason, side = "top", align = "center", delay, describe = true, hide = false, contentClassName, children }: TipProps) {
  const descId = useId();
  const words = disabledReason || tip;
  const said = describe && typeof words === "string" ? words : undefined;
  const own = children.props as { id?: string; "aria-describedby"?: string };
  const trigger = said ? cloneElement(children, { "aria-describedby": [own["aria-describedby"], descId].filter(Boolean).join(" ") } as never) : children;
  // Always the same shape, so a change of words never remounts the control (it keeps focus).
  return (
    <>
      <Tooltip disabled={hide}>
        <TooltipTrigger delay={delay} id={own.id} render={trigger} />
        <TooltipContent side={side} align={align} className={contentClassName}>
          {words}
        </TooltipContent>
      </Tooltip>
      {said && (
        <span id={descId} hidden>
          {said}
        </span>
      )}
    </>
  );
}
