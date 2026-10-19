import { useMemo } from "react";
import type { PreviewInfo } from "@/api";
import { isFaceLoaded } from "@/fontLoader";
import { chooseMetrics, fitRow, fitStyle, fitWaterfall, type Fit, type FitExtra } from "@/previewFit";
import { measureText } from "@/previewMeasure";
import { previewCase, styleCss, styleExtra } from "@/previewStyle";
import { cn } from "@/lib/utils";
import { usePreviewStyle } from "./PreviewStyle";

interface Props {
  /** CSS font-family value, such as `"ff-12-abc"`. Also what the canvas measures with. */
  fontFamily: string;
  /** The page-only face name (fontLoader's `faceName`) when the font is one the app loads. The
   *  text is measured only once that face has loaded, so a measurement of the fallback font is
   *  never taken (or cached) for it. It also marks the element (`data-face`), so a color font
   *  with an all-dark palette draws light on dark paper (colorPalette.ts). Leave it out for
   *  fonts the system draws by name. */
  face?: string;
  text: string;
  /** Font size in px. */
  size: number;
  /** Show the text: until then it stays hidden and isn't measured. */
  ready: boolean;
  /** The face's profile, when it has one: its line metrics are the fallback for fitting. */
  profile?: PreviewInfo;
  /** `text` is the profile's own text, so its stored ink counts too. */
  ownText?: boolean;
  /** `text` is what was typed: the View options' case always applies to it. Otherwise (the
   *  font's name, the page's words) only if the font can draw the result. */
  typed?: boolean;
  /** "row": a list preview, 1.3 em tall, shrunk if needed. "waterfall": never shrunk; the row
   *  grows instead. */
  mode?: "row" | "waterfall";
  /** A sample of characters rather than words: hidden from screen readers, which read the
   *  family name and the badge instead. Its case never changes. */
  sample?: boolean;
  /** `font-feature-settings` instead of the View options' (the font page's own switches). */
  features?: string;
  /** More room the fit keeps above and below, in em, for features that can draw past the
   *  plain text's ink (openType.featureSlack). */
  slack?: number;
  /** Draw the View options' paper behind this preview (false: an enclosing sheet has it). */
  paper?: boolean;
  /** The language the text is in (turns on the font's localized forms). */
  lang?: string;
  className?: string;
  style?: React.CSSProperties;
}

/** The fit for this text, or undefined to draw it plainly. Pure apart from the cached canvas
 *  measurement, so it's cheap to call on every render. */
function useFit({ fontFamily, face, text, size, ready, profile, ownText, mode = "row" }: Props, extra: FitExtra): Fit | undefined {
  const ascent = profile?.ascent;
  const descent = profile?.descent;
  const inkTop = profile?.inkTop;
  const inkBottom = profile?.inkBottom;
  const { pad, minBottom, slack } = extra;
  // A face that failed to load (or hasn't yet) draws in the fallback font: drawn plainly.
  const loaded = ready && (!face || isFaceLoaded(face));
  return useMemo(() => {
    if (!loaded || !text) return undefined;
    const fit = mode === "row" ? fitRow : fitWaterfall;
    const line = ascent !== undefined && descent !== undefined ? { ascent, descent } : undefined;
    const ink = ownText && inkTop !== undefined && inkBottom !== undefined ? { top: inkTop, bottom: inkBottom } : undefined;
    const chosen = chooseMetrics({ line, ink }, measureText(fontFamily, text) ?? undefined);
    return chosen ? fit(chosen.line, chosen.ink, size, { pad, minBottom, slack }) : undefined;
  }, [loaded, text, mode, ascent, descent, inkTop, inkBottom, ownText, fontFamily, size, pad, minBottom, slack]);
}

/**
 * Preview text fitted to its box: nothing clipped, the baseline where it belongs (see
 * previewFit.ts). Hidden until ready. Always left to right, so Hebrew and Arabic samples line
 * up with everything else. Styled as the View options say (PreviewStyle): alignment, case,
 * outline, underline, colors and features, with room in the fit for each.
 */
export function PreviewText(props: Props) {
  const { fontFamily, face, size, ready, sample, typed, profile, className, style, mode = "row", features, slack = 0, paper = true, lang } = props;
  const look = usePreviewStyle();
  const { options } = look;
  // Measured and drawn the same: the case is in the text itself.
  const text = previewCase(props.text, options.case, { typed, sample, missing: profile?.asciiMissing });
  const extra = styleExtra(options, size);
  const fit = useFit({ ...props, text }, { ...extra, slack });
  const sized = fit ? fitStyle(fit, size) : { fontSize: size, lineHeight: mode === "row" ? 1.3 : 1.5 };
  // The outline's stroke follows the drawn size, which the fit may have made smaller.
  const css = styleCss(options, look.colors, fit ? fit.scale * size : size, paper);
  return (
    <div
      dir="ltr"
      lang={lang}
      data-face={face}
      // The paper drawn here, if any: a color font's palette follows it (colorPalette.ts).
      data-paper={paper ? look.colors.paperTone : undefined}
      aria-hidden={sample || undefined}
      className={cn("truncate transition-opacity", !ready && "preview-loading", className)}
      style={{ ...style, ...css, fontFamily, fontFeatureSettings: features ?? look.featureCss, ...sized }}
    >
      {text}
    </div>
  );
}
