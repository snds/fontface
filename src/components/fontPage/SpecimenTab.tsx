import { useEffect, useId, useRef, useState } from "react";
import type { ActivationMode } from "@/api";
import type { VariationAt } from "@/axisField";
import { activationIds, type Face, type Family } from "@/library";
import { faceName, useFontFace } from "@/fontLoader";
import { ROW_HEIGHT } from "@/previewFit";
import { isSampleKind, usePreviewProfile } from "@/previewProfiles";
import { cn } from "@/lib/utils";
import { summarize } from "@/fontState";
import { previewCase, styleCss } from "@/previewStyle";
import { usePreviewStyle } from "@/components/PreviewStyle";
import { StateControl } from "@/components/ActivationSwitch";
import { CopiesBadge, FacePreview, SampleBadge, sampleWhy } from "@/components/FacePreview";
import { PreviewText } from "@/components/PreviewText";
import { createTipHandle, ROW_TIP_DELAY, Tip, TipHost, type TipHandle } from "@/components/Tip";
import { FaceStateMessage, paragraphText, SectionTitle, waterfallText } from "./parts";

const WATERFALL = [12, 16, 24, 36, 48, 72, 96];
/** The "All styles" preview size. */
const STYLE_SIZE = 28;
/** "All styles" lines this far past the edges of the page's scroll area load their font, so
 *  they're ready by the time they scroll in. */
const NEAR = "400px 0px";

interface Props {
  family: Family;
  /** The chosen style. */
  face: Face;
  previewText: string;
  /** font-variation-settings from the Axes tab, for each text size: optical size follows the
   *  size unless it's set by hand, so each waterfall line gets its own. */
  variation: VariationAt;
  /** font-feature-settings: the preview bar's features with the OpenType tab's switches on top. */
  features: string | undefined;
  /** Room the fit keeps for features that can draw past the plain ink (openType.featureSlack). */
  slack: number;
  /** The text's language, from the OpenType tab (the font's localized forms). */
  lang: string | undefined;
  busy: Set<string>;
  onChoose: (faceKey: string) => void;
  onActivate: (ids: number[], active: boolean, scope?: ActivationMode | null) => void;
}

/** The paragraph's size in px (text-lg). */
const PARAGRAPH_SIZE = 18;

/**
 * The waterfall and a paragraph in the chosen style, then every style with its own switch. The
 * waterfall and paragraph follow the preview bar's preview styling and the OpenType tab's
 * switches; with a paper color, each sits on one sheet of it.
 */
