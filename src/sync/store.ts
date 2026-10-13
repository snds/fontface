import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { reload as reloadTags } from "@/tags/store";
import { syncApi, type Exception, type SyncStatus } from "./api";

/**
 * Sync's status and this computer's exceptions, shared by the settings page and the font menus.
 * The back end sends "sync-status" whenever it changes, and "sync-changed" when other computers'
 * changes reached the library.
 */
interface SyncState {
  status: SyncStatus | null;
  exceptions: Map<string, Exclude<Exception, "follow">>;
}

let state: SyncState = { status: null, exceptions: new Map() };
const listeners = new Set<() => void>();

function set(next: Partial<SyncState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useSync(): SyncState {
  return useSyncExternalStore(subscribe, () => state);
}

export function setSyncStatus(status: SyncStatus) {
  set({ status });
}

export async function loadSync(): Promise<void> {
  // Sync starts on its own thread; it may not be ready in the first moments after launch.
  const status = await syncApi.status().catch(() => null);
  const exceptions = status?.enabled ? await syncApi.exceptions().catch(() => ({})) : {};
  set({ status: status ?? state.status, exceptions: new Map(Object.entries(exceptions)) });
}

/** Sets this computer's exception for fonts, showing it at once. */
export async function setException(keys: string[], value: Exception): Promise<void> {
  const exceptions = new Map(state.exceptions);
  for (const k of keys) {
    if (value === "follow") exceptions.delete(k);
    else exceptions.set(k, value);
  }
  set({ exceptions });
  try {
    await syncApi.setException(keys, value);
  } finally {
    await loadSync();
  }
}

/**
 * Keeps sync in step with the window (call once, in App): reloads tags and fonts when other
 * computers' changes arrive, and checks for them when the window comes to the front.
 */
export function useSyncEvents(onFontsChanged: () => void) {
  useEffect(() => {
    loadSync();
    // Sync's thread may still be starting at first; ask again shortly.
    const retry = setTimeout(loadSync, 2000);
    const unlisten = [
      listen<SyncStatus>("sync-status", (e) => setSyncStatus(e.payload)),
      listen("sync-changed", () => {
        reloadTags().catch(() => {});
        onFontsChanged();
        loadSync();
      }),
      getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (focused && state.status?.enabled) syncApi.poke().catch(() => {});
      }),
    ];
    return () => {
      clearTimeout(retry);
      for (const u of unlisten) u.then((fn) => fn()).catch(() => {});
    };
  }, [onFontsChanged]);
}
