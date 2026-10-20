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
  /** What the folder's latest finished scan found but didn't add. Left out until a scan has
   *  counted them. */
  skipped?: SkippedFiles;
}

/** How many files of each kind a scan found but didn't add (skippedFiles.ts words them). Must
 *  match SkippedFiles in src-tauri/src/model.rs. */
export interface SkippedFiles {
  /** PostScript Type 1 outlines: .pfb, .pfa, and Mac LWFN files. */
  type1: number;
  /** The spacing files that go with Type 1 fonts: .pfm, .afm, .inf. */
  type1Metrics: number;
  woff: number;
  woff2: number;
  dfont: number;
  eot: number;
  /** .fon and .fnt files. */
  windowsBitmap: number;
  /** Classic Mac font suitcases. */
  suitcase: number;
  /** TrueType or OpenType files with no extension. */
  noExtension: number;
  /** Files that couldn't be read or aren't usable fonts, including ones remembered from earlier
   *  scans and unchanged since. */
  unreadable: number;
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
  /** What Fontface was asked to do (and keeps asking for: "set to turn on" while it isn't on). */
  activated: boolean;
  /** In a macOS font folder: always on, can't be switched off here. */
  installed: boolean;
  /** Identify this exact version of the file (used to key preview caches). */
  mtime: number;
  fileSize: number;
  /** What macOS reports right now. Drives the switches. */
  osActive: boolean;
  /** Fontface turned this file on until logout or restart (for this login only). Left out when
   *  it didn't. Only means something while the font is on (`osActive`). */
  temporary?: boolean;
  /** The font's own version string, designer and foundry (name IDs 5, 9 and 8): the Table's
   *  columns. Left out when the font doesn't say. */
  version?: string;
  designer?: string;
  manufacturer?: string;
  glyphCount: number;
  /** A variable font's lowest and highest weight (its wght axis). */
  weightRange?: [number, number];
  /** When the font came into the library, in Unix seconds. Fonts from before Fontface recorded
   *  it carry their file's date; left out until that's known. */
  addedAt?: number;
  /** The font names its own grouping family (name ID 16, other than its name ID 1): grouping by
   *  name leaves it as it is. Left out until Fontface has read the font's names (a launch
   *  backfill reads older fonts). */
  hasTypoFamily?: boolean;
  /** The font's name ID 1, when it differs from `family` (which is name ID 16 if there is one). */
  legacyFamily?: string;
  /** What the preview draws (src-tauri/src/preview). Null until the face has a current profile:
   *  the list then asks for one (`previewProfiles`) and draws the name meanwhile. */
  preview: PreviewInfo | null;
}

