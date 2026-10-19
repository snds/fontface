import type { FontSummary, PreviewInfo } from "@/api";
import type { Face } from "@/library";
import { faceName, useFontFace } from "@/fontLoader";
import { isSampleKind, kindFor, missingCharacters, useProfileWait, type ProfileState } from "@/previewProfiles";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PreviewText } from "./PreviewText";

// A font's one-line preview and the small marks beside it, shared by the library rows and the
// font page's "All styles" list.

const UNAVAILABLE: Record<string, { icon: string; text: string }> = {
  error: { icon: "error", text: "Preview unavailable" },
  cloud: { icon: "cloud_download", text: "Not downloaded yet: it's online-only in cloud storage" },
  "too-large": { icon: "data_usage", text: "Too large to preview" },
};

/**
 * A row's preview: the typed text, else the profile's text (the name, tidied, or a sample of
 * the font's real characters), else the name. Hidden until the font has loaded and the profile
 * is known (or 300 ms have passed), then fitted so nothing is clipped.
 */
export function FacePreview({ font, preview, typed, own, size }: { font: FontSummary; preview: ProfileState; typed: string; own: "family" | "full"; size: number }) {
  const state = useFontFace(font);
  const { profile, pending } = preview;
  const face = faceName(font);
  const waited = useProfileWait(pending, face);
  const unavailable = UNAVAILABLE[state];
  if (unavailable) {
    return (
      <div className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground italic">
        <Icon name={unavailable.icon} size={14} />
        {unavailable.text}
      </div>
    );
  }
  const name = own === "family" ? font.family : font.fullName || `${font.family} ${font.subfamily}`;
  const profileText = own === "family" ? profile?.familyText : profile?.fullText;
  return (
    <PreviewText
      fontFamily={`"${face}"`}
      face={face}
      text={typed || profileText || name}
      size={size}
      ready={state === "ready" && (!pending || waited)}
      profile={profile}
      ownText={!typed && !!profile}
      sample={!typed && isSampleKind(profile, own)}
    />
  );
}

/** "Symbols", "Expert set", a script name or "Partial set", for rows previewed by a sample.
 *  `row`: a family row goes by the family name, a style row by its full name. */
export function SampleBadge({ profile, row }: { profile: PreviewInfo | undefined; row: "family" | "full" }) {
  if (!isSampleKind(profile, row) || !profile?.label) return null;
  const why =
    kindFor(profile, row) === "expert"
      ? "An expert set: extra characters (fractions, ligatures, small capitals and the like) that go with another font. This shows the characters it has."
      : "This font can't draw its name, so this shows characters it does have.";
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="shrink-0" onClick={(e) => e.stopPropagation()} />}>
        <Badge variant="outline" className="text-muted-foreground">
          {profile.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{why}</TooltipContent>
    </Tooltip>
  );
}

/** Shown when the typed preview text uses characters this font doesn't have. */
export function MissingHint({ text, profile }: { text: string; profile: PreviewInfo | undefined }) {
  const missing = missingCharacters(text, profile);
  if (!missing.length) return null;
  const list = missing.join(" ");
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0 items-center text-muted-foreground" onClick={(e) => e.stopPropagation()} />}>
        <Icon name="font_download_off" size={14} />
        <span className="sr-only">Not in this font: {list}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        Not in this font: {list}. Those characters show in another font, or as boxes or blanks.
      </TooltipContent>
    </Tooltip>
  );
}

/** "×3" badge for a face that exists as several files; hover lists where. */
export function CopiesBadge({ face }: { face: Face }) {
  if (face.copies.length < 2) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span onClick={(e) => e.stopPropagation()} />}>
        <Badge variant="outline" className="font-mono">×{face.copies.length}</Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-md">
        <div className="mb-1 font-medium">{face.copies.length} copies of this font</div>
        {face.copies.map((c) => (
          <div key={c.id} className="truncate font-mono text-[11px]">{c.path}</div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

/** How a face's or family's on/off state reads to a screen reader: "on", "3 of 12 on", "always on". */
export function stateWords(active: number, total: number, installed: number): string {
  if (total === 0) return installed ? "always on (installed)" : "off";
  if (active === total) return "on";
  if (active === 0) return "off";
  return `${active} of ${total} on`;
}
