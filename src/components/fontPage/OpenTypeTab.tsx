import { useId } from "react";
import type { FontSummary, PreviewCase, PreviewInfo } from "@/api";
import { faceName, useFontFace } from "@/fontLoader";
import { featureSettings, styleCss, type FeatureValues } from "@/previewStyle";
import { fittingText, PANGRAM } from "@/sampleText";
import { featureSampleText, groupFeatures, isOn, languageChoices, scriptsLine, type FeatureView, type Toggles } from "@/openType";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tip } from "@/components/Tip";
import { cn } from "@/lib/utils";
import { usePreviewStyle } from "@/components/PreviewStyle";
import { FaceStateMessage, factsOf, FactsMessage, SectionTitle, type FactsState } from "./parts";

/** The test text's words: ligatures, a fraction, figures and punctuation that changes with case. */
export const OPENTYPE_TEXT = "Fine office affinity, 1/2 (H-O) 0123456789";

const TEXT_TRANSFORM = { asTyped: undefined, upper: "uppercase", lower: "lowercase", title: "capitalize" } as const;

/** The language picker's choice for no language (the font's default forms). */
const NO_LANGUAGE = "default";

interface Props {
  font: FontSummary;
  profile: PreviewInfo | undefined;
  facts: FactsState;
  retry: () => void;
  /** The toolbar's preview text: the test text starts with it, if there is one. */
  previewText: string;
  /** What's typed in the test field (null: not yet, so it shows its starting text). */
  testText: string | null;
  onTestText: (text: string) => void;
  testSize: number;
  onTestSize: (px: number) => void;
  /** The page's own switches, and what they add up to with the View options' features. */
  toggles: Toggles;
  values: FeatureValues;
  onToggle: (tag: string, on: boolean, defaultOn: boolean) => void;
  lang: string | undefined;
  onLang: (lang: string | undefined) => void;
  onReset: () => void;
  variation: string | undefined;
}

/**
 * The features the chosen style really has (its GSUB and GPOS tables), by group, each with a
 * switch and a sample in the font. The switches apply at once to the test text here and to the
 * Specimen, for every style of the family while the page is open; Reset puts them back. The
 * language picker sets the text's language, which turns on the font's own forms for it.
 */
