import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  api,
  type ActivationMode,
  type Folder,
  type FontSummary,
  type GoogleFamily,
  type LibraryLayout,
  type PurchaseFind,
  type PurchaseImported,
  type ScanProgress,
  type ServiceId,
  type ServiceInfo,
  type SortOrder,
  type SwitchOrigin,
} from "@/api";
import {
  activationIds,
  filterFamilies,
  groupFamilies,
  groupLibrary,
  INSTALLED_LABEL,
  placeCounts,
  recentSince,
  sortFamilies,
  ungroup,
  viewKey,
  type Family,
  type FilterContext,
  type LibraryView,
  type StatusFilter,
} from "@/library";
import { hiddenBySidebar, placeLabel, SERVICE_LABELS, sourceFolders, sourceOf, sourceView } from "@/places";
import { hasSubfolders } from "@/subfolders";
import { describeSort, layoutInfo, layoutShortcut, sizeShortcut, stepSize } from "@/viewOptions";
import { familySources } from "@/familyFacts";
import { applyOutcomes, type StateWording } from "@/fontState";
import { newestWins } from "@/newestWins";
import { listenForProfiles } from "@/previewProfiles";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SETTINGS_BUTTON_ID, Sidebar, scanStatus } from "@/components/Sidebar";
import { LIBRARY_SEARCH_ID, Toolbar } from "@/components/Toolbar";
import { LibraryPane, type ListHandle, type OpenRequest } from "@/components/library/LibraryPane";
import { ViewOptions } from "@/components/ViewOptions";
import { FontPage } from "@/components/fontPage/FontPage";
import { BackButton } from "@/components/fontPage/PageHeader";
import { SubfolderPicker } from "@/components/SubfolderPicker";
import { StateWordingContext } from "@/components/ActivationSwitch";
import { GOOGLE_SEARCH_ID, GoogleFontsPanel } from "@/components/GoogleFontsPanel";
import { AdobeFontsPanel } from "@/components/AdobeFontsPanel";
import { PurchasesPanel } from "@/components/PurchasesPanel";
import { IS_MAC, type PageBack } from "@/components/TitleBar";
import { cancelDrag, isDragging } from "@/tags/drag";
import { locateFolder } from "@/tags/locate";
import { useLocations } from "@/tags/locations";
import { leafOf, useFilterContext, useTagIndex } from "@/tags/model";
import { TagDialogHost } from "@/tags/TagDialogs";
import { useLastView } from "@/settings/lastView";
import type { SectionId } from "@/settings/parts";
import { useRestorePrompt } from "@/settings/restorePrompt";
import { SETTINGS_SEARCH_ID, SettingsScreen } from "@/settings/SettingsView";
import { applyTheme, useDarkTheme } from "@/settings/theme";
import { DEFAULT_SETTINGS, SettingsContext, useSettingsStore } from "@/settings/useSettings";
import { useSyncEvents } from "@/sync/store";
import { popupOpen, useNav } from "@/useNav";
import { findIntent, type CatalogPageEntry, type GroupsFilter } from "@/nav";
import { suggestGroups, type GroupingOptions } from "@/familyGroups";
import { FamilyGroupsContext, reloadFamilyChoices, useFamilyChoices, type OpenFamilyGroups } from "@/families/store";
import { FamilyGroupsPage, GROUPS_SEARCH_ID } from "@/components/FamilyGroupsPage";

const fileName = (path: string) => path.split("/").pop() || path;
/** While a scan runs, reload the font list at most this often so new fonts appear as they're read. */
const LIVE_REFRESH_MS = 4000;
/** Screen readers hear scan progress at most this often (plus start and finish). */
const ANNOUNCE_MS = 15000;
/** Recently Added starts newest first, whatever the library's sort is (see `chooseSort`). */
const RECENT_SORT: SortOrder = { key: "added", desc: true };
/** The Browse button on Google Fonts and Purchases: focus comes back to it from their page. */
const BROWSE_ID = "browse-service";

/** Unix seconds now, to the hour: Recently Added's 30 days move on while Fontface stays open. */
function useHourNow(): number {
  const [hour, setHour] = useState(() => Math.floor(Date.now() / 3_600_000));
  useEffect(() => {
    const timer = setInterval(() => setHour(Math.floor(Date.now() / 3_600_000)), 60_000);
    return () => clearInterval(timer);
  }, []);
  return hour * 3600;
}

/** A service's page on the page stack: its header has Back, and its heading takes focus when it opens. */
function CatalogPage({ placeName, onBack, children }: { placeName: string; onBack: () => void; children: (back: PageBack) => React.ReactNode }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus({ preventScroll: true }), []);
  return <>{children({ leading: <BackButton placeName={placeName} onBack={onBack} />, headingRef })}</>;
}

