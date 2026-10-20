import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  api,
  type ActivationMode,
  type ActivationOutcome,
  type Folder,
  type RemoveReport,
  type FontPageTab,
  type FontSummary,
  type GoogleFamily,
  type GoogleRemoved,
  type LibraryLayout,
  type PreviewOptions,
  type PurchaseFind,
  type PurchaseImported,
  type PurchasesStatus,
  type ScanProgress,
  type ServiceId,
  type ServiceInfo,
  type SkippedFiles,
  type SortOrder,
  type SwitchOrigin,
  type TemporaryOffReport,
} from "@/api";
import {
  activationIds,
  filterFamilies,
  groupFamilies,
  groupLibrary,
  warmUpGrouping,
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
import { hiddenBySidebar, placeLabel, SERVICE_LABELS, sourceFolders, sourceOf } from "@/places";
import { describeSort, layoutInfo, layoutShortcut, sizeShortcut, sortInfo, stepSize } from "@/viewOptions";
import {
  commandName,
  compareKeysOf,
  createShortcutGuard,
  fontActionStates,
  fontShortcut,
  menuCommand,
  menuStateKey,
  nativeMenuState,
  pageTarget,
  postScriptNames,
  removalPlan,
  revealFontOf,
  scopeOf,
  viewCommands,
  type ActionContext,
  type FontActionId,
  type FontTarget,
  type MenuCommand,
} from "@/fontActions";
import { compareList } from "@/compare";
import { copyText } from "@/lib/clipboard";
import { byIdOnTop, focusBack as noteFocus } from "@/focusReturn";
import { familySources } from "@/familyFacts";
import { applyOutcomes } from "@/fontState";
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
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Sidebar, currentSidebarRow, scanStatus } from "@/components/Sidebar";
import { LIBRARY_SEARCH_ID, Toolbar } from "@/components/Toolbar";
import { LibraryPane, type ListHandle, type OpenRequest } from "@/components/library/LibraryPane";
import { FontActionsContext, type FontActionsApi } from "@/components/FontActions";
import { FontPickerContext, FontPickerDialog, type PickRequest } from "@/components/FontPicker";
import { ComparePage, type FaceRef } from "@/components/ComparePage";
import { PairPage } from "@/components/PairPage";
import { RemoveFontsDialog, type RemovalRequest } from "@/components/RemoveFontsDialog";
import { SKIPPED_DETAILS_TIP, SkippedFilesDialog, type SkippedRequest } from "@/components/SkippedFilesDialog";
import { skippedSummary } from "@/skippedFiles";
import { newPurchaseCount } from "@/purchaseWatch";
import { REVEAL_LABEL } from "@/components/fontPage/InfoTab";
import { ViewOptions } from "@/components/ViewOptions";
import { PreviewStyleContext, usePreviewStyleValue } from "@/components/PreviewStyle";
import { FontPage } from "@/components/fontPage/FontPage";
import { BackButton } from "@/components/fontPage/PageHeader";
import { Tip, TIP_DELAY, TIP_INSTANT_WINDOW } from "@/components/Tip";
import { StateWordingContext, type SwitchWording } from "@/components/ActivationSwitch";
import { GOOGLE_SOURCE, GoogleFontsPanel, GoogleFooterNote } from "@/components/GoogleFontsPanel";
import { useGoogleView } from "@/components/google/useGoogleView";
import { ChoiceGroup } from "@/components/ChoiceGroup";
import { CATALOG_SHOWS } from "@/googleCatalog";
import { catalogCountText, libraryCountText } from "@/footerCounts";
import { FOOTER_RAIL_HEIGHT, ListFrame } from "@/components/FooterRail";
import { PREVIEW_BAR_SPACE, PreviewBar } from "@/components/PreviewBar";
import { AdobeFontsPanel } from "@/components/AdobeFontsPanel";
import { PurchasesPanel } from "@/components/PurchasesPanel";
import { IS_MAC, type PageBack } from "@/components/TitleBar";
import { cancelDrag, isDragging } from "@/tags/drag";
import { locateFolder } from "@/tags/locate";
import { useLocations } from "@/tags/locations";
import { leafOf, useFilterContext, useTagIndex } from "@/tags/model";
import { openTagDialog } from "@/tags/dialogs";
import { TagDialogHost } from "@/tags/TagDialogs";
import { temporaryOffMessage } from "@/trayMenu";
import { useLastView } from "@/settings/lastView";
import type { SectionId } from "@/settings/parts";
import { useRestorePrompt } from "@/settings/restorePrompt";
import { SETTINGS_SEARCH_ID, SettingsScreen } from "@/settings/SettingsView";
import { applyTheme, useDarkTheme } from "@/settings/theme";
import { DEFAULT_SETTINGS, SettingsContext, useSettingsStore } from "@/settings/useSettings";
import { useSyncEvents } from "@/sync/store";
import { popupOpen, useNav } from "@/useNav";
import { findIntent, type CatalogPageEntry, type GroupsFilter, type Page, type PageReturn } from "@/nav";
import type { GroupingOptions } from "@/familyGroups";
import { FamilyGroupsContext, reloadFamilyChoices, useFamilyChoices, type OpenFamilyGroups } from "@/families/store";
import { FamilyGroupsPage, GROUPS_SEARCH_ID } from "@/components/FamilyGroupsPage";

const fileName = (path: string) => path.split("/").pop() || path;
/** While a scan runs, reload the font list at most this often so new fonts appear as they're read. */
const LIVE_REFRESH_MS = 4000;
/** Screen readers hear scan progress at most this often (plus start and finish). */
const ANNOUNCE_MS = 15000;
/** Recently Added starts newest first, whatever the library's sort is (see `chooseSort`). */
const RECENT_SORT: SortOrder = { key: "added", desc: true };
/** The Browse button on Purchases: focus comes back to it from its page. */
const BROWSE_ID = "browse-service";
/** Toasts stack above the footer rail and the preview bar (bottom right, where the bar's Paper
 *  and Reset and the rail's source line are), so an Undo never covers them. */
const TOAST_OFFSET = { bottom: FOOTER_RAIL_HEIGHT + PREVIEW_BAR_SPACE };
/** The layouts the Google Fonts view can't show yet, and why (the toolbar greys them out). */
const GOOGLE_LAYOUTS = {
  tiles: "Google Fonts shows as rows. Tiles aren't available here yet.",
  table: "Google Fonts shows as rows. The table isn't available here yet.",
} as const;

/** Unix seconds now, to the hour: Recently Added's 30 days move on while Fontface stays open. */
function useHourNow(): number {
  const [hour, setHour] = useState(() => Math.floor(Date.now() / 3_600_000));
  useEffect(() => {
    const timer = setInterval(() => setHour(Math.floor(Date.now() / 3_600_000)), 60_000);
    return () => clearInterval(timer);
  }, []);
  return hour * 3600;
}

