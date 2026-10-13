import { invoke } from "@tauri-apps/api/core";

/** Another computer that syncs through the same folder. */
export interface SyncDevice {
  id: string;
  name: string;
  group: string | null;
  /** Milliseconds since 1970; 0 if it hasn't said yet. */
  lastSeen: number;
  appVersion: string;
  /** Plain words, if its files can't be read. */
  problem: string | null;
}

/** A font that's on elsewhere (or set to be on here) that this computer doesn't have. */
export interface MissingFont {
  key: string;
  family: string;
  style: string;
}

export interface SyncStatus {
  enabled: boolean;
  /** The folder the user picked; "Fontface Sync" is inside it. */
  folder: string | null;
  deviceId: string;
  deviceName: string;
  group: string | null;
  syncing: boolean;
  /** When other computers' changes were last read (ms since 1970). */
  lastSync: number | null;
  /** Changes made here that aren't in the folder yet. */
  pending: number;
  devices: SyncDevice[];
  problems: string[];
  missing: MissingFont[];
  /** The folder is in a cloud drive, where files can be online-only. */
  cloudFolder: boolean;
  /** This computer's app data came from another computer, so it took a new sync identity. */
  cloned: boolean;
  /** Another computer uses a newer sync format. */
  newerFormat: boolean;
}

/** "follow": the shared choice. "on": always on here. "off": never on here. */
export type Exception = "follow" | "on" | "off";

export const syncApi = {
  status: () => invoke<SyncStatus>("sync_status"),
  setFolder: (path: string) => invoke<SyncStatus>("sync_set_folder", { path }),
  turnOff: () => invoke<SyncStatus>("sync_turn_off"),
  setDevice: (name: string, group: string) => invoke<SyncStatus>("sync_set_device", { name, group }),
  syncNow: () => invoke<SyncStatus>("sync_now"),
  poke: () => invoke<void>("sync_poke"),
  /** This computer's exceptions, by face key ("follow" is never listed). */
  exceptions: () => invoke<Record<string, Exclude<Exception, "follow">>>("sync_exceptions"),
  setException: (keys: string[], value: Exception) => invoke<void>("sync_set_exception", { keys, value, group: false }),
};
