import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { IS_MAC } from "@/components/TitleBar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ConfirmButton, describe, SECTION_LIST, TextSetting, type GroupDef, type SectionDef } from "@/settings/parts";
import { syncApi, type SyncStatus } from "./api";
import { loadSync, setSyncStatus, useSync } from "./store";

const COMPUTER = IS_MAC ? "Mac" : "computer";
const FILE_BROWSER = IS_MAC ? "Finder" : "File Explorer";
const n = (v: number) => v.toLocaleString();
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "2 minutes ago", "yesterday", or a date for anything older than a week. */
function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (s < 45) return "just now";
  if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
  if (s < 7 * 86400) return rtf.format(-Math.round(s / 86400), "day");
  return when(ms);
}

async function chooseFolder(title: string) {
  const path = await open({ directory: true, multiple: false, title });
  if (typeof path !== "string") return;
  try {
    setSyncStatus(await syncApi.setFolder(path));
    toast.success("Sync is on", { description: "Your tags and which fonts are on will sync through this folder." });
  } catch (e) {
    toast.error("Couldn't use that folder", { description: String(e) });
  }
}

/** The Sync page of the settings. */
export function useSyncSection(): SectionDef {
  const { status } = useSync();
  const [busy, setBusy] = useState(false);
  // Fresh status each time settings open (a device may have checked in since).
  useEffect(() => {
    loadSync();
  }, []);
  const meta = SECTION_LIST.find((s) => s.id === "sync")!;
  const intro = `Share your tags and which fonts are on with your other computers, through a folder that iCloud Drive, Dropbox, OneDrive, Google Drive, Syncthing or another sync app keeps up to date. Font files aren't copied: each ${COMPUTER} uses its own.`;

  if (!status || !status.enabled) {
    return {
      ...meta,
      intro,
      groups: [
        {
          id: "sync-start",
          rows: [
            {
              id: "syncFolder",
              label: "Sync folder",
              description: status
                ? "Choose a folder your sync app keeps up to date. Fontface makes a “Fontface Sync” folder inside it. Choose the same folder on each computer."
                : "Sync is starting…",
              keywords: "sync folder cloud icloud dropbox onedrive google drive syncthing nextcloud other computers devices",
              control: (ids) => (
                <Button size="sm" variant="outline" disabled={!status} aria-describedby={ids.description} onClick={() => chooseFolder("Choose a folder to sync through")}>
                  <Icon name="folder_open" size={16} />
                  Choose Folder…
                </Button>
              ),
            },
          ],
        },
      ],
    };
  }

  const syncNow = async () => {
    setBusy(true);
    try {
      setSyncStatus(await syncApi.syncNow());
      await loadSync();
    } catch (e) {
      toast.error("Couldn't sync", { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const setDevice = async (name: string, group: string) => {
    try {
      setSyncStatus(await syncApi.setDevice(name, group));
    } catch (e) {
      toast.error("Couldn't change that", { description: String(e) });
      loadSync();
    }
  };

  const groups: GroupDef[] = [
    {
      id: "sync-folder",
      title: "Folder",
      rows: [
        {
          id: "syncStatus",
          label: status.syncing || busy ? "Syncing…" : status.lastSync ? `Synced ${ago(status.lastSync)}` : "Not synced yet",
          description: describeStatus(status),
          keywords: "sync now status last synced",
          control: (ids) => (
            <Button size="sm" variant="outline" disabled={busy} aria-describedby={ids.description} onClick={syncNow}>
              <Icon name="sync" size={16} className={busy || status.syncing ? "animate-spin" : undefined} />
              Sync Now
            </Button>
          ),
        },
        {
          id: "syncFolderPath",
          label: "Sync folder",
          description: status.folder ?? "",
          keywords: `sync folder change move turn off stop ${FILE_BROWSER}`,
          control: (ids) => (
            <>
              <Button size="sm" variant="outline" aria-describedby={ids.description} onClick={() => chooseFolder("Choose another folder to sync through")}>
                Change…
              </Button>
              <ConfirmButton
                variant="destructive"
                label="Turn Off Sync…"
                aria-describedby={ids.description}
                title="Turn off sync?"
                description={`This ${COMPUTER} stops sharing changes. Your tags and fonts here stay as they are, and so do the files in the sync folder, so your other computers keep what they have.`}
                confirm="Turn Off"
                onConfirm={async () => {
                  try {
                    setSyncStatus(await syncApi.turnOff());
                    toast.success("Sync is off");
                  } catch (e) {
                    toast.error("Couldn't turn sync off", { description: String(e) });
                  }
                }}
              />
            </>
          ),
        },
        ...(status.cloudFolder
          ? [
              {
                id: "syncKeepDownloaded",
                label: "Keep the sync folder downloaded",
                description: IS_MAC
                  ? "It's in a cloud drive, where files can be online-only. In Finder, Control-click the “Fontface Sync” folder and choose “Keep Downloaded” (or “Make Available Offline”), so syncing never waits for a download."
                  : "It's in a cloud drive, where files can be online-only. In File Explorer, right-click the “Fontface Sync” folder and choose “Always keep on this device”, so syncing never waits for a download.",
                keywords: "offline online-only download icloud google drive onedrive dropbox",
              },
            ]
          : []),
      ],
    },
    {
      id: "sync-device",
      title: `This ${COMPUTER}`,
      rows: [
        {
          id: "syncDeviceName",
          label: "Name",
          description: `How this ${COMPUTER} appears on your other computers.`,
          keywords: "device computer name",
          labelsControl: true,
          control: (ids) => (
            <TextSetting
              id={ids.control}
              {...describe(ids)}
              value={status.deviceName}
              maxLength={100}
              className="w-60"
              onCommit={(name) => name.trim() && setDevice(name, status.group ?? "")}
            />
          ),
        },
        {
          id: "syncDeviceGroup",
          label: "Device group",
          description: "Optional. Computers in the same group, like “Work Macs”, can share exceptions to the synced choices.",
          keywords: "device group work home",
          labelsControl: true,
          control: (ids) => (
            <TextSetting
              id={ids.control}
              {...describe(ids)}
              value={status.group ?? ""}
              maxLength={100}
              placeholder="None"
              className="w-60"
              onCommit={(group) => setDevice(status.deviceName, group)}
            />
          ),
        },
      ],
    },
    {
      id: "sync-others",
      title: "Other computers",
      rows: [
        {
          id: "syncDevices",
          label: status.devices.length ? `${n(status.devices.length)} ${status.devices.length === 1 ? "computer" : "computers"}` : "None yet",
          description: status.devices.length
            ? "Computers that sync through this folder."
            : `Choose the same folder in Fontface on your other computers. They appear here once their sync app has copied their files to this ${COMPUTER}.`,
          keywords: "devices computers macs last seen",
          below: () =>
            status.devices.length > 0 && (
              <ul className="flex flex-col divide-y rounded-lg border bg-background text-sm">
                {status.devices.map((d) => (
                  <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                    <Icon name={d.problem ? "error" : "computer"} size={18} className={d.problem ? "text-destructive" : "text-muted-foreground"} />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">
                        {d.name}
                        {d.group && <span className="text-muted-foreground"> · {d.group}</span>}
                      </span>
                      {d.problem && <span className="text-xs text-destructive">{d.problem}</span>}
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{d.lastSeen ? `Seen ${ago(d.lastSeen)}` : "Not seen yet"}</span>
                  </li>
                ))}
              </ul>
            ),
        },
      ],
    },
  ];

  if (status.missing.length) {
    const shown = status.missing.slice(0, 100);
    groups.push({
      id: "sync-missing",
      title: `Not on this ${COMPUTER}`,
      rows: [
        {
          id: "syncMissing",
          label: `${n(status.missing.length)} ${status.missing.length === 1 ? "font is" : "fonts are"} on elsewhere but not on this ${COMPUTER}`,
          description: "Each keeps its choice and turns on here when the font arrives, for example from Google Fonts, a purchase or a drive you connect.",
          keywords: "missing not on this device absent fonts",
          below: () => (
            <ul className="max-h-60 overflow-y-auto rounded-lg border bg-background px-3 py-1.5 text-sm">
              {shown.map((m) => (
                <li key={m.key} className="truncate py-0.5">
                  {m.family || m.key.slice(3).split("|")[0]}
                  {m.style && <span className="text-muted-foreground"> {m.style}</span>}
                </li>
              ))}
              {status.missing.length > shown.length && (
                <li className="py-0.5 text-muted-foreground">and {n(status.missing.length - shown.length)} more</li>
              )}
            </ul>
          ),
        },
      ],
    });
  }

  return { ...meta, intro, groups };
}

/** The line under the status: what's waiting, and anything wrong, in plain words. */
function describeStatus(s: SyncStatus): string {
  const parts: string[] = [];
  if (s.cloned) parts.push(`This ${COMPUTER}'s Fontface data was copied from another computer, so it now syncs as a computer of its own.`);
  if (s.newerFormat) parts.push(`Another computer uses a newer version of Fontface. Update Fontface on this ${COMPUTER} to sync with it.`);
  parts.push(...s.problems);
  if (s.pending > 0) parts.push(`${n(s.pending)} ${s.pending === 1 ? "change is" : "changes are"} waiting to be written to the folder.`);
  if (!parts.length) parts.push("Changes here are shared within a few seconds; changes from other computers arrive when their sync app delivers them.");
  return parts.join(" ");
}