export function OpenTypeTab(props: Props) {
  const { font, profile, facts, retry, previewText, testText, onTestText, testSize, onTestSize, toggles, values, onToggle, lang, onLang, onReset, variation } = props;
  const id = useId();
  const state = useFontFace(font, true);
  const look = usePreviewStyle();
  const data = factsOf(facts);
  const pageFace = faceName(font);
  const fontFamily = `"${pageFace}"`;
  const features = featureSettings(values);
  const start = previewText || fittingText([OPENTYPE_TEXT, PANGRAM], profile, font.family);
  const text = testText ?? start;
  const groups = data ? groupFeatures(data.features, profile?.asciiMissing) : [];
  const languages = data ? languageChoices(data.scripts) : [];
  const changed = Object.keys(toggles).length > 0 || !!lang;
  return (
    <div className="flex max-w-3xl flex-col gap-7 px-6 pt-5 pb-12">
      <FaceStateMessage state={state} />
      <FactsMessage state={facts} retry={retry} what="features" />
      {data && (
        <>
          <section aria-label="Test text" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <label htmlFor={`${id}-text`} className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Test text
              </label>
              <span className="flex-1" />
              <div className="flex w-40 items-center gap-2">
                <Icon name="format_size" size={16} className="text-muted-foreground" />
                <Tip tip="Sets the size of the test text">
                  <Slider
                    min={16}
                    max={96}
                    step={1}
                    value={[testSize]}
                    onValueChange={(v) => onTestSize(Array.isArray(v) ? v[0] : v)}
                    aria-label="Test text size"
                  />
                </Tip>
              </div>
              {languages.length > 0 && (
                <Select
                  value={lang ?? NO_LANGUAGE}
                  onValueChange={(v) => typeof v === "string" && onLang(v === NO_LANGUAGE ? undefined : v)}
                  items={[{ value: NO_LANGUAGE, label: "Default forms" }, ...languages.map((l) => ({ value: l.value, label: l.label }))]}
                >
                  <Tip tip="Sets the text's language, to show the font's forms for it">
                    <SelectTrigger size="sm" aria-label="Language of the text" className="min-w-36">
                      <SelectValue />
                    </SelectTrigger>
                  </Tip>
                  <SelectContent className="max-h-80">
                    <SelectItem value={NO_LANGUAGE}>Default forms</SelectItem>
                    {languages.map((l) => (
                      <SelectItem key={l.value} value={l.value}>
                        <span className="truncate">{l.label}</span>
                        <span className="ml-auto pl-3 font-mono text-xs text-muted-foreground">{l.tag}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {/* Stays focusable once it has nothing left to undo, so focus doesn't fall out of the page. */}
              <Tip
                tip="Puts the switches and the language back as they started"
                disabledReason={!changed && "Nothing to reset yet: no switch or language has changed"}
              >
                <Button variant="outline" size="sm" disabled={!changed} focusableWhenDisabled className="aria-disabled:opacity-50" onClick={onReset}>
                  <Icon name="restart_alt" size={16} />
                  Reset
                </Button>
              </Tip>
            </div>
            <textarea
              id={`${id}-text`}
              dir="auto"
              lang={lang}
              data-face={pageFace}
              data-paper={look.colors.paperTone}
              rows={2}
              spellCheck={false}
              value={text}
              onChange={(e) => onTestText(e.target.value)}
              className={cn(
                "min-h-20 w-full resize-y rounded-lg border bg-transparent px-3 py-2 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                state === "loading" && "preview-loading",
              )}
              style={{
                ...styleCss(look.options, look.colors, testSize, false),
                backgroundColor: look.colors.paper,
                // The field holds the text as typed; the View options' case shows by CSS here
                // (a field can't hold one text and show another).
                textTransform: TEXT_TRANSFORM[look.options.case],
                fontFamily,
                fontSize: testSize,
                lineHeight: 1.6,
                fontFeatureSettings: features,
                fontVariationSettings: variation,
              }}
            />
          </section>

          {data.appleFeatures && (
            <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
              <Icon name="info" size={16} className="mt-0.5 shrink-0" />
              {data.features.length === 0
                ? "This font keeps its features in Apple's own format (AAT) rather than OpenType, so they can't be switched here. macOS apps that offer typography settings can use them."
                : "This font also has features in Apple's own format (AAT). Those can't be switched here, but macOS apps that offer typography settings can use them."}
            </p>
          )}
          {data.features.length === 0 && !data.appleFeatures && <p className="text-sm text-muted-foreground">This style has no OpenType features.</p>}

          {groups.map((g) => (
            <section key={g.id} aria-labelledby={`${id}-${g.id}`}>
              <div id={`${id}-${g.id}`}>
                <SectionTitle>{g.label}</SectionTitle>
              </div>
              {g.note && <p className="-mt-1 mb-2 text-xs text-muted-foreground">{g.note}</p>}
              <ul className="flex flex-col">
                {g.features.map((f) => (
                  <FeatureRow
                    key={f.tag}
                    feature={f}
                    on={isOn(f.tag, f.defaultOn, toggles, look.features)}
                    fontFamily={fontFamily}
                    face={pageFace}
                    ready={state === "ready"}
                    lang={lang}
                    variation={variation}
                    caseMode={look.options.case}
                    onToggle={(on) => onToggle(f.tag, on, f.defaultOn)}
                  />
                ))}
              </ul>
            </section>
          ))}

          {data.scripts.length > 0 && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">Written for:</span> {scriptsLine(data.scripts)}.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function FeatureRow({
  feature,
  on,
  fontFamily,
  face,
  ready,
  lang,
  variation,
  caseMode,
  onToggle,
}: {
  feature: FeatureView;
  on: boolean;
  fontFamily: string;
  face: string;
  ready: boolean;
  lang: string | undefined;
  variation: string | undefined;
  caseMode: PreviewCase;
  onToggle: (on: boolean) => void;
}) {
  const id = useId();
  const sample = featureSampleText(feature, caseMode);
  return (
    <li className="flex min-h-11 items-center gap-3 border-b py-1.5 last:border-b-0">
      {/* The page's switch, for the test text and the Specimen (every style, while the page is
          open). Vertical-text features can't show here, so their switch is greyed out. */}
      <Tip
        tip={`${on ? "Turns off" : "Turns on"} ${feature.label} in the test text and Specimen`}
        disabledReason={!feature.switchable && "Changes only vertical text, which these previews don't show"}
      >
        <Switch
          checked={on}
          disabled={!feature.switchable}
          onCheckedChange={(v) => onToggle(v)}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-detail`}
        />
      </Tip>
      <span className="flex min-w-0 flex-1 flex-col">
        <span id={`${id}-label`} className="truncate text-sm">
          {feature.label}
        </span>
        <span id={`${id}-detail`} className="truncate font-mono text-[11px] text-muted-foreground">
          {feature.detail}
          {feature.defaultOn && <span className="font-sans"> · on unless turned off</span>}
        </span>
      </span>
      {sample && (
        // This feature alone, as its switch has it now (other switches would muddle it: with
        // Fractions on, every figure turns into a numerator). Never clipped above or below.
        <span
          aria-hidden
          lang={lang}
          data-face={face}
          className={cn("max-w-[50%] overflow-x-clip py-1 text-[22px] leading-normal whitespace-nowrap", !ready && "preview-loading")}
          style={{ fontFamily, fontFeatureSettings: featureSettings({ [feature.tag]: on ? 1 : 0 }), fontVariationSettings: variation }}
        >
          {sample}
        </span>
      )}
    </li>
  );
}
