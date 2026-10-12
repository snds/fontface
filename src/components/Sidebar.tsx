import type { Folder, ScanProgress, ServiceInfo } from "@/api";
import { INSTALLED_LABEL, type Family, type LibraryView } from "@/library";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { colorVar } from "@/tags/api";
import { ADOBE_LOCATION, FONT_BOOK_LOCATION, useLocations } from "@/tags/locations";
import { SubfolderToggle, SubfolderTree, useSubfolders } from "@/tags/LocationTree";
import { LocationMenu } from "@/tags/menus";
import { TagsSection } from "@/tags/TagsSection";

interface Props {
  folders: Folder[];
  /** Style counts (duplicate copies count once), matching what the list shows. */
  counts: { all: number; installed: number };
  /** The same, per folder. */
  folderCounts: Map<number, number>;
  /** The whole library, for tag and subfolder counts. */
  families: Family[];
  services: ServiceInfo[];
  /** Fonts Creative Cloud has turned on, once known. */
  adobeCount: number | null;
  view: LibraryView;
  scans: Map<number, ScanProgress>;
  onView: (v: LibraryView) => void;
  onAddFolder: () => void;
  onRemoveFolder: (f: Folder) => void;
  onRescan: (f: Folder) => void;
  onCancelScan: (f: Folder) => void;
}

const same = (a: LibraryView, b: LibraryView) =>
  a.kind === b.kind &&
  (a.kind !== "folder" || (b.kind === "folder" && a.id === b.id)) &&
  (a.kind !== "service" || (b.kind === "service" && a.id === b.id));

const itemClass = (selected: boolean) =>
  cn(
    "group/item flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm",
    selected ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "hover:bg-sidebar-accent/60",
  );

const n = (v: number) => v.toLocaleString();

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{children}</div>;
}

