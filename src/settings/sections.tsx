import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { api, type AppSettings, type FontSummary, type PurchasesStatus, type RemovedFile, type SidebarSections, type TagBackup, type TurnOffAllReport } from "@/api";
import { previewCacheButton } from "@/googlePreviews";
import { refreshGooglePreviews, useGooglePreviewAnswers } from "@/googlePreviewStore";
import { INSTALLED_LABEL } from "@/library";
import { PRIVACY_SETTINGS_LABEL, PRIVACY_SETTINGS_TIP, PRIVACY_SETTINGS_URL, WATCH_LABEL, watchExplainer, watchNotice, watchSwitchTip } from "@/purchaseWatch";
import { ChoiceGroup } from "@/components/ChoiceGroup";
import { IS_MAC } from "@/components/TitleBar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { createTipHandle, ROW_TIP_DELAY, Tip, TipHost } from "@/components/Tip";
import { cn } from "@/lib/utils";
import { openTagDialog } from "@/tags/dialogs";
import { useSyncSection } from "@/sync/SyncSection";
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

/** A switch's tooltip, saying what a click does: `on` while it's off, `off` while it's on. */
interface SwitchTips {
  on: string;
  off: string;
}
const switchTip = (checked: boolean, tips: SwitchTips) => (checked ? tips.off : tips.on);

/** Says why a button is greyed out while Fontface is busy with it. */
const WAIT = (doing: string) => `Wait: Fontface is still ${doing}`;

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
  /** Opens the Family groups page. */
  onReviewFamilyGroups: () => void;
  /** Put Back: removed files are listed again (App scans their folders). */
  onPutBack: (paths: string[]) => Promise<void>;
}

/** Files shown in Settings › Library's list of removed fonts before "Show all". */
const REMOVED_SHOWN = 50;

/** The fonts you removed from the library (Remove from Library…), read when settings open, and
 *  Put Back for one or all of them. */
function useRemovedFonts(onPutBack: (paths: string[]) => Promise<void>) {
  const [files, setFiles] = useState<RemovedFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  // One tooltip shared by the list's rows: after "Show all" it can hold thousands.
  const [tips] = useState(createTipHandle);
  const load = useCallback(() => api.fontsRemoved().then(setFiles, () => setFiles([])), []);
  useEffect(() => void load(), [load]);
  const putBack = async (paths: string[]) => {
    setBusy(true);
    try {
      await onPutBack(paths);
    } catch (e) {
      toast.error("Couldn't put the fonts back", { description: String(e) });
    } finally {
      setBusy(false);
      await load();
      // The Put Back that had focus went with its row: the next one takes it.
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        document.querySelector<HTMLElement>('[aria-label="Removed fonts"] button')?.focus();
      });
    }
  };
  return { files, busy, putBack, all, showAll: () => setAll(true), tips };
}

