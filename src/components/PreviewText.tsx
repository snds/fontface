import { useMemo } from "react";
import type { PreviewInfo } from "@/api";
import { chooseMetrics, fitRow, fitStyle, fitWaterfall, type Fit, type Ink, type LineMetrics } from "@/previewFit";
import { measureText } from "@/previewMeasure";
import { cn } from "@/lib/utils";

interface Props {
  /** CSS font-family value, such as `"ff-12-abc"`. Also what the canvas measures with. */
  fontFamily: string;
  text: string;
  /** Font size in px. */
  size: number;
  /** The font has loaded: until then the text stays hidden and isn't measured. */
  ready: boolean;
  /** The face's profile, when it has one: its line metrics are the reference for fitting. */
  profile?: PreviewInfo;
  /** `text` is the profile's own text, so its ink is already known (no canvas needed). */
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
function useFit({ fontFamily, text, size, ready, profile, ownText, mode = "row" }: Props): Fit | undefined {
  const ascent = profile?.ascent;
  const descent = profile?.descent;
  const inkTop = profile?.inkTop;
  const inkBottom = profile?.inkBottom;
  return useMemo(() => {
    if (!ready || !text) return undefined;
    const fit = mode === "row" ? fitRow : fitWaterfall;
    const line: LineMetrics | undefined = ascent !== undefined && descent !== undefined ? { ascent, descent } : undefined;
    if (ownText && line && inkTop !== undefined && inkBottom !== undefined) {
      const ink: Ink = { top: inkTop, bottom: inkBottom };
      return fit(line, ink, size);
    }
    const chosen = chooseMetrics(line, measureText(fontFamily, text) ?? undefined);
    return chosen ? fit(chosen.line, chosen.ink, size) : undefined;
  }, [ready, text, mode, ascent, descent, inkTop, inkBottom, ownText, fontFamily, size]);
}

/**
 * Preview text fitted to its box: nothing clipped, the baseline where it belongs (see
 * previewFit.ts). Hidden until the font is ready. Always left to right, so Hebrew and Arabic
 * samples line up with everything else.
 */
export function PreviewText(props: Props) {
  const { fontFamily, text, size, ready, sample, className, style, mode = "row" } = props;
  const fit = useFit(props);
  const sized = fit ? fitStyle(fit, size) : { fontSize: size, lineHeight: mode === "row" ? 1.3 : 1.5 };
  return (
    <div
      dir="ltr"
      aria-hidden={sample || undefined}
      className={cn("truncate transition-opacity", !ready && "preview-loading", className)}
      style={{ ...style, fontFamily, ...sized }}
    >
      {text}
    </div>
  );
}