/** The element (by id) focus goes back to when `closed` is closed with pages left under it: the
 *  button that opened it there (More on a font page, a Compare lane's name), else none (the
 *  page's heading). */
function returnElement(closed: Page): string | null {
  if (closed.kind === "font") return closed.returnTo;
  if (closed.kind === "catalog") return null;
  return closed.returnTo && "element" in closed.returnTo ? closed.returnTo.element : null;
}

/**
 * Focuses an element on a layer that was hidden until this render (the list, or a page that was
 * covered: `invisible`). A button there (`transition-all`) eases into being visible like any other
 * property, and while that has only just started it's still hidden and can't take focus. So its
 * transition is skipped for the moment it takes focus.
 */
function focusShown(el: HTMLElement) {
  el.focus({ preventScroll: true });
  if (document.activeElement === el) return;
  const transition = el.style.transition;
  el.style.transition = "none";
  void getComputedStyle(el).visibility;
  el.focus({ preventScroll: true });
  el.style.transition = transition;
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
  /** The source whose skipped files are listed (Show Skipped Files…, or a scan's Details). */
  const [skippedList, setSkippedList] = useState<SkippedRequest | null>(null);
  const showSkipped = useCallback((name: string, skipped: SkippedFiles) => setSkippedList({ name, skipped, returnFocus: noteFocus() }), []);
  /** Files with an on/off request queued or in progress. The OS acts on whole files, so every
   *  style with a copy in one of these files shows as busy. */
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [adobeCount, setAdobeCount] = useState<number | null>(null);
  /** Google Fonts families with a download or removal in progress (kept here, so leaving and
   *  returning to the Google page still shows them). */
  const [googleBusy, setGoogleBusy] = useState<Set<string>>(new Set());
  /** Bumped after each Google Fonts change, so the Google Fonts view reloads its catalog. */
  const [googleVersion, setGoogleVersion] = useState(0);
  const [googleUpdatingAll, setGoogleUpdatingAll] = useState(false);
  /** The same busy set, readable synchronously (so two clicks can't both start). */
  const googleBusyRef = useRef(new Set<string>());
  /** Purchases: bumped when the watcher finds something or an import/removal finishes. */
  const [purchasesVersion, setPurchasesVersion] = useState(0);
  const [newPurchases, setNewPurchases] = useState(0);
  /** Whether watching for purchases is on (from the last status). While off, nothing checks the folders. */
  const purchasesWatching = useRef(false);
  const onPurchasesStatus = useCallback((st: PurchasesStatus) => {
    purchasesWatching.current = st.watching;
    setNewPurchases(newPurchaseCount(st));
  }, []);
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
  const [loadFonts] = useState(() =>
    newestWins(
      () => {
        const list = api.listFonts();
        // While the first list is on its way: the grouping code gets compiled (library.ts).
        warmUpGrouping();
        return list;
      },
      setFonts,
      () => mutationEpoch.current,
    ),
  );

  const refresh = useCallback(async () => {
    const [f, svc] = await Promise.all([api.listFolders(), api.listServices(), loadFonts()]);
    setFolders(f);
    setServices(svc);
  }, [loadFonts]);

  // Settings open over the library (which stays as it was underneath). Focus comes back to
  // where it was, or to the sidebar's current place.
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
   *  back to where it was a frame later would pull it off the page). */
  const closeSettings = useCallback(({ restoreFocus = true }: { restoreFocus?: boolean } = {}) => {
    if (!settingsOpenRef.current) return;
    setSettingsOpen(false);
    if (!restoreFocus) {
      focusBack.current = null;
      return;
    }
    requestAnimationFrame(() => {
      const back = focusBack.current;
      const target = back instanceof HTMLElement && back.isConnected && back !== document.body ? back : currentSidebarRow();
      target?.focus();
    });
  }, []);

  // ------------------------------------------------------------------ pages and Back

  // Pages (the font page) open over the list, which stays as it was underneath (see nav.ts).
  // Back puts focus on the row that opened the page; ⌘F leaves a font page for Search.
  const listRef = useRef<ListHandle>(null);
  const pendingFocus = useRef<{ row: string | null } | { element: string | null } | "search" | null>(null);
  const placeNameRef = useRef("All Fonts");
  // A shortcut that's also a macOS menu item (Back, the layouts, the sizes, the Font menu) can
  // reach both the page's key handler and the menu: the second of the two is dropped.
  const [shortcutGuard] = useState(() => createShortcutGuard());
  const nav = useNav({
    // Settings over the page take Esc themselves; a drag takes Esc to cancel.
    blocked: () => settingsOpenRef.current || isDragging(),
    allowKeyBack: () => shortcutGuard.allow("back", "key", performance.now()),
    onBack: (closed, remaining) => {
      if (remaining.length) {
        // Back to the page underneath (a font page under Family groups or Compare): focus goes to
        // what opened this one, else that page's heading, once it's no longer covered (below).
        pendingPageFocus.current = returnElement(closed);
        return;
      }
      pendingFocus.current =
        closed.kind === "font" ? { row: closed.returnTo } : closed.kind === "catalog" ? { element: closed.returnTo } : (closed.returnTo ?? { element: null });
      announce(`Back to ${placeNameRef.current}`);
    },
  });
  const pageOpen = nav.pages.length > 0;
  // After Back to a page underneath: its element (by id) or heading takes focus once the page is
  // drawn on top again (an effect, so it's no longer inert). Undefined: nothing waiting.
  const pendingPageFocus = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const want = pendingPageFocus.current;
    if (want === undefined) return;
    pendingPageFocus.current = undefined;
    // By id on the page now on top: a font page further down the stack has the same ids.
    const el = (want && byIdOnTop(want)) || document.querySelector<HTMLElement>("[data-page-top] h1");
    if (el) focusShown(el);
  }, [nav.pages]);
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
      if (el) return focusShown(el);
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
  /** Browse on Purchases: its own page, over its list. */
  const openCatalog = useCallback(
    (service: CatalogPageEntry["service"]) => {
      openPage({ kind: "catalog", service, returnTo: BROWSE_ID });
      announce(`Opened the ${SERVICE_LABELS[service]} page`);
    },
    [openPage, announce],
  );
  // ⌘F (Ctrl+F on Windows) goes to Search, leaving a font page if one is open (on the Google
  // Fonts view, Search searches the catalog). On Family groups it goes to that page's own
  // search, and on Purchases (no search) it does nothing, so neither page closes and loses its
  // place (nav.findIntent).
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
          const field = document.getElementById(GROUPS_SEARCH_ID);
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
        if (purchasesWatching.current) api.purchasesRetryWatch().catch(() => {});
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
        // One more line, about files it found but can't use yet, when that's news: on a scan you
        // asked for, or when they differ from the last scan's. Never a toast of its own. (Files
        // that couldn't be read have the warning's own words.)
        const skippedLine = skippedSummary(r.skipped);
        const skippedNews = skippedLine && (!quiet || skippedLine !== skippedSummary(folder.skipped)) ? skippedLine : null;
        const toastId = `scan-${folder.id}`;
        const report = (text: string) =>
          skippedNews
            ? {
                id: toastId,
                description: (
                  <>
                    <span className="block">{text}</span>
                    <span className="mt-1 block">{skippedNews}</span>
                  </>
                ),
                action: (
                  <Tip tip={SKIPPED_DETAILS_TIP}>
                    <Button
                      variant="outline"
                      size="xs"
                      className="shrink-0 self-center"
                      onClick={() => {
                        toast.dismiss(toastId);
                        showSkipped(name, r.skipped);
                      }}
                    >
                      Details
                    </Button>
                  </Tip>
                ),
              }
            : { description: text };
        if (r.cancelled) {
          toast.info(`Stopped scanning ${name}`, { description: "Fonts read so far are kept." });
        } else if (r.walkErrors > 0) {
          toast.warning(
            `${name}: some folders couldn't be opened`,
            report(`${description}. Nothing was removed from the library because the scan was incomplete.`),
          );
        } else if (r.failed.length) {
          toast.warning(`${name}: ${r.failed.length.toLocaleString()} file(s) couldn't be read`, report(description));
          for (const f of r.failed) console.warn("scan failure", f.path, f.reason);
        } else if (!quiet || changed) {
          toast.success(name, report(description));
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
      .then((st) => my === purchaseCountSeq.current && onPurchasesStatus(st))
      .catch(() => {});
  }, [onPurchasesStatus]);
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
            // takes focus, so focus doesn't go back to where it was before settings.
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
  // The menu bar icon's "Turn Off Temporary Fonts" (src-tauri/src/tray.rs): the list reloads, and
  // says what happened.
  useEffect(() => {
    const unlisten = listen<TemporaryOffReport>("activation-changed", (e) => {
      loadFonts().catch(() => {});
      const m = temporaryOffMessage(e.payload);
      if (m) toast[m.tone](m.title, { description: m.description, duration: m.tone === "success" ? undefined : 12_000 });
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
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
      setView((v) => (v.kind === "folder" && v.id === folder.id ? { kind: "all" } : v));
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
   * (see bringIntoLibrary). Without them, it's the user's switch. `report` gets the outcomes (or
   * the error) instead of a message per problem file: a tag switch sums them up (src/tags/switching.ts).
   */
  const setActivation = (
    ids: number[],
    active: boolean,
    knownPaths?: string[],
    scope: ActivationMode | null = null,
    origin: SwitchOrigin = "switch",
    report?: (outcomes: readonly ActivationOutcome[], error?: unknown) => void,
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
          if (o.error && !report) toast.error(fileName(o.path), { description: o.error });
        }
        // What the OS has and what Fontface recorded, which differ when another app keeps a font
        // on or macOS didn't load it: those states show now, not after the next reload.
        setFonts((list) => applyOutcomes(list, outcomes));
        report?.(outcomes);
      } catch (e) {
        if (report) report([], e);
        else toast.error(String(e));
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

  /**
   * Uninstalls a downloaded Google Fonts family: turns it off, removes its files (Fontface keeps
   * them aside until it quits, for Undo) and updates the library. Asked first on the Google
   * Fonts view. The message after it offers Undo, as Remove from Library does.
   */
  const removeGoogle = async (fam: GoogleFamily) => {
    const removed = await googleOp(fam.id, async () => {
      mutationEpoch.current++;
      try {
        return await api.googleRemove(fam.id);
      } finally {
        mutationEpoch.current++;
        const folder = googleFolderNow();
        if (folder) await rescan(folder).catch(() => {});
      }
    });
    announce(`Uninstalled ${fam.family}`);
    toast.success(`Uninstalled ${fam.family}`, {
      description: "Its downloaded files were turned off and removed.",
      action: { label: "Undo", onClick: () => void undoRemoveGoogle(fam, removed) },
      // As long as Remove from Library's Undo.
      duration: 10_000,
    });
  };

  /** Undo for Uninstall: the family's files go back, and what was on turns back on the same way
   *  (until logout, or to stay). */
  const undoRemoveGoogle = async (fam: GoogleFamily, removed: GoogleRemoved) => {
    try {
      await googleOp(fam.id, async () => {
        const result = await api.googleRestore(fam.id);
        const wasOn = new Set(removed.wasActiveFiles);
        const temporary = new Set(removed.temporaryFiles);
        await bringIntoLibrary(
          "google",
          result.dir,
          result.files,
          (name) => wasOn.has(name),
          (name) => (temporary.has(name) ? "temporary" : "persistent"),
        );
      });
      announce(`Put back ${fam.family}`);
      toast.success(`Put back ${fam.family}`);
    } catch (e) {
      toast.error(`Couldn't put back ${fam.family}`, { description: e instanceof Error ? e.message : String(e) });
    }
  };

  // Group the whole library once; views filter faces, so each Face keeps all of its copies.
  // Families group by name (unless that's off in View options), and by your choices (familyGroups.ts).
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
  // The preview bar's preview styling, for the layouts, Google Fonts, Adobe Fonts and the font
  // page (PreviewStyle.tsx).
  const previewOptions = settings?.preview ?? DEFAULT_SETTINGS.preview;
  const previewStyle = usePreviewStyleValue(previewOptions, dark);
  const choosePreview = useCallback((patch: Partial<PreviewOptions>) => updateSettings({ preview: patch }), [updateSettings]);
  // The preview bar over the bottom of every list view (PreviewBar.tsx): your own text, the size
  // and the styling.
  const previewBar = (
    <PreviewBar
      previewText={previewText}
      onPreviewText={setPreviewText}
      size={size}
      onSize={setSize}
      preview={previewOptions}
      onPreview={choosePreview}
      dark={dark}
    />
  );
  // "On until logout" says "until you quit Fontface" when quitting turns those fonts off.
  const untilQuit = settings?.clearTemporaryOnQuit ?? false;
  // Switches turn fonts on the saved way; Option-click turns them on the other way.
  const activationMode = settings?.activationMode ?? DEFAULT_SETTINGS.activationMode;
  const stateWording = useMemo<SwitchWording>(() => ({ untilQuit, mode: activationMode }), [untilQuit, activationMode]);

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
  const chooseGroupByName = (on: boolean) => {
    updateSettings({ groupByName: on });
    announce(on ? "Families grouped by name" : "Families use the fonts' own names");
  };
  /** Cmd+= and Cmd+- (and View › Bigger and Smaller Preview): the next size step. */
  const stepPreviewSize = useCallback(
    (step: 1 | -1) => {
      const to = stepSize(sizeRef.current, step);
      // Already at the end: nothing changes, so nothing to say.
      if (to === sizeRef.current) return;
      sizeRef.current = to;
      setSize(to);
      announce(`Preview size ${to} pixels`);
    },
    [announce],
  );
  // Cmd+1/2/3 pick the layout and Cmd+= / Cmd+- step the preview size (Ctrl on Windows), while
  // the list layer is showing (not under settings or a page). Like Cmd+F and Back, they wait
  // while a menu, dialog or popover is open (the list it hands focus back to would be gone) and
  // during a drag (the rows being dragged would change under it).
  const adobePage = view.kind === "service" && view.id === "adobe";
  // Google Fonts' own view: the catalog, under the same toolbar (GoogleFontsPanel). It and Adobe
  // Fonts' page have one layout and their own order, so only the size shortcuts work there.
  const googleView = view.kind === "service" && view.id === "google";
  const commands = viewCommands({
    covered: settingsOpen || pageOpen,
    service: googleView ? "google" : adobePage ? "adobe" : null,
    adobeFonts: (adobeCount ?? 0) > 0,
  });
  const sizeKeys = commands.size;
  const arrangeKeys = commands.arrange;
  useEffect(() => {
    if (!sizeKeys) return;
    const onKey = (e: KeyboardEvent) => {
      if (popupOpen() || isDragging()) return;
      const next = layoutShortcut(e, IS_MAC);
      if (next) {
        e.preventDefault();
        // Holding the keys down picks it once; the View menu's item for the same press doesn't
        // pick it again.
        if (arrangeKeys && !e.repeat && shortcutGuard.allow(`layout:${next}`, "key", performance.now())) chooseLayout(next);
        return;
      }
      const step = sizeShortcut(e, IS_MAC);
      if (step) {
        e.preventDefault();
        if (shortcutGuard.allow(`size:${step}`, "key", performance.now())) stepPreviewSize(step);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sizeKeys, arrangeKeys, chooseLayout, stepPreviewSize, shortcutGuard]);
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
    switch (under?.kind) {
      case "font":
        return (familyOfFace.get(under.styleKey) ?? familyOfFace.get(under.faceKey))?.name ?? placeName;
      case "compare":
        return "Compare";
      case "pair":
        return "Pair";
      case "groups":
        return "Family groups";
      case "catalog":
        return SERVICE_LABELS[under.service];
      default:
        return placeName;
    }
  };
  const styleCount = useMemo(() => filtered.reduce((n, f) => n + f.faces.length, 0), [filtered]);
  const { hasOwnTag } = filterContext;
  const counts = useMemo(() => placeCounts(allFamilies, { hideInstalled, recentSince: since, hasOwnTag }), [allFamilies, hideInstalled, since, hasOwnTag]);
  // The source this view shows (its sidebar row) and its library folders.
  const source = sourceOf(view, folders, services);
  const sourceKey = source ? `${source}:${sourceFolders(source, folders, services).map((f) => `${f.id}=${f.path}`).join(",")}` : "";
  const sourceRoots = useMemo(() => (source ? sourceFolders(source, folders, services) : []), [sourceKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const browsePurchases = source === "purchases";
  // A source's view shows only its own folders' scans: Purchases with nothing in the library yet
  // (no folder) keeps offering Browse while another folder is scanned. Other places can gain
  // fonts from any scan.
  const viewScan = source ? sourceRoots.map((f) => scans.get(f.id)).find(Boolean) : [...scans.values()][0];
  const resetKey = `${viewKey(view)}:${listStatus}:${variableOnly}:${query}`;
  // Empty list with filters on: say which fonts were asked for, e.g. "No active variable fonts here."
  const filtersOn = !!query || listStatus !== "any" || variableOnly;
  const kinds = [listStatus !== "any" && listStatus, variableOnly && "variable", "fonts"].filter(Boolean).join(" ");
  const where = view.kind === "tag" ? " with this tag" : "";
  const noMatch = query ? `No ${kinds}${where} match “${query}”.` : `No ${kinds}${where || " here"}.`;

  // "Open where you left off": the view and filters are saved as they change, and reopened at launch.
  useLastView({
    settings,
    libraryLoaded,
    folders,
    services,
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

  /** Double-click or Return on a row: the family's page, on the last tab used (Show Info: on
   *  the Info tab, which leaves the tab Open uses as it was). */
  const openFont = (r: OpenRequest, tab?: FontPageTab) => {
    nav.open({ kind: "font", faceKey: r.faceKey, styleKey: r.styleKey, tab: tab ?? settings?.fontPageTab ?? "specimen", returnTo: r.rowKey });
    announce(tab === "info" ? `Opened ${r.name}, on Info` : `Opened ${r.name}`);
  };
  const revealFont = (id: number) => api.revealFont(id).catch((e) => toast.error(String(e)));

  /** Family groups: from View options, a font's menus or Settings, on some fonts or on all. */
  const openFamilyGroups = useCallback<OpenFamilyGroups>(
    (faces, options = {}) => {
      const focus = faces?.map((f) => f.key) ?? [];
      const filter: GroupsFilter = options.filter ?? "all";
      nav.open({ kind: "groups", filter, focus, returnTo: options.returnTo ? { element: options.returnTo } : null });
      announce(filter === "automatic" ? "Opened Family groups, on the automatic groups" : "Opened Family groups");
      closeSettings({ restoreFocus: false });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nav.open, announce, closeSettings],
  );


  // ------------------------------------------------------------- font actions and menus

  // One set of font actions (fontActions.ts) for the right-click menus, the font page's More
  // menu, the selection bar, the shortcuts and the macOS Font menu. What they work on: the open
  // font page's family, else the list's selection (as the list last reported it).
  const userFolderIds = useMemo(() => new Set(folders.filter((f) => f.kind === "user").map((f) => f.id)), [folders]);
  const actionContext = useMemo<ActionContext>(
    () => ({ mode: activationMode, untilQuit, removable: (font) => userFolderIds.has(font.folderId), revealLabel: REVEAL_LABEL }),
    [activationMode, untilQuit, userFolderIds],
  );
  const listTarget = useRef<FontTarget | null>(null);
  const [picker, setPicker] = useState<PickRequest | null>(null);
  /** The font picker, for Compare and Pair (their pages ask through FontPickerContext). What has
   *  focus now gets it back when the picker closes, else `returnTo` (focusReturn.ts). */
  const openPicker = useCallback((request: PickRequest, returnTo?: string) => setPicker({ returnFocus: noteFocus(returnTo), ...request }), []);
  /** Remove from Library… waiting for its confirmation. `closePage`: the font page it came from,
   *  closed once its whole family is gone. */
  const [removal, setRemoval] = useState<(RemovalRequest & { closePage: number | null }) | null>(null);
  /** Cmd+T on a font page opens its Tags popover: the page asked for, and a count that only grows. */
  const [tagsAsk, setTagsAsk] = useState({ page: 0, n: 0 });
  const allFaces = useMemo(() => allFamilies.flatMap((f) => f.faces), [allFamilies]);
  // The Google Fonts view's catalog and filters: the toolbar shows and changes them, the view
  // lists the families they keep. The toolbar's search and Variable work on it too.
  const google = useGoogleView({ shown: googleView, version: googleVersion, faces: allFaces, query, variableOnly });
  const familyOfFaceKey = useCallback((key: string) => familyOfFace.get(key), [familyOfFace]);
  /** The catalog's families you have, downloaded here or already in your library (its "Installed"). */
  const googleInstalled = useMemo(
    () => google.catalog?.families.filter((f) => f.installed || google.holdings.has(f.id)).length ?? 0,
    [google.catalog, google.holdings],
  );
  const googleShows = CATALOG_SHOWS.map((o) => ({
    value: o.value,
    tip: o.tip,
    // How many have an update, so it's seen without picking the filter.
    label:
      o.value === "updates" && google.counts.updates > 0 ? (
        <span className="flex items-center gap-1">
          {o.label}
          <span className="rounded-full bg-primary px-1.5 font-mono text-[11px] text-primary-foreground tabular-nums">{google.counts.updates.toLocaleString()}</span>
        </span>
      ) : (
        o.label
      ),
  }));
  const faceOf = useCallback(
    (key: string): FaceRef | undefined => {
      const family = familyOfFace.get(key);
      const face = family?.faces.find((f) => f.key === key);
      return family && face ? { family, face } : undefined;
    },
    [familyOfFace],
  );
  // The library A to Z for the picker: worked out while it's open, and kept while it closes.
  const pickerList = useRef<Family[]>([]);
  const pickerFamilies = useMemo(() => {
    if (picker) pickerList.current = sortFamilies(allFamilies, { key: "name", desc: false });
    return pickerList.current;
  }, [picker, allFamilies]);

  const currentTarget = (): FontTarget | null => {
    if (settingsOpenRef.current) return null;
    const top = nav.pages[nav.pages.length - 1];
    if (top) {
      if (top.kind !== "font") return null;
      const family = familyOfFace.get(top.styleKey) ?? familyOfFace.get(top.faceKey);
      if (!family) return null;
      const face = family.faces.find((f) => f.key === top.styleKey) ?? family.faces.find((f) => f.key === top.faceKey) ?? family.representative;
      return pageTarget(family, face);
    }
    return adobePage ? null : listTarget.current;
  };

  /** A target in words: “Inter”, “Inter Bold”, or "12 styles". */
  const targetName = (target: FontTarget) => {
    const [only] = target.items;
    if (target.items.length !== 1) return `${target.faces.length.toLocaleString()} ${target.faces.length === 1 ? "style" : "styles"}`;
    return only.kind === "family" ? `“${only.family.name}”` : `“${only.family.name} ${only.face.style}”`;
  };

  const openCompare = (keys: string[], returnTo: PageReturn) => {
    const list = compareList(keys);
    nav.open({ kind: "compare", ...list, mode: "lines", returnTo });
    announce(`Opened Compare with ${list.faces.length} ${list.faces.length === 1 ? "font" : "fonts"}${list.left ? `; ${list.left} more didn't fit` : ""}`);
  };
  const openPair = (heading: string, body: string, returnTo: PageReturn) => {
    nav.open({ kind: "pair", heading, body, returnTo });
    announce("Opened Pair");
  };

  const runFontAction = (action: FontActionId, target: FontTarget, opts: { returnTo?: string } = {}) => {
    if (!fontActionStates(target, actionContext)[action].enabled) return;
    const name = targetName(target);
    const first = target.items[0];
    // A page it opens hands focus back to: the button it came from, else the list row.
    const returnTo: PageReturn = opts.returnTo ? { element: opts.returnTo } : target.where === "list" && first?.rowKey ? { row: first.rowKey } : null;
    const switchable = target.faces.filter((f) => !f.installed);
    const top = nav.pages[nav.pages.length - 1];
    switch (action) {
      case "open":
        openFont({ faceKey: first.face.key, styleKey: first.face.key, rowKey: first.rowKey ?? "", name: first.family.ungroupedFrom ?? first.family.name });
        return;
      case "info":
        // On the font page: its Info tab, for the style it's on (or the line right-clicked).
        if (target.where === "page" && top?.kind === "font") {
          nav.update(top.id, { styleKey: first.face.key, tab: "info" });
          announce(`Info for ${first.family.name} ${first.face.style}`);
        } else openFont({ faceKey: first.face.key, styleKey: first.face.key, rowKey: first.rowKey ?? "", name: first.family.ungroupedFrom ?? first.family.name }, "info");
        return;
      case "turnOn":
      case "turnOnOther": {
        const scope = scopeOf(action, activationMode);
        const until = (scope ?? activationMode) === "temporary" ? (untilQuit ? " until you quit Fontface" : " until logout") : "";
        // On Google Fonts, a downloaded family's own copies (FontTarget.onFaces).
        const turnOn = target.onFaces ? target.onFaces.filter((f) => !f.installed) : switchable;
        void setActivation(activationIds(turnOn, true), true, undefined, scope).then((on) => on.size && announce(`Turned on ${name}${until}`));
        return;
      }
      case "turnOff":
        void setActivation(activationIds(switchable, false), false).then(() => announce(`Turned off ${name}`));
        return;
      case "tags":
        // The open page's family: its own Tags popover. Anything else: the tag picker, which gives
        // focus back to what had it (the list, say) when it closes.
        if (target.where === "page" && first.kind === "family" && top?.kind === "font") setTagsAsk((t) => ({ page: top.id, n: t.n + 1 }));
        else openTagDialog({ kind: "pick", faces: target.faces, returnFocus: noteFocus(opts.returnTo) });
        return;
      case "compare": {
        const keys = compareKeysOf(target);
        if (keys.length > 1) return openCompare(keys, returnTo);
        openPicker(
          {
            title: `Compare ${name} with…`,
            multiple: true,
            confirm: "Compare",
            confirmTip: "Opens Compare with the fonts you picked",
            // Picking its own family again would only show it once.
            exclude: first.face.key === first.family.representative.key ? [first.family.id] : [],
            onPick: (families) => {
              openCompare([keys[0], ...families.map((f) => f.representative.key)], returnTo);
              return true;
            },
          },
          opts.returnTo,
        );
        return;
      }
      case "pair":
        if (target.items.length === 2) return openPair(target.items[0].face.key, target.items[1].face.key, returnTo);
        openPicker(
          {
            title: `Pair ${name} with…`,
            description: `${name} is the heading font: pick the body font. Swap them on the Pair page.`,
            multiple: false,
            onPick: ([family]) => {
              openPair(first.face.key, family.representative.key, returnTo);
              return true;
            },
          },
          opts.returnTo,
        );
        return;
      case "familyGroup":
        return openFamilyGroups(target.faces, { returnTo: opts.returnTo });
      case "reveal": {
        const font = revealFontOf(target);
        if (font) revealFont(font.id);
        return;
      }
      case "copyPostScript": {
        const names = postScriptNames(target);
        void copyText(names.join("\n")).then((ok) =>
          ok
            ? toast.success(names.length === 1 ? "Copied the PostScript name" : `Copied ${names.length.toLocaleString()} PostScript names`, {
                description: names.length === 1 ? names[0] : undefined,
              })
            : toast.error("Couldn't copy the PostScript names"),
        );
        return;
      }
      case "remove": {
        const plan = removalPlan(target.faces, allFaces, actionContext.removable);
        if (!plan.files.length) return;
        const wholeFamily = target.where === "page" && first.kind === "family" && plan.leaving === target.faces.length;
        setRemoval({ what: name, plan, closePage: wholeFamily && top?.kind === "font" ? top.id : null, returnFocus: noteFocus(opts.returnTo) });
        return;
      }
    }
  };

  /** Remove from Library…, confirmed: turned off and no longer listed, with Undo. */
  const confirmRemoval = async ({ what, plan, closePage }: RemovalRequest & { closePage: number | null }) => {
    setRemoval(null);
    mutationEpoch.current++;
    let report: RemoveReport;
    try {
      report = await api.fontsRemove(plan.ids);
    } catch (e) {
      toast.error(`Couldn't remove ${what} from the library`, { description: String(e) });
      return;
    } finally {
      mutationEpoch.current++;
      // The folders too: a folder that's now empty shows 0 in the sidebar, not its old count.
      await refresh().catch(() => {});
    }
    for (const f of report.failures) toast.error(fileName(f.path), { description: f.error });
    if (!report.removed.length) return;
    // From its own page: the page goes too, once nothing of the family is left to show (unless
    // Back already closed it while the fonts were being removed).
    if (closePage !== null) nav.backFrom(closePage);
    const files = report.removed.length;
    announce(`Removed ${what} from the library`);
    toast.success(`Removed ${what} from the library`, {
      description: `${files.toLocaleString()} font ${files === 1 ? "file" : "files"} turned off and no longer listed. Nothing was deleted.`,
      action: { label: "Undo", onClick: () => void undoRemoval(report) },
      // As long as the tag drags' Undo: time to notice, and to change your mind.
      duration: 10_000,
    });
  };

  /** Put Back: removed files are listed again (their folders are scanned). */
  const putBack = async (paths: string[]) => {
    const ids = await api.fontsPutBack(paths);
    for (const id of ids) {
      const folder = foldersRef.current.find((f) => f.id === id);
      if (folder) await rescan(folder);
    }
    await refresh();
  };

  /** Undo for Remove from Library: put back, and turned back on the way each file was on. */
  const undoRemoval = async (report: RemoveReport) => {
    try {
      await putBack(report.removed);
      if (report.wasOn.length) {
        const list = await api.listFonts();
        for (const temporary of [false, true]) {
          const paths = new Set(report.wasOn.filter((w) => w.temporary === temporary).map((w) => w.path));
          const ids = list.filter((f) => paths.has(f.path)).map((f) => f.id);
          if (ids.length) await setActivation(ids, true, [...paths], temporary ? "temporary" : "persistent", "arrival");
        }
      }
      announce("Put back in the library");
      toast.success("Put back in the library");
    } catch (e) {
      toast.error("Couldn't put the fonts back", { description: String(e) });
    }
  };

  /** A View or Font menu item (macOS). The menus can lag a moment behind the page, so each one
   *  checks again that it applies now. */
  const runMenuCommand = (c: MenuCommand) => {
    if (settingsOpenRef.current || popupOpen() || isDragging()) return;
    if (c.kind === "back") {
      if (nav.pages.length) nav.back();
      return;
    }
    if (c.kind === "font") {
      const target = currentTarget();
      if (target) runFontAction(c.action, target);
      return;
    }
    // The services' own views take only the size (the menus have the rest greyed out).
    if (c.kind === "size" ? !sizeKeys : !arrangeKeys) return;
    switch (c.kind) {
      case "layout":
        return chooseLayout(c.layout);
      case "group":
        return chooseGrouping(!groupStyles);
      case "sort":
        if (sort.key !== c.key) chooseSort({ key: c.key, desc: sortInfo(c.key).desc });
        return;
      case "direction":
        if (sort.desc !== c.desc) chooseSort({ ...sort, desc: c.desc });
        return;
      case "size":
        return stepPreviewSize(c.step);
    }
  };

  /** The macOS menus' state, sent when it changes (a moment after the page settles). */
  const menuSent = useRef("");
  const syncMenus = () => {
    const state = nativeMenuState({
      list: sizeKeys,
      catalog: !arrangeKeys,
      back: nav.pages.length > 0 && !settingsOpen,
      layout: googleView ? "rows" : layout,
      groupStyles,
      sort,
      size,
      actions: fontActionStates(currentTarget(), actionContext),
    });
    const key = menuStateKey(state);
    if (key === menuSent.current) return;
    menuSent.current = key;
    api.setMenuState(state).catch(() => {
      menuSent.current = "";
    });
  };

  const latest = useRef({ runFontAction, runMenuCommand, currentTarget, syncMenus, actionContext });
  latest.current = { runFontAction, runMenuCommand, currentTarget, syncMenus, actionContext };
  const menuTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleMenus = useCallback(() => {
    if (!IS_MAC) return;
    clearTimeout(menuTimer.current);
    menuTimer.current = setTimeout(() => latest.current.syncMenus(), 50);
  }, []);
  // After every render: whatever changed (a page, the layout, the selection) shows in the menus.
  useEffect(() => scheduleMenus());

  // The View and Font menus' items send "menu" (window.rs). One the page's own key handler has
  // just acted on (Cmd+[, Cmd+1…) is the same key press, and is dropped (shortcutGuard).
  useEffect(() => {
    const unlisten = listen<string>("menu", (e) => {
      const c = menuCommand(e.payload);
      if (!c || !shortcutGuard.allow(commandName(c), "menu", performance.now())) return;
      latest.current.runMenuCommand(c);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [shortcutGuard]);

  // Cmd+T (Tags), Cmd+Return (Turn On), Option-Cmd+Return (the other way) and Shift-Cmd+Return
  // (Turn Off), on the selection or the open font page; Ctrl on Windows. They wait while a menu,
  // dialog or popover is open, and during a drag.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = fontShortcut(e, IS_MAC);
      if (!action) return;
      // Handled here, the key doesn't reach the Font menu as well.
      e.preventDefault();
      if (e.repeat || settingsOpenRef.current || popupOpen() || isDragging()) return;
      const target = latest.current.currentTarget();
      if (!target || !shortcutGuard.allow(`font:${action}`, "key", performance.now())) return;
      latest.current.runFontAction(action, target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcutGuard]);

  const fontActionsApi = useMemo<FontActionsApi>(
    () => ({
      states: (target) => fontActionStates(target, latest.current.actionContext),
      run: (action, target, options) => latest.current.runFontAction(action, target, options),
    }),
    [],
  );

  return (
    <SettingsContext.Provider value={settingsStore}>
      <FamilyGroupsContext.Provider value={openFamilyGroups}>
      <StateWordingContext.Provider value={stateWording}>
      <FontActionsContext.Provider value={fontActionsApi}>
      <FontPickerContext.Provider value={openPicker}>
      {/* One timing for every tooltip in the app (components/Tip.tsx). */}
      <TooltipProvider delay={TIP_DELAY} timeout={TIP_INSTANT_WINDOW}>
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
              onImportPurchases={() => {
                goToPlace({ kind: "service", id: "purchases" });
                openCatalog("purchases");
              }}
              onLocateFolder={relocate}
              onRevealFolder={(f) => api.revealFolder(f.id).catch((e) => toast.error(`Couldn't show ${f.label}`, { description: String(e) }))}
              onShowSkipped={showSkipped}
            />
            <main className="relative flex min-h-0 min-w-0 flex-col outline-none" tabIndex={-1}>
              {/* The list layer: the place picked in the sidebar. While a page is open it stays as it
                  was (scroll, selection, loaded previews), hidden and out of reach underneath. */}
              <div inert={pageOpen} className={cn("flex min-h-0 flex-1 flex-col", pageOpen && "invisible")}>
              {adobePage ? (
                <PreviewStyleContext.Provider value={previewStyle}>
                  <AdobeFontsPanel previewText={previewText} size={size} bar={previewBar} onStatus={(st) => setAdobeCount(st.faces.length)} />
                </PreviewStyleContext.Provider>
              ) : (
              <>
              <Toolbar
                query={query}
                onQuery={setQuery}
                status={listStatus}
                onStatus={setStatus}
                showStatus={view.kind !== "active"}
                variableOnly={variableOnly}
                onVariableOnly={setVariableOnly}
                // The Google Fonts view: its own filter and search words, one layout, and no View
                // options (its order is the catalog's; the preview bar has the rest).
                filter={googleView ? <ChoiceGroup label="Show families" value={google.show} options={googleShows} onChange={google.setShow} /> : undefined}
                searchLabel={googleView ? "Search Google Fonts" : undefined}
                layout={googleView ? "rows" : layout}
                onLayout={googleView ? () => {} : chooseLayout}
                unavailableLayouts={googleView ? GOOGLE_LAYOUTS : undefined}
                browse={browsePurchases ? <BrowseButton newPurchases={newPurchases} onBrowse={() => openCatalog("purchases")} /> : undefined}
                viewOptions={
                  googleView ? undefined : (
                  <ViewOptions
                    layout={layout}
                    onLayout={chooseLayout}
                    groupStyles={groupStyles}
                    onGroupStyles={chooseGrouping}
                    groupByName={groupByName}
                    onGroupByName={chooseGroupByName}
                    sort={sort}
                    onSort={chooseSort}
                    density={tableDensity}
                    onDensity={(d) => updateSettings({ tableDensity: d })}
                    columns={tableColumns}
                    onColumns={(c) => updateSettings({ tableColumns: c })}
                    onFamilyGroups={() => openFamilyGroups()}
                  />
                  )
                }
              />
              {googleView ? (
                <ListFrame
                  bar={google.catalog ? previewBar : undefined}
                  count={google.catalog ? catalogCountText(google.visible.length, google.catalog.families.length, googleInstalled) : ""}
                  note={<GoogleFooterNote onlinePreviews={settings?.googlePreviews ?? false} stale={!!google.catalog?.stale} />}
                  source={GOOGLE_SOURCE}
                >
                <PreviewStyleContext.Provider value={previewStyle}>
                  <GoogleFontsPanel
                    ref={listRef}
                    view={google}
                    fonts={fonts}
                    previewText={previewText}
                    size={size}
                    onlinePreviews={settings?.googlePreviews ?? false}
                    yoursFirst={settings?.catalogYoursFirst ?? DEFAULT_SETTINGS.catalogYoursFirst}
                    onYoursFirst={(on) => updateSettings({ catalogYoursFirst: on })}
                    busy={googleBusy}
                    switching={busy}
                    updatingAll={googleUpdatingAll}
                    onInstall={installGoogle}
                    onRemove={removeGoogle}
                    onUpdateAll={updateAllGoogle}
                    onActivate={(ids, on, scope) => void setActivation(ids, on, undefined, scope)}
                    onOpen={openFont}
                    onTarget={(target) => {
                      listTarget.current = target;
                      scheduleMenus();
                    }}
                    familyOfFace={familyOfFaceKey}
                    resetKey={`${query}:${google.category}:${google.show}:${variableOnly}`}
                  />
                </PreviewStyleContext.Provider>
                </ListFrame>
              ) : (
              <ListFrame bar={families.length > 0 ? previewBar : undefined} count={libraryCountText(filtered.length, styleCount)}>
              {families.length > 0 ? (
                <PreviewStyleContext.Provider value={previewStyle}>
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
                  onActivate={(ids, on, scope) => void setActivation(ids, on, undefined, scope)}
                  onOpen={openFont}
                  onTarget={(target) => {
                    listTarget.current = target;
                    scheduleMenus();
                  }}
                  showAdded={view.kind === "recent"}
                  table={{
                    sort,
                    onSort: chooseSort,
                    columns: tableColumns,
                    onColumns: (c) => updateSettings({ tableColumns: c }),
                    density: tableDensity,
                  }}
                />
                </PreviewStyleContext.Provider>
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
                <EmptyPlace
                  view={view}
                  libraryEmpty={allFamilies.length === 0}
                  folder={view.kind === "folder" ? folders.find((f) => f.id === view.id) : undefined}
                  onAddFolder={addFolder}
                  onBrowse={openCatalog}
                  onShowSkipped={showSkipped}
                />
              )}
              </ListFrame>
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
                        onGroupByName={chooseGroupByName}
                        announce={announce}
                      />
                    ) : page.kind === "catalog" ? (
                      <CatalogPage placeName={placeName} onBack={nav.back}>
                        {(back) => (
                          <PurchasesPanel
                            version={purchasesVersion}
                            busy={purchaseBusy}
                            onStatus={onPurchasesStatus}
                            onImport={importPurchase}
                            onImportPath={importPurchasePath}
                            onReplace={replacePurchase}
                            onRemove={removePurchase}
                            onSubscriptionEnded={purchaseSubscriptionEnded}
                            back={back}
                          />
                        )}
                      </CatalogPage>
                    ) : page.kind === "compare" ? (
                      <ComparePage
                        page={page}
                        faceOf={faceOf}
                        placeName={pageUnder(i)}
                        previewText={previewText}
                        onBack={nav.back}
                        onChange={(patch) => nav.update(page.id, patch)}
                        onOpen={(faceKey, returnTo) => {
                          nav.open({ kind: "font", faceKey, styleKey: faceKey, tab: settings?.fontPageTab ?? "specimen", returnTo });
                          announce(`Opened ${familyOfFace.get(faceKey)?.name ?? "the font"}`);
                        }}
                        announce={announce}
                      />
                    ) : page.kind === "pair" ? (
                      <PairPage
                        page={page}
                        faceOf={faceOf}
                        placeName={pageUnder(i)}
                        previewText={previewText}
                        onBack={nav.back}
                        onChange={(patch) => nav.update(page.id, patch)}
                        announce={announce}
                      />
                    ) : (
                    <PreviewStyleContext.Provider value={previewStyle}>
                    <FontPage
                      page={page}
                      family={familyOfFace.get(page.styleKey) ?? familyOfFace.get(page.faceKey)}
                      placeName={pageUnder(i)}
                      previewText={previewText}
                      busy={busy}
                      locations={locations}
                      onBack={nav.back}
                      onChange={(patch) => {
                        nav.update(page.id, patch);
                        if (patch.tab && patch.tab !== settings?.fontPageTab) settingsStore.update({ fontPageTab: patch.tab });
                      }}
                      onActivate={(ids, on, scope) => void setActivation(ids, on, undefined, scope)}
                      onReveal={revealFont}
                      // Only the page asked gets the count: a covered font page never opens its Tags.
                      tagsAsk={tagsAsk.page === page.id ? tagsAsk.n : undefined}
                    />
                    </PreviewStyleContext.Provider>
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
                // The page's heading takes focus (not where focus was before settings).
                closeSettings({ restoreFocus: false });
              }}
              onReviewFamilyGroups={() => openFamilyGroups()}
              onPutBack={async (paths) => {
                await putBack(paths);
                toast.success(paths.length === 1 ? "Put back in the library" : `Put ${paths.length.toLocaleString()} font files back in the library`);
              }}
            />
          )}
        </div>

        {/* Tag dialogs (new, rename, delete, find, import, export) can be asked for from anywhere. */}
        <TagDialogHost
          families={allFamilies}
          onDeleted={(ids) => setView((v) => (v.kind === "tag" && ids.includes(v.id) ? { kind: "all" } : v))}
          switchFonts={(ids, on, scope, report) => setActivation(ids, on, undefined, scope, "switch", report)}
        />
        {/* The library search for Compare and Pair, and Remove from Library's confirmation. */}
        <FontPickerDialog request={picker} families={pickerFamilies} onClose={() => setPicker(null)} />
        <RemoveFontsDialog request={removal} onConfirm={(r) => void confirmRemoval({ ...r, closePage: removal?.closePage ?? null })} onCancel={() => setRemoval(null)} />
        {/* The files a source's latest scan found but didn't add, and why. */}
        <SkippedFilesDialog request={skippedList} onClose={() => setSkippedList(null)} />

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
              <Tip tip="Turns off its fonts and takes the folder out of your library. Files stay on disk.">
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    if (pendingRemoval) removeFolder(pendingRemoval);
                    setPendingRemoval(null);
                  }}
                >
                  Remove
                </AlertDialogAction>
              </Tip>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Toaster position="bottom-right" offset={TOAST_OFFSET} mobileOffset={TOAST_OFFSET} theme={dark ? "dark" : "light"} />
        {/* One calm, always-present live region for screen readers. */}
        <div role="status" aria-live="polite" className="sr-only">
          {announcement}
        </div>
      </TooltipProvider>
      </FontPickerContext.Provider>
      </FontActionsContext.Provider>
      </StateWordingContext.Provider>
      </FamilyGroupsContext.Provider>
    </SettingsContext.Provider>
  );
}

/** Browse, on Purchases: opens its own page (new downloads and imports) over the list, with
 *  Back. It shows how many downloads are new. */
function BrowseButton({ newPurchases, onBrowse }: { newPurchases: number; onBrowse: () => void }) {
  const fresh = newPurchases > 0;
  return (
    <Tip tip="Review new downloads, import fonts you bought, and manage watched folders">
      <Button
        id={BROWSE_ID}
        variant="outline"
        size="sm"
        className="shrink-0"
        aria-label={`Browse purchases${fresh ? `, ${newPurchases.toLocaleString()} new ${newPurchases === 1 ? "download" : "downloads"}` : ""}`}
        onClick={onBrowse}
      >
        <Icon name="storefront" size={16} />
        <span className="@max-[1000px]/toolbar:hidden">Browse</span>
        {fresh && (
          <span aria-hidden className="rounded-full bg-primary px-1.5 font-mono text-[11px] text-primary-foreground tabular-nums">
            {newPurchases.toLocaleString()}
          </span>
        )}
      </Button>
    </Tip>
  );
}

/** What an empty place says, with a way to fill it where there is one. */
function EmptyPlace({
  view,
  libraryEmpty,
  folder,
  onAddFolder,
  onBrowse,
  onShowSkipped,
}: {
  view: LibraryView;
  /** No fonts at all yet. */
  libraryEmpty: boolean;
  /** The folder a folder view shows. */
  folder?: Folder;
  onAddFolder: () => void;
  onBrowse: (service: CatalogPageEntry["service"]) => void;
  onShowSkipped: (name: string, skipped: SkippedFiles) => void;
}) {
  const quiet = (text: string) => <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">{text}</div>;
  // A folder of fonts Fontface can't use yet (Type 1, say) says so, and what they are.
  const skipped = folder?.skipped;
  const skippedLine = skippedSummary(skipped, { unreadable: true });
  if (folder && skipped && skippedLine) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">No fonts in this folder.</p>
        <p className="max-w-sm text-sm text-muted-foreground">{skippedLine}</p>
        <Tip tip={SKIPPED_DETAILS_TIP}>
          <Button variant="outline" size="sm" onClick={() => onShowSkipped(folder.label, skipped)}>
            <Icon name="visibility_off" size={16} />
            Show Skipped Files…
          </Button>
        </Tip>
      </div>
    );
  }
  // (Google Fonts never gets here: its view is the catalog.)
  if (view.kind === "service" && view.id === "purchases") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="shopping_bag" size={40} weight={300} className="text-muted-foreground" />
        <h2 className="text-lg font-semibold">No purchased fonts in your library yet</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          Browse your purchases to add fonts you bought, from your downloads or from a zip or folder.
        </p>
        <Tip tip="Opens Purchases, to add fonts you bought">
          <Button onClick={() => onBrowse("purchases")}>
            <Icon name="storefront" size={16} />
            Browse Purchases
          </Button>
        </Tip>
      </div>
    );
  }
  if (!libraryEmpty) {
    switch (view.kind) {
      case "tag":
        return quiet("No fonts have this tag yet. Select fonts in another view, then tag them from the tag button or by right-clicking.");
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
      <Tip tip="Picks a folder of fonts to add to your library">
        <Button onClick={onAddFolder}>
          <Icon name="create_new_folder" size={16} />
          Add Folder…
        </Button>
      </Tip>
    </div>
  );
}
