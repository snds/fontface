import { toast } from "sonner";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { useStateWording } from "@/components/ActivationSwitch";
import { CONTEXT, type Kit } from "@/components/Tip";
import type { ActivationMode } from "@/api";
import { otherMode } from "@/fontActions";
import type { Face } from "@/library";
import { useSettings } from "@/settings/useSettings";
import { canNestIn, tagEditStates, tagSwitchStates, type TagActionState } from "@/tagActions";
import { COLOR_NAMES, PALETTE, colorVar, type Tag, type TagColor } from "./api";
import { openTagDialog } from "./dialogs";
import { moveTag, moveToGroup } from "./drag";
import { parentOf, useTagIndex } from "./model";
import { recolorTag, setLocationColor } from "./store";
import { switchTag } from "./switching";

/*
 * Menu items show their words, so none of them has a tooltip (components/Tip.tsx). A greyed-out
 * item doesn't say why there either: a built-in tag's menu starts with "Built-in tag, read-only".
 */

/** A menu item for one of a tag's actions (tagActions.ts says if it can run, and its words). */
function ActionItem({ kit, state, icon, onClick, variant }: { kit: Kit; state: TagActionState; icon: string; onClick: (e: React.MouseEvent) => void; variant?: "destructive" }) {
  const { Item } = kit;
  return (
    <Item disabled={!state.enabled} variant={variant} onClick={onClick}>
      <Icon name={icon} size={16} />
      {state.label}
    </Item>
  );
}

/** A "Color" submenu with the palette as radio items. */
function ColorSub({
  kit,
  value,
  defaultColor,
  onPick,
  disabled,
}: {
  kit: Kit;
  value: TagColor;
  defaultColor?: TagColor;
  onPick: (c: TagColor) => void;
  disabled?: boolean;
}) {
  const { Sub, SubTrigger, SubContent, RadioGroup, RadioItem } = kit;
  return (
    <Sub>
      <SubTrigger disabled={disabled}>
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
 * already (tagActions.canNestIn). Greyed out on a built-in tag (`state`).
 */
function MoveSub({ kit, tag, state }: { kit: Kit; tag: Tag; state: TagActionState }) {
  const { Item, Sub, SubTrigger, SubContent, Separator } = kit;
  const index = useTagIndex();
  const builtinHidden = useBuiltinHidden();
  const parent = parentOf(tag.name);
  const places = state.enabled ? index.byGroup.flatMap((g) => g.nodes).filter((n) => canNestIn(tag, n.tag)) : [];
  if (state.enabled && !parent && !places.length) return null;
  return (
    <Sub>
      <SubTrigger disabled={!state.enabled}>
        <Icon name="drive_file_move" size={16} />
        {state.label}
      </SubTrigger>
      <SubContent className="max-h-[min(26rem,var(--available-height))] min-w-48 overflow-y-auto">
        {parent && (
          <>
            <Item onClick={() => moveTag(tag, null, { builtinHidden, follow: true })}>
              <Icon name="vertical_align_top" size={16} />
              Top level
            </Item>
            {places.length > 0 && <Separator />}
          </>
        )}
        {places.map((n) => (
          <Item key={n.tag.id} style={{ paddingLeft: 6 + n.depth * 14 }} onClick={() => moveTag(tag, n.tag, { builtinHidden, follow: true })}>
            <Icon name="label" size={16} filled style={{ color: colorVar(n.tag.color) }} />
            <span className="truncate">{n.label}</span>
          </Item>
        ))}
      </SubContent>
    </Sub>
  );
}

/**
 * The tag menu, for its right-click menu and its "…" menu. `set`: the fonts it covers (its own
 * and the tags' inside it, tagActions.facesByTag), which Turn on and Turn off work on. A
 * built-in tag shows the same items, with the ones that would change it greyed out, under
 * "Built-in tag, read-only", plus "Make it my tag".
 */
/** Turning on until logout has the clock the font list's mark uses; turning on to stay, a switch. */
const modeIcon = (mode: ActivationMode) => (mode === "temporary" ? "timer" : "toggle_on");

export function TagMenuItems({ kit, tag, set }: { kit: Kit; tag: Tag; set: readonly Face[] }) {
  const { Separator, Group, Label } = kit;
  const index = useTagIndex();
  const builtinHidden = useBuiltinHidden();
  const { mode = "persistent", untilQuit = false } = useStateWording();
  const top = index.topTag(tag.id) ?? tag;
  const edit = tagEditStates(tag, top);
  const turn = tagSwitchStates(set, { mode, untilQuit });
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
      <ColorSub kit={kit} value={tag.color} disabled={!edit.color.enabled} onPick={(c) => recolorTag(tag.id, c).catch(failed("change the color"))} />
      <ActionItem kit={kit} state={edit.newInside} icon="new_label" onClick={() => openTagDialog({ kind: "create", parent: tag })} />
      <MoveSub kit={kit} tag={tag} state={edit.moveTo} />
      <ActionItem kit={kit} state={edit.export} icon="ios_share" onClick={() => openTagDialog({ kind: "export", tag })} />
      <Separator />
      <ActionItem kit={kit} state={edit.delete} icon="delete" variant="destructive" onClick={() => openTagDialog({ kind: "delete", tag })} />
    </>
  );
}

/** "Locate…", for a folder that can't be found. */
function LocateItem({ onLocate }: { onLocate: () => void }) {
  const { Item } = CONTEXT;
  return (
    <Item onClick={onLocate}>
      <Icon name="folder_open" size={16} />
      Locate…
    </Item>
  );
}

/** The color items for one location: the palette (the color of the dots that mark where each font
 *  in a list lives; its sidebar icon is an outline in the text color), and a way back to the
 *  default. */
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
  // Picking the default goes back to following it, rather than fixing that color in place.
  const pick = (c: TagColor) => setLocationColor(location, c === defaultColor ? null : c).catch(failed("change the color"));
  return (
    <>
      {onLocate && (
        <>
          <LocateItem onLocate={onLocate} />
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
          onLocate && <LocateItem onLocate={onLocate} />
        ) : (
          <LocationItems location={location} color={color} defaultColor={defaultColor} onLocate={onLocate} />
        )}
        {after.length > 0 && <Separator />}
        {after.map(action)}
      </ContextMenuContent>
    </ContextMenu>
  );
}