/** Things the settings show that live outside the settings themselves, read when the screen opens. */
function useOutsideState(onPurchasesChanged: () => void) {
  const [purchases, setPurchases] = useState<PurchasesStatus | null>(null);
  const [purchasesError, setPurchasesError] = useState<string | null>(null);
  const [watchBusy, setWatchBusy] = useState(false);
  /** Why turning watching on didn't fully work (a folder macOS wouldn't let Fontface see). */
  const [watchNote, setWatchNote] = useState<string | null>(null);
  const [backups, setBackups] = useState<TagBackup[] | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  /** The Google Fonts preview cache's size in bytes; null until read (or if it can't be). */
  const [previewCache, setPreviewCache] = useState<number | null>(null);
  const [clearingCache, setClearingCache] = useState(false);

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
  const loadPreviewCache = useCallback(() => {
    api.googlePreviewCache().then(
      (c) => setPreviewCache(c.bytes),
      () => setPreviewCache(null),
    );
  }, []);

  useEffect(() => {
    loadPurchases();
    loadBackups();
    loadPreviewCache();
    getVersion().then(setVersion, () => {});
  }, [loadPurchases, loadBackups, loadPreviewCache]);

  // The Google Fonts page stays open under Settings, and its rows keep saving preview files (more
  // of them once previews are turned on, or after Clear). The size is read again once their
  // answers settle for a moment.
  const answers = useGooglePreviewAnswers();
  const answersAtOpen = useRef(answers);
  useEffect(() => {
    if (answers === answersAtOpen.current) return;
    const timer = setTimeout(loadPreviewCache, 500);
    return () => clearTimeout(timer);
  }, [answers, loadPreviewCache]);

  const setWatching = async (on: boolean) => {
    setPurchases((p) => p && { ...p, watching: on });
    setWatchBusy(true);
    try {
      setWatchNote(watchNotice(await api.purchasesSetWatching(on), IS_MAC));
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

  const clearPreviewCache = async () => {
    setClearingCache(true);
    try {
      await api.clearGooglePreviewCache();
      toast.success("Preview cache cleared");
    } catch (e) {
      toast.error("Couldn't clear the preview cache", { description: String(e) });
    } finally {
      setClearingCache(false);
      // Rows still showing a family ask again; fonts already on screen keep drawing.
      refreshGooglePreviews();
      loadPreviewCache();
    }
  };

  return {
    purchases,
    purchasesError,
    watchBusy,
    watchNote,
    setWatching,
    backups,
    backingUp,
    backUpNow,
    version,
    previewCache,
    clearingCache,
    clearPreviewCache,
  };
}

type SidebarKey = keyof SidebarSections;

/** Settings › Sidebar, in the sidebar's own order: LIBRARY's smart entries, SOURCES, then TAGS. */
const SIDEBAR_GROUPS: { id: string; title: string; rows: { key: SidebarKey; label: string; description: string; keywords?: string }[] }[] = [
  {
    id: "library",
    title: "Library",
    rows: [
      {
        key: "yours",
        label: "Your Fonts",
        description: `Fonts you added: in your folders, Google Fonts or Purchases. Fonts that are only in ${OS}'s own font folders aren't listed.`,
        keywords: "smart mine my own added user folders",
      },
      { key: "recent", label: "Recently Added", description: "Fonts added in the last 30 days, newest first.", keywords: "smart new latest date added" },
      {
        key: "active",
        label: "Active",
        description: `Fonts that are on right now, apart from the ones ${OS} always keeps on.`,
        keywords: "smart on turned on activated enabled",
      },
      {
        key: "untagged",
        label: "Not Tagged",
        description: "Fonts with none of your own tags. Built-in tags don't count.",
        keywords: "smart untagged no tags labels organize",
      },
    ],
  },
  {
    id: "sources",
    title: "Sources",
    rows: [
      { key: "fontBook", label: INSTALLED_LABEL, description: `Fonts installed in ${OS}, from its font folders as one source.`, keywords: "installed system folders" },
      { key: "google", label: "Google Fonts", description: "Google's free fonts: get them, turn them on and off, update or remove them.", keywords: "service catalog download" },
      { key: "adobe", label: "Adobe Fonts", description: "Fonts Creative Cloud has turned on.", keywords: "service creative cloud" },
      { key: "purchases", label: "Purchases", description: "Fonts you bought, found in your downloads.", keywords: "service store downloads" },
    ],
  },
  {
    id: "tags",
    title: "Tags",
    rows: [
      { key: "tags", label: "Tags", description: "Your tags, each with its own view.", keywords: "labels organize" },
      {
        key: "builtinTags",
        label: "Built-in tags",
        description: "Tags another app made for you, such as Fixed Width and Style. When hidden, fonts still show them.",
        keywords: "labels style fixed width defaults automatic classification group",
      },
    ],
  },
];

/** Rows that only matter while another row is on: Built-in tags sit inside Tags. */
const SIDEBAR_NEEDS: Partial<Record<SidebarKey, SidebarKey>> = { builtinTags: "tags" };
/** Each row's name, for a greyed-out row's tooltip ("Turn on Tags first"). */
const SIDEBAR_LABELS = Object.fromEntries(SIDEBAR_GROUPS.flatMap((g) => g.rows.map((r) => [r.key, r.label]))) as Record<SidebarKey, string>;

/** Every settings section, in order, with its rows and their controls. */
export function useSections(props: SectionProps): SectionDef[] | null {
  const { settings: s, update, reset } = useSettings();
  const outside = useOutsideState(props.onPurchasesChanged);
  const syncSection = useSyncSection();
  const removed = useRemovedFonts(props.onPutBack);
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

  const flag = (key: Flag, ids: RowIds, tips: SwitchTips) => (
    <Tip tip={switchTip(s[key], tips)}>
      <Switch id={ids.control} {...describe(ids)} checked={s[key]} onCheckedChange={(on) => update({ [key]: on })} />
    </Tip>
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
                  { value: "system", label: "System", tip: `Matches your ${COMPUTER}'s light or dark appearance` },
                  { value: "light", label: "Light", tip: "Always uses the light appearance" },
                  { value: "dark", label: "Dark", tip: "Always uses the dark appearance" },
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
            control: (ids) =>
              flag("restoreLastView", ids, {
                on: "Reopens your last view and filters when Fontface opens",
                off: "Stops reopening your last view: Fontface opens on All Fonts",
              }),
          },
          ...(IS_MAC
            ? ([
                {
                  id: "launchAtLogin",
                  label: "Open at login",
                  description: "Start Fontface when you log in to your Mac.",
                  keywords: "launch startup login item",
                  labelsControl: true,
                  control: (ids) =>
                    flag("launchAtLogin", ids, { on: "Starts Fontface when you log in to your Mac", off: "Stops Fontface starting when you log in" }),
                },
                {
                  id: "keepRunningInBackground",
                  label: "Keep running when the window is closed",
                  description: "Fontface keeps watching for font purchases. Click its Dock icon to bring the window back.",
                  keywords: "background close window dock quit",
                  labelsControl: true,
                  control: (ids) =>
                    flag("keepRunningInBackground", ids, {
                      on: "Keeps Fontface running after you close its window",
                      off: "Quits Fontface when you close its window",
                    }),
                },
              ] satisfies RowDef[])
            : []),
        ],
      },
      {
        id: "google",
        title: "Google Fonts",
        rows: [
          {
            id: "googlePreviews",
            label: "Show previews of Google Fonts you haven't downloaded",
            description:
              "Fontface downloads a tiny file with each family's name from fonts.googleapis.com and fonts.gstatic.com. Google sees your IP address and which families you view. Text you type is never sent.",
            keywords: "google fonts preview previews online internet network privacy catalog browse ip address download",
            labelsControl: true,
            control: (ids) =>
              flag("googlePreviews", ids, {
                on: "Lets Fontface download small preview files from Google",
                off: "Stops online previews: families you haven't downloaded show their names",
              }),
          },
          {
            id: "googlePreviewCache",
            label: "Preview cache",
            description: "The small preview files Fontface keeps, so previews show again without going online. Clearing it doesn't touch fonts you downloaded.",
            keywords: "google fonts preview cache clear delete empty storage disk space",
            control: (ids) => {
              const button = previewCacheButton(outside.previewCache, outside.clearingCache);
              return (
                <Tip tip="Deletes the saved preview files. Fonts you downloaded stay." disabledReason={button.disabled && WAIT("clearing the cache")}>
                  {/* Stays focusable while it's busy clearing. */}
                  <Button
                    size="sm"
                    variant="outline"
                    aria-describedby={ids.description}
                    disabled={button.disabled}
                    focusableWhenDisabled
                    onClick={outside.clearPreviewCache}
                  >
                    <Icon name={outside.clearingCache ? "progress_activity" : "delete_sweep"} size={16} className={cn(outside.clearingCache && "animate-spin")} />
                    {button.label}
                  </Button>
                </Tip>
              );
            },
          },
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
              <Tip tip="Picks a folder of fonts to add to your library">
                <Button size="sm" variant="outline" aria-describedby={ids.description} onClick={props.onAddFolder}>
                  <Icon name="create_new_folder" size={16} />
                  Add Folder…
                </Button>
              </Tip>
            ),
          },
          {
            id: "scanAtLaunch",
            label: "Check folders for changes when Fontface opens",
            description: "Finds fonts added, changed or removed while it was closed. When off, use Rescan on a folder in the sidebar.",
            keywords: "scan rescan launch startup",
            labelsControl: true,
            control: (ids) =>
              flag("scanAtLaunch", ids, {
                on: "Checks your folders for changes each time Fontface opens",
                off: "Stops checking folders at launch: use Rescan instead",
              }),
          },
        ],
      },
      {
        id: "families",
        title: "Families",
        rows: [
          {
            id: "familyGroups",
            label: "Family groups",
            description: "See how styles are grouped into families, and change it. To turn grouping by name on or off, use View options in the library.",
            keywords: "family families group groups by name merge keep separate move styles automatic weight bold italic combine split typeface",
            control: (ids) => (
              <Tip tip="Opens Family groups, to see and change how styles are grouped">
                <Button size="sm" variant="outline" aria-describedby={ids.description} onClick={props.onReviewFamilyGroups}>
                  <Icon name="account_tree" size={16} />
                  Family groups…
                </Button>
              </Tip>
            ),
          },
        ],
      },
      {
        id: "removed",
        title: "Removed from the library",
        rows: [
          {
            id: "removedFonts",
            label: removed.files?.length ? `${n(removed.files.length)} removed font ${removed.files.length === 1 ? "file" : "files"}` : "Removed fonts",
            description: removed.files?.length
              ? "Fonts you removed with Remove from Library. Fontface doesn't list them; their files are where they were. Put Back lists them again."
              : "Fonts you remove with Remove from Library are listed here, to put back. Their files are never touched.",
            keywords: "removed remove from library hidden excluded put back restore undo",
            control: (ids) =>
              removed.files && removed.files.length > 1 ? (
                <Tip tip={`Lists all ${n(removed.files.length)} removed files in the library again`} disabledReason={removed.busy && WAIT("putting fonts back")}>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-describedby={ids.description}
                    disabled={removed.busy}
                    focusableWhenDisabled
                    onClick={() => removed.putBack(removed.files!.map((f) => f.path))}
                  >
                    <Icon name="undo" size={16} />
                    Put All Back
                  </Button>
                </Tip>
              ) : null,
            below: () =>
              !removed.files?.length ? null : (
                <>
                  <TipHost handle={removed.tips} />
                  <ul className="flex flex-col divide-y rounded-lg border bg-background" aria-label="Removed fonts">
                    {(removed.all ? removed.files : removed.files.slice(0, REMOVED_SHOWN)).map((f) => (
                      <li key={f.path} className="flex items-center gap-3 px-3 py-2">
                        <Icon name="font_download_off" size={16} className="text-muted-foreground" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm">{fileName(f.path)}</span>
                          {/* The whole path, when it doesn't fit. Screen readers read it all already. */}
                          <Tip handle={removed.tips} tip={f.path} describe={false} delay={ROW_TIP_DELAY} contentClassName="max-w-sm break-all">
                            <span className="truncate font-mono text-[11px] text-muted-foreground">{f.path}</span>
                          </Tip>
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">{when(f.removedAt * 1000)}</span>
                        <Tip handle={removed.tips} tip="Lists this file in the library again" disabledReason={removed.busy && WAIT("putting fonts back")}>
                          <Button size="xs" variant="ghost" disabled={removed.busy} focusableWhenDisabled aria-label={`Put back ${fileName(f.path)}`} onClick={() => removed.putBack([f.path])}>
                            Put Back
                          </Button>
                        </Tip>
                      </li>
                    ))}
                  </ul>
                  {!removed.all && removed.files.length > REMOVED_SHOWN && (
                    <Tip tip={`Lists the other ${n(removed.files.length - REMOVED_SHOWN)} removed files here`}>
                      <Button size="xs" variant="ghost" className="self-start" onClick={removed.showAll}>
                        Show all {n(removed.files.length)}
                      </Button>
                    </Tip>
                  )}
                </>
              ),
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
            keywords: `system installed all fonts hide ${OS} folders library fonts`,
            labelsControl: true,
            control: (ids) =>
              flag("showInstalledInAll", ids, {
                on: `Lists fonts that are only in ${INSTALLED_LABEL} in All Fonts too`,
                off: `Leaves fonts that are only in ${INSTALLED_LABEL} out of All Fonts`,
              }),
          },
        ],
      },
    ],
  };

  const sidebar: SectionDef = {
    ...meta("sidebar"),
    intro: "Choose what the sidebar shows. All Fonts and your folders are always there.",
    groups: SIDEBAR_GROUPS.map((group) => ({
      id: `sidebar-${group.id}`,
      title: group.title,
      rows: group.rows.map((r) => {
        const needs = SIDEBAR_NEEDS[r.key];
        const off = !!needs && !s.sidebar[needs];
        return {
          id: `sidebar-${r.key}`,
          label: r.label,
          description: off ? `${r.description} Shown only while Tags is on.` : r.description,
          keywords: `sidebar show hide ${r.keywords ?? ""}`,
          labelsControl: true,
          control: (ids: RowIds) => (
            <Tip
              tip={switchTip(s.sidebar[r.key], { on: `Shows ${r.label} in the sidebar`, off: `Hides ${r.label} from the sidebar` })}
              disabledReason={off && `Turn on ${SIDEBAR_LABELS[needs!]} first: ${r.label} show inside it`}
            >
              <Switch
                id={ids.control}
                {...describe(ids)}
                checked={s.sidebar[r.key]}
                disabled={off}
                focusableWhenDisabled
                onCheckedChange={(on) => update({ sidebar: { [r.key]: on } })}
              />
            </Tip>
          ),
        };
      }),
    })),
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
                    tip: "Fonts you turn on stay on until you turn them off",
                  },
                  {
                    value: "temporary",
                    label: "Until you log out or restart",
                    description: "Handy for a single job. Logging out or restarting turns them off.",
                    tip: "Fonts you turn on go off when you log out or restart",
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
            control: (ids) =>
              flag("clearTemporaryOnQuit", ids, {
                on: "Turns temporary fonts off as soon as you quit Fontface",
                off: "Leaves temporary fonts on after you quit, until you log out",
              }),
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
                  { value: "always", label: "Turn them back on", description: "Without asking.", tip: "Turns those fonts back on, without asking, when Fontface opens" },
                  { value: "ask", label: "Ask me", description: "Fontface lists them and asks once.", tip: "Lists those fonts when Fontface opens, and asks you once" },
                  { value: "never", label: "Leave them off", description: "They're shown as off in Fontface too.", tip: "Leaves those fonts off, and shows them as off here too" },
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
                tip="Turns off every font Fontface turned on, after asking"
                confirmTip="Turns off every font Fontface turned on"
                disabledReason="Nothing to turn off: Fontface has no fonts turned on"
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
            label: WATCH_LABEL,
            description: watchExplainer(IS_MAC),
            keywords: "downloads watcher store myfonts fontspring privacy permission access",
            labelsControl: true,
            below: () =>
              outside.watchNote && (
                <div role="status" className="flex flex-col items-start gap-2 text-xs text-pretty">
                  <p>{outside.watchNote}</p>
                  {IS_MAC && (
                    <Tip tip={PRIVACY_SETTINGS_TIP}>
                      <Button size="sm" variant="outline" onClick={() => openUrl(PRIVACY_SETTINGS_URL).catch((e) => toast.error(String(e)))}>
                        {PRIVACY_SETTINGS_LABEL}
                      </Button>
                    </Tip>
                  )}
                </div>
              ),
            control: (ids) => (
              <Tip
                tip={watchSwitchTip(purchases?.watching ?? false, IS_MAC)}
                disabledReason={
                  !purchases
                    ? outside.purchasesError
                      ? "Couldn't read whether Fontface is watching. Close and reopen Settings to try again."
                      : WAIT("checking whether it's watching")
                    : outside.watchBusy && WAIT("changing this")
                }
              >
                <Switch
                  id={ids.control}
                  {...describe(ids)}
                  checked={purchases?.watching ?? false}
                  disabled={!purchases || outside.watchBusy}
                  focusableWhenDisabled
                  onCheckedChange={outside.setWatching}
                />
              </Tip>
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
              <Tip tip="Closes Settings and opens the Purchases page">
                <Button size="sm" variant="outline" aria-describedby={ids.description} onClick={props.onOpenPurchases}>
                  Open Purchases
                  <Icon name="arrow_forward" size={16} />
                </Button>
              </Tip>
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
            control: (ids) =>
              flag("tagBackups", ids, {
                on: "Backs up your tags once a day, when Fontface opens",
                off: "Stops the daily backup: Back up now still works",
              }),
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
                <Tip tip={`Opens the backups folder in ${FILE_BROWSER}`}>
                  <Button size="sm" variant="outline" aria-describedby={ids.description} onClick={() => api.backupsReveal().catch((e) => toast.error(String(e)))}>
                    <Icon name="folder_open" size={16} />
                    Show in {FILE_BROWSER}
                  </Button>
                </Tip>
                <Tip tip="Saves a backup of your tags now" disabledReason={outside.backingUp && WAIT("backing up your tags")}>
                  {/* Stays focusable while it's busy, so keyboard focus isn't lost. */}
                  <Button size="sm" variant="outline" disabled={outside.backingUp} focusableWhenDisabled onClick={outside.backUpNow}>
                    <Icon name={outside.backingUp ? "progress_activity" : "backup"} size={16} className={cn(outside.backingUp && "animate-spin")} />
                    {outside.backingUp ? "Backing up…" : "Back up now"}
                  </Button>
                </Tip>
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
                      <Tip tip="Brings back tags from this backup, once you choose how">
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
                      </Tip>
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
              <Tip tip={`Opens Fontface's data folder in ${FILE_BROWSER}`}>
                <Button size="sm" variant="outline" aria-describedby={ids.description} onClick={() => api.appDataReveal().catch((e) => toast.error(String(e)))}>
                  <Icon name="folder_open" size={16} />
                  Show app data folder
                </Button>
              </Tip>
            ),
          },
          {
            id: "reset",
            label: "Reset all settings",
            description: "Put every setting back the way it started. Your fonts, folders and tags aren't touched. Sync and watching for purchases stay as they are.",
            keywords: "defaults reset restore factory",
            control: (ids) => (
              <ConfirmButton
                variant="destructive"
                label="Reset to defaults…"
                aria-describedby={ids.description}
                tip="Puts every setting back the way it started, after asking"
                confirmTip="Puts every setting back the way it started"
                title="Reset all settings?"
                description={`Every setting on these pages goes back to how it started${IS_MAC ? ", and Fontface stops opening at login" : ""}. Sync and watching for font purchases stay as they are. Your fonts, folders, tags and purchased fonts aren't touched.`}
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

  return [general, library, sidebar, activation, syncSection, purchasesSection, backupsSection, about];
}

/** The preview size slider: moves freely, and saves when you let go. */
function PreviewSize({ ids, value, onCommit }: { ids: RowIds; value: number; onCommit: (size: number) => void }) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  return (
    <>
      <Tip tip="Sets the preview size Fontface opens with">
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
      </Tip>
      <span className="w-12 text-right font-mono text-xs text-muted-foreground tabular-nums" aria-hidden>
        {shown}px
      </span>
    </>
  );
}
