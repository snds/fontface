import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { api, type AppSettings, type AppSettingsPatch } from "@/api";

/**
 * The app settings, loaded once in App and shared through context.
 *
 * Changes show at once (optimistic), then save in the order they were made, so a quick
 * "on, off, on" can't reach the back end the other way round. While changes are saving,
 * "settings-changed" events are held back; once the last one is saved, the back end's answer
 * is shown (it may have pulled a number into range). If a change is refused, its error is
 * shown and the settings are read again, which undoes it on screen.
 */

/** The back end's defaults (settings.rs), used only if the settings can't be read at all. */
export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  previewText: "",
  previewSize: 32,
  restoreLastView: true,
  launchAtLogin: false,
  keepRunningInBackground: false,
  scanAtLaunch: true,
  showInstalledInAll: true,
  sidebar: { fontBook: true, google: true, adobe: true, purchases: true, tags: true },
  activationMode: "persistent",
  clearTemporaryOnQuit: false,
  restoreOnLaunch: "always",
  tagBackups: true,
  tagBackupKeep: 10,
};

export interface Settings {
  /** Null until the first read. */
  settings: AppSettings | null;
  /** Why the settings couldn't be read, if they couldn't. */
  error: string | null;
  /** Changes some settings. Resolves false (after showing why) if it was refused. */
  update: (patch: AppSettingsPatch) => Promise<boolean>;
  /** Every setting back to its default. Resolves false (after showing why) if that failed. */
  reset: () => Promise<boolean>;
  /** Reads the settings again (after an error). */
  reload: () => void;
  /** The first settings read (the defaults if they can't be read), for launch. */
  ready: Promise<AppSettings>;
}

const merge = (s: AppSettings, patch: AppSettingsPatch): AppSettings => ({
  ...s,
  ...patch,
  sidebar: { ...s.sidebar, ...patch.sidebar },
});

/** Owns the settings. Call once, in App, and hand the result to <SettingsContext.Provider>. */
export function useSettingsStore(): Settings {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef({ pending: 0, failed: false, latest: null as AppSettings | null });
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [first] = useState(() => {
    let resolve!: (s: AppSettings) => void;
    const promise = new Promise<AppSettings>((r) => (resolve = r));
    return { promise, resolve };
  });

  const load = useCallback(() => {
    api.settingsGet().then(
      (s) => {
        // A change made meanwhile wins; its own answer arrives when it's saved.
        if (saving.current.pending === 0) setSettings(s);
        setError(null);
        first.resolve(s);
      },
      (e) => {
        setError(String(e));
        first.resolve(DEFAULT_SETTINGS);
      },
    );
  }, [first]);

  useEffect(() => {
    const unlisten = listen<AppSettings>("settings-changed", (e) => {
      if (saving.current.pending > 0) saving.current.latest = e.payload;
      else setSettings(e.payload);
    });
    // Listen first, then read, so a change in between isn't missed.
    unlisten.then(load, load);
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [load]);

  const run = useCallback(
    async (op: () => Promise<AppSettings>, optimistic: (s: AppSettings) => AppSettings, failure: string): Promise<boolean> => {
      const state = saving.current;
      state.pending++;
      setSettings((s) => s && optimistic(s));
      const task = queue.current.then(op);
      queue.current = task.catch(() => {});
      let ok = true;
      try {
        state.latest = await task;
      } catch (e) {
        ok = false;
        state.failed = true;
        toast.error(failure, { description: String(e) });
      } finally {
        if (--state.pending === 0) {
          const { failed, latest } = state;
          state.failed = false;
          state.latest = null;
          if (failed) load();
          else if (latest) setSettings(latest);
        }
      }
      return ok;
    },
    [load],
  );

  const update = useCallback(
    (patch: AppSettingsPatch) => run(() => api.settingsUpdate(patch), (s) => merge(s, patch), "Couldn't change that setting"),
    [run],
  );
  const reset = useCallback(
    // Resetting also turns off opening at login, so the defaults are the whole answer.
    () => run(() => api.settingsReset(), () => DEFAULT_SETTINGS, "Couldn't reset the settings"),
    [run],
  );

  return useMemo(() => ({ settings, error, update, reset, reload: load, ready: first.promise }), [settings, error, update, reset, load, first]);
}

export const SettingsContext = createContext<Settings | null>(null);

export function useSettings(): Settings {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings needs <SettingsContext.Provider>");
  return ctx;
}
