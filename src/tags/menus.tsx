import { useId, useState } from "react";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
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
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useStateWording } from "@/components/ActivationSwitch";
import type { ActivationMode } from "@/api";
import { otherMode } from "@/fontActions";
import type { Face } from "@/library";
import { cn } from "@/lib/utils";
import { useSettings } from "@/settings/useSettings";
import { canNestIn, tagEditStates, tagSwitchStates, type TagActionState } from "@/tagActions";
import { COLOR_NAMES, PALETTE, colorVar, type Tag, type TagColor } from "./api";
import { openTagDialog } from "./dialogs";
import { moveTag, moveToGroup } from "./drag";
import type { Locations } from "./locations";
import { parentOf, useTagIndex } from "./model";
import { recolorTag, setLocationColor } from "./store";
import { switchTag } from "./switching";

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
};

/** How long the pointer rests on a menu item before its tooltip shows, so moving down a menu
 *  doesn't flash one per item. */
const MENU_TIP_DELAY = 500;

/**
 * A menu item (or submenu trigger, with `as`) with a design-system tooltip: what it does, or,
 * when it's greyed out, why. The tip is also the item's description for screen readers. A
 * greyed-out item still takes the pointer, so its tooltip shows. Submenu triggers put the tip
 * above, so it doesn't cover the submenu.
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
  as?: "Item" | "SubTrigger";
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
} & Record<string, unknown>) {
  const Item = kit[as];
  const id = useId();
  return (
    <Tooltip>
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

/** A menu item for one of a tag's actions (tagActions.ts says if it can run, and its words). */
function ActionItem({ kit, state, icon, onClick, variant }: { kit: Kit; state: TagActionState; icon: string; onClick: (e: React.MouseEvent) => void; variant?: "destructive" }) {
  return (
    <TipItem kit={kit} tip={state.tip} disabled={!state.enabled} variant={variant} onClick={onClick}>
      <Icon name={icon} size={16} />
      {state.label}
    </TipItem>
  );
}

/** A "Color" submenu with the palette as radio items. `tip`: the trigger's tooltip (with
 *  `disabled`, why it's greyed out). */
function ColorSub({
  kit,
  value,
  defaultColor,
  onPick,
  tip = "Change its color.",
  disabled,
}: {
  kit: Kit;
  value: TagColor;
  defaultColor?: TagColor;
  onPick: (c: TagColor) => void;
  tip?: string;
  disabled?: boolean;
}) {
  const { Sub, SubContent, RadioGroup, RadioItem } = kit;
  return (
    <Sub>
      <TipItem kit={kit} as="SubTrigger" tip={tip} disabled={disabled}>
        <span className="size-3 rounded-full" style={{ background: colorVar(value) }} aria-hidden />
        Color
      </TipItem>
      <SubContent className="min-w-40">
        <RadioGroup value={value} onValueChange={(c: TagColor) => onPick(c)}>
          {PALETTE.map((c) => (
            <RadioItem key={c} value={c}>
              <span className="size-3 rounded-full" style={{ background: colorVar(c) }} aria-hidden />
              {COLOR_NAMES[c]}
              {c === defaultColor && <span className="text-muted-foreground">(default)</span>}
            </RadioItem>
          ))}
        </RadioGroup>
      </SubContent>
    </Sub>
  );
}

const failed = (what: string) => (e: unknown) => toast.error(`Couldn't ${what}`, { description: String(e) });

/** Shift-F10 (fn-Shift-F10 on most Mac keyboards) or the Menu key. */
export const isMenuKey = (e: React.KeyboardEvent) => e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");

/**
 * Opens a right-click menu from the keyboard: Shift-F10 or the Menu key, on whatever has focus
 * (or on `on`: a list's active row, while the list itself has focus). The web view doesn't do
 * this by itself. Returns true if it handled the key. (VoiceOver's own VO-Shift-M works too.)
 */
export function openMenuFromKeyboard(e: React.KeyboardEvent, on?: HTMLElement | null): boolean {
  if (!isMenuKey(e)) return false;
  e.preventDefault();
  const el = on ?? (e.target as HTMLElement);
  const box = el.getBoundingClientRect();
  el.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: box.left + 12, clientY: box.top + box.height / 2 }),
  );
  return true;
}

/** True while Settings › Sidebar hides the Built-in group, so a move into it can say so. */
export function useBuiltinHidden(): boolean {
  return useSettings().settings?.sidebar.builtinTags === false;
}

