import type { FontDetail, PreviewInfo } from "@/api";
import { copyWords, stateDetails, stateWords, summarize } from "@/fontState";
import { WEIGHT_NAMES, type Face } from "@/library";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useStateWording } from "@/components/ActivationSwitch";
import { characterSetLine, type CharactersState } from "@/components/CharacterGrid";
import { IS_MAC } from "@/components/TitleBar";
import { colorVar } from "@/tags/api";
import type { Locations } from "@/tags/locations";
import { keepSeparate, resetChoices, useOpenFamilyGroups } from "@/families/store";
import { nameRef, runChange } from "@/families/feedback";
import { squash } from "@/familyGroups";
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
  // On or off, in words: why it's locked, on until logout (or until Fontface quits), and so on.
  const wording = useStateWording();
  const state = summarize([face]);
  const words = stateWords(state, wording);
  const status = stateDetails(state, true, wording).join(" ") || `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
  // [label, value, monospace?]
  const rows: [string, string | null | undefined, boolean?][] = [
    ["On or off", status],
    // The font's own names, when it's listed under another family or style.
    ["Its family name", face.family !== font.family ? font.family : font.legacyFamily],
    ["Its style name", face.style !== font.subfamily ? font.subfamily : null],
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
      <FamilyGroupNote face={face} />
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
                      {copyWords(c, wording)}
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

/**
 * How this style got its family, when it isn't simply its own name: grouped by name (with Keep
 * separate), or by your rule or choice (with a way back). Each change has Undo.
 */
function FamilyGroupNote({ face }: { face: Face }) {
  const openFamilyGroups = useOpenFamilyGroups();
  const raw = face.primary.family;
  const moved = face.family !== raw;
  if (face.groupedBy === "own") return null;
  let text: string;
  let action: { label: string; run: () => void } | null = null;
  if (face.groupedBy === "name") {
    text = `Grouped by name into ${face.family}, from “${raw}”.`;
    action = {
      label: `Keep “${raw}” separate`,
      run: () => void runChange(() => keepSeparate(`Kept “${raw}” separate`, [nameRef(raw)]), "Couldn't keep it separate"),
    };
  } else if (face.groupedBy === "rule") {
    text = moved ? `Merged into ${face.family} by you, from “${raw}”.` : `You chose to keep “${raw}” separate.`;
    action = {
      label: moved ? "Undo this merge" : "Allow grouping by name",
      run: () => void runChange(() => resetChoices(moved ? `Took “${raw}” out of ${face.family}` : `Allowed grouping “${raw}” by name`, [], [squash(raw)]), "Couldn't change it"),
    };
  } else {
    text = moved ? `Moved into ${face.family} by you, from “${raw}”.` : "You chose to keep this style under its own family name.";
    action = {
      label: moved ? "Use its own family name" : "Allow grouping by name",
      run: () => void runChange(() => resetChoices(moved ? `Took ${face.style} out of ${face.family}` : `Allowed grouping ${face.style} by name`, [face.key], []), "Couldn't change it"),
    };
  }
  return (
    <section aria-label="Family group" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5 text-sm">
      <Icon name="account_tree" size={16} className="text-muted-foreground" />
      <span className="min-w-0 flex-1">{text}</span>
      {action && (
        <Button variant="link" size="sm" className="h-auto p-0" onClick={action.run}>
          {action.label}
        </Button>
      )}
      <Button variant="link" size="sm" className="h-auto p-0" onClick={() => openFamilyGroups([face])}>
        Family groups…
      </Button>
    </section>
  );
}
