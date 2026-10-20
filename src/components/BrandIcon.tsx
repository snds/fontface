import { cn } from "@/lib/utils";

/*
 * Brand marks for the two sources that are online services, drawn in one color (currentColor) so
 * they sit with the outlined Material Symbols around them in the sidebar. They only label those
 * integrations; the marks belong to their owners. Credits and licences: docs/THIRD-PARTY.md.
 *
 * - Google Fonts: Simple Icons, icons/googlefonts.svg (https://simpleicons.org,
 *   https://github.com/simple-icons/simple-icons). CC0 1.0: no rights reserved. Drawn filled, as
 *   Simple Icons draws it: traced as an outline, its overlapping pieces turn into circles and
 *   chords at this size.
 * - Adobe (for Adobe Fonts): Tabler Icons, icons/outline/brand-adobe.svg
 *   (https://tabler.io/icons, https://github.com/tabler/tabler-icons). MIT, Copyright (c)
 *   2020-2026 Paweł Kuna. An outline icon already. Simple Icons dropped Adobe's marks in its
 *   version 14, so it has none.
 */

/** Simple Icons' Google Fonts mark, on a 24 by 24 grid. */
const GOOGLE_FONTS =
  "M4 2.8A3.6 3.6 0 1 0 4 10a3.6 3.6 0 0 0 0-7.2zm7.6 0v18.4h7.2a5.2 5.2 0 1 1 0-10.4 4 4 0 1 1 0-8zm7.2 0v8a4 4 0 1 0 0-8zm0 8v10.4A5.2 5.2 0 0 0 24 16a5.2 5.2 0 0 0-5.2-5.2zm-7.7-7.206L0 21.199h8.8l2.3-3.64Z";

/** Tabler Icons' Adobe outline, on a 24 by 24 grid, for a 2-unit round stroke. */
const ADOBE =
  "M12.893 4.514l7.977 14a.993 .993 0 0 1 -.394 1.365a1.04 1.04 0 0 1 -.5 .127h-3.476l-4.5 -8l-2.5 4h1.5l2 4h-8.977c-.565 0 -1.023 -.45 -1.023 -1c0 -.171 .045 -.34 .13 -.49l7.977 -13.993a1.034 1.034 0 0 1 1.786 0l0 -.009";

export type Brand = "google" | "adobe";

/**
 * A service's mark at the size of an <Icon> (`size`, the box it sits in). Decorative: the row's
 * name says which service it is. Google's mark fills its whole grid, so it's drawn a little
 * smaller to look the same size as the outlined icons, which leave room around them.
 */
export function BrandIcon({ brand, size = 18, className }: { brand: Brand; size?: number; className?: string }) {
  const shared = { width: size, height: size, "aria-hidden": true, focusable: false, className: cn("shrink-0", className) } as const;
  if (brand === "google") {
    return (
      <svg {...shared} viewBox="-3.5 -3.5 31 31" fill="currentColor" data-slot="icon">
        <path d={GOOGLE_FONTS} />
      </svg>
    );
  }
  return (
    <svg {...shared} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" data-slot="icon">
      <path d={ADOBE} />
    </svg>
  );
}
