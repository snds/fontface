import { countText } from "./googleCatalog.ts";

/**
 * The footer rail's counts (components/FooterRail.tsx), in full words with every digit: the
 * place in view's families and styles, or a catalog's families and how many you have. Pure, so
 * `npm run test:ui` covers it. Always "en-US" digit grouping, as the rest of the app's counts.
 */

const digits = (n: number) => n.toLocaleString("en-US");
const counted = (n: number, one: string, many: string) => `${digits(n)} ${n === 1 ? one : many}`;

/** "2,514 families · 11,047 styles". */
export const libraryCountText = (families: number, styles: number) =>
  `${counted(families, "family", "families")} · ${counted(styles, "style", "styles")}`;

/** "1,918 families · 644 installed", or "312 of 1,918 families · 644 installed" while the search,
 *  a filter or a category narrows the list. `installed`: families you have, downloaded here or
 *  already in your library (the catalog's "Installed"). */
export const catalogCountText = (shown: number, total: number, installed: number) => `${countText(shown, total)} · ${digits(installed)} installed`;
