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
import { keepSeparate, resetChoices, useFamilyChoices, useOpenFamilyGroups } from "@/families/store";
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
    ["Its family name", face.family !== font.family ? font.family : null],
    ["Its style name", face.style !== font.subfamily ? font.subfamily : null],
    // Name ID 1, when the font's own family name is its name ID 16: what apps that list four
    // styles per family show ("Avenir Next Medium" for Avenir Next's Medium).
    ["Name in older apps", font.legacyFamily],
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
 * separate), or by your rule or choice (with a way back). Also your rule for the family's own
 * name, when it keeps the family out of suggestions. Each change has Undo.
 */
function FamilyGroupNote({ face }: { face: Face }) {
  const openFamilyGroups = useOpenFamilyGroups();
  const { rules } = useFamilyChoices();
  // The name it was placed by: its own, or the copy's your rule or grouping went by.
  const raw = face.name;
  const familyKey = squash(face.family);
  // Your rule for the family's own name, other than the one that placed this style.
  const familyKept = face.ruleKey !== familyKey && rules.get(familyKey)?.decision === "separate";
  if (face.groupedBy === "own" && !familyKept) return null;
  let text: string | null = null;
  let action: { label: string; run: () => void } | null = null;
  if (face.groupedBy === "name") {
    text = `Grouped by name into ${face.family}, from “${raw}”.`;
    action = {
      label: `Keep “${raw}” separate`,
      run: () => void runChange(() => keepSeparate(`Kept “${raw}” separate`, [nameRef(raw)]), "Couldn't keep it separate"),
    };
  } else if (face.groupedBy === "rule") {
    const ruleKey = face.ruleKey ?? squash(raw);
    text = face.kept ? `You chose to keep “${face.family}” separate.` : `Merged into ${face.family} by you, from “${raw}”.`;
    action = {
      label: face.kept ? "Allow grouping by name" : "Undo this merge",
      run: () =>
        void runChange(
          () => resetChoices(face.kept ? `Allowed grouping “${face.family}” by name` : `Took “${raw}” out of ${face.family}`, [], [ruleKey]),
          "Couldn't change it",
        ),
    };
  } else if (face.groupedBy === "choice") {
    text = face.kept ? "You chose to keep this style under its own family name." : `Moved into ${face.family} by you, from “${raw}”.`;
    action = {
      // Forgets the move: grouping by name (or the font's own name) decides again.
      label: face.kept ? "Allow grouping by name" : "Undo my move",
      run: () =>
        void runChange(() => resetChoices(face.kept ? `Allowed grouping ${face.style} by name` : `Took ${face.style} out of ${face.family}`, [face.key], []), "Couldn't change it"),
    };
  }
  return (
    <section aria-label="Family group" className="flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-sm">
      {text && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
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
        </div>
      )}
      {familyKept && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Icon name="account_tree" size={16} className="text-muted-foreground" />
          <span className="min-w-0 flex-1">You chose to keep {face.family} separate: it isn't suggested for another family.</span>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => void runChange(() => resetChoices(`Allowed suggestions for ${face.family}`, [], [familyKey]), "Couldn't change it")}
          >
            Allow suggestions
          </Button>
          {!text && (
            <Button variant="link" size="sm" className="h-auto p-0" onClick={() => openFamilyGroups([face])}>
              Family groups…
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
