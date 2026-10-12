import { useState } from "react";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { COLOR_NAMES, PALETTE, colorVar, type Tag, type TagColor } from "./api";
import { openTagDialog } from "./dialogs";
import type { Locations } from "./locations";
import { recolorTag, setLocationColor } from "./store";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The same menu items work in a right-click menu and in a "…" menu. */
interface Kit {
  Item: React.ComponentType<any>;
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
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  RadioGroup: DropdownMenuRadioGroup,
  RadioItem: DropdownMenuRadioItem,
};

export const CONTEXT: Kit = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem,
};

/** A "Color" submenu with the palette as radio items. */
function ColorSub({ kit, value, defaultColor, onPick }: { kit: Kit; value: TagColor; defaultColor?: TagColor; onPick: (c: TagColor) => void }) {
  const { Sub, SubTrigger, SubContent, RadioGroup, RadioItem } = kit;
  return (
    <Sub>
      <SubTrigger>
        <span className="size-3 rounded-full" style={{ background: colorVar(value) }} aria-hidden />
        Color
      </SubTrigger>
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

/**
 * Opens a right-click menu from the keyboard: Shift-F10 (fn-Shift-F10 on most Mac keyboards)
 * or the Menu key, on whatever has focus. The web view doesn't do this by itself. Returns true
 * if it handled the key. (VoiceOver's own VO-Shift-M works too.)
 */
export function openMenuFromKeyboard(e: React.KeyboardEvent): boolean {
  if (!(e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) return false;
  e.preventDefault();
  const el = e.target as HTMLElement;
  const box = el.getBoundingClientRect();
  el.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: box.left + 12, clientY: box.top + box.height / 2 }),
  );
  return true;
}

export function TagMenuItems({ kit, tag }: { kit: Kit; tag: Tag }) {
  const { Item, Separator } = kit;
  return (
    <>
      <Item onClick={() => openTagDialog({ kind: "rename", tag })}>
        <Icon name="edit" size={16} />
        Rename…
      </Item>
      <ColorSub kit={kit} value={tag.color} onPick={(c) => recolorTag(tag.id, c).catch(failed("change the color"))} />
      <Item onClick={() => openTagDialog({ kind: "create", parent: tag })}>
        <Icon name="new_label" size={16} />
        New tag inside…
      </Item>
      <Item onClick={() => openTagDialog({ kind: "export", tag })}>
        <Icon name="ios_share" size={16} />
        Export…
      </Item>
      <Separator />
      <Item variant="destructive" onClick={() => openTagDialog({ kind: "delete", tag })}>
        <Icon name="delete" size={16} />
        Delete…
      </Item>
    </>
  );
}

/** The color items for one location: the palette, and a way back to the default. */
function LocationItems({ location, color, defaultColor }: { location: string; color: TagColor; defaultColor: TagColor }) {
  const { Item, Separator } = CONTEXT;
  // Picking the default goes back to following it (a parent folder, or Font Book), rather
  // than fixing that color in place.
  const pick = (c: TagColor) => setLocationColor(location, c === defaultColor ? null : c).catch(failed("change the color"));
  return (
    <>
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

/**
 * Right-click a location (a folder, Font Book, a service) to pick its color. Wraps the row in
 * a plain block, so the row's own layout is untouched.
 */
export function LocationMenu({
  location,
  color,
  defaultColor,
  disabled,
  children,
}: {
  location: string;
  color: TagColor;
  defaultColor: TagColor;
  /** No color for this row: just show it. */
  disabled?: boolean;
  children: React.ReactNode;
}) {
  if (disabled) return <>{children}</>;
  return (
    <ContextMenu>
      <ContextMenuTrigger className="block" onKeyDown={openMenuFromKeyboard}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        <LocationItems location={location} color={color} defaultColor={defaultColor} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * One right-click menu for many location rows (a subfolder tree can have thousands). Each row
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
