import { activationIds, type Face, type Family } from "@/library";
import { faceName, useFontFace } from "@/fontLoader";
import { isSampleKind, usePreviewProfile } from "@/previewProfiles";
import { cn } from "@/lib/utils";
import { ActivationSwitch, InstalledBadge } from "@/components/ActivationSwitch";
import { CopiesBadge, FacePreview, SampleBadge } from "@/components/FacePreview";
import { PreviewText } from "@/components/PreviewText";
import { FaceStateMessage, paragraphText, SectionTitle, waterfallText } from "./parts";

const WATERFALL = [12, 16, 24, 36, 48, 72, 96];
/** The "All styles" preview size. */
const STYLE_SIZE = 28;

interface Props {
  family: Family;
  /** The chosen style. */
  face: Face;
  previewText: string;
  /** font-variation-settings from the Axes tab, if any are set. */
  variation: string | undefined;
  busy: Set<string>;
  onChoose: (faceKey: string) => void;
  onActivate: (ids: number[], active: boolean) => void;
}

/** The waterfall and a paragraph in the chosen style, then every style with its own switch. */
export function SpecimenTab({ family, face, previewText, variation, busy, onChoose, onActivate }: Props) {
  const font = face.primary;
  const state = useFontFace(font);
  const { profile } = usePreviewProfile(font);
  const pageFace = faceName(font);
  const fontFamily = `"${pageFace}"`;
  const sample = waterfallText(previewText, profile, font.family);
  const paragraph = paragraphText(profile, font.family);
  const ownText = sample === (profile?.familyText ?? font.family);
  const sampleOnly = !previewText && sample === profile?.familyText && isSampleKind(profile);
  return (
    <div className="flex flex-col gap-8 px-6 pt-5 pb-12">
      <FaceStateMessage state={state} />
      <section aria-label="Waterfall">
        <SectionTitle>Waterfall</SectionTitle>
        {WATERFALL.map((px) => (
          <div key={px} className="flex items-baseline gap-3 overflow-hidden whitespace-nowrap">
            <span className="w-6 shrink-0 text-right font-mono text-[10px] text-muted-foreground">{px}</span>
            {/* Never shrunk: a row grows when the font's ink is taller than the line. Hidden only
                while loading: a face that fails to load draws in the fallback font. */}
            <PreviewText
              fontFamily={fontFamily}
              face={pageFace}
              text={sample}
              size={px}
              ready={state !== "loading"}
              profile={profile}
              ownText={!previewText && ownText}
              sample={sampleOnly}
              mode="waterfall"
              className="min-w-0 flex-1"
              style={{ fontVariationSettings: variation }}
            />
          </div>
        ))}
      </section>

      <section aria-label="Paragraph">
        <SectionTitle>Paragraph</SectionTitle>
        <p
          dir="ltr"
          data-face={pageFace}
          aria-hidden={paragraph === profile?.familyText && isSampleKind(profile) ? true : undefined}
          className={cn("max-w-[68ch] text-lg leading-relaxed break-words transition-opacity", state === "loading" && "preview-loading")}
          style={{ fontFamily, fontVariationSettings: variation }}
        >
          {paragraph}
        </p>
      </section>

      <section aria-label="All styles">
        <SectionTitle>All styles</SectionTitle>
        <ul className="flex flex-col">
          {family.faces.map((f) => (
            <StyleLine
              key={f.key}
              face={f}
              chosen={f.key === face.key}
              previewText={previewText}
              busy={f.copies.some((c) => busy.has(c.path))}
              onChoose={onChoose}
              onActivate={onActivate}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

/** One style: pick it to see it above (it's then the chosen style), and its own switch. */
function StyleLine({
  face,
  chosen,
  previewText,
  busy,
  onChoose,
  onActivate,
}: {
  face: Face;
  chosen: boolean;
  previewText: string;
  busy: boolean;
  onChoose: (faceKey: string) => void;
  onActivate: (ids: number[], active: boolean) => void;
}) {
  const font = face.primary;
  const preview = usePreviewProfile(font);
  const label = `${font.subfamily}${font.variable ? " (Variable)" : ""}`;
  return (
    // Right-click a line for that style's menu (see FontPage).
    <li data-face-key={face.key} className="flex items-center gap-3 border-b py-1.5 last:border-b-0">
      <button
        type="button"
        aria-pressed={chosen}
        aria-label={label}
        onClick={() => onChoose(face.key)}
        className={cn(
          "flex min-w-0 flex-1 flex-col items-stretch gap-0.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          chosen ? "bg-accent" : "hover:bg-muted/50",
        )}
      >
        <span className="flex min-w-0 items-center gap-2 text-xs">
          <span className="truncate font-medium">{label}</span>
          <span className="shrink-0 font-mono text-muted-foreground">
            {font.weight}
            {font.italic ? " · italic" : ""}
          </span>
          <CopiesBadge face={face} />
          <SampleBadge profile={preview.profile} row="full" />
        </span>
        <FacePreview font={font} preview={preview} typed={previewText} own="full" size={STYLE_SIZE} />
      </button>
      {face.installed ? (
        <InstalledBadge />
      ) : (
        <ActivationSwitch
          active={face.active ? 1 : 0}
          total={1}
          label={`Activate ${font.family} ${font.subfamily}`}
          busy={busy}
          onChange={(on) => onActivate(activationIds([face], on), on)}
        />
      )}
    </li>
  );
}
