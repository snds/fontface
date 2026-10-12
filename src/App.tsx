import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  api,
  type Folder,
  type FontSummary,
  type GoogleFamily,
  type PurchaseFind,
  type PurchaseImported,
  type ScanProgress,
  type ServiceId,
  type ServiceInfo,
} from "@/api";
import { activationIds, filterFamilies, groupFamilies, viewKey, type Face, type LibraryView, type StatusFilter } from "@/library";
import { faceName } from "@/fontLoader";
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
import { Sidebar, scanStatus } from "@/components/Sidebar";
import { Toolbar } from "@/components/Toolbar";
import { FontList } from "@/components/FontList";
import { DetailPanel } from "@/components/DetailPanel";
import { GoogleFontsPanel } from "@/components/GoogleFontsPanel";
import { AdobeFontsPanel } from "@/components/AdobeFontsPanel";
import { PurchasesPanel } from "@/components/PurchasesPanel";
import { locateFolder } from "@/tags/locate";
import { useLocations } from "@/tags/locations";
import { useFilterContext } from "@/tags/model";
import { TagDialogHost } from "@/tags/TagDialogs";

const fileName = (path: string) => path.split("/").pop() || path;
/** While a scan runs, reload the font list at most this often so new fonts appear as they're read. */
const LIVE_REFRESH_MS = 4000;
/** Screen readers hear scan progress at most this often (plus start and finish). */
const ANNOUNCE_MS = 15000;

