import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type UpdateStatus } from "@/api";
import { UPDATE_EVENT } from "@/updates";

/** Where updates stand, kept current from "fontface://update"; null until read, or if it can't be. */
export function useUpdates(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    let live = true;
    // An event that arrives first is newer than the first read's answer.
    let heard = false;
    const unlisten = listen<UpdateStatus>(UPDATE_EVENT, (e) => {
      heard = true;
      if (live) setStatus(e.payload);
    });
    api.updateStatus().then(
      (s) => live && !heard && setStatus(s),
      () => live && !heard && setStatus(null),
    );
    return () => {
      live = false;
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);
  return status;
}
