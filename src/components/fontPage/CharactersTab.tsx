import { useMemo, useState } from "react";
import type { CharacterBlock, FontSummary } from "@/api";
import type { VariationAt } from "@/axisField";
import { blockCount, openNewlyPicked, remember, startingBlocks, uniqueBlocks, type BlockInfo } from "@/charBlocks";
import { blockMemory, setBlockMemory, setClosedGroups, useBlockStore } from "@/charBlocksStore";
import { faceName, useFontFace } from "@/fontLoader";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { CharacterGrid, type CharactersState } from "@/components/CharacterGrid";
import { BlockSelect } from "./BlockSelect";

interface Props {
  font: FontSummary;
  characters: CharactersState;
  /** The Axes tab's values for each text size (optical size may follow it). */
  variation: VariationAt;
  query: string;
  onQuery: (q: string) => void;
}

const NO_BLOCKS: CharacterBlock[] = [];

/** Every real character of the chosen style, in the Unicode blocks picked, with a search. */
export function CharactersTab({ font, characters, variation, query, onQuery }: Props) {
  // The chosen style: its file loads ahead of others waiting.
  const state = useFontFace(font, true);
  const pageFace = faceName(font);
  const data = characters.status === "ready" ? characters.data : null;
  const blocks = useMemo(() => (data ? uniqueBlocks(data.blocks) : NO_BLOCKS), [data]);
  const infos = useMemo<BlockInfo[]>(() => blocks.map((b) => ({ name: b.name, count: blockCount(b) })), [blocks]);
  const { closed } = useBlockStore();

  // The blocks picked for this style. A style starts with what the app remembers (charBlocks.ts);
  // a choice here is remembered for the next.
  const [choice, setChoice] = useState(() => ({ infos, picked: startingBlocks(infos, blockMemory()) }));
  let picked = choice.picked;
  if (choice.infos !== infos) {
    picked = startingBlocks(infos, blockMemory());
    setChoice({ infos, picked });
  }
  const onPick = (next: string[], all: boolean) => {
    setChoice({ infos, picked: next });
    setBlockMemory(remember(blockMemory(), infos, next, all));
    setClosedGroups(openNewlyPicked(closed, picked, next));
  };

  const searching = query.trim() !== "";
  const drawable = state === "loading" || state === "ready";
  return (
    <div className="flex flex-col gap-3 px-6 pt-5 pb-12">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-80 max-w-full">
          <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Find a character or U+ code"
            aria-label="Find a character. Type it, or its code, such as U+00DF"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              // Esc clears the search first; once it's empty, Esc leaves the field, then goes back.
              if (e.key === "Escape" && query) {
                e.preventDefault();
                onQuery("");
              }
            }}
            className="pl-8"
          />
        </div>
        {/* A search looks in every block, so the picker rests while one shows its results. */}
        {infos.length > 1 && drawable && <BlockSelect blocks={infos} picked={picked} onPick={onPick} disabled={searching} />}
      </div>
      <CharacterGrid
        state={characters}
        fontFamily={`"${pageFace}"`}
        face={pageFace}
        variation={variation}
        fontState={state}
        query={query}
        blocks={blocks}
        picked={picked}
      />
    </div>
  );
}
