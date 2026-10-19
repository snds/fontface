import { createContext, useContext } from "react";
import { LOCK_LABELS, MARK_ICONS, markOf, stateDetails, switchLook, type LockKind, type StateMark as Mark, type StateSummary, type StateWording } from "@/fontState";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// A font's on/off control and the marks that say more (see src/fontState.ts for the states).
// Every layout and the font page use `StateControl`; the marks have a tooltip, and what they
// say is also screen-reader text (on `srId`, which the item's description points at), so color
// is never the only sign.

/** How the state words put "on until logout" (App provides it, from settings). */
export const StateWordingContext = createContext<StateWording>({});
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
  onChange: (next: boolean) => void;
}

/**
 * The on/off switch. It's on when every style is on or set to turn on; with only some, it reads
 * as off with an "n/total" count of the styles that are on beside it (in Rows and on the font
 * page), and switching it turns them all on. Set to turn on but not on yet, it's on and paler.
 */
export function ActivationSwitch({ state, label, busy = false, tabIndex, compact = false, describedBy, onChange }: SwitchProps) {
  const { checked, partial, dim } = switchLook(state);
  const counted = `${state.on} of ${state.total} styles on${state.waiting ? `, ${state.waiting} more set to turn on` : ""}`;
  return (
    // Rows are clickable (they select); keep switch clicks from also selecting.
    <span className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {busy && <Icon name="progress_activity" size={14} className="animate-spin text-muted-foreground" aria-hidden />}
      {partial && !busy && !compact && (
        // The same count the item's name says ("3 of 12 on"); styles set to turn on have their own mark.
        <MarkTip text={`${counted}.`}>
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {state.on}/{state.total}
          </span>
        </MarkTip>
      )}
      <Switch
        checked={checked}
        disabled={busy}
        aria-busy={busy}
        onCheckedChange={(on) => onChange(on)}
        aria-label={label}
        aria-describedby={describedBy}
        tabIndex={tabIndex}
        size={compact ? "sm" : "default"}
        className={cn("data-checked:bg-active", partial && "data-unchecked:bg-active/40", dim && "data-checked:bg-active/45")}
      />
    </span>
  );
}

/** A tooltip over a mark. The trigger keeps clicks from reaching the row (they'd select it). */
function MarkTip({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0 items-center" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{text}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Shown instead of a switch for fonts in one of the OS's font folders: they're always on. It
 * says why: "Part of macOS" or "Installed". `compact` (Tiles, Table): the lock alone, named for
 * screen readers.
 */
export function LockBadge({ kind, details, compact = false }: { kind: LockKind; details: string[]; compact?: boolean }) {
  return (
    <MarkTip text={details.join(" ")}>
      {compact ? (
        <span className="flex items-center text-muted-foreground">
          <Icon name="lock" size={14} />
          <span className="sr-only">{LOCK_LABELS[kind]}</span>
        </span>
      ) : (
        <Badge variant="secondary" className="gap-1">
          <Icon name="lock" size={12} />
          {LOCK_LABELS[kind]}
        </Badge>
      )}
    </MarkTip>
  );
}

/** The small mark beside a switch: on until logout, set to turn on but not on, turned on by
 *  another app, or (in Tiles and Table) partly on. */
export function StateMark({ mark, details }: { mark: Mark; details: string[] }) {
  return (
    <MarkTip text={details.join(" ")}>
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
  onSwitch: (on: boolean) => void;
}

/** A font's state wherever it shows: the lock (with why), or the switch with its mark. While a
 *  request runs, its spinner takes the mark's place, so the Table's on/off column always fits. */
export function StateControl({ state, single, label, busy, tabIndex, compact, srId, onSwitch }: ControlProps) {
  const details = stateDetails(state, single, useStateWording());
  const mark = busy ? null : markOf(state, { compact });
  const said = details.length > 0 && (
    <span id={srId} className="sr-only">
      {details.join(" ")}
    </span>
  );
  if (state.lock) {
    return (
      <>
        <LockBadge kind={state.lock} details={details} compact={compact} />
        {said}
      </>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      {mark && <StateMark mark={mark} details={details} />}
      <ActivationSwitch
        state={state}
        label={label}
        busy={busy}
        tabIndex={tabIndex}
        compact={compact}
        describedBy={details.length && srId ? srId : undefined}
        onChange={onSwitch}
      />
      {said}
    </span>
  );
}
