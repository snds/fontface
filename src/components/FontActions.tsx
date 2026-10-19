import { createContext, Fragment, useContext } from "react";
import { ACTION_ORDER, shortcutText, type ActionStates, type FontActionId, type FontTarget } from "@/fontActions";
import { ContextMenuShortcut } from "@/components/ui/context-menu";
import { DropdownMenuShortcut } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { SyncFontMenuItems } from "@/sync/SyncFontMenu";
import { FontMenuLabel, TagSubmenus } from "@/tags/FontMenu";
import { CONTEXT, DROPDOWN } from "@/tags/menus";
import type { TagIndex } from "@/tags/model";
import { IS_MAC } from "./TitleBar";

/**
 * The font actions (src/fontActions.ts) as menu items: the list's right-click menu, the font
 * page's right-click and More menus. App provides what they do (`FontActionsContext`), and the
 * macOS Font menu runs the same actions.
 */
export interface FontActionsApi {
  /** Which actions are available for a target, and their names. */
  states: (target: FontTarget | null) => ActionStates;
  /** Runs an action. `returnTo`: the element (by id) focus goes back to after a page it opens
   *  (else the list row it came from, or the page's heading). */
  run: (action: FontActionId, target: FontTarget, options?: { returnTo?: string }) => void;
}

export const FontActionsContext = createContext<FontActionsApi | null>(null);
export const useFontActions = () => useContext(FontActionsContext);

const ICONS: Record<FontActionId, string> = {
  open: "open_in_full",
  info: "info",
  turnOn: "toggle_on",
  turnOnOther: "timer",
  turnOff: "toggle_off",
  tags: "sell",
  compare: "compare",
  pair: "join",
  familyGroup: "account_tree",
  reveal: "folder_open",
  copyPostScript: "content_copy",
  remove: "playlist_remove",
};

interface Props {
  /** A right-click menu, or a "…" menu (the font page's More). */
  kind: "context" | "dropdown";
  target: FontTarget;
  /** The tag index, for the right-click menu's Add to tag and Remove from tag. */
  index?: TagIndex;
  /** Only these actions (the More menu leaves out what its page shows already). */
  only?: readonly FontActionId[];
  /** See FontActionsApi.run. */
  returnTo?: string;
}

/**
 * One font action set, in one order, wherever a font's menu is: Open, Show Info; Turn On, Turn On the other
 * way, Turn Off (the saved activation mode's Turn On first); Tags… (and, in a right-click menu,
 * Add to tag and Remove from tag); Compare, Pair, Family Group…; Show in Finder, Copy PostScript
 * Name; Remove from Library…. Ones that don't apply are shown dimmed, so the menu keeps its shape.
 */
export function FontActionItems({ kind, target, index, only, returnTo }: Props) {
  const api = useFontActions();
  if (!api) return null;
  const kit = kind === "context" ? CONTEXT : DROPDOWN;
  const Shortcut = kind === "context" ? ContextMenuShortcut : DropdownMenuShortcut;
  const states = api.states(target);
  const shown = ACTION_ORDER.filter((a) => !only || only.includes(a.id));
  return (
    <>
      {kind === "context" && <FontMenuLabel faces={target.faces} />}
      {shown.map(({ id, gap }, i) => {
        const state = states[id];
        const keys = shortcutText(id, IS_MAC);
        return (
          <Fragment key={id}>
            {gap && i > 0 && <kit.Separator />}
            <kit.Item disabled={!state.enabled} variant={id === "remove" ? "destructive" : undefined} onClick={() => api.run(id, target, { returnTo })}>
              <Icon name={ICONS[id]} size={16} />
              {state.label}
              {keys && <Shortcut>{keys}</Shortcut>}
            </kit.Item>
            {id === "tags" && kind === "context" && index && target.faces.length > 0 && <TagSubmenus faces={target.faces} index={index} />}
          </Fragment>
        );
      })}
      {kind === "context" && <SyncFontMenuItems faces={target.faces} />}
    </>
  );
}
