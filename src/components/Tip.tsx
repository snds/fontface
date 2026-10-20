import { cloneElement, useCallback, useState } from "react";
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
import { shortcutAria, shortcutLabel, type ShortcutSpec } from "@/tips";
import { IS_MAC } from "./TitleBar";

/*
 * Tooltips: only a control with no visible words of its own has one, and it says just that
 * control's name.
 *
 * - Which controls: icon-only buttons and toggles, color swatches, icon-only menu or popover
 *   triggers, icon-only ChoiceGroup options (give the option a `tip`), a picker that shows only
 *   its value. A control that shows its words has none: a text button, a menu item, a tab, a
 *   link, a switch or checkbox with its label beside it, a settings row. A button whose words
 *   hide at narrow widths has one only while they're hidden (`hide` while they show).
 * - Words: the control's name, a few words, sentence case, no full stop: "Uninstall",
 *   "Align left", "Reset preview", "More". Not a sentence, not what it does, not why it's
 *   greyed out. If that reason matters, say it in short visible text near the control, where
 *   it fits. Give the keyboard shortcut with `shortcut` ("Mod+1"; see tips.ts), never in the
 *   words.
 * - Two other uses, both the content itself, not an explanation: text cut short (truncated)
 *   shows all of itself while it's cut (`CutShort`), and a mark with no words (an icon, a row
 *   of dots) shows what it stands for ("Not in this font: ä ö", "3 copies").
 * - Never the browser's `title`: always these parts, on the design system's tooltip
 *   (ui/tooltip.tsx). Don't name other font managers; the system's own font folders are
 *   "System Fonts".
 *
 * `Tip` goes around one control: a Button, a plain <button>, a Switch, a menu's or popover's
 * trigger (Tip goes outside: <Tip><PopoverTrigger render={<Button/>} /></Tip>, never inside its
 * `render`). It doesn't change the control: same element, same layout, same focus order. In a
 * virtualised list, share one tooltip between the rows: `createTipHandle()`, one
 * <TipHost handle/>, and `handle` on each row's Tip.
 *
 * Screen readers: the control's own name (its aria-label) says the same words, so the tooltip
 * adds nothing to its description. The shortcut goes on aria-keyshortcuts. Keyboard focus shows
 * the tooltip as hover does. A greyed-out control keeps focus, so focus never drops when it
 * greys out under it: on a Button or a Switch, `disabled` with `focusableWhenDisabled`; on a
 * plain <button>, `aria-disabled` instead of `disabled` (with `aria-disabled:opacity-50`), and
 * ignore the click.
 *
 * Esc closes an open tooltip and, in the same press, still does its other job there: closes the
 * dialog or menu, goes Back, leaves Settings (ui/tooltip.tsx; window handlers ask tips.ts's
 * `keyHandled`, not `defaultPrevented`).
 *
 * Timing: the app's TooltipProvider (App.tsx) opens a tooltip once the pointer rests on a
 * control for TIP_DELAY; once one is open, the next control's opens at once, as on macOS. Don't
 * pass `delay` unless the target is a big one the pointer crosses on its way elsewhere (a list
 * row's cut-short name: ROW_TIP_DELAY).
 */

/** How long the pointer rests on a control before its tooltip opens, app-wide (App.tsx's
 *  TooltipProvider). */
export const TIP_DELAY = 500;
/** After a tooltip closes, the next one opens without waiting for this long, so moving along a
 *  toolbar shows each tooltip at once, like macOS. */
export const TIP_INSTANT_WINDOW = 400;
/** For big targets the pointer crosses on its way elsewhere: a list row's cut-short name. */
export const ROW_TIP_DELAY = 800;

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

/** The one tooltip that a list's Tips with this `handle` share. Mount it once, beside the list. */
export function TipHost({ handle }: { handle: TipHandle }) {
  return (
    <Tooltip handle={handle}>
      {({ payload }) =>
        payload ? (
          <TooltipContent side={payload.side} align={payload.align} className={payload.className}>
            {payload.content}
          </TooltipContent>
        ) : null
      }
    </Tooltip>
  );
}

