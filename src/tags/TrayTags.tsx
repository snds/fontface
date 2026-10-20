import { useEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type AppSettings } from "@/api";
import { switchScope } from "@/fontActions";
import type { Family } from "@/library";
import { facesByTag } from "@/tagActions";
import { rememberTag, trayTags, trayTagTurnsOn } from "@/trayMenu";
import { useTagIndex } from "./model";
import { onTagSwitch, switchTag } from "./switching";

/**
 * The menu bar icon's Tags menu (src/trayMenu.ts): sends Fontface the tags to list whenever they
 * or their fonts' states change, remembers which tags were switched last, and turns a tag on or
 * off when it's chosen there ("tray-tag"), through the same switch as the sidebar's, with its
 * progress and summary. Mounted once, in App; draws nothing.
 */
export function TrayTags({
  families,
  settings,
  onRecent,
}: {
  families: Family[];
  /** Null until they're read. */
  settings: AppSettings | null;
  onRecent: (recentTags: number[]) => void;
}) {
  const index = useTagIndex();
  const sets = useMemo(() => facesByTag(families, index), [families, index]);
  const recent = settings?.recentTags;
  const showBuiltin = settings?.sidebar.builtinTags ?? true;
  const list = useMemo(() => {
    const tags = index.byGroup.flatMap((g) => g.nodes.map((n) => ({ id: n.tag.id, name: n.tag.name, builtin: g.group === "builtin" })));
    return trayTags(tags, sets, recent ?? [], { showBuiltin });
  }, [index, sets, recent, showBuiltin]);

  // Sent again only when it changes.
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (!settings) return;
    const json = JSON.stringify(list);
    if (json === sent.current) return;
    sent.current = json;
    api.setTrayTags(list).catch(() => {
      sent.current = null;
    });
  }, [list, settings]);

  // The latest of everything the handlers below read, so they're set up once.
  const latest = useRef({ index, sets, settings, onRecent });
  latest.current = { index, sets, settings, onRecent };

  useEffect(
    () =>
      onTagSwitch((id) => {
        const { settings, onRecent } = latest.current;
        if (!settings) return;
        const next = rememberTag(settings.recentTags, id);
        if (next.join() !== settings.recentTags.join()) onRecent(next);
      }),
    [],
  );

  useEffect(() => {
    const unlisten = listen<number>("tray-tag", (e) => {
      const { index, sets, settings } = latest.current;
      const tag = index.byId.get(e.payload);
      const set = sets.get(e.payload);
      if (!tag || !set) return;
      const mode = settings?.activationMode ?? "persistent";
      const on = trayTagTurnsOn(set);
      void switchTag(tag, set, on, switchScope(on, false, mode), { mode, untilQuit: settings?.clearTemporaryOnQuit ?? false });
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  return null;
}
