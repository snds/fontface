import { cloneElement, useId } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
  ContextMenuCheckboxItem,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { joinIds, shortcutAria, shortcutLabel, shortcutSaid, tipSaid, type ShortcutSpec } from "@/tips";
import { IS_MAC } from "./TitleBar";

/*
 * Tooltips: every action in the app has one, from the design system (ui/tooltip.tsx), never the
 * browser's `title`. Use these parts for every new one:
 *
 * - `Tip` around any one control: a Button, a plain <button>, a link, a Switch, a Slider, a
 *   ChoiceGroup option (give the option a `tip`), a menu's or popover's trigger (Tip goes
 *   outside: <Tip><PopoverTrigger render={<Button/>} /></Tip>, never inside its `render`). It
 *   doesn't change the control: same element, same layout, same focus order. In a virtualised
 *   list, share one tooltip between the rows: `createTipHandle()`, one <TipHost handle/>, and
 *   `handle` on each row's Tip.
 * - `TipItem` for a menu item, submenu trigger, radio or checkbox item, in a dropdown (`DROPDOWN`)
 *   or right-click menu (`CONTEXT`).
 *
 * Words: plain and short (about 4 to 12), usually starting with a verb, saying what happens:
 * "Shows fonts as a grid of cards", "Turns on every style in this family". One sentence has no
 * closing period; two or more end each with one ("Stops the scan. Fonts read so far are kept.").
 * Give the shortcut with `shortcut` ("Mod+1"; see tips.ts), never in the words. A greyed-out
 * control says why, and what would make it work: `disabledReason` ("Select a font to compare
 * it"); while Fontface is busy, "Wait: Fontface is still …". Don't name other font managers;
 * macOS's own font folders are "macOS Fonts".
 *
 * Screen readers: the words become the control's description (aria-describedby, after its own),
 * with the shortcut as said ("Command-1"); the shortcut also goes on aria-keyshortcuts. Pass
 * `describe={false}` only when the control's name already says exactly the same. Keyboard focus
 * shows the tooltip as hover does. A greyed-out control must still take the pointer and focus,
 * or its tooltip can't show: on a Button, `disabled` with `focusableWhenDisabled` (and
 * `className="aria-disabled:opacity-50"` to look greyed out); on a plain <button>,
 * `aria-disabled` instead of `disabled`, and ignore the click.
 *
 * Timing: the app's TooltipProvider (App.tsx) opens a tooltip once the pointer rests on a
 * control for TIP_DELAY; once one is open, the next control's opens at once, as on macOS. Don't
 * pass `delay` unless the control is a big target the pointer crosses on its way elsewhere (a
 * list or sidebar row's name: ROW_TIP_DELAY).
 */

/** How long the pointer rests on a control before its tooltip opens, app-wide (App.tsx's
 *  TooltipProvider). */
export const TIP_DELAY = 500;
/** After a tooltip closes, the next one opens without waiting for this long, so moving along a
 *  toolbar shows each tooltip at once, like macOS. */
export const TIP_INSTANT_WINDOW = 400;
/** For big targets the pointer crosses on its way elsewhere: a list or sidebar row's name. */
export const ROW_TIP_DELAY = 800;
/** How long the pointer rests on a menu item before its tooltip shows, so moving down a menu
 *  doesn't flash one per item. */
export const MENU_TIP_DELAY = 500;

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

/** What a shared tooltip (TipHost) shows for the row whose Tip opened it. */
export interface TipPayload {
  content: React.ReactNode;
  side: Side;
  align: Align;
  className?: string;
}

/** One tooltip shared by many rows (a virtualised list): make it once per list with
 *  `useState(createTipHandle)`, render one <TipHost handle/>, and pass it to each row's Tip. */
export type TipHandle = TooltipPrimitive.Handle<TipPayload>;
export const createTipHandle = (): TipHandle => TooltipPrimitive.createHandle<TipPayload>();

/**
 * Escape closes an open tooltip. Inside a dialog, popover or menu it closes that too, in the same
 * press: without this, Base UI keeps the key from reaching it, and the first Escape would only
 * close the tooltip. Elsewhere Escape stops at the tooltip, as usual.
 */
function escapeReachesPopup(open: boolean, details: TooltipPrimitive.Root.ChangeEventDetails) {
  if (open || details.reason !== "escape-key") return;
  const target = details.event?.target;
  if (target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) details.allowPropagation();
}

/** The one tooltip that a list's Tips with this `handle` share. Mount it once, beside the list. */
export function TipHost({ handle }: { handle: TipHandle }) {
  return (
    <TooltipPrimitive.Root handle={handle} onOpenChange={escapeReachesPopup}>
      {({ payload }) =>
        payload ? (
          <TooltipContent side={payload.side} align={payload.align} className={payload.className}>
            {payload.content}
          </TooltipContent>
        ) : null
      }
    </TooltipPrimitive.Root>
  );
}

/** A shortcut inside a tooltip, after its words: how the menus show it, a little quieter. */
export function TipShortcut({ shortcut }: { shortcut: ShortcutSpec }) {
  return <span className="shrink-0 tracking-widest text-background/70">{shortcutLabel(shortcut, IS_MAC)}</span>;
}