/**
 * "Move to": the top level, or any of your tags that isn't this one, inside it, or its parent
 * already (tagActions.canNestIn). Greyed out on a built-in tag, with why (`state`).
 */
function MoveSub({ kit, tag, state }: { kit: Kit; tag: Tag; state: TagActionState }) {
  const { Sub, SubContent, Separator } = kit;
  const index = useTagIndex();
  const builtinHidden = useBuiltinHidden();
  const parent = parentOf(tag.name);
  const places = state.enabled ? index.byGroup.flatMap((g) => g.nodes).filter((n) => canNestIn(tag, n.tag)) : [];
  if (state.enabled && !parent && !places.length) return null;
  return (
    <Sub>
      <TipItem kit={kit} as="SubTrigger" tip={state.tip} disabled={!state.enabled}>
        <Icon name="drive_file_move" size={16} />
        {state.label}
      </TipItem>
      <SubContent className="max-h-[min(26rem,var(--available-height))] min-w-48 overflow-y-auto">
        {parent && (
          <>
            <TipItem kit={kit} tip={`Take it out of “${parent}”.`} onClick={() => moveTag(tag, null, { builtinHidden, follow: true })}>
              <Icon name="vertical_align_top" size={16} />
              Top level
            </TipItem>
            {places.length > 0 && <Separator />}
          </>
        )}
        {places.map((n) => (
          <TipItem
            kit={kit}
            key={n.tag.id}
            tip={`Put it inside “${n.tag.name}”.`}
            style={{ paddingLeft: 6 + n.depth * 14 }}
            onClick={() => moveTag(tag, n.tag, { builtinHidden, follow: true })}
          >
            <Icon name="label" size={16} filled style={{ color: colorVar(n.tag.color) }} />
            <span className="truncate">{n.label}</span>
          </TipItem>
        ))}
      </SubContent>
    </Sub>
  );
}

/**
 * The tag menu, for its right-click menu and its "…" menu. `set`: the fonts it covers (its own
 * and the tags' inside it, tagActions.facesByTag), which Turn on and Turn off work on. A
 * built-in tag shows the same items, with the ones that would change it greyed out (each
 * tooltip says why), plus "Make it my tag".
 */
/** Turning on until logout has the clock the font list's mark uses; turning on to stay, a switch. */
const modeIcon = (mode: ActivationMode) => (mode === "temporary" ? "timer" : "toggle_on");

export function TagMenuItems({ kit, tag, set }: { kit: Kit; tag: Tag; set: readonly Face[] }) {
  const { Separator, Group, Label } = kit;
  const index = useTagIndex();
  const builtinHidden = useBuiltinHidden();
  const { mode = "persistent", untilQuit = false } = useStateWording();
  const nested = (index.subtree.get(tag.id)?.size ?? 1) > 1;
  const top = index.topTag(tag.id) ?? tag;
  const edit = tagEditStates(tag, top, { nested });
  const turn = tagSwitchStates(tag.name, set, { mode, untilQuit, nested });
  const locked = !edit.rename.enabled;
  const wording = { mode, untilQuit };
  return (
    <>
      {locked && (
        <Group>
          <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Icon name="lock" size={14} />
            Built-in tag, read-only
          </Label>
        </Group>
      )}
      <ActionItem kit={kit} state={turn.turnOn} icon={modeIcon(mode)} onClick={() => void switchTag(tag, set, true, null, wording)} />
      <ActionItem kit={kit} state={turn.turnOnOther} icon={modeIcon(otherMode(mode))} onClick={() => void switchTag(tag, set, true, otherMode(mode), wording)} />
      <ActionItem kit={kit} state={turn.turnOff} icon="toggle_off" onClick={() => void switchTag(tag, set, false, null, wording)} />
      <Separator />
      {locked && (
        <>
          <ActionItem kit={kit} state={edit.makeMine} icon="lock_open" onClick={() => moveToGroup(tag, "mine", { builtinHidden, follow: true })} />
          <Separator />
        </>
      )}
      <ActionItem kit={kit} state={edit.rename} icon="edit" onClick={() => openTagDialog({ kind: "rename", tag })} />
      <ColorSub
        kit={kit}
        value={tag.color}
        tip={edit.color.tip}
        disabled={!edit.color.enabled}
        onPick={(c) => recolorTag(tag.id, c).catch(failed("change the color"))}
      />
      <ActionItem kit={kit} state={edit.newInside} icon="new_label" onClick={() => openTagDialog({ kind: "create", parent: tag })} />
      <MoveSub kit={kit} tag={tag} state={edit.moveTo} />
      <ActionItem kit={kit} state={edit.export} icon="ios_share" onClick={() => openTagDialog({ kind: "export", tag })} />
      <Separator />
      <ActionItem kit={kit} state={edit.delete} icon="delete" variant="destructive" onClick={() => openTagDialog({ kind: "delete", tag })} />
    </>
  );
}

