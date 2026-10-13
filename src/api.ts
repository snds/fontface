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
  /** What the preview draws (src-tauri/src/preview). Null until the face has a current profile:
   *  the list then asks for one (`previewProfiles`) and draws the name meanwhile. */
  preview: PreviewInfo | null;
}

/** A face's preview profile. Must match PreviewInfo in src-tauri/src/preview/mod.rs. */
export interface PreviewInfo {
  /** "name" (draw the name as is), "trim", "case", "sample19" (the font's own sample text),
   *  or a sample of its real characters: "script", "symbols", "expert", "partial". "none":
   *  nothing real to draw. */
  kind: PreviewKind;
  /** What a family row draws instead of the family name. */
  familyText?: string;
  /** What a style row draws instead of the full name. */
  fullText?: string;
  /** "Symbols", "Expert set", a script name or "Partial set". */
  label?: string;
  /** Printable ASCII characters the face can't draw. */
  asciiMissing?: string;
  /** Line ascent and descent in em, as the web view lays the line out. */
  ascent: number;
  descent: number;
  /** Ink of the family and full preview texts in em, above and below the baseline. */
  inkTop?: number;
  inkBottom?: number;
}

export type PreviewKind = "name" | "trim" | "case" | "sample19" | "script" | "symbols" | "expert" | "partial" | "none";

/** `previewProfiles` answer for one id. */
export interface PreviewAnswer {
  id: number;
  preview: PreviewInfo | null;
  /** No profile now, but worth asking again later (online-only, or changed since the scan). */
  retry: boolean;
}

/** The "preview-profiles" event: profiles the launch backfill just saved. */
export interface PreviewBatch {
  profiles: { id: number; mtime: number; fileSize: number; preview: PreviewInfo }[];
  /** The last batch: the backfill is finished. */
  done: boolean;
}

/** Every real character of a face (`fontCharacters`). Must match FontCharacters in
 *  src-tauri/src/preview/characters.rs. */
export interface FontCharacters {
  total: number;
  /** Code points that draw the shared placeholder shape (hidden). */
  placeholders: number;
  /** Code points mapped to a glyph with no ink (hidden). */
  empty: number;
  lookup: "unicode" | "symbol" | "macRoman" | "none";
  expert: boolean;
  ascent: number;
  descent: number;
  /** The ink most characters stay within, in em, for sizing the grid's cells. */
  inkTop: number;
  inkBottom: number;
  blocks: CharacterBlock[];
}

export interface CharacterBlock {
  name: string;
  /** Consecutive code points as [first, last]. */
  runs: [number, number][];
  /** One per code point, in run order ("" when the font has none). */
  glyphNames: string[];
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
  /**
   * For an update: file names to turn back on for this login only (scope "temporary"), because
   * what they replace was on that way. Turn an update's other files back on with "persistent".
   */
  temporaryFiles: string[];
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
  /** An imported purchase (its folder) this looks like a newer version of: offer "Replace". */
  replaces: string | null;
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
  /** May be a trial and was added at least 30 days ago: remind the user. */
  trialReminder: boolean;
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
  /** Font files this import added to the folder (it may have joined a folder of its family). */
  files: string[];
}

export interface ReplaceResult {
  dir: string;
  store: string;
  /** Every font file now in the folder. */
  files: string[];
  /** PostScript names of the faces that were on before the swap. */
  wasActiveFaces: string[];
  /** PostScript names of every face the old copy had. */
  oldFaces: string[];
  /** PostScript names to turn back on for this login only (scope "temporary"); the rest with "persistent". */
  temporaryFaces: string[];
}

// ------------------------------------------------------------------------------- settings
// Must match AppSettings in src-tauri/src/settings.rs. Events: "settings-changed" (payload:
// AppSettings, after every update or reset), "restore-pending" (payload: PendingRestore, at
// launch when restoreOnLaunch is "ask" and there's something to ask about) and "open-settings"
// (no payload: the macOS app menu's Settings… item, ⌘,).

export type ThemeSetting = "system" | "light" | "dark";
/** "persistent": fonts stay on after quitting and restarting. "temporary": on until logout or restart. */
export type ActivationMode = "persistent" | "temporary";
/** What launch does with fonts that were on last time but aren't on now. */
export type RestorePolicy = "always" | "ask" | "never";

export interface SidebarSections {
  fontBook: boolean;
  google: boolean;
  adobe: boolean;
  purchases: boolean;
  tags: boolean;
}

