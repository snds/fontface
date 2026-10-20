import type { Folder, ScanProgress, ServiceInfo, SidebarSections, SkippedFiles } from "@/api";
import { INSTALLED_LABEL, type Family, type LibraryView, type PlaceCounts } from "@/library";
import { smartRows, sourceFolders, sourceOf, sourceRows, sourceView, type SourceKey } from "@/places";
import { skippedMenuTip, skippedTotal, sumSkipped } from "@/skippedFiles";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ROW_TIP_DELAY, Tip } from "@/components/Tip";
import { FONT_LIST_TIP } from "@/components/FontListDialog";
import { cn } from "@/lib/utils";
import { colorVar } from "@/tags/api";
import { ADOBE_LOCATION, FONT_BOOK_LOCATION, useLocations } from "@/tags/locations";
import { LocationMenu, type MenuAction } from "@/tags/menus";
import { TagsSection } from "@/tags/TagsSection";
import { dragRegion, IS_MAC, useTitleBar } from "@/components/TitleBar";

interface Props {
  folders: Folder[];
  /** Style counts (duplicate copies count once) for the smart entries and Font Book, matching
   *  what each lists. */
  counts: PlaceCounts;
  /** The same, per folder. */
  folderCounts: Map<number, number>;
  /** The whole library, for tag counts. */
  families: Family[];
  services: ServiceInfo[];
  /** Fonts Creative Cloud has turned on, once known. */
  adobeCount: number | null;
  /** Font downloads found by the purchases watcher, waiting to be added. */
  newPurchases: number;
  view: LibraryView;
  scans: Map<number, ScanProgress>;
  /** What the sidebar shows (a setting). All Fonts and the user's folders are always there. */
  show: SidebarSections;
  /** A click on an entry: go there (App closes any open page). */
  onView: (v: LibraryView) => void;
  /** The view went away by itself (its tag was deleted or hidden): App falls back without
   *  closing an open page. */
  onFallback: (v: LibraryView) => void;
  onAddFolder: () => void;
  onRemoveFolder: (f: Folder) => void;
  onRescan: (f: Folder) => void;
  onCancelScan: (f: Folder) => void;
  onOpenSettings: () => void;
  /** Point a folder that can't be found at where it moved ("Locate…"). */
  onLocateFolder?: (f: Folder) => void;
  /** Show a folder in Finder. */
  onRevealFolder: (f: Folder) => void;
  /** List the files a source's latest scan found but didn't add (Show Skipped Files…). */
  onShowSkipped: (name: string, skipped: SkippedFiles) => void;
  /** Turn On Fonts from a List…: paste font names, then turn them on or tag them. */
  onFontList: () => void;
}

const itemClass = (selected: boolean) =>
  cn(
    "group/item flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm",
    selected ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "hover:bg-sidebar-accent/60",
  );

const n = (v: number) => v.toLocaleString();
const styles = (v: number) => `${n(v)} ${v === 1 ? "style" : "styles"}`;
const FILE_BROWSER = IS_MAC ? "Finder" : "Explorer";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{children}</div>;
}

/** A small icon button: `label` is its name, `tip` its tooltip (what a click does). */
function IconAction({ icon, label, tip, onClick }: { icon: string; label: string; tip: string; onClick: () => void }) {
  return (
    <Tip tip={tip}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        // Ignore the second click of a double-click: Rescan turns into Stop under the cursor.
        onClick={(e) => e.detail <= 1 && onClick()}
      >
        <Icon name={icon} size={16} />
      </Button>
    </Tip>
  );
}

/** The tooltips of a source's scan commands, on its hover buttons and in its right-click menu. */
const RESCAN_TIP = "Looks again for added, changed or removed fonts";
const STOP_TIP = "Stops the scan. Fonts read so far are kept.";
const LOCATE_TIP = "Points Fontface at where the folder moved, then rescans it";
const REMOVE_TIP = "Turns off its fonts and takes them out of your library. Files stay on disk.";
const ADD_FOLDER_TIP = "Picks a folder of fonts to add to your library";
const OS = IS_MAC ? "macOS" : "Windows";

