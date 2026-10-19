import type { FontDetail, PreviewInfo } from "@/api";
import { copyWords, stateDetails, stateWords, summarize } from "@/fontState";
import { WEIGHT_NAMES, type Face } from "@/library";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { characterSetLine, type CharactersState } from "@/components/CharacterGrid";
import { IS_MAC } from "@/components/TitleBar";
import { colorVar } from "@/tags/api";
import type { Locations } from "@/tags/locations";
import { formatBytes, SectionTitle } from "./parts";

export const REVEAL_LABEL = IS_MAC ? "Show in Finder" : "Show in Explorer";

interface Props {
  face: Face;
  /** Null while it's read (the rows from the list show meanwhile). */
  detail: FontDetail | null;
  characters: CharactersState;
  profile: PreviewInfo | undefined;
  locations: Locations;
  onReveal: (fontId: number) => void;
}

/** "12 October 2026", from a file time in seconds. */
const fileDate = (seconds: number) =>
  seconds > 0 ? new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : null;

/** The chosen style's names, numbers and files. */
export function InfoTab({ face, detail, characters, profile, locations, onReveal }: Props) {
  const font = face.primary;
  // The label is there only when a row of this face draws a sample of characters.
  const characterSet = characters.status === "ready" ? characterSetLine(characters.data, profile?.label) : profile?.label;
  const weight = detail?.weight ?? font.weight;
  // On or off, in words: why it's locked, on until logout, and so on.
  const state = summarize([face]);
  const words = stateWords(state);
  const status = stateDetails(state, true).join(" ") || `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
  // [label, value, monospace?]
  const rows: [string, string | null | undefined, boolean?][] = [
    ["On or off", status],
    ["Full name", font.fullName],
    ["PostScript", font.postscriptName, true],
    ["Version", detail?.version],
    ["Format", font.format],
    ["Weight", `${weight}${WEIGHT_NAMES[weight] ? ` · ${WEIGHT_NAMES[weight]}` : ""}`],
    ["Width", String(detail?.width ?? font.width)],
    ["Italic", font.italic ? "Yes" : "No"],
    ["Glyphs", detail?.glyphCount.toLocaleString()],
    ["Character set", characterSet],
    ["Monospaced", font.monospace ? "Yes" : "No"],
    ["Designer", detail?.designer],
    ["Foundry", detail?.manufacturer],
    ["File size", formatBytes(font.fileSize)],
    // When the file was last changed. (When it joined the library isn't recorded yet.)
    ["File date", fileDate(font.mtime)],
    ["Copyright", detail?.copyright],
    ["License", detail?.license],
    ["License URL", detail?.licenseUrl, true],
  ];
  return (
    <div className="flex max-w-3xl flex-col gap-8 px-6 pt-5 pb-12">
      <section aria-label="Details">
        <SectionTitle>Details</SectionTitle>
        <dl className="flex flex-col gap-1.5 text-sm">
          {rows
            .filter(([, v]) => v)
            .map(([k, v, mono]) => (
              <div key={k} className="grid grid-cols-[120px_1fr] gap-3">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className={cn("selectable max-h-40 overflow-y-auto break-words", mono && "font-mono text-xs leading-5")}>{v}</dd>
              </div>
            ))}
        </dl>
      </section>

      <section aria-label={face.copies.length > 1 ? "Copies" : "Location"}>
        <SectionTitle>{face.copies.length > 1 ? `${face.copies.length} copies of this font` : "Location"}</SectionTitle>
        <ul className="flex flex-col gap-3">
          {face.copies.map((c) => (
            <li key={c.id} className="flex items-start gap-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: colorVar(locations.colorOfCopy(c)) }} aria-hidden />
                  <span className="truncate">{locations.describeCopy(c)}</span>
                  {face.copies.length > 1 && (
                    <span className={cn("flex shrink-0 items-center gap-1", c.osActive ? "text-active" : "text-muted-foreground")}>
                      <Icon name={c.osActive ? "check_circle" : "radio_button_unchecked"} size={14} filled={c.osActive} />
                      {copyWords(c)}
                    </span>
                  )}
                </div>
                <div className="selectable font-mono text-[11px] break-all text-muted-foreground">
                  {c.path}
                  {c.faceIndex > 0 ? ` (face ${c.faceIndex})` : ""}
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={() => onReveal(c.id)} aria-label={face.copies.length > 1 ? `${REVEAL_LABEL}: ${c.path}` : undefined}>
                <Icon name="folder_open" size={16} />
                {REVEAL_LABEL}
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