function IconAction({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            // Ignore the second click of a double-click: Rescan turns into Stop under the cursor.
            onClick={(e) => e.detail <= 1 && onClick()}
          />
        }
      >
        <Icon name={icon} size={16} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** One line describing where a scan is up to. */
export function scanStatus(p: ScanProgress): string {
  if (p.phase === "starting") return "Starting…";
  if (p.phase === "discovering") return `Finding font files… ${n(p.found)} found`;
  return `Reading ${n(p.done)} of ${n(p.found)}`;
}

function FolderRow({
  folder,
  count,
  selected,
  scan,
  color,
  leading,
  onView,
  onRemove,
  onRescan,
  onCancel,
}: {
  folder: Folder;
  count: number;
  selected: boolean;
  scan: ScanProgress | undefined;
  /** The location color (CSS), tinting the folder icon. */
  color?: string;
  /** Shown before the icon (the subfolder toggle). */
  leading?: React.ReactNode;
  onView: () => void;
  onRemove: () => void;
  onRescan: () => void;
  onCancel: () => void;
}) {
  const system = folder.kind === "system";
  const icon = folder.missing ? "folder_off" : system ? "folder_special" : "folder";
  return (
    <div className={cn(itemClass(selected), leading && "pl-1")}>
      {leading}
      <button
        className="flex min-w-0 flex-1 items-center gap-2"
        aria-current={selected ? "page" : undefined}
        title={folder.path}
        onClick={onView}
      >
        {scan ? (
          <Icon name="progress_activity" size={18} className="animate-spin text-muted-foreground" />
        ) : (
          <Icon
            name={icon}
            size={18}
            filled={!!color && !folder.missing}
            className={folder.missing ? "text-destructive" : "text-muted-foreground"}
            style={color && !folder.missing ? { color } : undefined}
          />
        )}
        <span className="truncate">{folder.label}</span>
      </button>
      {/* Count, or scan progress; swapped for actions on hover. */}
      <span className="font-mono text-xs text-muted-foreground tabular-nums group-focus-within/item:hidden group-hover/item:hidden">
        {scan && scan.phase === "reading" ? `${Math.floor((scan.done / Math.max(1, scan.found)) * 100)}%` : n(count)}
      </span>
      <span className="hidden items-center group-focus-within/item:flex group-hover/item:flex">
        {scan ? (
          <IconAction icon="stop_circle" label="Stop scanning" onClick={onCancel} />
        ) : (
          <IconAction icon="refresh" label="Rescan folder" onClick={onRescan} />
        )}
        {!system && <IconAction icon="close" label="Remove from library" onClick={onRemove} />}
      </span>
    </div>
  );
}

/** A user folder with its subfolder tree. */
function UserFolder({ folder, families, row, view, onView, locations }: {
  folder: Folder;
  families: Family[];
  row: (folder: Folder, leading?: React.ReactNode) => React.ReactNode;
  view: LibraryView;
  onView: (v: LibraryView) => void;
  locations: ReturnType<typeof useLocations>;
}) {
  const { nodes, hasChildren } = useSubfolders(folder, families);
  return (
    <>
      {row(folder, <SubfolderToggle path={folder.path} label={folder.label} hasChildren={hasChildren} />)}
      <SubfolderTree nodes={nodes} root={folder.path} view={view} onView={onView} locations={locations} />
    </>
  );
}

export function Sidebar({ folders, counts, folderCounts, families, services, adobeCount, view, scans, onView, onAddFolder, onRemoveFolder, onRescan, onCancelScan }: Props) {
  const locations = useLocations(folders, services);
  const items: { label: string; icon: string; view: LibraryView; count: number; hint: string }[] = [
    { label: "All Fonts", icon: "font_download", view: { kind: "all" }, count: counts.all, hint: "Every font Fontface knows about" },
    {
      label: INSTALLED_LABEL,
      icon: "auto_stories",
      view: { kind: "installed" },
      count: counts.installed,
      hint: "Fonts installed in the operating system's own font folders",
    },
  ];
  const system = folders.filter((f) => f.kind === "system");
  const user = folders.filter((f) => f.kind === "user");
  const running = folders.filter((f) => scans.has(f.id));

  const row = (folder: Folder, leading?: React.ReactNode) => (
    <LocationMenu
      key={folder.id}
      location={folder.path}
      color={locations.colorOf(folder.path)}
      defaultColor={locations.defaultOf(folder.path)}
    >
      <FolderRow
        folder={folder}
        count={folderCounts.get(folder.id) ?? folder.fontCount}
        selected={same(view, { kind: "folder", id: folder.id })}
        scan={scans.get(folder.id)}
        color={colorVar(locations.colorOf(folder.path))}
        leading={leading}
        onView={() => onView({ kind: "folder", id: folder.id })}
        onRemove={() => onRemoveFolder(folder)}
        onRescan={() => onRescan(folder)}
        onCancel={() => onCancelScan(folder)}
      />
    </LocationMenu>
  );

  return (
    <aside className="flex min-h-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <ScrollArea className="min-h-0 flex-1">
        <nav className="flex flex-col gap-4 p-2 pt-3">
          <div>
            <SectionLabel>Library</SectionLabel>
            {items.map((item) => (
              <div key={item.label}>
                {/* Font Book has a location color (its folders follow it); All Fonts doesn't. */}
                <LocationMenu
                  location={FONT_BOOK_LOCATION}
                  color={locations.colorOf(FONT_BOOK_LOCATION)}
                  defaultColor={locations.defaultOf(FONT_BOOK_LOCATION)}
                  disabled={item.view.kind !== "installed"}
                >
                <button
                  className={itemClass(same(view, item.view))}
                  aria-current={same(view, item.view) ? "page" : undefined}
                  title={item.hint}
                  onClick={() => onView(item.view)}
                >
                  <Icon
                    name={item.icon}
                    size={18}
                    filled={item.view.kind === "installed"}
                    className="text-muted-foreground"
                    style={item.view.kind === "installed" ? { color: colorVar(locations.colorOf(FONT_BOOK_LOCATION)) } : undefined}
                  />
                  <span className="flex-1 truncate">{item.label}</span>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">{n(item.count)}</span>
                </button>
                </LocationMenu>
                {/* The OS font folders sit under the installed-fonts view. */}
                {item.view.kind === "installed" && system.length > 0 && <div className="pl-4">{system.map((f) => row(f))}</div>}
              </div>
            ))}
          </div>

          <div>
            <SectionLabel>Services</SectionLabel>
            {(() => {
              const google = services.find((x) => x.id === "google");
              const googleScan = google?.folderId != null ? scans.get(google.folderId) : undefined;
              const googleCount = google?.folderId != null ? folderCounts.get(google.folderId) ?? 0 : 0;
              const rows: { id: "google" | "adobe"; label: string; count: string; busy: boolean; hint: string }[] = [
                {
                  id: "google",
                  label: "Google Fonts",
                  count: googleCount ? n(googleCount) : "",
                  busy: !!googleScan,
                  hint: "Browse and download free Google Fonts",
                },
                {
                  id: "adobe",
                  label: "Adobe Fonts",
                  count: adobeCount ? n(adobeCount) : "",
                  busy: false,
                  hint: "Fonts Creative Cloud has turned on (read-only)",
                },
              ];
              return rows.map((r) => {
                // Google Fonts' color is its download folder's; Adobe Fonts has no folder here.
                const location = r.id === "google" ? folders.find((f) => f.id === google?.folderId)?.path : ADOBE_LOCATION;
                const color = location ? locations.colorOf(location) : undefined;
                return (
                <LocationMenu key={r.id} location={location ?? ""} color={color ?? "gray"} defaultColor={location ? locations.defaultOf(location) : "gray"} disabled={!location}>
                <button
                  aria-current={same(view, { kind: "service", id: r.id }) ? "page" : undefined}
                  className={itemClass(same(view, { kind: "service", id: r.id }))}
                  title={r.hint}
                  onClick={() => onView({ kind: "service", id: r.id })}
                >
                  <Icon
                    name={r.busy ? "progress_activity" : "cloud"}
                    size={18}
                    filled={!r.busy && !!color}
                    className={cn("text-muted-foreground", r.busy && "animate-spin")}
                    style={!r.busy && color ? { color: colorVar(color) } : undefined}
                  />
                  <span className="flex-1 truncate">{r.label}</span>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">{r.count}</span>
                </button>
                </LocationMenu>
                );
              });
            })()}
          </div>

          <div>
            <div className="flex items-center justify-between pr-1">
              <SectionLabel>Folders</SectionLabel>
              <IconAction icon="create_new_folder" label="Add folder" onClick={onAddFolder} />
            </div>
            {user.length === 0 && (
              <button className="w-full px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground" onClick={onAddFolder}>
                Add a folder of fonts…
              </button>
            )}
            {user.map((folder) => (
              <UserFolder key={folder.id} folder={folder} families={families} row={row} view={view} onView={onView} locations={locations} />
            ))}
          </div>

          <TagsSection families={families} view={view} onView={onView} />
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
                  <Button variant="ghost" size="xs" onClick={() => onCancelScan(folder)}>
                    Cancel
                  </Button>
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
    </aside>
  );
}