/** A smart entry's tooltip. places.ts words each hint as what the entry lists ("Fonts added in the
 *  last 30 days…"), so it reads on from "Shows". */
const showsTip = (hint: string) => `Shows ${hint.charAt(0).toLowerCase()}${hint.slice(1)}`;

/** One line describing where a scan is up to. */
export function scanStatus(p: ScanProgress): string {
  if (p.phase === "starting") return "Starting…";
  if (p.phase === "discovering") return `Finding font files… ${n(p.found)} found`;
  return `Reading ${n(p.done)} of ${n(p.found)}`;
}

/** Several folders' scans as one (Font Book's three folders): reading once every one is. */
function combined(list: ScanProgress[]): ScanProgress | undefined {
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  const reading = list.every((p) => p.phase === "reading");
  const sum = (pick: (p: ScanProgress) => number) => list.reduce((t, p) => t + pick(p), 0);
  return { ...list[0], phase: reading ? "reading" : "discovering", found: sum((p) => p.found), done: sum((p) => p.done), cloud: sum((p) => p.cloud) };
}

interface RowProps {
  label: string;
  icon: string;
  /** The location color (CSS), filling the icon. */
  color?: string;
  /** Can't be found: a red icon. */
  missing?: boolean;
  scan?: ScanProgress;
  count: number | null;
  /** A highlighted badge before the count ("3 new"), with what screen readers hear for it. */
  badge?: { text: string; said: string };
  selected: boolean;
  /** The row's tooltip: what it shows. */
  hint: string;
  onOpen: () => void;
  /** Shown in place of the count on hover or focus: Rescan or Stop (and Remove, for your folders). */
  actions?: React.ReactNode;
}

/**
 * A row in SOURCES. No chevrons: a source's folders are picked in the toolbar instead. The
 * button covers the whole row (its ::after), so a click on the count, the "n new" badge or the
 * padding opens the source too, like the rest of the row; the hover actions sit above it.
 */
function SourceRow({ label, icon, color, missing, scan, count, badge, selected, hint, onOpen, actions }: RowProps) {
  const progress = scan && scan.phase === "reading" ? `${Math.floor((scan.done / Math.max(1, scan.found)) * 100)}%` : null;
  return (
    <div className={cn(itemClass(selected), "relative")}>
      <Tip tip={hint} delay={ROW_TIP_DELAY} contentClassName="max-w-72 break-words">
        <button
          className="flex min-w-0 flex-1 items-center gap-2 after:absolute after:inset-0 after:rounded-md"
          aria-current={selected ? "page" : undefined}
          onClick={onOpen}
        >
          {scan ? (
            <Icon name="progress_activity" size={18} className="animate-spin text-muted-foreground" />
          ) : (
            <Icon
              name={icon}
              size={18}
              filled={!!color && !missing}
              className={missing ? "text-destructive" : "text-muted-foreground"}
              style={color && !missing ? { color } : undefined}
            />
          )}
          <span className="truncate">{label}</span>
          <span className="sr-only">
            {count !== null ? `, ${styles(count)}` : ""}
            {badge ? `, ${badge.said}` : ""}
            {scan ? `, scanning${progress ? ` (${progress})` : ""}` : ""}
            {missing ? ", can't be found" : ""}
          </span>
        </button>
      </Tip>
      {badge && (
        <span aria-hidden className="shrink-0 rounded-full bg-primary px-1.5 font-mono text-xs text-primary-foreground tabular-nums">
          {badge.text}
        </span>
      )}
      {/* Count, or scan progress; swapped for actions on hover. */}
      <span
        aria-hidden
        className={cn("font-mono text-xs text-muted-foreground tabular-nums", actions && "group-focus-within/item:hidden group-hover/item:hidden")}
      >
        {progress ?? (count !== null ? n(count) : "")}
      </span>
      {actions && <span className="relative z-10 hidden items-center group-focus-within/item:flex group-hover/item:flex">{actions}</span>}
    </div>
  );
}

