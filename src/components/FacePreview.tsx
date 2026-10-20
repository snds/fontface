import type { FontSummary, PreviewInfo } from "@/api";
import type { Face } from "@/library";
import { faceName, useFontFace } from "@/fontLoader";
import { isSampleKind, kindFor, missingCharacters, useProfileWait, type ProfileState } from "@/previewProfiles";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { applyCase } from "@/previewStyle";
import { usePreviewStyle } from "./PreviewStyle";
import { PreviewText } from "./PreviewText";
import { CutShort, Tip } from "./Tip";

// A font's one-line preview and the small marks beside it, shared by the library rows and the
// font page's "All styles" list.

const UNAVAILABLE: Record<string, { icon: string; text: string }> = {
  error: { icon: "error", text: "Preview unavailable" },
  cloud: { icon: "cloud_download", text: "Not downloaded yet: it's online-only in cloud storage" },
  "too-large": { icon: "data_usage", text: "Too large to preview" },
};

/** Profile kinds that draw the font's own name (as is, tidied, or in one case). */
const DRAWS_NAME = new Set(["name", "trim", "case"]);

/**
 * A row's preview: the typed text, else the profile's text (the name, tidied, or a sample of
 * the font's real characters), else the name. Hidden until the font has loaded and the profile
 * is known (or 300 ms have passed), then fitted so nothing is clipped. `family`: the family the
 * row lists it under, when grouping by name gave it another than its own ("Aaux Pro" for Aaux
 * ProRegular): a family row draws that, if the font draws its own name.
 */
export function FacePreview({
  font,
  preview,
  typed,
  own,
  size,
  family,
  tip = true,
}: {
  font: FontSummary;
  preview: ProfileState;
  typed: string;
  own: "family" | "full";
  size: number;
  family?: string;
  /** false: no tooltip on "Preview unavailable" and the like, inside a control that has its
   *  own tooltip (a trigger never goes inside another). */
  tip?: boolean;
}) {
  const state = useFontFace(font);
  const { profile, pending } = preview;
  const face = faceName(font);
  const waited = useProfileWait(pending, face);
  const unavailable = UNAVAILABLE[state];
  if (unavailable) {
    // One line, cut short with "…" where it doesn't fit (a card in Tiles, a Table cell) rather
    // than wrapping out of a fixed-height preview area; while it's cut, all of it shows on hover
    // (only rows in this state mount a tooltip). Screen readers have all of it anyway.
    const words = <span className="min-w-0 truncate">{unavailable.text}</span>;
    return (
      <div className="flex min-w-0 items-center gap-1.5 py-1 text-xs text-muted-foreground italic">
        <Icon name={unavailable.icon} size={14} />
        {tip ? <CutShort tip={unavailable.text}>{words}</CutShort> : words}
      </div>
    );
  }
  const name = own === "family" ? font.family : font.fullName || `${font.family} ${font.subfamily}`;
  let profileText = own === "family" ? profile?.familyText : profile?.fullText;
  if (own === "family" && family && family !== font.family && (!profile || DRAWS_NAME.has(profile.kind))) {
    // Drawn in the case the font draws its name in.
    profileText = profile?.familyText && profile.familyText === profile.familyText.toUpperCase() ? family.toUpperCase() : family;
  }
  return (
    <PreviewText
      fontFamily={`"${face}"`}
      face={face}
      text={typed || profileText || name}
      size={size}
      ready={state === "ready" && (!pending || waited)}
      profile={profile}
      ownText={!typed && !!profile}
      typed={!!typed}
      sample={!typed && isSampleKind(profile, own)}
    />
  );
}

/** Why a row shows a sample of characters, or null when it doesn't. */
export function sampleWhy(profile: PreviewInfo | undefined, row: "family" | "full"): string | null {
  if (!isSampleKind(profile, row) || !profile?.label) return null;
  return kindFor(profile, row) === "expert"
    ? "An expert set: extra characters (fractions, ligatures, small capitals and the like) that go with another font. This shows the characters it has."
    : "This font can't draw its name, so this shows characters it does have.";
}

/** "Symbols", "Expert set", a script name or "Partial set", for rows previewed by a sample.
 *  `row`: a family row goes by the family name, a style row by its full name. `id` goes on the
 *  badge, so a list row can point its description at it. Its words are its own: no tooltip. */
export function SampleBadge({ profile, row, id }: { profile: PreviewInfo | undefined; row: "family" | "full"; id?: string }) {
  if (!sampleWhy(profile, row) || !profile?.label) return null;
  return (
    <Badge id={id} variant="outline" className="shrink-0 text-muted-foreground">
      {profile.label}
    </Badge>
  );
}

/** Shown when the typed preview text uses characters this font doesn't have. `srId` goes on the
 *  screen-reader text ("Not in this font: …"). */
export function MissingHint({ text, profile, srId }: { text: string; profile: PreviewInfo | undefined; srId?: string }) {
  // The text as previews draw it: in the preview bar's case.
  const { options } = usePreviewStyle();
  const missing = missingCharacters(applyCase(text, options.case), profile);
  if (!missing.length) return null;
  const list = missing.join(" ");
  // An icon only: the tooltip says what's missing, as screen readers hear it.
  return (
    <Tip tip={`Not in this font: ${list}`}>
      <span className="inline-flex shrink-0 items-center text-muted-foreground" onClick={(e) => e.stopPropagation()}>
        <Icon name="font_download_off" size={14} />
        <span className="sr-only" id={srId}>
          Not in this font: {list}.
        </span>
      </span>
    </Tip>
  );
}

/** "×3" badge for a face that exists as several files, with "3 copies" as its tooltip. Screen
 *  readers hear the same (`srId` goes on that text). `tip` false: no tooltip of its own, inside a
 *  control that has one. */
export function CopiesBadge({ face, srId, tip = true }: { face: Face; srId?: string; tip?: boolean }) {
  if (face.copies.length < 2) return null;
  // The span keeps a click from reaching the row (it would select it).
  const badge = (
    <span onClick={(e) => e.stopPropagation()}>
      <Badge variant="outline" className="font-mono">
        <span aria-hidden>×{face.copies.length}</span>
        <span className="sr-only" id={srId}>
          {face.copies.length} copies
        </span>
      </Badge>
    </span>
  );
  if (!tip) return badge;
  return (
    <Tip tip={`${face.copies.length} copies`}>
      {badge}
    </Tip>
  );
}
