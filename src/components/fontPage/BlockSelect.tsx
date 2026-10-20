import { useRef } from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { allBlocks, inBlockOrder, isAll, moreText, pickerLabel, pickerName, type BlockInfo } from "@/charBlocks";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Select, SelectContent, SelectSeparator } from "@/components/ui/select";
import { Tip } from "@/components/Tip";
import { cn } from "@/lib/utils";

/** "All blocks" in the list: never a block's name. */
const ALL = "\u0000all";

/**
 * The Characters tab's Unicode block picker: a dropdown where any number of blocks can be picked
 * (charBlocks.ts has the rules). Its button shows the alphabetically first block picked and a
 * round "+N" for the others, and an × beside it clears them. Keyboard, as for every select:
 * Space, Enter or Down opens it; arrows move; Space or Enter picks or unpicks; typing a name
 * jumps to it; Esc closes.
 */
export function BlockSelect({
  blocks,
  picked,
  onPick,
  disabled = false,
}: {
  /** The font's blocks, in Unicode order. */
  blocks: BlockInfo[];
  /** The blocks picked, in Unicode order. */
  picked: string[];
  /** A new choice; `all`: it was "All blocks". */
  onPick: (picked: string[], all: boolean) => void;
  /** While a search shows its results, which come from every block. */
  disabled?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const everything = isAll(picked, blocks);
  // "All blocks" is ticked while every block is.
  const value = everything ? [ALL, ...picked] : picked;
  const label = pickerLabel(picked);
  const total = blocks.reduce((n, b) => n + b.count, 0);

  const onValueChange = (next: string[], details: SelectPrimitive.Root.ChangeEventDetails) => {
    // Only a press on a line is a choice. Select also trims its value by itself when the list
    // changes (another style's blocks), from the list before: what the next style shows is
    // charBlocks.ts's to say.
    if (details.reason !== "item-press") return;
    const all = next.includes(ALL);
    if (all && !everything) onPick(allBlocks(blocks), true);
    else if (!all && everything) onPick([], false);
    else onPick(inBlockOrder(next, blocks), false);
  };

  return (
    <div
      ref={box}
      className={cn(
        "flex h-8 w-fit max-w-72 min-w-48 items-center rounded-lg border border-input transition-colors dark:bg-input/30",
        "has-[[data-blocks-trigger]:focus-visible]:border-ring has-[[data-blocks-trigger]:focus-visible]:ring-3 has-[[data-blocks-trigger]:focus-visible]:ring-ring/50",
        disabled && "opacity-50",
      )}
    >
      <Select multiple value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectPrimitive.Trigger
          ref={trigger}
          data-blocks-trigger
          aria-label={pickerName(picked, blocks.length)}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg py-1 pr-1.5 pl-2.5 text-left text-sm whitespace-nowrap outline-none select-none enabled:hover:bg-muted/60 disabled:cursor-not-allowed data-popup-open:bg-muted/60 dark:enabled:hover:bg-input/50"
        >
          {label ? (
            <>
              <span className="shrink-0 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Blocks</span>
              <span className="min-w-0 truncate">{label.first}</span>
              {label.more > 0 && (
                <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground tabular-nums">
                  {moreText(label.more)}
                </span>
              )}
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">Unicode blocks</span>
              <Icon name="unfold_more" size={16} className="pointer-events-none shrink-0 text-muted-foreground" />
            </>
          )}
        </SelectPrimitive.Trigger>
        <SelectContent anchor={box} className="max-h-80 min-w-64">
          <BlockItem value={ALL} name="All blocks" count={total} />
          <SelectSeparator />
          {blocks.map((b) => (
            <BlockItem key={b.name} value={b.name} name={b.name} count={b.count} />
          ))}
        </SelectContent>
      </Select>
      {label && (
        <Tip tip="Clear blocks">
          <Button
            variant="ghost"
            size="icon-xs"
            className="mr-1 text-muted-foreground"
            aria-label="Clear blocks"
            disabled={disabled}
            onClick={() => {
              onPick([], false);
              // The × goes with the blocks: focus moves to the picker beside it.
              trigger.current?.focus();
            }}
          >
            <Icon name="close" size={14} />
          </Button>
        </Tip>
      )}
    </div>
  );
}

/** One line of the list: a tick box, the block's name, and how many characters it has. */
function BlockItem({ value, name, count }: { value: string; name: string; count: number }) {
  const n = count.toLocaleString();
  return (
    <SelectPrimitive.Item
      value={value}
      // Typing jumps by the name alone.
      label={name}
      aria-label={`${name}, ${n} ${count === 1 ? "character" : "characters"}`}
      className="group/item flex w-full cursor-default items-center gap-2 rounded-md py-1 pr-2 pl-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
    >
      <span
        aria-hidden
        className="flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input group-data-[selected]/item:border-primary group-data-[selected]/item:bg-primary group-data-[selected]/item:text-primary-foreground dark:bg-input/30 dark:group-data-[selected]/item:bg-primary"
      >
        <SelectPrimitive.ItemIndicator render={<span className="flex" />}>
          <Icon name="check" size={13} weight={600} />
        </SelectPrimitive.ItemIndicator>
      </span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span aria-hidden className="shrink-0 pl-3 font-mono text-xs text-muted-foreground tabular-nums">
        {n}
      </span>
    </SelectPrimitive.Item>
  );
}
