// Loading the font list with "newest wins". The list can be asked for again before an earlier
// request has answered (a scan's progress, the preview backfill finishing, sync, the window
// coming to the front). Only the newest request's answer is shown, so a slow, stale list never
// replaces a fresher one. And every request settles only once a list at least as fresh as the
// one it asked for is on screen: a request that a newer one overtook waits for that newer one
// instead of returning early. So `await load()` always means "the list is loaded": launch can
// then check a saved subfolder view against the real list, not an empty one.
// Pure (no DOM, no Tauri), so `node --test` covers it.

/**
 * Returns `load`. Each call runs `fetch`; only the newest call's answer goes to `apply`.
 * `epoch` counts changes the answer can't reflect (an on/off switch, a removal): if it moved
 * while a call was waiting, that call asks again. A call overtaken by a newer one settles with
 * the newest call, also when its own fetch failed.
 */
export function newestWins<T>(fetch: () => Promise<T>, apply: (value: T) => void, epoch: () => number = () => 0): () => Promise<void> {
  let seq = 0;
  let newest: Promise<void> = Promise.resolve();
  const load = (): Promise<void> => {
    const mine = ++seq;
    const began = epoch();
    const run = (async (): Promise<void> => {
      let value: T;
      try {
        value = await fetch();
      } catch (e) {
        if (mine !== seq) return newest; // a newer request is on its way: its outcome counts
        throw e;
      }
      if (mine !== seq) return newest; // a newer request is on its way: settle when it does
      if (began !== epoch()) return load(); // something changed mid-flight: ask again
      apply(value);
    })();
    newest = run;
    return run;
  };
  return load;
}
