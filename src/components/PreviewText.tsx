import { useMemo } from "react";
import type { PreviewInfo } from "@/api";
import { isFaceLoaded } from "@/fontLoader";
import { chooseMetrics, fitRow, fitStyle, fitWaterfall, type Fit } from "@/previewFit";
import { measureText } from "@/previewMeasure";
import { cn } from "@/lib/utils";

interface Props {
  /** CSS font-family value, such as `"ff-12-abc"`. Also what the canvas measures with. */
  fontFamily: string;
  /** The page-only face name (fontLoader's `faceName`) when the font is one the app loads. The
   *  text is measured only once that face has loaded, so a measurement of the fallback font is
   *  never taken (or cached) for it. It also marks the element (`data-face`), so a color font
   *  with an all-dark palette draws light in the dark theme (colorPalette.ts). Leave it out for
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
  /** "row": a list preview, 1.3 em tall, shrunk if needed. "waterfall": never shrunk; the row
   *  grows instead. */
  mode?: "row" | "waterfall";
  /** A sample of characters rather than words: hidden from screen readers, which read the
   *  family name and the badge instead. */
  sample?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/** The fit for this text, or undefined to draw it plainly. Pure apart from the cached canvas
 *  measurement, so it's cheap to call on every render. */
function useFit({ fontFamily, face, text, size, ready, profile, ownText, mode = "row" }: Props): Fit | undefined {
  const ascent = profile?.ascent;
  const descent = profile?.descent;
  const inkTop = profile?.inkTop;
  const inkBottom = profile?.inkBottom;
  // A face that failed to load (or hasn't yet) draws in the fallback font: drawn plainly.
  const loaded = ready && (!face || isFaceLoaded(face));
  return useMemo(() => {
    if (!loaded || !text) return undefined;
    const fit = mode === "row" ? fitRow : fitWaterfall;
    const line = ascent !== undefined && descent !== undefined ? { ascent, descent } : undefined;
    const ink = ownText && inkTop !== undefined && inkBottom !== undefined ? { top: inkTop, bottom: inkBottom } : undefined;
    const chosen = chooseMetrics({ line, ink }, measureText(fontFamily, text) ?? undefined);
    return chosen ? fit(chosen.line, chosen.ink, size) : undefined;
  }, [loaded, text, mode, ascent, descent, inkTop, inkBottom, ownText, fontFamily, size]);
}

/**
 * Preview text fitted to its box: nothing clipped, the baseline where it belongs (see
 * previewFit.ts). Hidden until ready. Always left to right, so Hebrew and Arabic samples line
 * up with everything else.
 */
export function PreviewText(props: Props) {
  const { fontFamily, face, text, size, ready, sample, className, style, mode = "row" } = props;
  const fit = useFit(props);
  const sized = fit ? fitStyle(fit, size) : { fontSize: size, lineHeight: mode === "row" ? 1.3 : 1.5 };
  return (
    <div
      dir="ltr"
      data-face={face}
      aria-hidden={sample || undefined}
      className={cn("truncate transition-opacity", !ready && "preview-loading", className)}
      style={{ ...style, fontFamily, ...sized }}
    >
      {text}
    </div>
  );
}
