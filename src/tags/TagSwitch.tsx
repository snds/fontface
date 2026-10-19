import { useId, useMemo, useRef } from "react";
import { useStateWording } from "@/components/ActivationSwitch";
import { IS_MAC } from "@/components/TitleBar";
import { Icon } from "@/components/ui/icon";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { switchScope } from "@/fontActions";
import { stateWords, summarize, switchLook } from "@/fontState";
import type { Face } from "@/library";
import { cn } from "@/lib/utils";
import { tagSwitchProgress, tagSwitchTip } from "@/tagActions";
import type { Tag } from "./api";
import { switchTag, useTagRun } from "./switching";

/**
 * The small switch on a tag's sidebar row: turns on (or off) every font in the tag and in the
 * tags inside it. It reads like a font's switch: on when they all are, a paler track when some
 * are, Option-click for the other activation mode. While nothing is on it waits out of sight
 * until the row is hovered or has focus (like the row's "…"), so the sidebar stays quiet; once
 * something is on it stays, so the state shows at a glance.
 *
 * `set`: the fonts it covers (tagActions.facesByTag). Fonts that are always on (installed in a
 * macOS font folder) show a lock instead. A tag with no fonts in the library keeps the space.
 */
export function TagSwitch({ tag, set }: { tag: Tag; set: readonly Face[] }) {
  const state = useMemo(() => summarize(set), [set]);
  const run = useTagRun(tag.id);
  const { mode = "persistent", untilQuit = false } = useStateWording();
  /** Option was held for the press that's changing the switch. */
  const alt = useRef(false);
  const descId = useId();
  if (!set.length) return <span className="w-6 shrink-0" aria-hidden />;
  const progress = run && tagSwitchProgress(tag.name, run.on, run.done, run.total);
  const tip = progress ? `${progress.title} ${progress.detail} done.` : tagSwitchTip(tag.name, state, { mode, untilQuit, mac: IS_MAC });
  if (state.lock) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="flex w-6 shrink-0 justify-center text-muted-foreground" data-no-drag="" />}>
          <Icon name="lock" size={14} />
          <span className="sr-only">Always on</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{tip}</TooltipContent>
      </Tooltip>
    );
  }
  const { checked, partial, dim } = switchLook(state);
  const shown = state.wanted > 0 || !!run;
  return (
    <span
      data-no-drag=""
      className={cn(
        "flex w-6 shrink-0 justify-center",
        !shown && "opacity-0 group-focus-within/item:opacity-100 group-hover/item:opacity-100",
      )}
      onPointerDownCapture={(e) => (alt.current = e.altKey)}
      onKeyDownCapture={(e) => (alt.current = e.altKey)}
      onClickCapture={(e) => {
        // A click from the keyboard (detail 0) keeps what its key press said.
        if (e.detail > 0) alt.current = e.altKey;
      }}
    >
      <Tooltip>
        <TooltipTrigger
          delay={600}
          render={
            <Switch
              size="sm"
              checked={checked}
              disabled={!!run}
              aria-busy={!!run}
              aria-label={`All fonts in “${tag.name}”`}
              aria-describedby={descId}
              className={cn("data-checked:bg-active", partial && "data-unchecked:bg-active/40 dark:data-unchecked:bg-active/40", dim && "data-checked:bg-active/45")}
              onCheckedChange={(on) => {
                void switchTag(tag, set, on, switchScope(on, alt.current, mode), { mode, untilQuit });
                alt.current = false;
              }}
            />
          }
        />
        <TooltipContent className="max-w-xs">{tip}</TooltipContent>
      </Tooltip>
      <span id={descId} hidden>
        {run ? "working" : stateWords(state, { untilQuit })}
      </span>
    </span>
  );
}