export interface AppSettings {
  theme: ThemeSetting;
  /** Empty: each family previews its own name. */
  previewText: string;
  /** 10–128 (clamped). */
  previewSize: number;
  restoreLastView: boolean;
  /** Read from the LaunchAgent itself (macOS). Turning it on elsewhere fails with a plain message. */
  launchAtLogin: boolean;
  /** macOS: closing the window hides it; clicking the Dock icon brings it back. */
  keepRunningInBackground: boolean;
  scanAtLaunch: boolean;
  showInstalledInAll: boolean;
  sidebar: SidebarSections;
  activationMode: ActivationMode;
  clearTemporaryOnQuit: boolean;
  restoreOnLaunch: RestorePolicy;
  tagBackups: boolean;
  /** 1–50 (clamped). */
  tagBackupKeep: number;
}

/** Only the keys given change; `sidebar` may be partial too. */
export type AppSettingsPatch = Partial<Omit<AppSettings, "sidebar">> & { sidebar?: Partial<SidebarSections> };

export interface PendingRestore {
  /** Font files that were on last time and aren't on now. 0: nothing to ask. */
  count: number;
  /** Their family names, sorted. */
  families: string[];
}

export interface RestoreReport {
  restored: number;
  failed: number;
}

export interface TurnOffAllReport {
  /** Font files turned off. */
  turnedOff: number;
  /** [file, why] for each one that couldn't be turned off. */
  failed: [string, string][];
}

export interface TagBackup {
  path: string;
  /** Unix time in milliseconds. */
  createdAt: number;
  tags: number;
  bytes: number;
}

export const api = {
  listFolders: () => invoke<Folder[]>("list_folders"),
  addFolder: (path: string) => invoke<Folder>("add_folder", { path }),
  removeFolder: (folderId: number) => invoke<ActivationOutcome[]>("remove_folder", { folderId }),
  scanFolder: (folderId: number) => invoke<ScanReport>("scan_folder", { folderId }),
  cancelScan: (folderId: number) => invoke<void>("cancel_scan", { folderId }),
  listFonts: () => invoke<FontSummary[]>("list_fonts"),
  getFont: (fontId: number) => invoke<FontDetail>("get_font", { fontId }),
  /** At most 64 ids per call. */
  previewProfiles: (ids: number[]) => invoke<PreviewAnswer[]>("preview_profiles", { ids }),
  fontCharacters: (fontId: number) => invoke<FontCharacters>("font_characters", { fontId }),
  /** `scope` turns fonts on that way instead of the saved activation mode (null: the saved mode). */
  setActivation: (fontIds: number[], active: boolean, scope: ActivationMode | null = null) =>
    invoke<ActivationOutcome[]>("set_activation", { fontIds, active, scope }),
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
  purchasesReplace: (id: number, dir: string) => invoke<ReplaceResult>("purchases_replace", { id, dir }),
  purchasesConfirmLicense: (dir: string) => invoke<void>("purchases_confirm_license", { dir }),
  purchasesTransferred: (dir: string) => invoke<void>("purchases_transferred", { dir }),
  purchasesSubscriptionEnded: (store: string) => invoke<RemovalReport>("purchases_subscription_ended", { store }),
  purchasesReveal: (dir: string) => invoke<void>("purchases_reveal", { dir }),
  // ----------------------------------------------------------------------------- settings
  settingsGet: () => invoke<AppSettings>("settings_get"),
  settingsUpdate: (patch: AppSettingsPatch) => invoke<AppSettings>("settings_update", { patch }),
  settingsReset: () => invoke<AppSettings>("settings_reset"),
  /** Waits until launch has worked out what to ask about, so it's safe to call once at startup. */
  activationPendingRestore: () => invoke<PendingRestore>("activation_pending_restore"),
  activationRestoreDecide: (restore: boolean) => invoke<RestoreReport>("activation_restore_decide", { restore }),
  activationTurnOffAll: () => invoke<TurnOffAllReport>("activation_turn_off_all"),
  backupsList: () => invoke<TagBackup[]>("backups_list"),
  backupsCreate: () => invoke<TagBackup>("backups_create"),
  backupsReveal: () => invoke<void>("backups_reveal"),
  appDataReveal: () => invoke<void>("app_data_reveal"),
  /** A double-click on the title bar: zooms, minimizes or does nothing, as the macOS setting says. */
  titleBarDoubleClick: () => invoke<void>("title_bar_double_click"),
};
