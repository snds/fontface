import { invoke } from "@tauri-apps/api/core";

export interface Folder {
  id: number;
  path: string;
  /** "system": a macOS font folder, always on. "service": a folder Fontface manages for a font
   *  service (e.g. Google Fonts downloads). "user": added by the user. */
  kind: "system" | "service" | "user";
  label: string;
  fontCount: number;
  missing: boolean;
}

export interface FontSummary {
  id: number;
  folderId: number;
  path: string;
  faceIndex: number;
  family: string;
  subfamily: string;
  fullName: string | null;
  postscriptName: string | null;
  weight: number;
  width: number;
  italic: boolean;
  monospace: boolean;
  variable: boolean;
  format: string;
  /** What Fontface was asked to do. */
  activated: boolean;
  /** In a macOS font folder: always on, can't be switched off here. */
  installed: boolean;
  /** Identify this exact version of the file (used to key preview caches). */
  mtime: number;
  fileSize: number;
  /** What macOS reports right now. Drives the switches. */
  osActive: boolean;
}

export interface Axis {
  tag: string;
  name: string | null;
  min: number;
  default: number;
  max: number;
  hidden: boolean;
}

export interface FontDetail extends FontSummary {
  version: string | null;
  designer: string | null;
  manufacturer: string | null;
  copyright: string | null;
  license: string | null;
  licenseUrl: string | null;
  axes: Axis[];
  glyphCount: number;
}

export interface ScanProgress {
  folderId: number;
  phase: "starting" | "discovering" | "reading";
  /** Font files found so far (discovering) or in total (reading). */
  found: number;
  /** Files finished, including unchanged ones. */
  done: number;
  /** Files that must download from cloud storage before they can be read. */
  cloud: number;
  current: string;
}

export interface ScanReport {
  folderId: number;
  files: number;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  failed: { path: string; reason: string }[];
  walkErrors: number;
  cancelled: boolean;
}

export interface ActivationOutcome {
  path: string;
  ids: number[];
  active: boolean;
  error: string | null;
}

export type ServiceId = "google" | "adobe" | "purchases";

export interface ServiceInfo {
  id: ServiceId;
  /** The managed library folder for a download service. */
  folderId: number | null;
}

export interface GoogleFamily {
  id: string;
  family: string;
  category: string;
  variable: boolean;
  weights: number[];
  styles: string[];
  subsets: string[];
  license: string;
  lastModified: string;
  installed: { dir: string; lastModified: string } | null;
  updateAvailable: boolean;
  /** Why it can't be downloaded (e.g. icon fonts live elsewhere), if it can't. */
  unavailable: string | null;
}

export interface GoogleCatalog {
  families: GoogleFamily[];
  fetchedAt: number;
  stale: boolean;
}

export interface GoogleInstallResult {
  dir: string;
  files: string[];
  /** An earlier copy was replaced. */
  updated: boolean;
  /** For an update: file names that were on before. */
  wasActiveFiles: string[];
  /** For an update: every font file name in the replaced copy. */
  oldFiles: string[];
}

export interface AdobeFace {
  postscriptName: string;
  family: string;
  style: string;
}

export interface AdobeStatus {
  appInstalled: boolean;
  fontStore: boolean;
  faces: AdobeFace[];
  supported: boolean;
}

export interface PurchaseContents {
  /** Desktop font files that will be imported (paths inside the download). */
  fonts: string[];
  families: string[];
  licenses: string[];
  /** Font files left out: web/app/ebook files, and second formats of a font. */
  skippedFonts: string[];
  /** Names or addresses suggest trial or demo fonts. */
  trial: boolean;
  /** Too many fonts to treat as one download (e.g. a whole collection); import it by hand. */
  tooLarge: boolean;
  /** Font files that couldn't be read or aren't valid fonts. */
  unreadable: string[];
}