export interface TipProps {
  /** What the control does, in plain words. A string, so it can also be the screen-reader
   *  description (else give `description`). */
  tip: React.ReactNode;
  /** The control's keyboard shortcut ("Mod+1", "Shift+Mod+Enter", or `{ mac, other }`; see
   *  tips.ts). Shown after the words as the menus show it, said to screen readers, and put on
   *  aria-keyshortcuts unless the control has its own. Hidden while it's greyed out. */
  shortcut?: ShortcutSpec;
  /** Set when the control is greyed out: why, and what would make it work. Shown (and said)
   *  instead of `tip`. The control must stay hoverable and focusable (see the top of this file). */
  disabledReason?: string | false | null;
  /** Default "top". */
  side?: Side;
  align?: Align;
  /** Only for a big target the pointer crosses on its way elsewhere (ROW_TIP_DELAY). */
  delay?: number;
  /** false: don't add the words to the control's description, because its name (aria-label)
   *  already says exactly the same. */
  describe?: boolean;
  /** The screen-reader words, when `tip` isn't a plain string. */
  description?: string;
  /** Keeps the tooltip from showing (the control is unchanged), e.g. while its own menu is open. */
  hide?: boolean;
  /** Classes for the tooltip's popup (e.g. "max-w-64" for a longer one). */
  contentClassName?: string;
  /** A shared tooltip (createTipHandle, TipHost), for rows of a virtualised list. */
  handle?: TipHandle;
  /** The one control. It's rendered as is, with the tooltip's handlers and the description
   *  merged in. */
  children: React.ReactElement;
}

/**
 * A design-system tooltip on one control, with no change to the control itself. Its words reach
 * screen readers through a hidden copy beside it (aria-describedby), and keyboard focus opens it
 * as hover does. See the top of this file for when and how.
 */
export function Tip({
  tip,
  shortcut,
  disabledReason,
  side = "top",
  align = "center",
  delay,
  describe = true,
  description,
  hide = false,
  contentClassName,
  handle,
  children,
}: TipProps) {
  const descId = useId();
  const reason = disabledReason || undefined;
  const keys = reason ? undefined : shortcut;
  const words = reason ?? tip;
  const text = reason ?? description ?? (typeof tip === "string" ? tip : undefined);
  const said = describe && text ? tipSaid(text, keys === undefined ? undefined : shortcutSaid(keys, IS_MAC)) : undefined;

  const own = children.props as { id?: string; "aria-describedby"?: string; "aria-keyshortcuts"?: string };
  const extra: Record<string, string | undefined> = {};
  if (said) extra["aria-describedby"] = joinIds(own["aria-describedby"], descId);
  if (keys !== undefined && own["aria-keyshortcuts"] === undefined) extra["aria-keyshortcuts"] = shortcutAria(keys, IS_MAC);
  const trigger = Object.keys(extra).length ? cloneElement(children, extra) : children;

  const content = (
    <>
      {words}
      {keys !== undefined && <TipShortcut shortcut={keys} />}
    </>
  );
  // The trigger takes the control's own id, so Base UI's and the DOM's agree.
  const tooltip = handle ? (
    <TooltipTrigger handle={handle} payload={{ content, side, align, className: contentClassName }} delay={delay} disabled={hide} id={own.id} render={trigger} />
  ) : (
    <Tooltip disabled={hide} onOpenChange={escapeReachesPopup}>
      <TooltipTrigger delay={delay} id={own.id} render={trigger} />
      <TooltipContent side={side} align={align} className={contentClassName}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
  // Always the same shape, so a change of words never remounts the control (it keeps focus).
  return (
    <>
      {tooltip}
      {/* The words for screen readers. Hidden, so it takes no room in the layout. */}
      {said && (
        <span id={descId} hidden>
          {said}
        </span>
      )}
    </>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The same menu items work in a right-click menu and in a "…" menu. */
export interface Kit {
  Item: React.ComponentType<any>;
  Group: React.ComponentType<any>;
  Label: React.ComponentType<any>;
  Separator: React.ComponentType<any>;
  Sub: React.ComponentType<any>;
  SubTrigger: React.ComponentType<any>;
  SubContent: React.ComponentType<any>;
  RadioGroup: React.ComponentType<any>;
  RadioItem: React.ComponentType<any>;
  CheckboxItem: React.ComponentType<any>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const DROPDOWN: Kit = {
  Item: DropdownMenuItem,
  Group: DropdownMenuGroup,
  Label: DropdownMenuLabel,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  RadioGroup: DropdownMenuRadioGroup,
  RadioItem: DropdownMenuRadioItem,
  CheckboxItem: DropdownMenuCheckboxItem,
};

export const CONTEXT: Kit = {
  Item: ContextMenuItem,
  Group: ContextMenuGroup,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem,
  CheckboxItem: ContextMenuCheckboxItem,
};

/**
 * A menu item (or, with `as`, a submenu trigger, radio item or checkbox item) with a
 * design-system tooltip: what it does, or, when it's greyed out, why. The tip is also the item's
 * description for screen readers. A greyed-out item still takes the pointer, so its tooltip
 * shows. Submenu triggers put the tip above, so it doesn't cover the submenu. A shortcut the
 * menu shows on the item (its Shortcut) isn't repeated in the tip.
 */
export function TipItem({
  kit,
  tip,
  as = "Item",
  disabled,
  className,
  children,
  ...rest
}: {
  kit: Kit;
  tip: string;
  as?: "Item" | "SubTrigger" | "RadioItem" | "CheckboxItem";
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
} & Record<string, unknown>) {
  const Item = kit[as];
  const id = useId();
  return (
    <Tooltip onOpenChange={escapeReachesPopup}>
      <TooltipTrigger
        delay={MENU_TIP_DELAY}
        render={<Item disabled={disabled} aria-describedby={id} className={cn(disabled && "data-disabled:pointer-events-auto data-disabled:opacity-50", className)} {...rest} />}
      >
        {children}
        <span id={id} hidden>
          {tip}
        </span>
      </TooltipTrigger>
      <TooltipContent side={as === "SubTrigger" ? "top" : "right"} className="max-w-64">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}
