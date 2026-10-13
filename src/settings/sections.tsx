import { useCallback, useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { toast } from "sonner";
import { api, type AppSettings, type FontSummary, type PurchasesStatus, type SidebarSections, type TagBackup, type TurnOffAllReport } from "@/api";
import { INSTALLED_LABEL } from "@/library";
import { ChoiceGroup } from "@/components/ChoiceGroup";
import { IS_MAC } from "@/components/TitleBar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { openTagDialog } from "@/tags/dialogs";
import { ConfirmButton, describe, NumberField, SECTION_LIST, TextSetting, type RowDef, type RowIds, type SectionDef, type SectionId } from "./parts";
import { useSettings } from "./useSettings";

const OS = IS_MAC ? "macOS" : "Windows";
const COMPUTER = IS_MAC ? "Mac" : "computer";
const FILE_BROWSER = IS_MAC ? "Finder" : "File Explorer";
const n = (v: number) => v.toLocaleString();
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
const meta = (id: SectionId) => SECTION_LIST.find((s) => s.id === id)!;
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

type Flag = { [K in keyof AppSettings]: AppSettings[K] extends boolean ? K : never }[keyof AppSettings];

/** "12 font files are on, and 3 more are set to come back on." `waiting`: files Fontface keeps
 *  on that macOS doesn't have on right now (e.g. on a drive that isn't connected). */
function onNow(on: number, waiting: number): string {
  const now = on === 0 ? "None are on right now" : `${n(on)} font ${on === 1 ? "file is" : "files are"} on`;
  if (waiting === 0) return `${now}.`;
  const later = on === 0 ? `${n(waiting)} font ${waiting === 1 ? "file is" : "files are"}` : `${n(waiting)} more ${waiting === 1 ? "is" : "are"}`;
  return `${now}, ${on === 0 ? "but" : "and"} ${later} set to come back on.`;
}

export interface SectionProps {
  /** The library, for counting the fonts Fontface has turned on. */
  fonts: FontSummary[];
  /** Folders the user added. */
  userFolders: number;
  onAddFolder: () => void;
  onTurnOffAll: () => Promise<TurnOffAllReport>;
  /** Watching for purchases changed here; the Purchases page (mounted underneath) reads it again. */
  onPurchasesChanged: () => void;
  onOpenPurchases: () => void;
}

/** Things the settings show that live outside the settings themselves, read when the screen opens. */
function useOutsideState(onPurchasesChanged: () => void) {
  const [purchases, setPurchases] = useState<PurchasesStatus | null>(null);
  const [purchasesError, setPurchasesError] = useState<string | null>(null);
  const [watchBusy, setWatchBusy] = useState(false);
  const [backups, setBackups] = useState<TagBackup[] | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [version, setVersion] = useState<string | null>(null);

  const loadPurchases = useCallback(() => {
    api.purchasesStatus().then(
      (st) => {
        setPurchases(st);
        setPurchasesError(null);
      },
      (e) => setPurchasesError(String(e)),
    );
  }, []);
  const loadBackups = useCallback(() => {
    api.backupsList().then(setBackups, () => setBackups([]));
  }, []);

  useEffect(() => {
    loadPurchases();
    loadBackups();
    getVersion().then(setVersion, () => {});
  }, [loadPurchases, loadBackups]);

  const setWatching = async (on: boolean) => {
    setPurchases((p) => p && { ...p, watching: on });
    setWatchBusy(true);
    try {
      await api.purchasesSetWatching(on);
    } catch (e) {
      toast.error("Couldn't change watching", { description: String(e) });
    } finally {
      setWatchBusy(false);
      loadPurchases();
      onPurchasesChanged();
    }
  };

  const backUpNow = async () => {
    setBackingUp(true);
    try {
      const b = await api.backupsCreate();
      toast.success("Tags backed up", { description: `${n(b.tags)} ${b.tags === 1 ? "tag" : "tags"}, ${when(b.createdAt)}` });
    } catch (e) {
      toast.error("Couldn't back up tags", { description: String(e) });
    } finally {
      setBackingUp(false);
      loadBackups();
    }
  };

  return { purchases, purchasesError, watchBusy, setWatching, backups, backingUp, backUpNow, version };
}

const SIDEBAR_ROWS: { key: keyof SidebarSections; label: string; description: string; keywords?: string }[] = [
  { key: "fontBook", label: INSTALLED_LABEL, description: `Fonts installed in ${OS}, with its font folders.`, keywords: "installed system" },
  { key: "google", label: "Google Fonts", description: "Browse and download free Google Fonts.", keywords: "service" },
  { key: "adobe", label: "Adobe Fonts", description: "Fonts Creative Cloud has turned on.", keywords: "service creative cloud" },
  { key: "purchases", label: "Purchases", description: "Fonts you bought, found in your downloads.", keywords: "service store" },
  { key: "tags", label: "Tags", description: "Your tags, each with its own view.", keywords: "labels organize" },
];

/** Every settings section, in order, with its rows and their controls. */
export function useSections(props: SectionProps): SectionDef[] | null {
  const { settings: s, update, reset } = useSettings();
  const outside = useOutsideState(props.onPurchasesChanged);
  // Font files Fontface has turned on, outside the OS's own font folders: what Turn Off All
  // covers (`wanted`), and how many of those macOS has on right now (`on`). The rest are set to
  // come back on, e.g. from a drive that isn't connected, or waiting on "Ask me".
  const { on: fontsOn, wanted: fontsWanted } = useMemo(() => {
    const files = (pick: (f: FontSummary) => boolean) => new Set(props.fonts.filter(pick).map((f) => f.path)).size;
    return {
      on: files((f) => f.activated && f.osActive && !f.installed),
      wanted: files((f) => f.activated && !f.installed),
    };
  }, [props.fonts]);
  const fontsWaiting = fontsWanted - fontsOn;
  if (!s) return null;

  const flag = (key: Flag, ids: RowIds) => (
    <Switch id={ids.control} {...describe(ids)} checked={s[key]} onCheckedChange={(on) => update({ [key]: on })} />
  );

  const turnOffAll = async () => {
    try {
      const r = await props.onTurnOffAll();
      if (r.failed.length) {
        toast.warning(`Turned off ${n(r.turnedOff)}; ${n(r.failed.length)} couldn't be turned off`, {
          description: r.failed
            .slice(0, 3)
            .map(([file, why]) => `${fileName(file)}: ${why}`)
            .join(" · "),
        });
      } else {
        toast.success(r.turnedOff === 1 ? "Turned off 1 font file" : `Turned off ${n(r.turnedOff)} font files`);
      }
    } catch (e) {
      toast.error("Couldn't turn fonts off", { description: String(e) });
    }
  };

  const { purchases, backups } = outside;

  const general: SectionDef = {
    ...meta("general"),
    groups: [
      {
        id: "look",
        title: "Look",
        rows: [
          {
            id: "theme",
            label: "Appearance",
            description: `Match your ${COMPUTER}, or always use light or dark.`,
            keywords: "theme dark mode light mode color scheme system",
            control: (ids) => (
              <ChoiceGroup
                labelledBy={ids.label}
                describedBy={ids.description}
                value={s.theme}
                onChange={(theme) => update({ theme })}
                options={[
                  { value: "system", label: "System" },
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
              />
            ),
          },
          {
            id: "previewText",
            label: "Preview text",
            description: "What every font shows when Fontface opens. Leave it empty to show each family's name.",
            keywords: "sample default type to preview",
            labelsControl: true,
            control: (ids) => (
              <TextSetting
                id={ids.control}
                {...describe(ids)}
                value={s.previewText}
                maxLength={500}
                placeholder="Family names"
                className="w-60"
                onCommit={(previewText) => update({ previewText })}
              />
            ),
          },
          {
            id: "previewSize",
            label: "Preview size",
            description: "The text size Fontface opens with.",
            keywords: "default font size points pixels",
            control: (ids) => <PreviewSize ids={ids} value={s.previewSize} onCommit={(previewSize) => update({ previewSize })} />,
          },
        ],
      },
      {
        id: "startup",
        title: "Opening and closing",
        rows: [
          {
            id: "restoreLastView",
            label: "Open where you left off",
            description: "Reopen the last view, with its All, Active, Inactive and Variable filters.",
            keywords: "restore remember last view filters launch startup",
            labelsControl: true,
            control: (ids) => flag("restoreLastView", ids),
          },
          ...(IS_MAC
            ? ([
                {
                  id: "launchAtLogin",
                  label: "Open at login",
                  description: "Start Fontface when you log in to your Mac.",
                  keywords: "launch startup login item",
                  labelsControl: true,
                  control: (ids) => flag("launchAtLogin", ids),
                },
                {
                  id: "keepRunningInBackground",
                  label: "Keep running when the window is closed",
                  description: "Fontface keeps watching for font purchases. Click its Dock icon to bring the window back.",
                  keywords: "background close window dock quit",
                  labelsControl: true,
                  control: (ids) => flag("keepRunningInBackground", ids),
                },
              ] satisfies RowDef[])
            : []),
        ],
      },
    ],
  };

  const library: SectionDef = {
    ...meta("library"),
    groups: [
      {
        id: "folders",
        rows: [
          {
            id: "folders",
            label: "Folders",
            description:
              (props.userFolders === 0
                ? "You haven't added a folder yet."
                : `You've added ${n(props.userFolders)} ${props.userFolders === 1 ? "folder" : "folders"}.`) +
              " Fontface reads fonts where they are; nothing is copied or moved.",
            keywords: "add folder library locations",
            control: (ids) => (
              <Button size="sm" variant="outline" aria-describedby={ids.description} onClick={props.onAddFolder}>
                <Icon name="create_new_folder" size={16} />
                Add Folder…
              </Button>
            ),
          },
          {
            id: "scanAtLaunch",
            label: "Check folders for changes when Fontface opens",
            description: "Finds fonts added, changed or removed while it was closed. When off, use Rescan on a folder in the sidebar.",
            keywords: "scan rescan launch startup",
            labelsControl: true,
            control: (ids) => flag("scanAtLaunch", ids),
          },
        ],
      },
      {
        id: "all",
        title: "All Fonts",
        rows: [
          {
            id: "showInstalledInAll",
            label: "Show installed fonts in All Fonts",
            description: `When off, All Fonts leaves out fonts that are only in ${OS}'s font folders, including ones you installed yourself. ${INSTALLED_LABEL} still lists them.`,
            keywords: `system installed font book all fonts hide ${OS} folders library fonts`,
            labelsControl: true,
            control: (ids) => flag("showInstalledInAll", ids),
          },
        ],
      },
    ],
  };

  const sidebar: SectionDef = {
    ...meta("sidebar"),
    intro: "Choose what the sidebar shows. All Fonts and your folders are always there.",
    groups: [
      {
        id: "sidebar",
        rows: SIDEBAR_ROWS.map((r) => ({
          id: `sidebar-${r.key}`,
          label: r.label,
          description: r.description,
          keywords: `sidebar show hide ${r.keywords ?? ""}`,
          labelsControl: true,
          control: (ids: RowIds) => (
            <Switch
              id={ids.control}
              {...describe(ids)}
              checked={s.sidebar[r.key]}
              onCheckedChange={(on) => update({ sidebar: { [r.key]: on } })}
            />
          ),
        })),
      },
    ],
  };

  const activation: SectionDef = {
    ...meta("activation"),
    groups: [
      {
        id: "turning-on",
        title: "Turning fonts on",
        rows: [
          {
            id: "activationMode",
            label: "Turn fonts on",
            description: "Applies to fonts you turn on from now on.",
            keywords: "activation mode temporary persistent permanent permanently session until log out logout restart stay on",
            below: (ids) => (
              <ChoiceGroup
                look="cards"
                labelledBy={ids.label}
                describedBy={ids.description}
                value={s.activationMode}
                onChange={(activationMode) => update({ activationMode })}
                options={[
                  {
                    value: "persistent",
                    label: "Until you turn them off",
                    description: `They stay on after you quit Fontface or restart your ${COMPUTER}.`,
                  },
                  {
                    value: "temporary",
                    label: "Until you log out or restart",
                    description: "Handy for a single job. Logging out or restarting turns them off.",
                  },
                ]}
              />
            ),
          },
          {
            id: "clearTemporaryOnQuit",
            label: "Turn temporary fonts off when Fontface quits",
            description:
              s.activationMode === "temporary"
                ? "Fonts on until you log out are turned off as soon as you quit Fontface."
                : "Only affects fonts turned on with “Until you log out or restart”, including ones still on from before.",
            keywords: "quit temporary clear session",
            labelsControl: true,
            control: (ids) => flag("clearTemporaryOnQuit", ids),
          },
        ],
      },
      {
        id: "opening",
        title: "When Fontface opens",
        rows: [
          {
            id: "restoreOnLaunch",
            label: "Fonts turned off while Fontface was closed",
            description: "For example by another app, or by a restart. Fonts turned on until you log out always stay off.",
            keywords: "restore reactivate launch startup ask turn back on leave off",
            below: (ids) => (
              <ChoiceGroup
                look="cards"
                labelledBy={ids.label}
                describedBy={ids.description}
                value={s.restoreOnLaunch}
                onChange={(restoreOnLaunch) => update({ restoreOnLaunch })}
                options={[
                  { value: "always", label: "Turn them back on", description: "Without asking." },
                  { value: "ask", label: "Ask me", description: "Fontface lists them and asks once." },
                  { value: "never", label: "Leave them off", description: "They're shown as off in Fontface too." },
                ]}
              />
            ),
          },
        ],
      },
      {
        id: "everything",
        rows: [
          {
            id: "turnOffAll",
            label: "Turn off all fonts Fontface turned on",
            description:
              fontsWanted === 0 ? onNow(0, 0) : `${onNow(fontsOn, fontsWaiting)} Fonts installed with ${OS} aren't affected.`,
            keywords: "deactivate disable everything reset",
            control: (ids) => (
              <ConfirmButton
                variant="destructive"
                label="Turn Off All…"
                icon="toggle_off"
                aria-describedby={ids.description}
                disabled={fontsWanted === 0}
                // Stays focusable when it disables itself after turning everything off.
                focusableWhenDisabled
                className="aria-disabled:opacity-50"
                title="Turn off all fonts Fontface turned on?"
                description={`${
                  fontsOn > 0 ? `${n(fontsOn)} font ${fontsOn === 1 ? "file" : "files"} will be turned off, and apps will stop showing them. ` : ""
                }${
                  fontsWaiting > 0 ? `${n(fontsWaiting)} ${fontsWaiting === 1 ? "file" : "files"} set to come back on will stay off. ` : ""
                }You can turn them back on at any time.`}
                confirm="Turn Off All"
                onConfirm={turnOffAll}
              />
            ),
          },
        ],
      },
    ],
  };

  const purchasesSection: SectionDef = {
    ...meta("purchases"),
    groups: [
      {
        id: "watching",
        rows: [
          {
            id: "watchPurchases",
            label: "Watch for font purchases",
            description: "Fontface notices fonts you download from stores like MyFonts and Fontspring, and offers to add them.",
            keywords: "downloads watcher store myfonts fontspring",
            labelsControl: true,
            control: (ids) => (
              <Switch
                id={ids.control}
                {...describe(ids)}
                checked={purchases?.watching ?? false}
                disabled={!purchases || outside.watchBusy}
                onCheckedChange={outside.setWatching}
              />
            ),
          },
          {
            id: "watchedFolders",
            label: "Watched folders",
            description: "Add or remove folders on the Purchases page.",
            keywords: "downloads folders watch",
            below: () => (
              <ul className="flex flex-col gap-1 text-xs" aria-label="Watched folders">
                {!purchases ? (
                  <li className="text-muted-foreground">{outside.purchasesError ? `Couldn't read them. ${outside.purchasesError}` : "Loading…"}</li>
                ) : purchases.folders.length === 0 ? (
                  <li className="text-muted-foreground">None yet. Turning watching on adds your Downloads folder.</li>
                ) : (
                  purchases.folders.map((f) => (
                    <li key={f.path} className={cn("flex items-start gap-1.5", f.problem && "text-destructive")}>
                      <Icon name={f.problem ? "warning" : "folder"} size={14} className={cn("mt-px", !f.problem && "text-muted-foreground")} />
                      {/* The problem goes on its own line under the path, so both wrap. */}
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="font-mono break-all selectable">{f.path}</span>
                        {f.problem && <span className="text-pretty">{f.problem}</span>}
                      </span>
                    </li>
                  ))
                )}
              </ul>
            ),
          },
          {
            id: "openPurchases",
            label: "Purchases page",
            description: "Review new downloads, import fonts you bought earlier, and manage watched folders.",
            keywords: "open purchases import",
            control: (ids) => (
              <Button size="sm" variant="outline" aria-describedby={ids.description} onClick={props.onOpenPurchases}>
                Open Purchases
                <Icon name="arrow_forward" size={16} />
              </Button>
            ),
          },
        ],
      },
    ],
  };

  const backupsSection: SectionDef = {
    ...meta("backups"),
    groups: [
      {
        id: "automatic",
        title: "Tag backups",
        rows: [
          {
            id: "tagBackups",
            label: "Back up tags automatically",
            description: "Once a day, when Fontface opens, if you have tags.",
            keywords: "backup automatic daily tags",
            labelsControl: true,
            control: (ids) => flag("tagBackups", ids),
          },
          {
            id: "tagBackupKeep",
            label: "Backups to keep",
            description: "When there are more, the oldest are deleted. From 1 to 50.",
            keywords: "keep count number rotate delete old",
            labelsControl: true,
            control: (ids) => (
              <NumberField
                id={ids.control}
                {...describe(ids)}
                min={1}
                max={50}
                value={s.tagBackupKeep}
                onCommit={(tagBackupKeep) => update({ tagBackupKeep })}
              />
            ),
          },
        ],
      },
      {
        id: "saved",
        title: "Saved backups",
        rows: [
          {
            id: "backupList",
            label: backups && backups.length ? `${n(backups.length)} ${backups.length === 1 ? "backup" : "backups"}` : "Backups",
            description: "Each holds your tags and location colors. Font files are not included in backups.",
            keywords: `restore saved backups list import back up now show reveal ${FILE_BROWSER} folder`,
            control: (ids) => (
              <>
                <Button size="sm" variant="outline" aria-describedby={ids.description} onClick={() => api.backupsReveal().catch((e) => toast.error(String(e)))}>
                  <Icon name="folder_open" size={16} />
                  Show in {FILE_BROWSER}
                </Button>
                {/* Stays focusable while it's busy, so keyboard focus isn't lost. */}
                <Button size="sm" variant="outline" disabled={outside.backingUp} focusableWhenDisabled onClick={outside.backUpNow}>
                  <Icon name={outside.backingUp ? "progress_activity" : "backup"} size={16} className={cn(outside.backingUp && "animate-spin")} />
                  {outside.backingUp ? "Backing up…" : "Back up now"}
                </Button>
              </>
            ),
            below: () =>
              !backups ? null : backups.length === 0 ? (
                <p className="text-xs text-muted-foreground">No backups yet.</p>
              ) : (
                <ul className="flex flex-col divide-y rounded-lg border bg-background" aria-label="Saved backups">
                  {backups.map((b) => (
                    <li key={b.path} className="flex items-center gap-3 px-3 py-2">
                      <Icon name="history" size={16} className="text-muted-foreground" />
                      <span className="flex-1 text-sm">{when(b.createdAt)}</span>
                      <span className="font-mono text-xs text-muted-foreground tabular-nums">
                        {n(b.tags)} {b.tags === 1 ? "tag" : "tags"}
                      </span>
                      <Button
                        size="xs"
                        variant="ghost"
                        aria-label={`Restore tags from the backup made on ${when(b.createdAt)}`}
                        onClick={() =>
                          openTagDialog({ kind: "import", source: { kind: "fontface", path: b.path }, backupMadeAt: b.createdAt })
                        }
                      >
                        Restore…
                      </Button>
                    </li>
                  ))}
                </ul>
              ),
          },
        ],
      },
    ],
  };

  const about: SectionDef = {
    ...meta("about"),
    groups: [
      {
        id: "app",
        rows: [
          {
            id: "version",
            label: "Fontface",
            description: outside.version ? `Version ${outside.version}` : "Version unknown",
            keywords: "about version app name",
          },
          {
            id: "appData",
            label: "App data",
            description: "Your library list, tags, Google Fonts downloads, purchases and backups.",
            keywords: `data folder database application support show reveal ${FILE_BROWSER}`,
            control: (ids) => (
              <Button size="sm" variant="outline" aria-describedby={ids.description} onClick={() => api.appDataReveal().catch((e) => toast.error(String(e)))}>
                <Icon name="folder_open" size={16} />
                Show app data folder
              </Button>
            ),
          },
          {
            id: "reset",
            label: "Reset all settings",
            description: "Put every setting back the way it started. Your fonts, folders and tags aren't touched, and nor is watching for purchases.",
            keywords: "defaults reset restore factory",
            control: (ids) => (
              <ConfirmButton
                variant="destructive"
                label="Reset to defaults…"
                aria-describedby={ids.description}
                title="Reset all settings?"
                description={`Every setting on these pages goes back to how it started${IS_MAC ? ", and Fontface stops opening at login" : ""}. Watching for font purchases stays as it is. Your fonts, folders, tags and purchased fonts aren't touched.`}
                confirm="Reset"
                onConfirm={async () => {
                  if (await reset()) toast.success("Settings are back to their defaults");
                }}
              />
            ),
          },
        ],
      },
    ],
  };

  return [general, library, sidebar, activation, purchasesSection, backupsSection, about];
}

/** The preview size slider: moves freely, and saves when you let go. */
function PreviewSize({ ids, value, onCommit }: { ids: RowIds; value: number; onCommit: (size: number) => void }) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  return (
    <>
      <Slider
        className="w-40"
        min={10}
        max={128}
        value={[shown]}
        onValueChange={(v) => setDraft(Array.isArray(v) ? v[0] : v)}
        onValueCommitted={(v) => {
          const size = Array.isArray(v) ? v[0] : v;
          setDraft(null);
          if (size !== value) onCommit(size);
        }}
        // The thumb takes its name from the root's label.
        aria-labelledby={ids.label}
        aria-describedby={ids.description}
      />
      <span className="w-12 text-right font-mono text-xs text-muted-foreground tabular-nums" aria-hidden>
        {shown}px
      </span>
    </>
  );
}
