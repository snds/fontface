// The order of a font service's catalog page (GoogleFontsPanel): "Installed" (yours first) puts the families
// you have before the rest, each group under a heading.

/** One row of a catalog page's list: a family, or a heading before a group of families. */
export type CatalogItem<T> = { kind: "heading"; id: string; label: string; count: number } | { kind: "family"; family: T };

export const YOURS_HEADING = "In your library";
export const REST_HEADING = "Everything else";

/**
 * The page's rows. With `yoursFirst`, families you have (`isYours`: downloaded here, or already
 * in your library) come first, then everything else, each group in the catalog's own order.
 * Headings show only when both groups have families: a list that's all yours (the Downloaded
 * filter) or has none of yours needs no headings. Off, the catalog's order as it is.
 */
export function catalogItems<T>(families: readonly T[], isYours: (f: T) => boolean, yoursFirst: boolean): CatalogItem<T>[] {
  const plain = () => families.map((family): CatalogItem<T> => ({ kind: "family", family }));
  if (!yoursFirst) return plain();
  const yours: T[] = [];
  const rest: T[] = [];
  for (const f of families) (isYours(f) ? yours : rest).push(f);
  if (!yours.length || !rest.length) return plain();
  return [
    { kind: "heading", id: "heading:yours", label: YOURS_HEADING, count: yours.length },
    ...yours.map((family): CatalogItem<T> => ({ kind: "family", family })),
    { kind: "heading", id: "heading:rest", label: REST_HEADING, count: rest.length },
    ...rest.map((family): CatalogItem<T> => ({ kind: "family", family })),
  ];
}
