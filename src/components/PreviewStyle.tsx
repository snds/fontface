import { createContext, useContext, useMemo } from "react";
import type { PreviewOptions } from "@/api";
import { DEFAULT_PREVIEW, featureSettings, previewFeatureValues, resolveColors, type FeatureValues, type PreviewColors } from "@/previewStyle";

/**
 * The View options' preview styling, handed to every preview that should follow it: the library
 * layouts and the font page (App provides it around them). Previews elsewhere (the catalogs, the
 * font picker, Compare and Pair, which have their own controls) get the plain default.
 */
export interface PreviewStyle {
  options: PreviewOptions;
  /** The colors to draw in, worked out for the theme (previewStyle.resolveColors). */
  colors: PreviewColors;
  /** The features' values and their `font-feature-settings`. */
  features: FeatureValues;
  featureCss: string | undefined;
}

function makeStyle(options: PreviewOptions, dark: boolean): PreviewStyle {
  const features = previewFeatureValues(options.features);
  return { options, colors: resolveColors(options, dark), features, featureCss: featureSettings(features) };
}

export const PLAIN_PREVIEW: PreviewStyle = makeStyle(DEFAULT_PREVIEW, false);

export const PreviewStyleContext = createContext<PreviewStyle>(PLAIN_PREVIEW);

export const usePreviewStyle = () => useContext(PreviewStyleContext);

/** The style for these options in this theme (for App's provider). */
export function usePreviewStyleValue(options: PreviewOptions, dark: boolean): PreviewStyle {
  return useMemo(() => makeStyle(options, dark), [options, dark]);
}