export function SpecimenTab({ family, face, previewText, variation, features, slack, lang, busy, onChoose, onActivate }: Props) {
  const font = face.primary;
  // The chosen style loads ahead of the "All styles" lines (which may have asked first).
  const state = useFontFace(font, true);
  const listRef = useRef<HTMLUListElement>(null);
  const near = useNearLines(listRef, family.faces);
  // One tooltip for every "All styles" line (a family can have dozens).
  const [tips] = useState(createTipHandle);
  const { profile } = usePreviewProfile(font);
  const pageFace = faceName(font);
  const fontFamily = `"${pageFace}"`;
  const sample = waterfallText(previewText, profile, font.family);
  const paragraph = paragraphText(profile, font.family);
  const ownText = sample === (profile?.familyText ?? font.family);
  const sampleOnly = !previewText && sample === profile?.familyText && isSampleKind(profile);
  const look = usePreviewStyle();
  const paper = look.colors.paper;
  const sheet = paper ? { backgroundColor: paper, color: look.colors.ink } : undefined;
  // Marks each sheet's paper as dark or light, for color fonts' palettes (colorPalette.ts).
  const tone = look.colors.paperTone;
  const paragraphSample = paragraph === profile?.familyText && isSampleKind(profile);
  const paragraphShown = previewCase(paragraph, look.options.case, { sample: paragraphSample, missing: profile?.asciiMissing });
  return (
    <div className="flex flex-col gap-8 px-6 pt-5 pb-12">
      <FaceStateMessage state={state} />
      <section aria-label="Waterfall">
        <SectionTitle>Waterfall</SectionTitle>
        <div className={cn(sheet && "rounded-lg px-4 py-3")} style={sheet} data-paper={tone}>
        {WATERFALL.map((px) => (
          <div key={px} className="flex items-baseline gap-3 overflow-hidden whitespace-nowrap">
            <span className={cn("w-6 shrink-0 text-right font-mono text-[10px]", sheet ? "opacity-60" : "text-muted-foreground")}>{px}</span>
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
              typed={!!previewText}
              sample={sampleOnly}
              mode="waterfall"
              features={features}
              slack={slack}
              paper={false}
              lang={lang}
              className="min-w-0 flex-1"
              style={{ fontVariationSettings: variation(px) }}
            />
          </div>
        ))}
        </div>
      </section>

      <section aria-label="Paragraph">
        <SectionTitle>Paragraph</SectionTitle>
        <div className={cn(sheet && "rounded-lg px-4 py-3")} style={sheet} data-paper={tone}>
          <p
            dir="ltr"
            lang={lang}
            data-face={pageFace}
            aria-hidden={paragraphSample ? true : undefined}
            className={cn("max-w-[68ch] text-lg leading-relaxed break-words transition-opacity", state === "loading" && "preview-loading")}
            style={{
              ...styleCss(look.options, look.colors, PARAGRAPH_SIZE, false),
              fontFamily,
              fontVariationSettings: variation(PARAGRAPH_SIZE),
              fontFeatureSettings: features,
            }}
          >
            {paragraphShown}
          </p>
        </div>
      </section>

      <section aria-label="All styles">
        <SectionTitle>All styles</SectionTitle>
        <TipHost handle={tips} />
        <ul ref={listRef} className="flex flex-col">
          {family.faces.map((f) => (
            <StyleLine
              key={f.key}
              face={f}
              near={near.has(f.key)}
              chosen={f.key === face.key}
              previewText={previewText}
              busy={f.copies.some((c) => busy.has(c.path))}
              tips={tips}
              onChoose={onChoose}
              onActivate={onActivate}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

/** The nearest ancestor that scrolls (the tab panel), or null for the window. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === "auto" || overflowY === "scroll") return p;
  }
  return null;
}

/**
 * Which "All styles" lines (by face key) are on screen or near it. Only those load their font:
 * a family of 60 styles doesn't fetch 60 files when its page opens, and a line that scrolls away
 * before its turn gives up its place in the queue.
 */
function useNearLines(listRef: React.RefObject<HTMLUListElement | null>, faces: Face[]): ReadonlySet<string> {
  const [near, setNear] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new IntersectionObserver(
      (entries) =>
        setNear((before) => {
          const next = new Set(before);
          for (const entry of entries) {
            const key = (entry.target as HTMLElement).dataset.faceKey;
            if (!key) continue;
            if (entry.isIntersecting) next.add(key);
            else next.delete(key);
          }
          return next;
        }),
      { root: scrollParent(list), rootMargin: NEAR },
    );
    for (const line of list.querySelectorAll("li[data-face-key]")) observer.observe(line);
    return () => observer.disconnect();
  }, [listRef, faces]);
  return near;
}

/** One style: pick it to see it above (it's then the chosen style), and its own switch. Its
 *  preview loads only while the line is `near` the screen. */
function StyleLine({
  face,
  near,
  chosen,
  previewText,
  busy,
  tips,
  onChoose,
  onActivate,
}: {
  face: Face;
  near: boolean;
  chosen: boolean;
  previewText: string;
  busy: boolean;
  tips: TipHandle;
  onChoose: (faceKey: string) => void;
  onActivate: (ids: number[], active: boolean, scope?: ActivationMode | null) => void;
}) {
  const font = face.primary;
  const preview = usePreviewProfile(font);
  const label = `${face.style}${font.variable ? " (Variable)" : ""}`;
  const stateId = useId();
  // The marks inside the line (copies, a sample instead of the name) have no tooltips of their
  // own here, since a tooltip's trigger never goes inside another's: the line's says it all.
  const what = chosen ? "This is the style shown above and in the other tabs" : "Shows this style above and in the other tabs";
  const why = sampleWhy(preview.profile, "full");
  const copies = face.copies.length > 1 ? `It's in ${face.copies.length} files. The Info tab lists them.` : null;
  const tip = why || copies ? [`${what}.`, why, copies].filter(Boolean).join(" ") : what;
  return (
    // Right-click a line for that style's menu (see FontPage).
    <li data-face-key={face.key} className="flex items-center gap-3 border-b py-1.5 last:border-b-0">
      {/* A big target the pointer crosses on its way elsewhere: its tooltip waits longer. */}
      <Tip handle={tips} tip={tip} delay={ROW_TIP_DELAY} align="start" contentClassName="max-w-xs">
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
            <CopiesBadge face={face} tip={false} />
            <SampleBadge profile={preview.profile} row="full" tip={false} />
          </span>
          {near ? (
            <FacePreview font={font} preview={preview} typed={previewText} own="full" size={STYLE_SIZE} tip={false} />
          ) : (
            // Holds the line's height until its preview loads.
            <span aria-hidden className="block" style={{ height: STYLE_SIZE * ROW_HEIGHT }} />
          )}
        </button>
      </Tip>
      <StateControl
        state={summarize([face])}
        single
        label={`Activate ${face.family} ${face.style}`}
        busy={busy}
        srId={stateId}
        tipHandle={tips}
        onSwitch={(on, scope) => onActivate(activationIds([face], on), on, scope)}
      />
    </li>
  );
}
