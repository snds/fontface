import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type GoogleCatalog, type GoogleFamily } from "@/api";
import { catalogCounts, filterCatalog, holdingsOf, type CatalogCounts, type CatalogFilters, type CatalogShow, type Holding } from "@/googleCatalog";
import type { Face } from "@/library";

/** The Google Fonts view's catalog and filters (App keeps them, so the toolbar can show them). */
export interface GoogleView {
  catalog: GoogleCatalog | null;
  loading: boolean;
  /** Why the catalog couldn't be loaded (with no saved copy to show instead). */
  error: string | null;
  /** Loads the catalog again; `refresh` asks the network even if the saved copy is recent. */
  reload: (refresh?: boolean) => void;
  /** The toolbar's filter: All, Downloaded, Active, Updates. */
  show: CatalogShow;
  setShow: (show: CatalogShow) => void;
  /** The slim bar's category ("" for all). */
  category: string;
  setCategory: (category: string) => void;
  /** What you have of each family (googleCatalog.holdingsOf). */
  holdings: ReadonlyMap<string, Holding>;
  /** Everything that narrows the list now: search, category, filter and Variable. */
  filters: Required<CatalogFilters>;
  /** The families the filters, category and search keep, in the catalog's order. */
  visible: GoogleFamily[];
  counts: CatalogCounts;
}

const NO_HOLDINGS: ReadonlyMap<string, Holding> = new Map();

/**
 * The catalog, loaded the first time the Google Fonts view shows, then again after every
 * download, update or removal (`version`). The toolbar's search and Variable, the filter and
 * the category narrow it. `faces`: every style in the library, for what you have of each family.
 */
export function useGoogleView({
  shown,
  version,
  faces,
  query,
  variableOnly,
}: {
  shown: boolean;
  version: number;
  faces: readonly Face[];
  query: string;
  variableOnly: boolean;
}): GoogleView {
  const [catalog, setCatalog] = useState<GoogleCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState<CatalogShow>("all");
  const [category, setCategory] = useState("");
  // Only the newest load lands (a refresh and a reload after a download can overlap).
  const seq = useRef(0);

  const reload = useCallback((refresh = false) => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    api
      .googleCatalog(refresh)
      .then((c) => my === seq.current && setCatalog(c))
      .catch((e) => my === seq.current && setError(String(e)))
      .finally(() => my === seq.current && setLoading(false));
  }, []);

  // Not before the view is first shown (it may ask the network); after that, kept up to date.
  const loadedVersion = useRef<number | null>(null);
  useEffect(() => {
    if ((!shown && loadedVersion.current === null) || loadedVersion.current === version) return;
    loadedVersion.current = version;
    reload();
  }, [shown, version, reload]);

  const holdings = useMemo(() => (catalog ? holdingsOf(catalog.families, faces) : NO_HOLDINGS), [catalog, faces]);
  const filters = useMemo(() => ({ query, category, show, variableOnly }), [query, category, show, variableOnly]);
  const visible = useMemo(() => (catalog ? filterCatalog(catalog.families, filters, holdings) : []), [catalog, filters, holdings]);
  const counts = useMemo(() => catalogCounts(catalog?.families ?? [], holdings), [catalog, holdings]);
  return { catalog, loading, error, reload, show, setShow, category, setCategory, holdings, filters, visible, counts };
}