export interface PurchaseFind {
  id: number;
  path: string;
  name: string;
  /** An unzipped download (a folder). */
  isFolder: boolean;
  store: string | null;
  storeName: string | null;
  originUrl: string | null;
  referrer: string | null;
  contents: PurchaseContents;
  status: "new" | "imported";
  foundAt: number;
  importedDir: string | null;
  /** The original download no longer exists. */
  missing: boolean;
}

export interface PurchaseImported {
  dir: string;
  label: string;
  store: string;
  storeName: string;
  originUrl: string | null;
  sourceName: string;
  importedAt: number;
  fontFiles: number;
  licenseFiles: string[];
  subscriptionBound: boolean;
  mayBeTrial: boolean;
}

export interface PurchaseStore {
  id: string;
  name: string;
  subscriptionBound: boolean;
  mayBeTrial: boolean;
}

export interface WatchFolder {
  path: string;
  /** Why it can't be read right now (missing, or no permission), if it can't. */
  problem: string | null;
}

export interface RemovalReport {
  removed: number;
  /** [folder name, why] for each one that couldn't be removed. */
  failed: [string, string][];
}

export interface PurchasesStatus {
  watching: boolean;
  folders: WatchFolder[];
  finds: PurchaseFind[];
  imported: PurchaseImported[];
  stores: PurchaseStore[];
}

export interface ImportResult {
  dir: string;
  files: string[];
}

export const api = {
  listFolders: () => invoke<Folder[]>("list_folders"),
  addFolder: (path: string) => invoke<Folder>("add_folder", { path }),
  removeFolder: (folderId: number) => invoke<ActivationOutcome[]>("remove_folder", { folderId }),
  scanFolder: (folderId: number) => invoke<ScanReport>("scan_folder", { folderId }),
  cancelScan: (folderId: number) => invoke<void>("cancel_scan", { folderId }),
  listFonts: () => invoke<FontSummary[]>("list_fonts"),
  getFont: (fontId: number) => invoke<FontDetail>("get_font", { fontId }),
  setActivation: (fontIds: number[], active: boolean) =>
    invoke<ActivationOutcome[]>("set_activation", { fontIds, active }),
  revealFont: (fontId: number) => invoke<void>("reveal_font", { fontId }),
  listServices: () => invoke<ServiceInfo[]>("list_services"),
  googleCatalog: (refresh = false) => invoke<GoogleCatalog>("google_catalog", { refresh }),
  googleInstall: (id: string) => invoke<GoogleInstallResult>("google_install", { id }),
  googleRemove: (id: string) => invoke<void>("google_remove", { id }),
  adobeStatus: () => invoke<AdobeStatus>("adobe_status"),
  purchasesStatus: () => invoke<PurchasesStatus>("purchases_status"),
  purchasesSetWatching: (on: boolean) => invoke<void>("purchases_set_watching", { on }),
  purchasesAddFolder: (path: string) => invoke<void>("purchases_add_folder", { path }),
  purchasesRemoveFolder: (path: string) => invoke<void>("purchases_remove_folder", { path }),
  purchasesCheckNow: () => invoke<number>("purchases_check_now"),
  purchasesImport: (id: number, store: string | null) => invoke<ImportResult>("purchases_import", { id, store }),
  purchasesImportPath: (path: string, store: string | null) => invoke<ImportResult>("purchases_import_path", { path, store }),
  purchasesDetectStore: (path: string) => invoke<string | null>("purchases_detect_store", { path }),
  purchasesRetryWatch: () => invoke<boolean>("purchases_retry_watch"),
  purchasesDismiss: (id: number) => invoke<void>("purchases_dismiss", { id }),
  purchasesRemove: (dir: string) => invoke<void>("purchases_remove", { dir }),
  purchasesSubscriptionEnded: (store: string) => invoke<RemovalReport>("purchases_subscription_ended", { store }),
  purchasesReveal: (dir: string) => invoke<void>("purchases_reveal", { dir }),
};
