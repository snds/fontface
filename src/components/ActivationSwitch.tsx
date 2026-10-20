import { createContext, useContext, useRef } from "react";
import type { ActivationMode } from "@/api";
import { fontShortcut, markName, SWITCH_TIP, switchScope } from "@/fontActions";
import { LOCK_LABELS, MARK_ICONS, markOf, stateDetails, switchLook, type LockKind, type StateMark as Mark, type StateSummary, type StateWording } from "@/fontState";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Tip, type TipHandle } from "./Tip";
import { IS_MAC } from "./TitleBar";

// A font's on/off control and the marks that say more (see src/fontState.ts for the states).
// Every layout and the font page use `StateControl`. The switch and the icon-only marks have
// their name as a tooltip; what the marks mean in full is screen-reader text (on `srId`, which
// the item's description points at), so color is never the only sign.

/** How the state words put "on until logout", and the saved activation mode a switch turns
 *  fonts on with (Option-click uses the other). App provides it, from settings. */
export interface SwitchWording extends StateWording {
  mode?: ActivationMode;
}
export const StateWordingContext = createContext<SwitchWording>({});
export const useStateWording = () => useContext(StateWordingContext);


interface SwitchProps {
  /** The item's states, counted (`summarize`). */
  state: StateSummary;
  label: string;
  /** A request for these fonts is queued or running: show progress and ignore clicks. */
  busy?: boolean;
  /** -1 keeps it out of the Tab order (a list row that isn't the active one). */
  tabIndex?: number;
  /** Tiles and Table: the small switch, with no "n/total" (StateControl shows a mark instead). */
  compact?: boolean;
  /** The text that says more about the state, as the switch's description. */
  describedBy?: string;
  /** A list's shared tooltip (createTipHandle, TipHost), so a row's switch doesn't mount one of
   *  its own. Elsewhere, leave it out. */
  tipHandle?: TipHandle;
  /** `scope`: how to turn fonts on, when it isn't the saved activation mode (Option-click). */
  onChange: (next: boolean, scope: ActivationMode | null) => void;
}

/**
 * The on/off switch. It's on when every style is on or set to turn on; with only some, it reads
 * as off with an "n/total" count of the styles that are on beside it (in Rows and on the font
 * page), and switching it turns them all on. Set to turn on but not on yet, it's on and paler.
 * Its tooltip is its name ("Activate"), as it has no visible one.
 *
 * Option-click (Alt-click on Windows) turns fonts on the other way from the saved activation
 * mode: until logout, or until you turn them off. (From the keyboard, the Font menu and
 * right-click menu have both ways.)
 */
export function ActivationSwitch({ state, label, busy = false, tabIndex, compact = false, describedBy, tipHandle, onChange }: SwitchProps) {
  const { checked, partial, dim } = switchLook(state);
  const { mode = "persistent" } = useStateWording();
  /** Option was held for the press that's changing the switch. */
  const alt = useRef(false);
  return (
    // Rows are clickable (they select); keep switch clicks from also selecting. The capture
    // handlers note Option before the switch acts on the press.
    <span
      className="flex items-center gap-1.5"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDownCapture={(e) => (alt.current = e.altKey)}
      onKeyDownCapture={(e) => {
        alt.current = e.altKey;
        // Cmd+Return, Option-Cmd+Return and Shift-Cmd+Return are the Font menu's Turn On and Turn
        // Off (App runs them on the selection or the page). The switch would also take the
        // Return as a press and flip itself first; a prevented key press doesn't press it.
        if (fontShortcut(e, IS_MAC)) e.preventDefault();
      }}
      onClickCapture={(e) => {
        // A click from the keyboard (detail 0) keeps what its key press said.
        if (e.detail > 0) alt.current = e.altKey;
      }}
    >
      {busy && <Icon name="progress_activity" size={14} className="animate-spin text-muted-foreground" aria-hidden />}
      {partial && !busy && !compact && (
        // The same count the item's name says ("3 of 12 on"); styles set to turn on have their own mark.
        <MarkTip text={markName("partial", state)} handle={tipHandle}>
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {state.on}/{state.total}
          </span>
        </MarkTip>
      )}
      {/* Its name starts the same ("Activate Inter"). While busy it's greyed out with a spinner
          beside it, but keeps focus. */}
      <Tip tip={SWITCH_TIP} handle={tipHandle}>
        <Switch
          checked={checked}
          disabled={busy}
          focusableWhenDisabled
          aria-busy={busy}
          onCheckedChange={(on) => {
            onChange(on, switchScope(on, alt.current, mode));
            alt.current = false;
          }}
          aria-label={label}
          aria-describedby={describedBy}
          // Only when given: Base UI's props take an explicit undefined as "no tabindex", which
          // would leave the font page's switches out of the Tab order.
          {...(tabIndex !== undefined && { tabIndex })}
          size={compact ? "sm" : "default"}
          className={cn("data-checked:bg-active", partial && "data-unchecked:bg-active/40", dim && "data-checked:bg-active/45")}
        />
      </Tip>
    </span>
  );
}