/** The id of the Settings button, so focus can come back to it when settings close. */
export const SETTINGS_BUTTON_ID = "open-settings";

/**
 * The sidebar: LIBRARY (All Fonts and the smart entries, each with a count), SOURCES (Font Book,
 * Google Fonts, Adobe Fonts, Purchases, then your folders A to Z, one row each), then TAGS.
 * Every source row's commands are on its right-click menu, which Shift-F10 opens too: Rescan or
 * Stop, Show in Finder, Show Skipped Files… (when its last scan found files it can't use),
 * Locate… (a folder that moved), its color, and for your folders Remove from Library…. Rows with
 * folders also show Rescan (or Stop) on hover, and your folders Remove.
 */
export function Sidebar(props: Props) {
  const { folders, counts, folderCounts, families, services, adobeCount, newPurchases, view, scans, show, onView, onFallback, onAddFolder } = props;
  const locations = useLocations(folders, services);
  const titleBar = useTitleBar();
  const smart = smartRows(show);
  const sources = sourceRows(folders, show);
  const selectedSource = sourceOf(view, folders, services);
  const running = folders.filter((f) => scans.has(f.id));
  const user = folders.filter((f) => f.kind === "user");

  /**
   * The commands for a source with library folders: Rescan (or Stop), Show in Finder for one
   * folder, and Show Skipped Files… when its latest scans found files they didn't add. `name`:
   * the source's.
   */
  const scanActions = (list: Folder[], scanning: boolean, name: string): MenuAction[] => {
    const reachable = list.filter((f) => !f.missing);
    if (!reachable.length) return [];
    const out: MenuAction[] = scanning
      ? [{ icon: "stop_circle", label: "Stop Scanning", tip: STOP_TIP, onClick: () => list.filter((f) => scans.has(f.id)).forEach(props.onCancelScan) }]
      : [{ icon: "refresh", label: "Rescan", tip: RESCAN_TIP, onClick: () => reachable.forEach(props.onRescan) }];
    if (list.length === 1 && !list[0].missing) {
      out.push({ icon: "folder_open", label: `Show in ${FILE_BROWSER}`, tip: `Opens the folder in ${FILE_BROWSER}`, onClick: () => props.onRevealFolder(list[0]) });
    }
    const skipped = sumSkipped(list.map((f) => f.skipped));
    if (skipped && skippedTotal(skipped) > 0) {
      out.push({ icon: "visibility_off", label: "Show Skipped Files…", tip: skippedMenuTip(skipped), onClick: () => props.onShowSkipped(name, skipped) });
    }
    return out;
  };

  /** The same Rescan (or Stop), as the hover button your folders have too. `name`: the source's. */
  const scanButton = (list: Folder[], scanning: boolean, name: string) => {
    const reachable = list.filter((f) => !f.missing);
    if (!reachable.length) return undefined;
    return scanning ? (
      <IconAction icon="stop_circle" label={`Stop scanning ${name}`} tip={STOP_TIP} onClick={() => list.filter((f) => scans.has(f.id)).forEach(props.onCancelScan)} />
    ) : (
      <IconAction icon="refresh" label={`Rescan ${name}`} tip={RESCAN_TIP} onClick={() => reachable.forEach(props.onRescan)} />
    );
  };

  const row = (source: SourceKey) => {
    const list = sourceFolders(source, folders, services);
    const scan = combined(list.flatMap((f) => scans.get(f.id) ?? []));
    const selected = selectedSource === source;
    const open = () => onView(sourceView(source));
    if (source === "fontbook") {
      return (
        <LocationMenu
          key={source}
          location={FONT_BOOK_LOCATION}
          color={locations.colorOf(FONT_BOOK_LOCATION)}
          defaultColor={locations.defaultOf(FONT_BOOK_LOCATION)}
          before={scanActions(list, !!scan, INSTALLED_LABEL)}
        >
          <SourceRow
            label={INSTALLED_LABEL}
            icon="auto_stories"
            color={colorVar(locations.colorOf(FONT_BOOK_LOCATION))}
            scan={scan}
            count={counts.installed}
            selected={selected}
            hint={`Shows the fonts installed in ${OS}. They're always on.`}
            onOpen={open}
            actions={scanButton(list, !!scan, INSTALLED_LABEL)}
          />
        </LocationMenu>
      );
    }
    if (source === "adobe") {
      return (
        <LocationMenu key={source} location={ADOBE_LOCATION} color={locations.colorOf(ADOBE_LOCATION)} defaultColor={locations.defaultOf(ADOBE_LOCATION)}>
          <SourceRow
            label="Adobe Fonts"
            icon="cloud"
            color={colorVar(locations.colorOf(ADOBE_LOCATION))}
            count={adobeCount || null}
            selected={selected}
            hint="Shows the fonts Adobe Creative Cloud has turned on (read-only)"
            onOpen={open}
          />
        </LocationMenu>
      );
    }
    if (source === "google" || source === "purchases") {
      const folder = list[0];
      const color = folder ? locations.colorOf(folder.path) : undefined;
      const google = source === "google";
      const name = google ? "Google Fonts" : "Purchases";
      return (
        <LocationMenu
          key={source}
          location={folder?.path ?? ""}
          color={color ?? "gray"}
          defaultColor={folder ? locations.defaultOf(folder.path) : "gray"}
          disabled={!folder}
          before={scanActions(list, !!scan, name)}
        >
          <SourceRow
            label={name}
            icon={google ? "cloud" : "shopping_bag"}
            color={color ? colorVar(color) : undefined}
            scan={scan}
            count={folder ? (folderCounts.get(folder.id) ?? 0) : 0}
            badge={!google && newPurchases > 0 ? { text: `${n(newPurchases)} new`, said: `${n(newPurchases)} new ${newPurchases === 1 ? "download" : "downloads"} to review` } : undefined}
            selected={selected}
            hint={
              google
                ? "Google's free fonts: get them, turn them on and off, update or remove them. The number counts the styles you downloaded."
                : "Fonts you bought, added from your downloads. Browse to review new downloads."
            }
            onOpen={open}
            actions={scanButton(list, !!scan, name)}
          />
        </LocationMenu>
      );
    }
    const folder = list[0];
    if (!folder) return null;
    const locate = folder.missing && props.onLocateFolder ? () => props.onLocateFolder!(folder) : undefined;
    return (
      <LocationMenu
        key={source}
        location={folder.path}
        color={locations.colorOf(folder.path)}
        defaultColor={locations.defaultOf(folder.path)}
        onLocate={locate}
        before={scanActions(list, !!scan, folder.label)}
        after={[{ icon: "close", label: "Remove from Library…", tip: REMOVE_TIP, destructive: true, onClick: () => props.onRemoveFolder(folder) }]}
      >
        <SourceRow
          label={folder.label}
          icon={folder.missing ? "folder_off" : "folder"}
          color={colorVar(locations.colorOf(folder.path))}
          missing={folder.missing}
          scan={scan}
          count={folderCounts.get(folder.id) ?? folder.fontCount}
          selected={selected}
          hint={folder.missing ? `Can't find ${folder.path}. If it moved, use Locate… to point Fontface at it.` : `Shows the fonts in ${folder.path}`}
          onOpen={open}
          actions={
            <>
              {locate ? (
                <IconAction icon="folder_open" label="Locate folder…" tip={LOCATE_TIP} onClick={locate} />
              ) : scan ? (
                <IconAction icon="stop_circle" label="Stop scanning" tip={STOP_TIP} onClick={() => props.onCancelScan(folder)} />
              ) : (
                <IconAction icon="refresh" label="Rescan folder" tip={RESCAN_TIP} onClick={() => props.onRescan(folder)} />
              )}
              <IconAction icon="close" label="Remove from library" tip={REMOVE_TIP} onClick={() => props.onRemoveFolder(folder)} />
            </>
          }
        />
      </LocationMenu>
    );
  };

  return (
    <aside className="flex min-h-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      {/* macOS: the window buttons sit here, in the sidebar's color, and the strip moves the window
          like the rest of the top row. Full screen hides the buttons, so the strip goes too. */}
      {titleBar && <div className="h-13 shrink-0 select-none" {...dragRegion(true)} />}
      <ScrollArea className="min-h-0 flex-1">
        <nav className={cn("flex flex-col gap-4 p-2", !titleBar && "pt-3")}>
          <div>
            {/* Library-wide, not about a selection, so it sits by the heading, as Add folder does by SOURCES. */}
            <div className="flex items-center justify-between pr-1">
              <SectionLabel>Library</SectionLabel>
              <IconAction icon="playlist_add_check" label="Turn on fonts from a list" tip={FONT_LIST_TIP} onClick={props.onFontList} />
            </div>
            {smart.map((entry) => {
              const selected = view.kind === entry.kind;
              return (
                <Tip key={entry.kind} tip={showsTip(entry.hint)} delay={ROW_TIP_DELAY} contentClassName="max-w-72">
                  <button className={itemClass(selected)} aria-current={selected ? "page" : undefined} onClick={() => onView({ kind: entry.kind })}>
                    <Icon name={entry.icon} size={18} className="text-muted-foreground" />
                    <span className="flex-1 truncate">{entry.label}</span>
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">{n(counts[entry.kind])}</span>
                  </button>
                </Tip>
              );
            })}
          </div>

          <div>
            <div className="flex items-center justify-between pr-1">
              <SectionLabel>Sources</SectionLabel>
              <IconAction icon="create_new_folder" label="Add folder" tip={ADD_FOLDER_TIP} onClick={onAddFolder} />
            </div>
            {sources.map(row)}
            {user.length === 0 && (
              <Tip tip={ADD_FOLDER_TIP}>
                <button className="w-full px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground" onClick={onAddFolder}>
                  Add a folder of fonts…
                </button>
              </Tip>
            )}
          </div>

          {show.tags && <TagsSection families={families} view={view} onView={onView} onFallback={onFallback} showBuiltin={show.builtinTags} />}
        </nav>
      </ScrollArea>

      {running.length > 0 && (
        <div className="flex flex-col gap-3 border-t p-3 text-xs">
          {running.map((folder) => {
            const p = scans.get(folder.id)!;
            const determinate = p.phase === "reading" && p.found > 0;
            return (
              <div key={folder.id} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <Icon name="progress_activity" size={14} className="animate-spin text-muted-foreground" />
                  <span className="flex-1 truncate font-medium">{folder.label}</span>
                  <Tip tip={`Stops scanning ${folder.label}. Fonts read so far are kept.`}>
                    <Button variant="ghost" size="xs" onClick={() => props.onCancelScan(folder)}>
                      Cancel
                    </Button>
                  </Tip>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-muted">
                  {determinate ? (
                    <div className="h-full bg-primary transition-[width]" style={{ width: `${(p.done / p.found) * 100}%` }} />
                  ) : (
                    <div className="h-full w-1/3 animate-pulse rounded-full bg-primary/60" />
                  )}
                </div>
                <div className="font-mono text-[11px] text-muted-foreground tabular-nums">{scanStatus(p)}</div>
                {p.cloud > 0 && (
                  <div className="flex items-start gap-1 text-[11px] text-muted-foreground">
                    <Icon name="cloud_download" size={14} />
                    <span>
                      {n(p.cloud)} files are online-only and download as they're read. This can take a while.
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex shrink-0 items-center border-t px-2 py-1.5">
        {/* Its name says what it opens; the tooltip adds the shortcut (also on aria-keyshortcuts). */}
        <Tip tip="Opens Settings" shortcut="Mod+," describe={false}>
          <Button id={SETTINGS_BUTTON_ID} variant="ghost" size="icon-sm" aria-label="Settings" onClick={props.onOpenSettings}>
            <Icon name="settings" size={18} />
          </Button>
        </Tip>
      </div>
    </aside>
  );
}