/** A shortcut inside a tooltip, after its words: how the menus show it, a little quieter. */
export function TipShortcut({ shortcut }: { shortcut: ShortcutSpec }) {
  return <span className="shrink-0 tracking-widest text-background/70">{shortcutLabel(shortcut, IS_MAC)}</span>;
}

export interface TipProps {
  /** The control's name, a few words with no full stop ("Align left"): the same words as its
   *  aria-label. Or, for text cut short, all of it. */
  tip: React.ReactNode;
  /** The control's keyboard shortcut ("Mod+1", "Shift+Mod+Enter", or `{ mac, other }`; see
   *  tips.ts). Shown after the words as the menus show it, and put on aria-keyshortcuts unless
   *  the control has its own. */
  shortcut?: ShortcutSpec;
  /** Default "top". */
  side?: Side;
  align?: Align;
  /** Only for a big target the pointer crosses on its way elsewhere (ROW_TIP_DELAY). */
  delay?: number;
  /** Keeps the tooltip from showing (the control is unchanged): while its own menu is open, or
   *  while the button's words show. */
  hide?: boolean;
  /** Classes for the tooltip's popup (e.g. "max-w-sm break-all" for a long path). */
  contentClassName?: string;
  /** A shared tooltip (createTipHandle, TipHost), for rows of a virtualised list. */
  handle?: TipHandle;
  /** The one control. It's rendered as is, with the tooltip's handlers merged in. */
  children: React.ReactElement;
}

/**
 * A design-system tooltip on one control, with no change to the control itself. Keyboard focus
 * opens it as hover does. See the top of this file for when and what it says.
 */
export function Tip({ tip, shortcut, side = "top", align = "center", delay, hide = false, contentClassName, handle, children }: TipProps) {
  const own = children.props as { id?: string; "aria-keyshortcuts"?: string };
  const trigger =
    shortcut !== undefined && own["aria-keyshortcuts"] === undefined
      ? cloneElement(children, { "aria-keyshortcuts": shortcutAria(shortcut, IS_MAC) } as Record<string, string>)
      : children;

  const content = (
    <>
      {tip}
      {shortcut !== undefined && <TipShortcut shortcut={shortcut} />}
    </>
  );
  // The trigger takes the control's own id, so Base UI's and the DOM's agree. Always the same
  // shape, so a change of words never remounts the control (it keeps focus).
  return handle ? (
    <TooltipTrigger handle={handle} payload={{ content, side, align, className: contentClassName }} delay={delay} disabled={hide} id={own.id} render={trigger} />
  ) : (
    <Tooltip disabled={hide}>
      <TooltipTrigger delay={delay} id={own.id} render={trigger} />
      <TooltipContent side={side} align={align} className={contentClassName}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Text that's cut short ("…") where there's no room for all of it: while it is, a tooltip shows
 * all of it. That's the text itself, not an explanation, so it's the one tooltip text gets. Only
 * where text had its whole self on hover already; don't add new ones. `more`: the tooltip shows
 * a little more than the text does (a file's whole path, every place's name), so it shows even
 * when nothing is cut. `children`: the one element that's cut short (`truncate`). Such text is a
 * big target the pointer crosses on its way elsewhere, so it waits ROW_TIP_DELAY.
 */
export function CutShort({
  tip,
  more = false,
  align = "start",
  contentClassName,
  handle,
  children,
}: {
  tip: React.ReactNode;
  more?: boolean;
  align?: Align;
  contentClassName?: string;
  handle?: TipHandle;
  children: React.ReactElement;
}) {
  const [cut, setCut] = useState(false);
  // Checked again whenever its size changes (a column dragged wider, the window resized).
  const measure = useCallback(
    (el: HTMLElement | null) => {
      if (!el || more) return;
      const observer = new ResizeObserver(() => setCut(el.scrollWidth > el.clientWidth));
      observer.observe(el);
      return () => observer.disconnect();
    },
    [more],
  );
  return (
    <Tip tip={tip} align={align} delay={ROW_TIP_DELAY} hide={!more && !cut} contentClassName={contentClassName} handle={handle}>
      {cloneElement(children as React.ReactElement<{ ref?: React.Ref<HTMLElement> }>, { ref: measure })}
    </Tip>
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
