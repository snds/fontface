import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface Props {
  /** How many faces are on, out of `total`. A single style passes 0/1 or 1/1. */
  active: number;
  total: number;
  label: string;
  /** A request for these fonts is queued or running: show progress and ignore clicks. */
  busy?: boolean;
  /** -1 keeps it out of the Tab order (a list row that isn't the active one). */
  tabIndex?: number;
  /** Tiles and Table: the small switch, with "n/total" only in its tooltip. */
  compact?: boolean;
  onChange: (next: boolean) => void;
}

/**
 * The on/off control for activation. When only some faces in a family are on, the switch
 * reads as off with an "n/total" count beside it, and switching it turns them all on.
 */
export function ActivationSwitch({ active, total, label, busy = false, tabIndex, compact = false, onChange }: Props) {
  const all = total > 0 && active === total;
  const partial = active > 0 && !all;
  return (
    // Rows are clickable (they select); keep switch clicks from also selecting.
    <span
      className="flex items-center gap-1.5"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      title={compact && partial ? `${active} of ${total} styles active` : undefined}
    >
      {busy && <Icon name="progress_activity" size={14} className="animate-spin text-muted-foreground" aria-hidden />}
      {partial && !busy && !compact && (
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums" title={`${active} of ${total} styles active`}>
          {active}/{total}
        </span>
      )}
      <Switch
        checked={all}
        disabled={busy}
        aria-busy={busy}
        onCheckedChange={(on) => onChange(on)}
        aria-label={label}
        tabIndex={tabIndex}
        size={compact ? "sm" : "default"}
        className={cn("data-checked:bg-active", partial && "data-unchecked:bg-active/40")}
      />
    </span>
  );
}

/** Shown instead of a switch for fonts in a macOS font folder: macOS always loads them.
 *  `compact` (Tiles, Table): the lock alone, named for screen readers. */
export function InstalledBadge({ compact = false }: { compact?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span onClick={(e) => e.stopPropagation()} />}>
        {compact ? (
          <span className="flex items-center text-muted-foreground">
            <Icon name="lock" size={14} />
            <span className="sr-only">Installed</span>
          </span>
        ) : (
          <Badge variant="secondary" className="gap-1">
            <Icon name="lock" size={12} />
            Installed
          </Badge>
        )}
      </TooltipTrigger>
      <TooltipContent>In a macOS font folder, so it's always on</TooltipContent>
    </Tooltip>
  );
}