export default function App() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [fonts, setFonts] = useState<FontSummary[]>([]);
  const [view, setView] = useState<LibraryView>({ kind: "all" });
  const [status, setStatus] = useState<StatusFilter>("any");
  const [query, setQuery] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [size, setSize] = useState(32);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<number>();
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
  // A font list reflects the moment it was requested. `listSeq` drops all but the newest
  // response, and `mutationEpoch` re-asks if an on/off change or removal happened meanwhile,
  // so a slow, stale list never flips a switch back.
  const listSeq = useRef(0);
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

  const loadFonts = useCallback(async (): Promise<void> => {
    const seq = ++listSeq.current;
    const epoch = mutationEpoch.current;
    const list = await api.listFonts();
    if (seq !== listSeq.current) return; // a newer request is on its way
    if (epoch !== mutationEpoch.current) return loadFonts(); // something changed mid-flight
    setFonts(list);
  }, []);

  const refresh = useCallback(async () => {
    const [f, svc] = await Promise.all([api.listFolders(), api.listServices(), loadFonts()]);
    setFolders(f);
    setServices(svc);
  }, [loadFonts]);

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
        action: { label: "Review", onClick: () => setView({ kind: "service", id: "purchases" }) },
      });
    });
    unlisten.then(() => countNewPurchases());
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [countNewPurchases]);

  // A folder view whose folder is gone (e.g. removed while a removal was still running) falls
  // back to All Fonts.
  useEffect(() => {
    setView((v) => (v.kind === "folder" && folders.length && !folders.some((f) => f.id === v.id) ? { kind: "all" } : v));
  }, [folders]);

  // At launch: load the library, then rescan every folder (macOS folders first) to catch changes.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      await refresh();
      for (const folder of await api.listFolders()) if (!folder.missing) await scan(folder, true);
    })().catch((e) => toast.error(String(e)));
  }, [refresh, scan]);

  const addFolder = async () => {
    const path = await open({ directory: true, multiple: false, title: "Add a font folder" });
    if (typeof path !== "string") return;
    try {
      const folder = await api.addFolder(path);
      await refresh();
      setView({ kind: "folder", id: folder.id });
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

  /** Turns fonts on or off. Resolves with the files that ended up on (useful to check a request). */
  const setActivation = (ids: number[], active: boolean, knownPaths?: string[]): Promise<Set<string>> => {
    if (ids.length === 0) return Promise.resolve(new Set());
    const paths = knownPaths ?? [...new Set(ids.map((id) => fontById.get(id)?.path).filter((p): p is string => !!p))];
    setBusy((b) => new Set([...b, ...paths]));
    const run = async (): Promise<Set<string>> => {
      mutationEpoch.current++;
      const on = new Set<string>();
      try {
        const outcomes = await api.setActivation(ids, active);
        const state = new Map<number, boolean>();
        for (const o of outcomes) {
          if (o.active) on.add(o.path);
          for (const id of o.ids) state.set(id, o.active);
          if (o.error) toast.error(fileName(o.path), { description: o.error });
        }
        setFonts((list) =>
          list.map((f) => (state.has(f.id) ? { ...f, activated: state.get(f.id)!, osActive: state.get(f.id)! } : f)),
        );
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

  // ------------------------------------------------------------------ services

  const googleFolder = folders.find((f) => f.id === services.find((s) => s.id === "google")?.folderId);

  /** Runs a Google Fonts operation with its busy state, then has the page reload. */
  const googleOp = async (id: string, op: () => Promise<void>) => {
    if (googleBusyRef.current.has(id)) throw new Error("Already working on that family");
    googleBusyRef.current.add(id);
    setGoogleBusy(new Set(googleBusyRef.current));
    try {
      await op();
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
   * didn't turn on. `pick` narrows which new fonts to turn on (default: all of them).
   */
  const bringIntoLibrary = async (
    service: ServiceId,
    dir: string,
    files: string[],
    pick: (name: string, font: FontSummary) => boolean = () => true,
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
    const wantedFiles = new Set(list.filter((f) => ids.includes(f.id)).map((f) => f.path));
    const on = await setActivation(ids, true, [...wantedFiles]);
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
      await bringIntoLibrary("purchases", result.dir, result.files, (_, font) => {
        const ps = font.postscriptName;
        return !!ps && (wasOn.has(ps) || (wasOn.size > 0 && !old.has(ps)));
      });
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
   * renamed file (e.g. statics rebuilt as a variable font) as the file it replaced. Throws with a
   * plain explanation if the family didn't fully reach the library or didn't turn on.
   */
  const installGoogle = (id: string) =>
    googleOp(id, async () => {
      const result = await api.googleInstall(id);
      // An update turns back on exactly what was on before; a renamed file (e.g. statics rebuilt
      // as a variable font) counts as the file it replaced.
      const wasOn = new Set(result.wasActiveFiles);
      const old = new Set(result.oldFiles);
      const renamedAway = result.wasActiveFiles.some((n) => !result.files.includes(n));
      await bringIntoLibrary("google", result.dir, result.files, (name) =>
        !result.updated || wasOn.has(name) || (renamedAway && !old.has(name)),
      );
    });

  /** Updates families one at a time, skipping any already being worked on. */
  const updateAllGoogle = async (families: GoogleFamily[]) => {
    if (googleUpdatingAll) return;
    setGoogleUpdatingAll(true);
    let done = 0;
    try {
      for (const fam of families) {
        if (googleBusyRef.current.has(fam.id)) continue;
        try {
          await installGoogle(fam.id);
          done++;
        } catch (e) {
          toast.error(fam.family, { description: e instanceof Error ? e.message : String(e) });
        }
      }
    } finally {
      setGoogleUpdatingAll(false);
      if (done) toast.success(`Updated ${done} ${done === 1 ? "family" : "families"}`);
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
  const allFamilies = useMemo(() => groupFamilies(fonts), [fonts]);
  const fontById = useMemo(() => new Map(fonts.map((f) => [f.id, f])), [fonts]);
  // Per-folder style counts, matching what each folder's view lists.
  const folderCounts = useMemo(() => {
    const map = new Map<number, number>();
    for (const family of allFamilies)
      for (const face of family.faces)
        for (const id of new Set(face.copies.map((c) => c.folderId))) map.set(id, (map.get(id) ?? 0) + 1);
    return map;
  }, [allFamilies]);
  // Tags narrow tag views and are searched too; location colors show on rows.
  const filterContext = useFilterContext();
  const locations = useLocations(folders, services);
  const families = useMemo(
    () => filterFamilies(allFamilies, view, status, query, filterContext),
    [allFamilies, view, status, query, filterContext],
  );
  const faceById = useMemo(() => {
    const map = new Map<number, Face>();
    for (const family of allFamilies) for (const face of family.faces) for (const c of face.copies) map.set(c.id, face);
    return map;
  }, [allFamilies]);
  const selected = selectedId === undefined ? undefined : faceById.get(selectedId);
  // Service pages have their own layout; the selection comes back with the library views.
  const showDetail = !!selected && view.kind !== "service";
  const styleCount = useMemo(() => families.reduce((n, f) => n + f.faces.length, 0), [families]);
  const counts = useMemo(() => {
    let all = 0;
    let installed = 0;
    for (const family of allFamilies) {
      all += family.faces.length;
      installed += family.faces.filter((face) => face.installed).length;
    }
    return { all, installed };
  }, [allFamilies]);
  const viewScan = view.kind === "folder" ? scans.get(view.id) : [...scans.values()][0];
  const resetKey = `${viewKey(view)}:${status}:${query}`;

  const toggleExpanded = (name: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <TooltipProvider>
      <div className={cn("grid h-full", showDetail ? "grid-cols-[240px_1fr_360px]" : "grid-cols-[240px_1fr]")}>
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
          onView={setView}
          onAddFolder={addFolder}
          onRemoveFolder={setPendingRemoval}
          onRescan={(f) => scan(f)}
          onCancelScan={(f) => api.cancelScan(f.id).catch((e) => toast.error(String(e)))}
          onLocateFolder={relocate}
        />
        <main className="flex min-h-0 min-w-0 flex-col">
          {view.kind === "service" ? (
            view.id === "google" ? (
              <GoogleFontsPanel
                fonts={googleFolder ? fonts.filter((f) => f.folderId === googleFolder.id) : []}
                previewText={previewText}
                busy={googleBusy}
                version={googleVersion}
                updatingAll={googleUpdatingAll}
                onInstall={installGoogle}
                onRemove={removeGoogle}
                onUpdateAll={updateAllGoogle}
              />
            ) : view.id === "purchases" ? (
              <PurchasesPanel
                version={purchasesVersion}
                busy={purchaseBusy}
                onStatus={(st) => setNewPurchases(st.finds.filter((f) => f.status === "new" && !f.missing).length)}
                onImport={importPurchase}
                onImportPath={importPurchasePath}
                onReplace={replacePurchase}
                onRemove={removePurchase}
                onSubscriptionEnded={purchaseSubscriptionEnded}
              />
            ) : (
              <AdobeFontsPanel previewText={previewText} onStatus={(st) => setAdobeCount(st.faces.length)} />
            )
          ) : (
          <>
          <Toolbar
            query={query}
            onQuery={setQuery}
            previewText={previewText}
            onPreviewText={setPreviewText}
            status={status}
            onStatus={setStatus}
            size={size}
            onSize={setSize}
            familyCount={families.length}
            fontCount={styleCount}
          />
          {families.length > 0 ? (
            <FontList
              families={families}
              expanded={expanded}
              onToggleExpanded={toggleExpanded}
              previewText={previewText}
              size={size}
              selectedId={selectedId}
              busy={busy}
              resetKey={resetKey}
              allFamilies={allFamilies}
              locations={locations}
              onSelect={setSelectedId}
              onActivate={setActivation}
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
          ) : view.kind === "tag" || view.kind === "location" ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
              {query || status !== "any"
                ? `No fonts ${view.kind === "tag" ? "with this tag" : "in this folder"} match your search or the Active/Inactive filter.`
                : view.kind === "tag"
                  ? "No fonts have this tag yet. Select fonts in another view, then tag them from the tag button or by right-clicking."
                  : "No fonts in this folder."}
            </div>
          ) : query || status !== "any" ? (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
              {query ? `No fonts match “${query}”` : `No ${status} fonts here`}
              {query && status !== "any" ? ` among ${status} fonts.` : "."}
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <Icon name="font_download" size={40} weight={300} className="text-muted-foreground" />
              <h2 className="text-lg font-semibold">No fonts here yet</h2>
              <p className="max-w-sm text-sm text-muted-foreground">
                Add a folder of fonts. Fontface reads them where they are. Nothing is copied or moved.
              </p>
              <Button onClick={addFolder}>
                <Icon name="create_new_folder" size={16} />
                Add Folder…
              </Button>
            </div>
          )}
          </>
          )}
        </main>
        {showDetail && selected && (
          <DetailPanel
            // Remount when the file changes, so its info and axes are re-read too.
            key={faceName(selected.primary)}
            face={selected}
            previewText={previewText}
            busy={selected.copies.some((c) => busy.has(c.path))}
            locations={locations}
            onClose={() => setSelectedId(undefined)}
            onActivate={setActivation}
            onReveal={(id) => api.revealFont(id).catch((e) => toast.error(String(e)))}
          />
        )}
      </div>

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

      {/* Tag dialogs (new, rename, delete, find, import, export), for every menu that opens one. */}
      <TagDialogHost
        families={allFamilies}
        onDeleted={(ids) => setView((v) => (v.kind === "tag" && ids.includes(v.id) ? { kind: "all" } : v))}
      />
      <Toaster position="bottom-right" />
      {/* One calm, always-present live region for screen readers. */}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </TooltipProvider>
  );
}