export default function App() {
  const settingsStore = useSettingsStore();
  const { settings, ready: settingsReady } = settingsStore;
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The settings section opened last this session. */
  const [settingsSection, setSettingsSection] = useState<SectionId>("general");
  const dark = useDarkTheme();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [fonts, setFonts] = useState<FontSummary[]>([]);
  const [view, setView] = useState<LibraryView>({ kind: "all" });
  const [status, setStatus] = useState<StatusFilter>("any");
  /** Recently Added's own sort, so sorting it another way leaves the library's sort as it was. */
  const [recentSort, setRecentSort] = useState<SortOrder>(RECENT_SORT);
  /** Only variable fonts (the toolbar's Variable toggle). */
  const [variableOnly, setVariableOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [size, setSize] = useState(32);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  /** Expanded families in the list, by Family.id. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [scans, setScans] = useState<Map<number, ScanProgress>>(new Map());
  const [pendingRemoval, setPendingRemoval] = useState<Folder | null>(null);
  /** Files with an on/off request queued or in progress. The OS acts on whole files, so every
   *  style with a copy in one of these files shows as busy. */
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [adobeCount, setAdobeCount] = useState<number | null>(null);
  /** Google Fonts families with a download or removal in progress (kept here, so leaving and
   *  returning to the Google page still shows them). */
  const [googleBusy, setGoogleBusy] = useState<Set<string>>(new Set());
  /** Bumped after each Google Fonts change, so the page reloads its catalog. */
  const [googleVersion, setGoogleVersion] = useState(0);
  const [googleUpdatingAll, setGoogleUpdatingAll] = useState(false);
  /** The same busy set, readable synchronously (so two clicks can't both start). */
  const googleBusyRef = useRef(new Set<string>());
  /** Purchases: bumped when the watcher finds something or an import/removal finishes. */
  const [purchasesVersion, setPurchasesVersion] = useState(0);
  const [newPurchases, setNewPurchases] = useState(0);
  const [purchaseBusy, setPurchaseBusy] = useState<Set<string>>(new Set());
  const purchaseBusyRef = useRef(new Set<string>());
  /** The first library read is done (folders and fonts). */
  const [libraryLoaded, setLibraryLoaded] = useState(false);

  const started = useRef(false);
  const lastLiveRefresh = useRef(0);
  const lastAnnounce = useRef(0);
  // Folders with a scan in flight. Progress events can land after a scan's result does,
  // so events for folders not in this set are ignored, to keep finished spinners from coming back.
  const activeScans = useRef(new Set<number>());
  // Folders removed this session (ids are never reused). Their scans end quietly.
  const removedFolders = useRef(new Set<number>());
  const foldersRef = useRef<Folder[]>([]);
  foldersRef.current = folders;
  const servicesRef = useRef<ServiceInfo[]>([]);
  servicesRef.current = services;
  // A font list reflects the moment it was requested. `loadFonts` shows only the newest
  // response, and `mutationEpoch` re-asks if an on/off change or removal happened meanwhile,
  // so a slow, stale list never flips a switch back.
  const mutationEpoch = useRef(0);
  // On/off requests run one after another, in click order.
  const activationQueue = useRef<Promise<unknown>>(Promise.resolve());
  // The scan in flight per folder, so callers can wait for it (e.g. after a download).
  const scanPromises = useRef(new Map<number, Promise<void>>());

  const announce = useCallback((text: string) => {
    lastAnnounce.current = performance.now();
    setAnnouncement(text);
  }, []);

  const setScan = useCallback((folderId: number, progress: ScanProgress | null) => {
    setScans((prev) => {
      const next = new Map(prev);
      if (progress) next.set(folderId, progress);
      else next.delete(folderId);
      return next;
    });
  }, []);

  // A request overtaken by a newer one (say the preview backfill's reload during the launch
  // load) settles only when the newest list is on screen, so after `await refresh()` the fonts
  // are really there (launch checks the saved view against them).
  const [loadFonts] = useState(() => newestWins(() => api.listFonts(), setFonts, () => mutationEpoch.current));

  const refresh = useCallback(async () => {
    const [f, svc] = await Promise.all([api.listFolders(), api.listServices(), loadFonts()]);
    setFolders(f);
    setServices(svc);
  }, [loadFonts]);

  // Settings open over the library (which stays as it was underneath). Focus comes back to
  // where it was, or to the Settings button.
  const settingsOpenRef = useRef(false);
  settingsOpenRef.current = settingsOpen;
  const focusBack = useRef<Element | null>(null);
  const openSettings = useCallback(() => {
    // Already open: go to the search field.
    if (settingsOpenRef.current) return document.getElementById(SETTINGS_SEARCH_ID)?.focus();
    // Marked open at once, so a second request before the next render (⌘, reaching both the
    // page and the menu) only goes to the search field.
    settingsOpenRef.current = true;
    focusBack.current = document.activeElement;
    setSettingsOpen(true);
  }, []);
  /** ⌘, and the menu's Settings… item. Ignored while a dialog, menu or select list (the font
   *  page's style picker) is open, so settings never open behind it or under it (close it
   *  first), and during a drag, whose drop would land on a tag that settings hide (drop or
   *  cancel it first). */
  const openSettingsByShortcut = useCallback(() => {
    if (popupOpen()) return;
    if (isDragging()) return;
    // A press that hasn't become a drag yet mustn't become one over settings.
    cancelDrag();
    openSettings();
  }, [openSettings]);
  /** `restoreFocus: false`: the same action opens a page, whose heading takes focus (focus going
   *  back to the Settings button a frame later would pull it off the page). */
  const closeSettings = useCallback(({ restoreFocus = true }: { restoreFocus?: boolean } = {}) => {
    if (!settingsOpenRef.current) return;
    setSettingsOpen(false);
    if (!restoreFocus) {
      focusBack.current = null;
      return;
    }
    requestAnimationFrame(() => {
      const back = focusBack.current;
      const target = back instanceof HTMLElement && back.isConnected && back !== document.body ? back : document.getElementById(SETTINGS_BUTTON_ID);
      target?.focus();
    });
  }, []);

  // ------------------------------------------------------------------ pages and Back

  // Pages (the font page) open over the list, which stays as it was underneath (see nav.ts).
  // Back puts focus on the row that opened the page; ⌘F leaves a font page for Search.
  const listRef = useRef<ListHandle>(null);
  const pendingFocus = useRef<{ row: string | null } | { element: string | null } | "search" | null>(null);
  const placeNameRef = useRef("All Fonts");
  const nav = useNav({
    // Settings over the page take Esc themselves; a drag takes Esc to cancel.
    blocked: () => settingsOpenRef.current || isDragging(),
    onBack: (closed, remaining) => {
      if (remaining.length) {
        // Back to the page underneath (a font page under Family groups): focus goes to what
        // opened this one, else that page's heading.
        const id = closed.kind === "groups" && closed.returnTo && "element" in closed.returnTo ? closed.returnTo.element : null;
        requestAnimationFrame(() => {
          const el = (id && document.getElementById(id)) || document.querySelector<HTMLElement>("[data-page-top] h1");
          el?.focus({ preventScroll: true });
        });
        return;
      }
      pendingFocus.current =
        closed.kind === "font" ? { row: closed.returnTo } : closed.kind === "groups" ? (closed.returnTo ?? { element: null }) : { element: closed.returnTo };
      announce(`Back to ${placeNameRef.current}`);
    },
  });
  const pageOpen = nav.pages.length > 0;
  const focusSearch = () => {
    const search = document.getElementById(LIBRARY_SEARCH_ID);
    if (search instanceof HTMLInputElement) {
      search.focus();
      search.select();
      return true;
    }
    return false;
  };
  useEffect(() => {
    if (pageOpen) return;
    const want = pendingFocus.current;
    pendingFocus.current = null;
    if (!want) return;
    if (want !== "search" && "element" in want) {
      // The button that opened a service's page (Browse), else the list.
      const el = want.element ? document.getElementById(want.element) : null;
      if (el) return el.focus();
      if (listRef.current) return void listRef.current.focusRow(null);
    } else if (want !== "search" && listRef.current) return void listRef.current.focusRow(want.row);
    if (!focusSearch()) document.querySelector<HTMLElement>("main")?.focus();
  }, [pageOpen]);
  const { clear: clearPages, open: openPage } = nav;
  /** A sidebar click (or another way of going somewhere): the place changes and every page closes.
   *  Recently Added starts newest first; in Active, All / Active / Inactive is hidden and set to All. */
  const goToPlace = useCallback(
    (v: LibraryView) => {
      setView(v);
      if (v.kind === "recent") setRecentSort(RECENT_SORT);
      if (v.kind === "active") setStatus("any");
      clearPages();
    },
    [clearPages],
  );
  /** Browse on Google Fonts or Purchases: that service's own page, over its list. */
  const openCatalog = useCallback(
    (service: CatalogPageEntry["service"]) => {
      openPage({ kind: "catalog", service, returnTo: BROWSE_ID });
      announce(`Opened the ${SERVICE_LABELS[service]} page`);
    },
    [openPage, announce],
  );
  // ⌘F (Ctrl+F on Windows) goes to Search, leaving a font page if one is open. On the Google
  // Fonts catalog it goes to the catalog's own search, and on Purchases (no search) it does
  // nothing, so neither page closes and loses its place (nav.findIntent).
  const onTop = nav.pages[nav.pages.length - 1];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "f" || !(IS_MAC ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (settingsOpenRef.current || popupOpen()) return;
      switch (findIntent(onTop)) {
        case "list":
          if (focusSearch()) e.preventDefault();
          break;
        case "leave":
          e.preventDefault();
          pendingFocus.current = "search";
          clearPages();
          break;
        case "page": {
          e.preventDefault();
          const field = document.getElementById(onTop?.kind === "groups" ? GROUPS_SEARCH_ID : GOOGLE_SEARCH_ID);
          if (field instanceof HTMLInputElement) {
            field.focus();
            field.select();
          }
          break;
        }
        case null:
          e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onTop, clearPages]);

  // Another app (Typeface, Font Book) may have turned fonts on or off while this window was in
  // the background. Re-read the OS state when it comes back to the front.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        loadFonts().catch(() => {});
        // A watched folder that wasn't available (e.g. an unplugged drive) may be back.
        api.purchasesRetryWatch().catch(() => {});
      }, 300);
    });
    return () => {
      clearTimeout(timer);
      unlisten.then((fn) => fn());
    };
  }, [loadFonts]);

  const scan = useCallback(
    (folder: Folder, quiet = false): Promise<void> => {
      if (removedFolders.current.has(folder.id)) return Promise.resolve();
      // Already scanning it from this window: share that scan. (If the back end is scanning it for
      // an earlier window, scanFolder waits for that scan.)
      const inFlight = scanPromises.current.get(folder.id);
      if (inFlight) return inFlight;
      const run = runScan(folder, quiet).finally(() => scanPromises.current.delete(folder.id));
      scanPromises.current.set(folder.id, run);
      return run;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refresh, setScan, announce],
  );

  const runScan = async (folder: Folder, quiet: boolean) => {
    {
      activeScans.current.add(folder.id);
      const name = folder.label || fileName(folder.path);
      // Show the scanning state right away, before the first progress event arrives.
      setScan(folder.id, { folderId: folder.id, phase: "starting", found: 0, done: 0, cloud: 0, current: "" });
      if (!quiet) announce(`Scanning ${name}`);
      try {
        const r = await api.scanFolder(folder.id);
        activeScans.current.delete(folder.id);
        setScan(folder.id, null);
        await refresh();
        if (removedFolders.current.has(folder.id)) return;
        const changed = r.added + r.updated + r.removed > 0;
        const description = `${r.added.toLocaleString()} added · ${r.updated.toLocaleString()} updated · ${r.removed.toLocaleString()} removed`;
        if (r.cancelled) {
          toast.info(`Stopped scanning ${name}`, { description: "Fonts read so far are kept." });
        } else if (r.walkErrors > 0) {
          toast.warning(`${name}: some folders couldn't be opened`, {
            description: `${description}. Nothing was removed from the library because the scan was incomplete.`,
          });
        } else if (r.failed.length) {
          toast.warning(`${name}: ${r.failed.length.toLocaleString()} file(s) couldn't be read`, { description });
          for (const f of r.failed) console.warn("scan failure", f.path, f.reason);
        } else if (!quiet || changed) {
          toast.success(name, { description });
        }
        if (!quiet || changed || r.failed.length || r.walkErrors) announce(`Finished scanning ${name}`);
      } catch (e) {
        activeScans.current.delete(folder.id);
        setScan(folder.id, null);
        await refresh().catch(() => {});
        if (removedFolders.current.has(folder.id)) return;
        toast.error(`Couldn't scan ${name}`, { description: String(e) });
        announce(`Couldn't scan ${name}`);
      }
    }
  };

  /** Scans a folder after any scan already running on it, so files added meanwhile are seen. */
  const rescan = async (folder: Folder) => {
    await scanPromises.current.get(folder.id)?.catch(() => {});
    await scan(folder, true);
  };

  // Progress events drive the scanning UI, and keep the list filling in while a scan runs.
  useEffect(() => {
    const unlisten = listen<ScanProgress>("scan-progress", (e) => {
      const p = e.payload;
      if (!activeScans.current.has(p.folderId)) return;
      setScan(p.folderId, p);
      const now = performance.now();
      if (now - lastAnnounce.current > ANNOUNCE_MS) {
        const folder = foldersRef.current.find((f) => f.id === p.folderId);
        announce(`${folder?.label ?? "Folder"}: ${scanStatus(p)}`);
      }
      if (p.phase === "reading" && now - lastLiveRefresh.current > LIVE_REFRESH_MS) {
        lastLiveRefresh.current = now;
        loadFonts().catch(() => {});
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [loadFonts, setScan, announce]);

  // Preview profiles worked out at launch for fonts that had none. Rows on screen pick them up
  // as they arrive; when the backfill is done, the list reloads once so families can choose a
  // representative that draws its name.
  useEffect(() => listenForProfiles(() => loadFonts().catch(() => {})), [loadFonts]);

  // The purchases watcher found new font downloads. The listener is registered before the
  // first count, and only the newest count is applied.
  const purchaseCountSeq = useRef(0);
  const countNewPurchases = useCallback(() => {
    const my = ++purchaseCountSeq.current;
    api
      .purchasesStatus()
      .then((st) => my === purchaseCountSeq.current && setNewPurchases(st.finds.filter((f) => f.status === "new" && !f.missing).length))
      .catch(() => {});
  }, []);
  useEffect(() => {
    const unlisten = listen<number[]>("purchases-changed", (e) => {
      setPurchasesVersion((v) => v + 1);
      countNewPurchases();
      const n = e.payload.length;
      toast.info(n === 1 ? "New font download found" : `${n} new font downloads found`, {
        description: "Add them to your library from Purchases.",
        action: {
          label: "Review",
          onClick: () => {
            goToPlace({ kind: "service", id: "purchases" });
            openCatalog("purchases");
            // The page opens in the library, so leave settings if they're open. Its heading
            // takes focus, so focus doesn't go back to the Settings button.
            closeSettings({ restoreFocus: false });
          },
        },
      });
    });
    unlisten.then(() => countNewPurchases());
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [countNewPurchases, closeSettings, goToPlace, openCatalog]);

  // A folder view whose folder is gone (e.g. removed while a removal was still running) falls
  // back to All Fonts.
  useEffect(() => {
    setView((v) => (v.kind === "folder" && folders.length && !folders.some((f) => f.id === v.id) ? { kind: "all" } : v));
  }, [folders]);

  // At launch: load the library, then rescan every folder (macOS folders first) to catch changes.
  // With "Check folders for changes when Fontface opens" off, only folders with no fonts yet
  // (never scanned, or empty) are scanned.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        await refresh();
      } finally {
        setLibraryLoaded(true);
      }
      const { scanAtLaunch } = await settingsReady;
      for (const folder of await api.listFolders()) {
        if (!folder.missing && (scanAtLaunch || folder.fontCount === 0)) await scan(folder, true);
      }
    })().catch((e) => toast.error(String(e)));
  }, [refresh, scan, settingsReady]);

  // Settings that change what's on screen: the appearance, and the preview text and size (at
  // launch, and again whenever they're changed in settings).
  useEffect(() => {
    if (settings) applyTheme(settings.theme);
  }, [settings?.theme]);
  useEffect(() => {
    if (settings) setPreviewText(settings.previewText);
  }, [settings?.previewText]);
  useEffect(() => {
    if (settings) setSize(settings.previewSize);
  }, [settings?.previewSize]);

  // A view the sidebar no longer shows (its section was just hidden) falls back to All Fonts.
  const sidebarShows = settings?.sidebar ?? DEFAULT_SETTINGS.sidebar;
  const sidebarKey = JSON.stringify(sidebarShows);
  useEffect(() => {
    setView((v) => (hiddenBySidebar(v, sidebarShows, foldersRef.current, servicesRef.current) ? { kind: "all" } : v));
  }, [sidebarKey]);

  // "Ask me": fonts turned off while Fontface was closed are offered back once, at launch.
  useRestorePrompt(() => loadFonts().catch(() => {}));
  useSyncEvents(useCallback(() => void loadFonts().catch(() => {}), [loadFonts]));
  // Older fonts' "Added" dates, and the names family grouping reads (name IDs 16, 1, 2), worked
  // out once in the background (db::backfill_added_at, families::backfill_names).
  useEffect(() => {
    const unlisten = [listen("added-dates", () => loadFonts().catch(() => {})), listen("family-names", () => loadFonts().catch(() => {}))];
    return () => {
      for (const u of unlisten) u.then((fn) => fn()).catch(() => {});
    };
  }, [loadFonts]);
  // Your family choices (merge, keep separate, move), kept by Fontface.
  useEffect(() => {
    reloadFamilyChoices().catch((e) => toast.error("Couldn't read your family choices", { description: String(e) }));
  }, []);

  // Cmd+, (Ctrl+, on Windows) opens settings, or goes to their search field if they're open.
  // On macOS the app menu's Settings… item has ⌘, too and sends "open-settings". The page sees
  // the key first; preventDefault keeps the menu from acting on it as well, and if both ever
  // run, the second only focuses the search field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "," || !(IS_MAC ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      openSettingsByShortcut();
    };
    window.addEventListener("keydown", onKey);
    const unlisten = listen("open-settings", () => openSettingsByShortcut());
    return () => {
      window.removeEventListener("keydown", onKey);
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [openSettingsByShortcut]);

  const addFolder = async () => {
    const path = await open({ directory: true, multiple: false, title: "Add a font folder" });
    if (typeof path !== "string") return;
    try {
      const folder = await api.addFolder(path);
      await refresh();
      goToPlace({ kind: "folder", id: folder.id });
      await scan(folder);
    } catch (e) {
      toast.error("Couldn't add that folder", { description: String(e) });
    }
  };

  /** "Locate…" for a folder that moved: point it at the new place, then rescan it. */
  const relocate = async (folder: Folder) => {
    if (!(await locateFolder(folder))) return;
    await refresh().catch(() => {});
    const moved = (await api.listFolders()).find((f) => f.id === folder.id);
    if (moved) await scan(moved);
  };

  const removeFolder = async (folder: Folder) => {
    removedFolders.current.add(folder.id);
    mutationEpoch.current++;
    try {
      const failures = await api.removeFolder(folder.id);
      for (const f of failures) toast.error(`Couldn't turn off ${fileName(f.path)}`, { description: f.error });
      setView((v) =>
        (v.kind === "folder" && v.id === folder.id) || (v.kind === "location" && v.path.startsWith(`${folder.path}/`))
          ? { kind: "all" }
          : v,
      );
    } catch (e) {
      removedFolders.current.delete(folder.id);
      toast.error(String(e));
    } finally {
      mutationEpoch.current++;
      await refresh().catch(() => {});
    }
  };

  /**
   * Turns fonts on or off. Resolves with the files that ended up on (useful to check a request).
   * `scope` turns them on that way instead of the saved activation mode, and `origin` says why
   * (see bringIntoLibrary). Without them, it's the user's switch.
   */
  const setActivation = (
    ids: number[],
    active: boolean,
    knownPaths?: string[],
    scope: ActivationMode | null = null,
    origin: SwitchOrigin = "switch",
  ): Promise<Set<string>> => {
    if (ids.length === 0) return Promise.resolve(new Set());
    const paths = knownPaths ?? [...new Set(ids.map((id) => fontById.get(id)?.path).filter((p): p is string => !!p))];
    setBusy((b) => new Set([...b, ...paths]));
    const run = async (): Promise<Set<string>> => {
      mutationEpoch.current++;
      const on = new Set<string>();
      try {
        const outcomes = await api.setActivation(ids, active, scope, origin);
        for (const o of outcomes) {
          if (o.active) on.add(o.path);
          if (o.error) toast.error(fileName(o.path), { description: o.error });
        }
        // What the OS has and what Fontface recorded, which differ when another app keeps a font
        // on or macOS didn't load it: those states show now, not after the next reload.
        setFonts((list) => applyOutcomes(list, outcomes));
      } catch (e) {
        toast.error(String(e));
      } finally {
        mutationEpoch.current++;
        setBusy((b) => {
          const next = new Set(b);
          for (const p of paths) next.delete(p);
          return next;
        });
      }
      return on;
    };
    const queued = activationQueue.current.then(run, run);
    activationQueue.current = queued;
    return queued;
  };

  /** Turns off every font Fontface turned on (settings), in turn with other on/off requests. */
  const turnOffAll = () => {
    const run = async () => {
      mutationEpoch.current++;
      try {
        return await api.activationTurnOffAll();
      } finally {
        mutationEpoch.current++;
        await loadFonts().catch(() => {});
      }
    };
    const queued = activationQueue.current.then(run, run);
    activationQueue.current = queued;
    return queued;
  };

  // ------------------------------------------------------------------ services

  const googleFolder = folders.find((f) => f.id === services.find((s) => s.id === "google")?.folderId);

  /** Runs a Google Fonts operation with its busy state, then has the page reload. */
  const googleOp = async <T,>(id: string, op: () => Promise<T>): Promise<T> => {
    if (googleBusyRef.current.has(id)) throw new Error("Already working on that family");
    googleBusyRef.current.add(id);
    setGoogleBusy(new Set(googleBusyRef.current));
    try {
      return await op();
    } finally {
      googleBusyRef.current.delete(id);
      setGoogleBusy(new Set(googleBusyRef.current));
      setGoogleVersion((v) => v + 1);
    }
  };

  const serviceFolderNow = (id: ServiceId) =>
    foldersRef.current.find((f) => f.id === servicesRef.current.find((s) => s.id === id)?.folderId);
  const googleFolderNow = () => serviceFolderNow("google");

  /**
   * After a service copied files into `dir`: rescan its folder (once more if files are missing),
   * then turn the new fonts on, one copy per style like everywhere else in the library, and
   * check it worked. Throws a plain explanation if the files didn't fully reach the library or
   * didn't turn on. This isn't the user's switch (origin "arrival"): sync keeps a choice made for
   * a font on another computer, and shares as on only fonts nobody has chosen for yet. `pick`
   * narrows which new fonts to turn on (default: all of them). `scopeOf` says how each one turns
   * on: an update brings a font back the way the one it replaces was on (until logout, or to
   * stay), whatever the activation mode is now. Null: the saved mode.
   */
  const bringIntoLibrary = async (
    service: ServiceId,
    dir: string,
    files: string[],
    pick: (name: string, font: FontSummary) => boolean = () => true,
    scopeOf: (name: string, font: FontSummary) => ActivationMode | null = () => null,
  ) => {
    const verb = service === "google" ? "Downloaded" : "Added";
    const nameOf = (f: FontSummary) => f.path.slice(dir.length + 1);
    const read = async () => {
      const folder = serviceFolderNow(service);
      if (folder) await rescan(folder);
      // Font ids don't depend on on/off state, so a direct list is fine for picking them; the
      // displayed list is refreshed through the guarded loader below.
      const list = await api.listFonts();
      return { list, added: list.filter((f) => f.path.startsWith(`${dir}/`)) };
    };
    let { list, added } = await read();
    if (files.some((n) => !added.some((f) => nameOf(f) === n))) ({ list, added } = await read());
    if (added.length === 0) {
      throw new Error(`${verb}, but it isn't in the library yet. Quit and reopen Fontface to finish adding it.`);
    }
    const arrived = new Set(added.map(nameOf));

    // Faces with a new copy here; turn on one copy each, preferring the new one.
    const newIds = new Set(added.filter((f) => pick(nameOf(f), f)).map((f) => f.id));
    const faces = groupFamilies(list).flatMap((fam) => fam.faces).filter((face) => face.copies.some((c) => newIds.has(c.id)));
    const ids = activationIds(
      faces.map((face) => {
        const here = face.copies.filter((c) => newIds.has(c.id));
        return { ...face, primary: here[0], copies: here };
      }),
      true,
    );
    const wanted = list.filter((f) => ids.includes(f.id));
    const wantedFiles = new Set(wanted.map((f) => f.path));
    // One request per scope; they run in turn, through the same queue as every switch.
    const byScope = new Map<ActivationMode | null, FontSummary[]>();
    for (const f of wanted) {
      const scope = scopeOf(nameOf(f), f);
      byScope.set(scope, [...(byScope.get(scope) ?? []), f]);
    }
    const results = await Promise.all(
      [...byScope].map(([scope, group]) =>
        setActivation(
          group.map((f) => f.id),
          true,
          [...new Set(group.map((f) => f.path))],
          scope,
          "arrival",
        ),
      ),
    );
    const on = new Set(results.flatMap((s) => [...s]));
    await loadFonts();

    const turnedOn = [...wantedFiles].filter((p) => on.has(p)).length;
    const missing = files.filter((n) => !arrived.has(n));
    if (missing.length) {
      throw new Error(`${verb}, but only ${arrived.size} of ${files.length} files reached the library. Quit and reopen Fontface to finish.`);
    }
    if (wantedFiles.size && turnedOn === 0) throw new Error(`${verb}, but it couldn't be turned on. See the messages above.`);
    if (turnedOn < wantedFiles.size) throw new Error(`${verb}; ${turnedOn} of ${wantedFiles.size} files turned on. See the messages above.`);
  };

  /** Runs a purchase operation with its busy state, then has the Purchases page reload. */
  const purchaseOp = async (key: string, op: () => Promise<void>) => {
    if (purchaseBusyRef.current.has(key)) throw new Error("Already working on that");
    purchaseBusyRef.current.add(key);
    setPurchaseBusy(new Set(purchaseBusyRef.current));
    try {
      await op();
    } finally {
      purchaseBusyRef.current.delete(key);
      setPurchaseBusy(new Set(purchaseBusyRef.current));
      setPurchasesVersion((v) => v + 1);
      countNewPurchases();
    }
  };

  // A single font file may join a folder of its family: turn on only the files this import added.
  const importPurchase = (find: PurchaseFind, store: string | null) =>
    purchaseOp(`path:${find.path}`, async () => {
      const result = await api.purchasesImport(find.id, store);
      await bringIntoLibrary("purchases", result.dir, result.files, (name) => result.files.includes(name));
      toast.success(`Added ${find.contents.families[0] ?? find.name} to your library`);
    });

  const importPurchasePath = (path: string, store: string | null) =>
    purchaseOp(`path:${path}`, async () => {
      const result = await api.purchasesImportPath(path, store);
      await bringIntoLibrary("purchases", result.dir, result.files, (name) => result.files.includes(name));
      toast.success("Added to your library");
    });

  /**
   * Swaps a newer download in for an imported purchase, then turns the same faces back on (and
   * faces that are new in this version, if any were on). Nothing is turned on if it was all off.
   * Each face comes back on until logout, or to stay, as it was before (the back end works out
   * which, including for new faces).
   */
  const replacePurchase = (find: PurchaseFind, dir: string) =>
    purchaseOp(`path:${find.path}`, async () => {
      mutationEpoch.current++;
      let result;
      try {
        result = await api.purchasesReplace(find.id, dir);
      } finally {
        mutationEpoch.current++;
      }
      const wasOn = new Set(result.wasActiveFaces);
      const old = new Set(result.oldFaces);
      const temporary = new Set(result.temporaryFaces);
      await bringIntoLibrary(
        "purchases",
        result.dir,
        result.files,
        (_, font) => {
          const ps = font.postscriptName;
          return !!ps && (wasOn.has(ps) || (wasOn.size > 0 && !old.has(ps)));
        },
        (_, font) => (font.postscriptName && temporary.has(font.postscriptName) ? "temporary" : "persistent"),
      );
      toast.success(`Updated ${find.contents.families[0] ?? find.name} to the new version`);
    });

  const rescanPurchases = async () => {
    const folder = serviceFolderNow("purchases");
    if (folder) await rescan(folder).catch(() => {});
  };

  /** Removes an imported purchase. `transferred`: the license went to someone else. */
  const removePurchase = (item: PurchaseImported, transferred = false) =>
    purchaseOp(`dir:${item.dir}`, async () => {
      mutationEpoch.current++;
      try {
        await (transferred ? api.purchasesTransferred(item.dir) : api.purchasesRemove(item.dir));
      } finally {
        mutationEpoch.current++;
        await rescanPurchases();
      }
    });

  const purchaseSubscriptionEnded = (store: string, name: string) =>
    purchaseOp(`store:${store}`, async () => {
      mutationEpoch.current++;
      let report;
      try {
        report = await api.purchasesSubscriptionEnded(store);
      } finally {
        mutationEpoch.current++;
        await rescanPurchases();
      }
      const { removed, failed } = report;
      if (failed.length) {
        throw new Error(
          `Removed ${removed} of ${removed + failed.length}. Couldn't remove: ${failed.map(([n, why]) => `${n} (${why})`).join("; ")}`,
        );
      }
      toast.success(`Removed ${removed} ${name} ${removed === 1 ? "font set" : "font sets"}`);
    });

  /**
   * Downloads a Google Fonts family, adds it to the library, and turns it on. An update turns
   * back on exactly what was on before (nothing, if the family had been turned off), counting a
   * renamed file (e.g. statics rebuilt as a variable font) as the file it replaced, and the same
   * way as before: until logout, or to stay. A first download uses the activation mode. An update
   * in which nothing changed upstream left the fonts in place and on (`unchanged`): there's
   * nothing to add or turn on. Throws with a plain explanation if the family didn't fully reach
   * the library or didn't turn on.
   */
  const installGoogle = (id: string) =>
    googleOp(id, async () => {
      const result = await api.googleInstall(id);
      if (result.unchanged) return result;
      // An update turns back on exactly what was on before; a renamed file (e.g. statics rebuilt
      // as a variable font) counts as the file it replaced.
      const wasOn = new Set(result.wasActiveFiles);
      const old = new Set(result.oldFiles);
      const temporary = new Set(result.temporaryFiles);
      const renamedAway = result.wasActiveFiles.some((n) => !result.files.includes(n));
      await bringIntoLibrary(
        "google",
        result.dir,
        result.files,
        (name) => !result.updated || wasOn.has(name) || (renamedAway && !old.has(name)),
        (name) => (!result.updated ? null : temporary.has(name) ? "temporary" : "persistent"),
      );
      return result;
    });

  /** Updates families one at a time, skipping any already being worked on. */
  const updateAllGoogle = async (families: GoogleFamily[]) => {
    if (googleUpdatingAll) return;
    setGoogleUpdatingAll(true);
    let updated = 0;
    // Families in which nothing had changed upstream (left as they were).
    const current: string[] = [];
    try {
      for (const fam of families) {
        if (googleBusyRef.current.has(fam.id)) continue;
        try {
          if ((await installGoogle(fam.id)).unchanged) current.push(fam.family);
          else updated++;
        } catch (e) {
          toast.error(fam.family, { description: e instanceof Error ? e.message : String(e) });
        }
      }
    } finally {
      setGoogleUpdatingAll(false);
      const n = current.length;
      const were = n === 1 ? "was" : "were";
      if (updated) toast.success(`Updated ${updated} ${updated === 1 ? "family" : "families"}${n ? `; ${n} ${were} already up to date` : ""}`);
      else if (n === 1) toast.success(`${current[0]} is already up to date`);
      else if (n) toast.success(`${n} families were already up to date`);
    }
  };

  /** Turns a Google Fonts family off, deletes its files, and updates the library. */
  const removeGoogle = (id: string) =>
    googleOp(id, async () => {
      mutationEpoch.current++;
      try {
        await api.googleRemove(id);
      } finally {
        mutationEpoch.current++;
      }
      const folder = googleFolderNow();
      if (folder) await rescan(folder);
    });

  // Group the whole library once; views filter faces, so each Face keeps all of its copies.
  // Families group by name (unless that's off in Settings), and by your choices (familyGroups.ts).
  const familyChoices = useFamilyChoices();
  const groupByName = settings?.groupByName ?? DEFAULT_SETTINGS.groupByName;
  const grouping = useMemo<GroupingOptions>(
    () => ({ byName: groupByName, choices: familyChoices.choices, rules: familyChoices.rules }),
    [groupByName, familyChoices.choices, familyChoices.rules],
  );
  const library = useMemo(() => groupLibrary(fonts, grouping), [fonts, grouping]);
  const allFamilies = library.families;
  const fontById = useMemo(() => new Map(fonts.map((f) => [f.id, f])), [fonts]);
  // Per-folder style counts, matching what each folder's view lists.
  const folderCounts = useMemo(() => {
    const map = new Map<number, number>();
    for (const family of allFamilies)
      for (const face of family.faces)
        for (const id of new Set(face.copies.map((c) => c.folderId))) map.set(id, (map.get(id) ?? 0) + 1);
    return map;
  }, [allFamilies]);
  // Tags narrow tag views (and Not Tagged) and are searched too; Recently Added goes back 30
  // days from now; a service's view lists its managed folder. Location colors show on rows.
  const tagContext = useFilterContext();
  const since = recentSince(useHourNow());
  const filterContext = useMemo<FilterContext>(
    () => ({ ...tagContext, recentSince: since, serviceFolder: (id) => services.find((s) => s.id === id)?.folderId ?? undefined }),
    [tagContext, since, services],
  );
  const locations = useLocations(folders, services);
  // A setting: All Fonts can leave out fonts that are only in the OS's font folders.
  const hideInstalled = settings ? !settings.showInstalledInAll : false;
  // In Active, All / Active / Inactive would add nothing: it's hidden there, and counts as All.
  const listStatus: StatusFilter = view.kind === "active" ? "any" : status;
  const filtered = useMemo(
    () => filterFamilies(allFamilies, view, { status: listStatus, query, variableOnly, hideInstalled }, filterContext),
    [allFamilies, view, listStatus, query, variableOnly, hideInstalled, filterContext],
  );
  // The View options (settings): layout, grouping, sort and the Table's columns. Grouping off
  // lists every style on its own; the sort runs after filtering.
  const { layout, groupStyles, sort: savedSort, tableColumns, tableDensity } = settings ?? DEFAULT_SETTINGS;
  // Recently Added has a sort of its own (newest first to start with); everywhere else uses the saved one.
  const sort = view.kind === "recent" ? recentSort : savedSort;
  // The Source sort goes by the place the Table's Source column names first.
  const sortContext = useMemo(() => ({ sourceOf: (f: Family) => familySources(f, locations.sourceOf)[0] ?? "" }), [locations]);
  const families = useMemo(
    () => sortFamilies(groupStyles ? filtered : ungroup(filtered), sort, sortContext),
    // Only the Source sort reads where fonts are, so a location color change doesn't re-sort.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, groupStyles, sort.key, sort.desc, sort.key === "source" ? sortContext : null],
  );
  const { update: updateSettings } = settingsStore;
  // "On until logout" says "until you quit Fontface" when quitting turns those fonts off.
  const untilQuit = settings?.clearTemporaryOnQuit ?? false;
  const stateWording = useMemo<StateWording>(() => ({ untilQuit }), [untilQuit]);
  const chooseLayout = useCallback(
    (next: LibraryLayout) => {
      updateSettings({ layout: next });
      announce(`${layoutInfo(next).label} layout`);
    },
    [updateSettings, announce],
  );
  const chooseSort = (next: SortOrder) => {
    if (view.kind === "recent") setRecentSort(next);
    else updateSettings({ sort: next });
    announce(describeSort(next));
  };
  const chooseGrouping = (on: boolean) => {
    updateSettings({ groupStyles: on });
    announce(on ? "Styles grouped into families" : "Every style listed on its own");
  };
  // Cmd+1/2/3 pick the layout and Cmd+= / Cmd+- step the preview size (Ctrl on Windows), while
  // the library list is showing (not under settings, a page or a service's own page). Like Cmd+F
  // and Back, they wait while a menu, dialog or popover is open (the list it hands focus back to
  // would be gone) and during a drag (the rows being dragged would change under it).
  const adobePage = view.kind === "service" && view.id === "adobe";
  const listShowing = !settingsOpen && !pageOpen && !adobePage;
  useEffect(() => {
    if (!listShowing) return;
    const onKey = (e: KeyboardEvent) => {
      if (popupOpen() || isDragging()) return;
      const next = layoutShortcut(e, IS_MAC);
      if (next) {
        e.preventDefault();
        // Holding the keys down picks it once.
        if (!e.repeat) chooseLayout(next);
        return;
      }
      const step = sizeShortcut(e, IS_MAC);
      if (step) {
        e.preventDefault();
        const to = stepSize(sizeRef.current, step);
        // Already at the end: nothing changes, so nothing to say.
        if (to === sizeRef.current) return;
        sizeRef.current = to;
        setSize(to);
        announce(`Preview size ${to} pixels`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listShowing, chooseLayout, announce]);
  // A font page finds its family by face key, whatever the list shows (filters don't apply there).
  const familyOfFace = useMemo(() => {
    const map = new Map<string, Family>();
    for (const family of allFamilies) for (const face of family.faces) map.set(face.key, family);
    return map;
  }, [allFamilies]);
  const tagIndex = useTagIndex();
  // What Back goes back to, in words.
  const placeName = placeLabel(view, { folders, fontBook: INSTALLED_LABEL, tagName: (id) => leafOf(tagIndex.byId.get(id)?.name ?? "") || undefined });
  placeNameRef.current = placeName;
  /** What Back from the page at `i` returns to, in words: the font page under it, or the place. */
  const pageUnder = (i: number) => {
    const under = i > 0 ? nav.pages[i - 1] : undefined;
    return under?.kind === "font" ? (familyOfFace.get(under.styleKey) ?? familyOfFace.get(under.faceKey))?.name ?? placeName : placeName;
  };
  const styleCount = useMemo(() => filtered.reduce((n, f) => n + f.faces.length, 0), [filtered]);
  const { hasOwnTag } = filterContext;
  const counts = useMemo(() => placeCounts(allFamilies, { hideInstalled, recentSince: since, hasOwnTag }), [allFamilies, hideInstalled, since, hasOwnTag]);
  // The source this view shows (its sidebar row), its library folders, and whether the toolbar
  // offers its subfolders.
  const source = sourceOf(view, folders, services);
  const sourceKey = source ? `${source}:${sourceFolders(source, folders, services).map((f) => `${f.id}=${f.path}`).join(",")}` : "";
  const sourceRoots = useMemo(() => (source ? sourceFolders(source, folders, services) : []), [sourceKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const offerSubfolders = useMemo(() => sourceRoots.length > 0 && (view.kind === "location" || hasSubfolders(sourceRoots, allFamilies)), [sourceRoots, allFamilies, view.kind]);
  const browseService = source === "google" || source === "purchases" ? source : null;
  // A source's view shows only its own folders' scans: Google Fonts or Purchases with nothing in
  // the library yet (no folder) keeps offering Browse while another folder is scanned. Other
  // places can gain fonts from any scan.
  const viewScan = source ? sourceRoots.map((f) => scans.get(f.id)).find(Boolean) : [...scans.values()][0];
  const resetKey = `${viewKey(view)}:${listStatus}:${variableOnly}:${query}`;
  // Empty list with filters on: say which fonts were asked for, e.g. "No active variable fonts here."
  const filtersOn = !!query || listStatus !== "any" || variableOnly;
  const kinds = [listStatus !== "any" && listStatus, variableOnly && "variable", "fonts"].filter(Boolean).join(" ");
  const where = view.kind === "tag" ? " with this tag" : view.kind === "location" ? " in this folder" : "";
  const noMatch = query ? `No ${kinds}${where} match “${query}”.` : `No ${kinds}${where || " here"}.`;

  // "Open where you left off": the view and filters are saved as they change, and reopened at launch.
  useLastView({
    settings,
    libraryLoaded,
    folders,
    services,
    families: allFamilies,
    current: { view, status, variableOnly },
    apply: (last) => {
      setView(last.view);
      setStatus(last.status);
      setVariableOnly(last.variableOnly);
    },
  });

  const toggleExpanded = (familyId: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(familyId)) next.delete(familyId);
      else next.add(familyId);
      return next;
    });

  /** Double-click or Return on a row: the family's page, on the last tab used. */
  const openFont = (r: OpenRequest) => {
    nav.open({ kind: "font", faceKey: r.faceKey, styleKey: r.styleKey, tab: settings?.fontPageTab ?? "specimen", returnTo: r.rowKey });
    announce(`Opened ${r.name}`);
  };
  const revealFont = (id: number) => api.revealFont(id).catch((e) => toast.error(String(e)));

  /** Family groups: from View options, a font's menus or Settings, on some fonts or on all. */
  const openFamilyGroups = useCallback<OpenFamilyGroups>(
    (faces, options = {}) => {
      const focus = faces?.map((f) => f.key) ?? [];
      const filter: GroupsFilter = options.filter ?? "all";
      nav.open({ kind: "groups", filter, focus, returnTo: options.returnTo ? { element: options.returnTo } : null });
      announce(filter === "suggested" ? "Opened Family groups, on the suggestions" : "Opened Family groups");
      closeSettings({ restoreFocus: false });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nav.open, announce, closeSettings],
  );
  // How many suggestions Settings › Library mentions: worked out only while settings are open.
  const familySuggestions = useMemo(
    () => (settingsOpen ? suggestGroups(library.families, library.plan, grouping).length : 0),
    [settingsOpen, library, grouping],
  );

  return (
    <SettingsContext.Provider value={settingsStore}>
      <FamilyGroupsContext.Provider value={openFamilyGroups}>
      <StateWordingContext.Provider value={stateWording}>
      <TooltipProvider>
        <div className="relative h-full">
          {/* While settings are open, the library stays as it was, hidden and out of reach underneath. */}
          <div inert={settingsOpen} className={cn("grid h-full grid-cols-[240px_1fr]", settingsOpen && "invisible")}>
            <Sidebar
              folders={folders}
              counts={counts}
              folderCounts={folderCounts}
              families={allFamilies}
              services={services}
              adobeCount={adobeCount}
              newPurchases={newPurchases}
              view={view}
              scans={scans}
              show={sidebarShows}
              onView={goToPlace}
              // Falling back to All Fonts (the viewed tag was deleted or hidden) keeps an open
              // page, like the other fallbacks.
              onFallback={setView}
              onAddFolder={addFolder}
              onRemoveFolder={setPendingRemoval}
              onRescan={(f) => scan(f)}
              onCancelScan={(f) => api.cancelScan(f.id).catch((e) => toast.error(String(e)))}
              onOpenSettings={openSettings}
              onLocateFolder={relocate}
              onRevealFolder={(f) => api.revealFolder(f.id).catch((e) => toast.error(`Couldn't show ${f.label}`, { description: String(e) }))}
            />
            <main className="relative flex min-h-0 min-w-0 flex-col outline-none" tabIndex={-1}>
              {/* The list layer: the place picked in the sidebar. While a page is open it stays as it
                  was (scroll, selection, loaded previews), hidden and out of reach underneath. */}
              <div inert={pageOpen} className={cn("flex min-h-0 flex-1 flex-col", pageOpen && "invisible")}>
              {adobePage ? (
                <AdobeFontsPanel previewText={previewText} onStatus={(st) => setAdobeCount(st.faces.length)} />
              ) : (
              <>
              <Toolbar
                query={query}
                onQuery={setQuery}
                previewText={previewText}
                onPreviewText={setPreviewText}
                status={listStatus}
                onStatus={setStatus}
                showStatus={view.kind !== "active"}
                variableOnly={variableOnly}
                onVariableOnly={setVariableOnly}
                size={size}
                onSize={setSize}
                familyCount={filtered.length}
                fontCount={styleCount}
                layout={layout}
                onLayout={chooseLayout}
                subfolders={
                  source && offerSubfolders ? (
                    <SubfolderPicker
                      sourceLabel={placeLabel(sourceView(source), { folders, fontBook: INSTALLED_LABEL, tagName: () => undefined })}
                      roots={sourceRoots}
                      families={allFamilies}
                      selected={view.kind === "location" ? view.path : null}
                      locations={locations}
                      onPick={(path) => goToPlace(path === null ? sourceView(source) : { kind: "location", path })}
                    />
                  ) : undefined
                }
                browse={browseService ? <BrowseButton service={browseService} newPurchases={newPurchases} onBrowse={openCatalog} /> : undefined}
                viewOptions={
                  <ViewOptions
                    layout={layout}
                    onLayout={chooseLayout}
                    groupStyles={groupStyles}
                    onGroupStyles={chooseGrouping}
                    sort={sort}
                    onSort={chooseSort}
                    density={tableDensity}
                    onDensity={(d) => updateSettings({ tableDensity: d })}
                    columns={tableColumns}
                    onColumns={(c) => updateSettings({ tableColumns: c })}
                    onFamilyGroups={() => openFamilyGroups()}
                  />
                }
              />
              {families.length > 0 ? (
                <LibraryPane
                  ref={listRef}
                  layout={layout}
                  families={families}
                  orderKey={`${groupStyles}:${sort.key}:${sort.desc}`}
                  expanded={expanded}
                  onToggleExpanded={toggleExpanded}
                  previewText={previewText}
                  size={size}
                  busy={busy}
                  resetKey={resetKey}
                  allFamilies={allFamilies}
                  locations={locations}
                  onActivate={setActivation}
                  onOpen={openFont}
                  showAdded={view.kind === "recent"}
                  table={{
                    sort,
                    onSort: chooseSort,
                    columns: tableColumns,
                    onColumns: (c) => updateSettings({ tableColumns: c }),
                    density: tableDensity,
                  }}
                />
              ) : viewScan ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                  <Icon name="progress_activity" size={32} className="animate-spin text-muted-foreground" />
                  <h2 className="text-lg font-semibold">Scanning fonts…</h2>
                  <p className="font-mono text-xs text-muted-foreground tabular-nums">{scanStatus(viewScan)}</p>
                  {viewScan.cloud > 0 && (
                    <p className="max-w-sm text-sm text-muted-foreground">
                      {viewScan.cloud.toLocaleString()} files are online-only, so each one downloads before it can be read.
                      Fonts appear here as they're ready.
                    </p>
                  )}
                </div>
              ) : filtersOn ? (
                <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">{noMatch}</div>
              ) : (
                <EmptyPlace view={view} libraryEmpty={allFamilies.length === 0} onAddFolder={addFolder} onBrowse={openCatalog} />
              )}
              </>
              )}
              </div>
              {/* The page layer: only the top page shows; any under it stay as they were. */}
              {nav.pages.map((page, i) => {
                const covered = i < nav.pages.length - 1;
                return (
                  <div
                    key={page.id}
                    inert={covered}
                    data-page-top={covered ? undefined : ""}
                    className={cn("absolute inset-0 flex flex-col bg-background", covered && "invisible")}
                  >
                    {page.kind === "groups" ? (
                      <FamilyGroupsPage
                        page={page}
                        library={library}
                        grouping={grouping}
                        placeName={pageUnder(i)}
                        locations={locations}
                        onBack={nav.back}
                        onFilter={(filter) => nav.update(page.id, { filter })}
                        announce={announce}
                      />
                    ) : page.kind === "catalog" ? (
                      <CatalogPage placeName={placeName} onBack={nav.back}>
                        {(back) =>
                          page.service === "google" ? (
                            <GoogleFontsPanel
                              fonts={googleFolder ? fonts.filter((f) => f.folderId === googleFolder.id) : []}
                              previewText={previewText}
                              busy={googleBusy}
                              version={googleVersion}
                              updatingAll={googleUpdatingAll}
                              onInstall={installGoogle}
                              onRemove={removeGoogle}
                              onUpdateAll={updateAllGoogle}
                              back={back}
                            />
                          ) : (
                            <PurchasesPanel
                              version={purchasesVersion}
                              busy={purchaseBusy}
                              onStatus={(st) => setNewPurchases(st.finds.filter((f) => f.status === "new" && !f.missing).length)}
                              onImport={importPurchase}
                              onImportPath={importPurchasePath}
                              onReplace={replacePurchase}
                              onRemove={removePurchase}
                              onSubscriptionEnded={purchaseSubscriptionEnded}
                              back={back}
                            />
                          )
                        }
                      </CatalogPage>
                    ) : (
                    <FontPage
                      page={page}
                      family={familyOfFace.get(page.styleKey) ?? familyOfFace.get(page.faceKey)}
                      placeName={placeName}
                      previewText={previewText}
                      busy={busy}
                      locations={locations}
                      onBack={nav.back}
                      onChange={(patch) => {
                        nav.update(page.id, patch);
                        if (patch.tab && patch.tab !== settings?.fontPageTab) settingsStore.update({ fontPageTab: patch.tab });
                      }}
                      onActivate={setActivation}
                      onReveal={revealFont}
                    />
                    )}
                  </div>
                );
              })}
            </main>
          </div>
          {settingsOpen && (
            <SettingsScreen
              section={settingsSection}
              onSection={setSettingsSection}
              onClose={closeSettings}
              fonts={fonts}
              userFolders={folders.filter((f) => f.kind === "user").length}
              onAddFolder={addFolder}
              onTurnOffAll={turnOffAll}
              onPurchasesChanged={() => {
                // The Purchases page may be open underneath; have it read its state again.
                setPurchasesVersion((v) => v + 1);
                countNewPurchases();
              }}
              onOpenPurchases={() => {
                goToPlace({ kind: "service", id: "purchases" });
                openCatalog("purchases");
                // The page's heading takes focus (not the Settings button).
                closeSettings({ restoreFocus: false });
              }}
              familySuggestions={familySuggestions}
              onReviewFamilyGroups={() => openFamilyGroups(undefined, { filter: "suggested" })}
            />
          )}
        </div>

        {/* Tag dialogs (new, rename, delete, find, import, export) can be asked for from anywhere. */}
        <TagDialogHost
          families={allFamilies}
          onDeleted={(ids) => setView((v) => (v.kind === "tag" && ids.includes(v.id) ? { kind: "all" } : v))}
        />

        <AlertDialog open={pendingRemoval !== null} onOpenChange={(o) => !o && setPendingRemoval(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove “{pendingRemoval?.label}”?</AlertDialogTitle>
              <AlertDialogDescription>
                Its fonts will be turned off and removed from the library. The files on disk are not touched.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  if (pendingRemoval) removeFolder(pendingRemoval);
                  setPendingRemoval(null);
                }}
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Toaster position="bottom-right" theme={dark ? "dark" : "light"} />
        {/* One calm, always-present live region for screen readers. */}
        <div role="status" aria-live="polite" className="sr-only">
          {announcement}
        </div>
      </TooltipProvider>
      </StateWordingContext.Provider>
      </FamilyGroupsContext.Provider>
    </SettingsContext.Provider>
  );
}

/** Browse, on Google Fonts and Purchases: opens the service's own page (the catalog, or new
 *  downloads and imports) over the list, with Back. Purchases shows how many downloads are new. */
function BrowseButton({ service, newPurchases, onBrowse }: { service: CatalogPageEntry["service"]; newPurchases: number; onBrowse: (service: CatalogPageEntry["service"]) => void }) {
  const google = service === "google";
  const fresh = !google && newPurchases > 0;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            id={BROWSE_ID}
            variant="outline"
            size="sm"
            className="shrink-0"
            aria-label={google ? "Browse Google Fonts" : `Browse purchases${fresh ? `, ${newPurchases.toLocaleString()} new ${newPurchases === 1 ? "download" : "downloads"}` : ""}`}
            onClick={() => onBrowse(service)}
          />
        }
      >
        <Icon name={google ? "travel_explore" : "storefront"} size={16} />
        <span className="@max-[1000px]/toolbar:hidden">Browse</span>
        {fresh && (
          <span aria-hidden className="rounded-full bg-primary px-1.5 font-mono text-[11px] text-primary-foreground tabular-nums">
            {newPurchases.toLocaleString()}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent>{google ? "Browse and download Google Fonts" : "Review new downloads, import fonts you bought, and manage watched folders"}</TooltipContent>
    </Tooltip>
  );
}

/** What an empty place says, with a way to fill it where there is one. */
function EmptyPlace({
  view,
  libraryEmpty,
  onAddFolder,
  onBrowse,
}: {
  view: LibraryView;
  /** No fonts at all yet. */
  libraryEmpty: boolean;
  onAddFolder: () => void;
  onBrowse: (service: CatalogPageEntry["service"]) => void;
}) {
  const quiet = (text: string) => <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">{text}</div>;
  if (view.kind === "service" && view.id !== "adobe") {
    const google = view.id === "google";
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name={google ? "cloud" : "shopping_bag"} size={40} weight={300} className="text-muted-foreground" />
        <h2 className="text-lg font-semibold">{google ? "No Google Fonts in your library yet" : "No purchased fonts in your library yet"}</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          {google
            ? "Browse Google Fonts to download free fonts. They're added here and turned on."
            : "Browse your purchases to add fonts you bought, from your downloads or from a zip or folder."}
        </p>
        <Button onClick={() => onBrowse(view.id as CatalogPageEntry["service"])}>
          <Icon name={google ? "travel_explore" : "storefront"} size={16} />
          {google ? "Browse Google Fonts" : "Browse Purchases"}
        </Button>
      </div>
    );
  }
  if (!libraryEmpty) {
    switch (view.kind) {
      case "tag":
        return quiet("No fonts have this tag yet. Select fonts in another view, then tag them from the tag button or by right-clicking.");
      case "location":
      case "folder":
        return quiet("No fonts in this folder.");
      case "recent":
        return quiet("No fonts were added in the last 30 days.");
      case "active":
        return quiet(`No fonts are on right now, apart from the ones ${IS_MAC ? "macOS" : "Windows"} always keeps on.`);
      case "untagged":
        return quiet("Every font has at least one of your tags.");
      case "installed":
        return quiet(`No fonts are installed in ${IS_MAC ? "macOS" : "Windows"}'s font folders.`);
    }
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <Icon name="font_download" size={40} weight={300} className="text-muted-foreground" />
      <h2 className="text-lg font-semibold">{view.kind === "yours" && !libraryEmpty ? "No fonts of your own yet" : "No fonts here yet"}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">Add a folder of fonts. Fontface reads them where they are. Nothing is copied or moved.</p>
      <Button onClick={onAddFolder}>
        <Icon name="create_new_folder" size={16} />
        Add Folder…
      </Button>
    </div>
  );
}