/** The color items for one location: the palette, and a way back to the default. */
function LocationItems({
  location,
  color,
  defaultColor,
  onLocate,
}: {
  location: string;
  color: TagColor;
  defaultColor: TagColor;
  onLocate?: () => void;
}) {
  const { Item, Separator } = CONTEXT;
  // Picking the default goes back to following it (a parent folder, or Font Book), rather
  // than fixing that color in place.
  const pick = (c: TagColor) => setLocationColor(location, c === defaultColor ? null : c).catch(failed("change the color"));
  return (
    <>
      {onLocate && (
        <>
          <Item onClick={onLocate}>
            <Icon name="folder_open" size={16} />
            Locate…
          </Item>
          <Separator />
        </>
      )}
      <ColorSub kit={CONTEXT} value={color} defaultColor={defaultColor} onPick={pick} />
      {color !== defaultColor && (
        <>
          <Separator />
          <Item onClick={() => setLocationColor(location, null).catch(failed("reset the color"))}>
            <Icon name="restart_alt" size={16} />
            Use default color ({COLOR_NAMES[defaultColor]})
          </Item>
        </>
      )}
    </>
  );
}

/** A command in a source row's menu (Rescan, Show in Finder, Remove from Library…). */
export interface MenuAction {
  icon: string;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}

/**
 * Right-click a source (Font Book, a service, one of your folders), or press Shift-F10 on it, for
 * its commands and its color: `before` (Rescan or Stop, Show in Finder), Locate… for a folder
 * that moved, the color, then `after` (Remove from Library…). Wraps the row in a plain block, so
 * the row's own layout is untouched.
 */
export function LocationMenu({
  location,
  color,
  defaultColor,
  disabled,
  onLocate,
  before = [],
  after = [],
  children,
}: {
  location: string;
  color: TagColor;
  defaultColor: TagColor;
  /** No color for this row (nothing to color yet). */
  disabled?: boolean;
  /** The folder can't be found: offer "Locate…" to point it at where it moved. */
  onLocate?: () => void;
  before?: MenuAction[];
  after?: MenuAction[];
  children: React.ReactNode;
}) {
  if (disabled && !before.length && !after.length && !onLocate) return <>{children}</>;
  const { Item, Separator } = CONTEXT;
  const action = (a: MenuAction) => (
    <Item key={a.label} variant={a.destructive ? "destructive" : undefined} onClick={a.onClick}>
      <Icon name={a.icon} size={16} />
      {a.label}
    </Item>
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger className="block" onKeyDown={openMenuFromKeyboard}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        {before.map(action)}
        {before.length > 0 && (!disabled || onLocate) && <Separator />}
        {disabled ? (
          onLocate && (
            <Item onClick={onLocate}>
              <Icon name="folder_open" size={16} />
              Locate…
            </Item>
          )
        ) : (
          <LocationItems location={location} color={color} defaultColor={defaultColor} onLocate={onLocate} />
        )}
        {after.length > 0 && <Separator />}
        {after.map(action)}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * One right-click menu for many location rows (a subfolder picker can list thousands). Each row
 * names its location in a `data-location` attribute.
 */
export function LocationsMenu({ locations, children }: { locations: Locations; children: React.ReactNode }) {
  const [target, setTarget] = useState<string | null>(null);
  return (
    <ContextMenu onOpenChange={(open) => !open && setTarget(null)}>
      <ContextMenuTrigger
        className="block"
        onKeyDown={openMenuFromKeyboard}
        onContextMenuCapture={(e) => setTarget((e.target as HTMLElement).closest("[data-location]")?.getAttribute("data-location") ?? null)}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        {target ? (
          <LocationItems location={target} color={locations.colorOf(target)} defaultColor={locations.defaultOf(target)} />
        ) : (
          <ContextMenuItem disabled>Right-click a folder to change its color</ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
