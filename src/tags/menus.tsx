import { toast } from "sonner";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { useStateWording } from "@/components/ActivationSwitch";
import { CONTEXT, TipItem, type Kit } from "@/components/Tip";
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
 *  `disabled`, why it's greyed out); `pickTip`: each color's. */
function ColorSub({
  kit,
  value,
  defaultColor,
  onPick,
  tip,
  pickTip,
  disabled,
}: {
  kit: Kit;
  value: TagColor;
  defaultColor?: TagColor;
  onPick: (c: TagColor) => void;
  tip: string;
  pickTip: (c: TagColor) => string;
  disabled?: boolean;
}) {
  const { Sub, SubContent, RadioGroup } = kit;
  return (
    <Sub>
      <TipItem kit={kit} as="SubTrigger" tip={tip} disabled={disabled}>
        <span className="size-3 rounded-full" style={{ background: colorVar(value) }} aria-hidden />
        Color
      </TipItem>
      <SubContent className="min-w-40">
        <RadioGroup value={value} onValueChange={(c: TagColor) => onPick(c)}>
          {PALETTE.map((c) => (
            <TipItem kit={kit} as="RadioItem" key={c} value={c} tip={pickTip(c)}>
              <span className="size-3 rounded-full" style={{ background: colorVar(c) }} aria-hidden />
              {COLOR_NAMES[c]}
              {c === defaultColor && <span className="text-muted-foreground">(default)</span>}
            </TipItem>
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
            <TipItem kit={kit} tip={`Takes it out of “${parent}”, to the top level`} onClick={() => moveTag(tag, null, { builtinHidden, follow: true })}>
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
            tip={`Puts it inside “${n.tag.name}”`}
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
        pickTip={(c) => (c === tag.color ? `“${tag.name}” is ${COLOR_NAMES[c]} now` : `Changes “${tag.name}” to ${COLOR_NAMES[c]}`)}
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

/** What a source's color is for: the dots that mark where each font in a list lives. (Its sidebar
 *  icon is an outline in the text color.) */
const LOCATION_COLOR_TIP = "Changes the color of the dots that mark its fonts in lists";

/** "Locate…", for a folder that can't be found. */
function LocateItem({ onLocate }: { onLocate: () => void }) {
  return (
    <TipItem kit={CONTEXT} tip="Points Fontface at where the folder moved, then rescans it" onClick={onLocate}>
      <Icon name="folder_open" size={16} />
      Locate…
    </TipItem>
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
  const { Separator } = CONTEXT;
  // Picking the default goes back to following it, rather than fixing that color in place.
  const pick = (c: TagColor) => setLocationColor(location, c === defaultColor ? null : c).catch(failed("change the color"));
  const pickTip = (c: TagColor) =>
    c === color ? `Its dots are ${COLOR_NAMES[c]} now` : c === defaultColor ? `Goes back to its default color, ${COLOR_NAMES[c]}` : `Changes its dots to ${COLOR_NAMES[c]}`;
  return (
    <>
      {onLocate && (
        <>
          <LocateItem onLocate={onLocate} />
          <Separator />
        </>
      )}
      <ColorSub kit={CONTEXT} value={color} defaultColor={defaultColor} onPick={pick} tip={LOCATION_COLOR_TIP} pickTip={pickTip} />
      {color !== defaultColor && (
        <>
          <Separator />
          <TipItem kit={CONTEXT} tip={`Goes back to its default color, ${COLOR_NAMES[defaultColor]}`} onClick={() => setLocationColor(location, null).catch(failed("reset the color"))}>
            <Icon name="restart_alt" size={16} />
            Use default color ({COLOR_NAMES[defaultColor]})
          </TipItem>
        </>
      )}
    </>
  );
}

/** A command in a source row's menu (Rescan, Show in Finder, Remove from Library…). */
export interface MenuAction {
  icon: string;
  label: string;
  /** Its tooltip: what it does. */
  tip: string;
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
  const { Separator } = CONTEXT;
  const action = (a: MenuAction) => (
    <TipItem kit={CONTEXT} key={a.label} tip={a.tip} variant={a.destructive ? "destructive" : undefined} onClick={a.onClick}>
      <Icon name={a.icon} size={16} />
      {a.label}
    </TipItem>
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