/** A face's preview profile. Must match PreviewInfo in src-tauri/src/preview/mod.rs. */
export interface PreviewInfo {
  /** What the family row draws: "name" (the name as is), "trim", "case", "sample19" (the
   *  font's own sample text), or a sample of its real characters: "script", "symbols",
   *  "expert", "partial". "none": nothing real to draw. */
  kind: PreviewKind;
  /** What a style row draws, when it differs from `kind` (the full name can't be drawn though
   *  the family name can). */
  fullKind?: PreviewKind;
  /** What a family row draws instead of the family name. */
  familyText?: string;
  /** What a style row draws instead of the full name. */
  fullText?: string;
  /** "Symbols", "Expert set", a script name or "Partial set", when either row draws a sample. */
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
  /** Profiles saved by this run so far. 0 on the last batch: nothing changed. */
  written: number;
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
  /** A work limit cut the check short: some characters may be missing from the grid. */
  limited: boolean;
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

/** One OpenType feature of a face (`fontFacts`). Must match Feature in src-tauri/src/facts/layout.rs. */
export interface FontFeature {
  /** "liga", "ss01"… */
  tag: string;
  /** The font's own name for it (stylistic sets and character variants), if it gives one. */
  name?: string;
  /** Characters it changes, space-separated ("a g y", "fi fl"), when that can be worked out. */
  sample?: string;
  /** In the substitution table, the positioning table, or both. */
  gsub: boolean;
  gpos: boolean;
}

/** A script the font's OpenType tables are written for, with the languages they treat
 *  specially (OpenType tags, trimmed: "latn" with "TRK", "ROM"). */
export interface FontScript {
  tag: string;
  languages: string[];
}

/** A variable font's named style (an `fvar` instance). */
export interface NamedInstance {
  name: string;
  postscriptName?: string;
  /** [axis tag, value], in the font's axis order. */
  values: [string, number][];
}

/** What a font file says about embedding it (OS/2 `fsType`). */
export interface Embedding {
  kind: "installable" | "editable" | "previewPrint" | "restricted" | "unclear";
  /** Documents must embed the whole font. */
  noSubsetting: boolean;
  /** Only bitmaps may be embedded, not outlines. */
  bitmapOnly: boolean;
}

/** `fontFacts`: read from the file on demand. Must match FontFacts in src-tauri/src/facts/mod.rs. */
export interface FontFacts {
  features: FontFeature[];
  scripts: FontScript[];
  /** Apple's own feature table (AAT `morx`) and no OpenType substitutions; there may still be
   *  OpenType positioning features, such as kerning. */
  appleFeatures: boolean;
  instances: NamedInstance[];
  embedding: Embedding | null;
  /** The kind of font its OS/2 table says it is, as a CSS generic family (Copy as CSS's
   *  fallback). Null when it doesn't say, as most fonts don't. */
  generic: "serif" | "sans-serif" | "monospace" | null;
  /** Name IDs 7, 10, 11, 12 and 19. */
  trademark: string | null;
  description: string | null;
  vendorUrl: string | null;
  designerUrl: string | null;
  sampleText: string | null;
  /** BCP 47 codes CoreText says the face supports (macOS); null where the system can't say. */
  languages: string[] | null;
}

/** Why `fontFacts` didn't read the file. "cloud": online-only, never downloaded for this. */
export type FactsUnread = "cloud" | "adobe" | "tooLarge" | "missing" | "changed" | "broken";

export interface FactsAnswer {
  facts: FontFacts | null;
  unread: FactsUnread | null;
  message: string | null;
  /** When Fontface last turned this font on, in Unix seconds. */
  lastTurnedOn: number | null;
}

/** `getFont`: the list's fields (version, designer and foundry among them) and the rest. */
export interface FontDetail extends FontSummary {
  copyright: string | null;
  license: string | null;
  licenseUrl: string | null;
  axes: Axis[];
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
  /** Files it found but didn't add, by kind. All zero for a cancelled scan. */
  skipped: SkippedFiles;
}

export interface ActivationOutcome {
  path: string;
  ids: number[];
  /** What the OS has now. */
  active: boolean;
  /** What Fontface has recorded now (the fonts' `activated`). It differs from `active` when
   *  another app keeps the font on, or macOS didn't load it. */
  activated: boolean;
  /** The file is on until logout or restart (its scope after this request). */
  temporary: boolean;
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
  /** SPDX id. Icon families (Material Icons and Symbols) show Apache-2.0, their real license. */
  license: string;
  lastModified: string;
  installed: { dir: string; lastModified: string } | null;
  updateAvailable: boolean;
  /** Why it can't be downloaded (an icon font Fontface doesn't know where to get yet), if it can't. */
  unavailable: string | null;
}

export interface GoogleCatalog {
  families: GoogleFamily[];
  fetchedAt: number;
  stale: boolean;
}

/**
 * What `google_preview` asks for. "row": what a catalog row shows (Rust picks the family's name,
 * its icons, or a sample of its script). "alphabet": a fixed set of letters (printable ASCII and
 * Latin-1), for drawing typed text, which never leaves the Mac.
 */
export type GooglePreviewKind = "row" | "alphabet";

/**
 * `google_preview`: an online preview of a family that isn't downloaded. Must match GooglePreview
 * in src-tauri. "ready": the file is in the preview cache. "off": online previews are turned off
 * in Settings. "offline": Google couldn't be reached (Rust waits a while before trying again).
 * "unavailable": Google has no preview of it, or the file can't draw anything. "tooLarge": the
 * file is over the size limit.
 */
export interface GooglePreview {
  state: "ready" | "off" | "offline" | "unavailable" | "tooLarge";
  /** "google/<id>/<token>/<file kind>": where `ff://` serves the cached file (fontLoader). */
  path?: string;
  /** What the row draws from the file: the family name, the icons or the script sample. */
  text?: string;
  /** `text` isn't the family name, so the View options' case doesn't apply to it. */
  sample?: boolean;
  /** The file's preview profile, as the library has for its fonts. */
  profile?: PreviewInfo;
}

/** `google_preview_cache`: how much the online preview files take up. */
export interface GooglePreviewCache {
  bytes: number;
}

export interface GoogleInstallResult {
  dir: string;
  files: string[];
  /** An earlier copy was replaced. */
  updated: boolean;
  /**
   * An update in which no font file had changed upstream: the fonts were left in place, still on
   * as they were, and only the install details were refreshed. Nothing needs turning back on.
   */
  unchanged: boolean;
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

/** `google_remove`: what it turned off, so Undo (`google_restore`) turns the same files back on,
 *  the same way. The files are set aside until Fontface quits, which deletes them. */
export interface GoogleRemoved {
  /** File names that were on. */
  wasActiveFiles: string[];
  /** Of those, the ones that were on until logout (scope "temporary"). */
  temporaryFiles: string[];
}

/** `google_restore`: the removed family's folder, back in place, and its font file names. */
export interface GoogleRestored {
  dir: string;
  files: string[];
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
// (no payload: the macOS app menu's Settings… item, ⌘,, or the menu bar icon's Settings…).
//
// The menu bar icon (src-tauri/src/tray.rs) also sends "activation-changed" (payload:
// TemporaryOffReport, after "Turn Off Temporary Fonts"; the list reloads).

export type ThemeSetting = "system" | "light" | "dark";
/** "persistent": fonts stay on after quitting and restarting. "temporary": on until logout or restart. */
export type ActivationMode = "persistent" | "temporary";

/**
 * Why fonts are switched. "switch": the user's switch, their choice. "arrival": Fontface turning on
 * fonts that just came into the library (a first download, an import, or an update or a
 * replacement putting back what was on); sync shares them only where nobody has chosen yet, and
 * gives the others their choice again.
 */
export type SwitchOrigin = "switch" | "arrival";
/** What launch does with fonts that were on last time but aren't on now. */
export type RestorePolicy = "always" | "ask" | "never";
/** macOS: when the Dock shows Fontface. "whileOpen" (the default) applies only while it's in the menu bar. */
export type DockIcon = "always" | "whileOpen";
/** A font page's tabs. "axes" shows only for variable styles (the page falls back to "specimen"). */
export type FontPageTab = "specimen" | "characters" | "opentype" | "axes" | "info";

/** The View options' preview styling. Must match PreviewOptions in src-tauri/src/settings.rs. */
export type PreviewAlign = "left" | "center" | "right";
export type PreviewCase = "asTyped" | "upper" | "lower" | "title";
/** Must match PREVIEW_FEATURES in src-tauri/src/settings.rs (previewStyle.ts has their CSS). */
export type PreviewFeature = "noLigatures" | "smallCaps" | "tabularFigures" | "caseForms";
export interface PreviewOptions {
  align: PreviewAlign;
  case: PreviewCase;
  outline: boolean;
  underline: boolean;
  /** "#rrggbb", or null for the theme's. */
  ink: string | null;
  paper: string | null;
  /** In PREVIEW_FEATURES order. */
  features: PreviewFeature[];
}

/** How the library lists fonts: a grid of cards, the list of rows, or a sortable table. */
export type LibraryLayout = "tiles" | "rows" | "table";
/** What the library is sorted by: the View options' choices, and the Table's other columns. */
export type SortKey =
  | "name"
  | "added"
  | "styles"
  | "weight"
  | "foundry"
  | "active"
  | "format"
  | "source"
  | "version"
  | "designer"
  | "file"
  | "size"
  | "glyphs";
/** `desc`: the other way round from smallest to largest (Z to A, newest first, most first). */
export interface SortOrder {
  key: SortKey;
  desc: boolean;
}
export type TableDensity = "compact" | "regular";
/** One Table column, in the order shown. `width` only once it has been dragged. The ids belong to
 *  src/components/library/columns.ts; ones it doesn't know are ignored. */
export interface TableColumnSetting {
  id: string;
  shown: boolean;
  width?: number;
}

/** What the sidebar shows. Must match SidebarSections in src-tauri/src/settings.rs: a key the
 *  back end doesn't know isn't saved. All Fonts and your folders always show. */
export interface SidebarSections {
  /** The smart entries under Library. */
  yours: boolean;
  recent: boolean;
  active: boolean;
  untagged: boolean;
  /** The sources. */
  fontBook: boolean;
  google: boolean;
  adobe: boolean;
  purchases: boolean;
  tags: boolean;
  /** The Built-in group under Tags (tags from Font Book and Typeface). Hidden, they still exist and still show on fonts. */
  builtinTags: boolean;
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
  /** macOS: closing the window hides it; clicking the Dock icon brings it back. While Fontface
   *  is in the menu bar (`showInMenuBar`), closing the window always does that; this decides
   *  only for when it isn't. */
  keepRunningInBackground: boolean;
  /** An icon in the menu bar (macOS) or the notification area (Windows), with a short menu.
   *  While it's there, closing the window keeps Fontface running. On by default. */
  showInMenuBar: boolean;
  /** macOS: whether the Dock shows Fontface while its window is closed. */
  dockIcon: DockIcon;
  scanAtLaunch: boolean;
  showInstalledInAll: boolean;
  sidebar: SidebarSections;
  activationMode: ActivationMode;
  clearTemporaryOnQuit: boolean;
  restoreOnLaunch: RestorePolicy;
  tagBackups: boolean;
  /** 1–50 (clamped). */
  tagBackupKeep: number;
  /** The font page tab used last; the next font page opens on it. */
  fontPageTab: FontPageTab;
  /** The View options (the toolbar's layout switch too). */
  layout: LibraryLayout;
  /** Off: every style is its own item, "Family Style". */
  groupStyles: boolean;
  /** View options › "Group families by name". Off: families use the fonts' own names
   *  (your own family choices still apply). */
  groupByName: boolean;
  sort: SortOrder;
  /** Empty: the default columns. */
  tableColumns: TableColumnSetting[];
  tableDensity: TableDensity;
  /** The View options' preview styling, for every layout and the font page. */
  preview: PreviewOptions;
  /** Settings › General › "Show previews of Google Fonts you haven't downloaded". On by default.
   *  Off: nothing is sent to Google for previews, and those families show their names in the
   *  interface font. */
  googlePreviews: boolean;
  /** "Installed" (yours first) on a font service's catalog page: families you have (downloaded, or already
   *  in your library) come before the rest. On by default. */
  catalogYoursFirst: boolean;
}

/** Only the keys given change; `sidebar` and `preview` may be partial too. */
export type AppSettingsPatch = Partial<Omit<AppSettings, "sidebar" | "preview">> & {
  sidebar?: Partial<SidebarSections>;
  preview?: Partial<PreviewOptions>;
};

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

/** What the menu bar icon's "Turn Off Temporary Fonts" did ("activation-changed"). Must match
 *  TemporaryOff in src-tauri/src/tray.rs. */
export interface TemporaryOffReport {
  /** Fonts (styles) turned off. */
  turnedOff: number;
  /** [file, why] for each file that couldn't be turned off. */
  failed: [string, string][];
  /** Why nothing could be done, if so. */
  error: string | null;
}

export interface TurnOffAllReport {
  /** Font files turned off. */
  turnedOff: number;
  /** [file, why] for each one that couldn't be turned off. */
  failed: [string, string][];
}

// --------------------------------------------------------------------------- family groups
// Must match src-tauri/src/families.rs. Your choices for family grouping (src/familyGroups.ts):
// stored by Fontface, never in the font files. Every change returns the change that undoes it.

/** A font's choice to set (`family` null: under its own name), or null to clear it. */
export interface FamilyChoiceValue {
  family: string | null;
  style: string | null;
}
/** A name's rule to set, or null to clear it. */
export interface FamilyRuleValue {
  name: string;
  decision: "merge" | "separate";
  into: string | null;
}
export interface FamilyChange {
  faces: { faceKey: string; set: FamilyChoiceValue | null }[];
  names: { nameKey: string; set: FamilyRuleValue | null }[];
}
export interface FamilyChoicesData {
  choices: { faceKey: string; family: string | null; style: string | null }[];
  rules: { nameKey: string; name: string; decision: "merge" | "separate"; into: string | null }[];
}
/** A family name for a rule: its squash key (familyGroups.squash) and its spelling. */
export interface NameRef {
  nameKey: string;
  name: string;
}

// ------------------------------------------------------------------ Remove from Library
// Must match src-tauri/src/removed.rs. Files stay where they are: Fontface stops listing them.

/** A removed file that was on: Undo turns it back on the same way. */
export interface RemovedOn {
  path: string;
  temporary: boolean;
}

export interface RemoveReport {
  /** The files no longer listed. */
  removed: string[];
  /** Their folders (scanned again on Undo). */
  folders: number[];
  wasOn: RemovedOn[];
  /** Files that couldn't be turned off: they stay in the library. */
  failures: ActivationOutcome[];
  /** Fonts that aren't in your folders: left alone. */
  skipped: number;
}

/** A file you removed from the library (Settings › Library lists them). */
export interface RemovedFile {
  path: string;
  folderId: number;
  /** Unix seconds. */
  removedAt: number;
}

export interface TagBackup {
  path: string;
  /** Unix time in milliseconds. */
  createdAt: number;
  tags: number;
  bytes: number;
}

/**
 * One font to find by name (Turn On Fonts from a List…): a line of text ("Inter-Bold", "Inter
 * Bold", "Inter"), or a font named in parts, as the Figma plugin's JSON does. Must match
 * NameLine in src-tauri/src/font_names/mod.rs.
 */
export type NameLine = string | { family?: string; style?: string; postscriptName?: string };

/** Which rule found a line's fonts: a whole family, a PostScript name, a full name, a family and
 *  style, or a style inside a variable font of that family. */
export type NameMatchHow = "family" | "postScript" | "fullName" | "familyStyle" | "namedStyle";

/** A style a line found. Must match FoundFace in src-tauri/src/font_names/mod.rs. */
export interface FoundFace {
  /** Its face key, as the library's styles are keyed (library.ts). */
  key: string;
  family: string;
  style: string;
  postscriptName: string | null;
  /** Its copies' font ids. Creative Cloud's are never listed. */
  ids: number[];
  variable: boolean;
  italic: boolean;
  /** In a macOS font folder: always on. */
  installed: boolean;
  /** Every copy is online-only in cloud storage: turning it on downloads it first. */
  onlineOnly: boolean;
}

/** What one line found: none when `how` is null, with the library's closest names if any. */
export interface LineMatch {
  how: NameMatchHow | null;
  faces: FoundFace[];
  near: string[];
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
  /** The font page's OpenType features, named styles, embedding, more names and languages, read
   *  from the file (never an online-only or Creative Cloud one), and when it was last turned on. */
  fontFacts: (fontId: number) => invoke<FactsAnswer>("font_facts", { fontId }),
  /**
   * `scope` turns fonts on that way instead of the saved activation mode (null: the saved mode).
   * `origin` says why: only the user's own switch is shared as their choice by sync.
   */
  setActivation: (fontIds: number[], active: boolean, scope: ActivationMode | null = null, origin: SwitchOrigin = "switch") =>
    invoke<ActivationOutcome[]>("set_activation", { fontIds, active, scope, origin }),
  revealFont: (fontId: number) => invoke<void>("reveal_font", { fontId }),
  /** Shows a library folder in Finder (Explorer on Windows). */
  revealFolder: (folderId: number) => invoke<void>("reveal_folder", { folderId }),
  listServices: () => invoke<ServiceInfo[]>("list_services"),
  googleCatalog: (refresh = false) => invoke<GoogleCatalog>("google_catalog", { refresh }),
  googleInstall: (id: string) => invoke<GoogleInstallResult>("google_install", { id }),
  googleRemove: (id: string) => invoke<GoogleRemoved>("google_remove", { id }),
  /** Undo for googleRemove, until Fontface quits. */
  googleRestore: (id: string) => invoke<GoogleRestored>("google_restore", { id }),
  /** An online preview file of a family (googlePreviewStore.ts). The only call that may use the
   *  network for previews, and only while `googlePreviews` is on. */
  googlePreview: (id: string, kind: GooglePreviewKind) => invoke<GooglePreview>("google_preview", { id, kind }),
  googlePreviewCache: () => invoke<GooglePreviewCache>("google_preview_cache"),
  clearGooglePreviewCache: () => invoke<void>("clear_google_preview_cache"),
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
  familiesGet: () => invoke<FamilyChoicesData>("families_get"),
  /** These names go into `into` from now on, and these fonts (chosen elsewhere before) with them. */
  familiesMerge: (names: NameRef[], into: string, faces: string[] = []) => invoke<FamilyChange>("families_merge", { names, into, faces }),
  /** These names are never grouped by name; these fonts stay under their own names. */
  familiesKeepSeparate: (names: NameRef[], faces: string[] = []) => invoke<FamilyChange>("families_keep_separate", { names, faces }),
  familiesMove: (faces: string[], family: string, style: string | null = null) => invoke<FamilyChange>("families_move", { faces, family, style }),
  /** Forgets your choices for these fonts and your rules for these names. */
  familiesReset: (faces: string[], nameKeys: string[]) => invoke<FamilyChange>("families_reset", { faces, nameKeys }),
  /** Applies a change another call returned: undo (and redo). */
  familiesUndo: (change: FamilyChange) => invoke<FamilyChange>("families_undo", { change }),
  /** Several changes as one, with one undo. */
  familiesApply: (change: FamilyChange) => invoke<FamilyChange>("families_apply", { change }),
  /** A double-click on the title bar: zooms, minimizes or does nothing, as the macOS setting says. */
  titleBarDoubleClick: () => invoke<void>("title_bar_double_click"),
  /** The macOS View and Font menus follow the page (fontActions.nativeMenuState). Elsewhere it does nothing. */
  setMenuState: (state: import("./fontActions").NativeMenuState) => invoke<void>("set_menu_state", { state }),
  /** Remove from Library: these fonts' files are turned off and no longer listed. Files aren't touched. */
  fontsRemove: (fontIds: number[]) => invoke<RemoveReport>("fonts_remove", { fontIds }),
  fontsRemoved: () => invoke<RemovedFile[]>("fonts_removed"),
  /** Lists these removed files again at their folders' next scan; returns the folders to scan. */
  fontsPutBack: (paths: string[]) => invoke<number[]>("fonts_put_back", { paths }),
  /** The library's styles for each name, in the order given (at most 5,000 at once). Reads only. */
  matchFontNames: (lines: NameLine[]) => invoke<LineMatch[]>("match_font_names", { lines }),
};