/** A mark's name as a tooltip over it. The trigger keeps clicks from reaching the row (they'd
 *  select it). What the mark means is already screen-reader text (the item's and the switch's
 *  description), so the tooltip adds none. `handle`: a list's shared tooltip (see SwitchProps). */
function MarkTip({ text, handle, children }: { text: string; handle?: TipHandle; children: React.ReactNode }) {
  return (
    <Tip tip={text} handle={handle}>
      <span className="inline-flex shrink-0 items-center" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        {children}
      </span>
    </Tip>
  );
}

/**
 * Shown instead of a switch for fonts in one of the OS's font folders: they're always on. It
 * says why: "System font" or "Installed". `compact` (Tiles, Table): the lock alone, named for
 * screen readers, with its name as a tooltip.
 */
export function LockBadge({ kind, compact = false, handle }: { kind: LockKind; compact?: boolean; handle?: TipHandle }) {
  if (!compact) {
    return (
      <Badge variant="secondary" className="gap-1">
        <Icon name="lock" size={12} />
        {LOCK_LABELS[kind]}
      </Badge>
    );
  }
  return (
    <MarkTip text={LOCK_LABELS[kind]} handle={handle}>
      <span className="flex items-center text-muted-foreground">
        <Icon name="lock" size={14} />
        <span className="sr-only">{LOCK_LABELS[kind]}</span>
      </span>
    </MarkTip>
  );
}

/** The small mark beside a switch: on until logout, set to turn on but not on, turned on by
 *  another app, or (in Tiles and Table) partly on. Its tooltip is its name ("On until logout"). */
export function StateMark({ mark, name, handle }: { mark: Mark; name: string; handle?: TipHandle }) {
  return (
    <MarkTip text={name} handle={handle}>
      <Icon name={MARK_ICONS[mark]} size={14} className={mark === "waiting" ? "text-destructive/80" : "text-muted-foreground"} aria-hidden />
    </MarkTip>
  );
}

interface ControlProps {
  state: StateSummary;
  /** One style (else a family, whose details count its styles). */
  single: boolean;
  /** The switch's name: "Activate Inter". */
  label: string;
  busy?: boolean;
  tabIndex?: number;
  compact?: boolean;
  /** Id for the screen-reader text that says more (the item's description points at it). */
  srId?: string;
  /** In a virtualized list: the list's shared tooltip for the switch (see SwitchProps). */
  tipHandle?: TipHandle;
  /** `scope`: the other activation mode, for an Option-click that turns fonts on; else null. */
  onSwitch: (on: boolean, scope: ActivationMode | null) => void;
}

/** A font's state wherever it shows: the lock (with why), or the switch with its mark. While a
 *  request runs, its spinner takes the mark's place, so the Table's on/off column always fits. */
export function StateControl({ state, single, label, busy, tabIndex, compact, srId, tipHandle, onSwitch }: ControlProps) {
  const wording = useStateWording();
  const details = stateDetails(state, single, wording);
  // The item's description (srId) leaves out the "n of N on" count its name already says; the
  // switch's own description keeps it, since the switch alone doesn't say how many.
  const forItem = stateDetails(state, single, wording, { count: false });
  const switchSrId = srId ? `${srId}-switch` : undefined;
  const said = (
    <>
      {forItem.length > 0 && (
        <span id={srId} className="sr-only">
          {forItem.join(" ")}
        </span>
      )}
      {details.length > 0 && switchSrId && (
        <span id={switchSrId} className="sr-only">
          {details.join(" ")}
        </span>
      )}
    </>
  );
  const mark = busy ? null : markOf(state, { compact });
  if (state.lock) {
    return (
      <>
        <LockBadge kind={state.lock} compact={compact} handle={tipHandle} />
        {said}
      </>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      {mark && <StateMark mark={mark} name={markName(mark, state, wording.untilQuit)} handle={tipHandle} />}
      <ActivationSwitch
        state={state}
        label={label}
        busy={busy}
        tabIndex={tabIndex}
        compact={compact}
        describedBy={details.length && switchSrId ? switchSrId : undefined}
        tipHandle={tipHandle}
        onChange={onSwitch}
      />
      {said}
    </span>
  );
}
