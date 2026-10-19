import type { FontSummary } from "@/api";
import { faceName, useFontFace } from "@/fontLoader";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { CharacterGrid, type CharactersState } from "@/components/CharacterGrid";

interface Props {
  font: FontSummary;
  characters: CharactersState;
  variation: string | undefined;
  query: string;
  onQuery: (q: string) => void;
}

/** Every real character of the chosen style, by Unicode block, with a search. */
export function CharactersTab({ font, characters, variation, query, onQuery }: Props) {
  // The chosen style: its file loads ahead of others waiting.
  const state = useFontFace(font, true);
  const pageFace = faceName(font);
  return (
    <div className="flex flex-col gap-3 px-6 pt-5 pb-12">
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
      <CharacterGrid
        state={characters}
        fontFamily={`"${pageFace}"`}
        face={pageFace}
        fontVariationSettings={variation}
        fontState={state}
        query={query}
      />
    </div>
  );
}
