// Loading the font list with "newest wins". The list can be asked for again before an earlier
// request has answered (a scan's progress, the preview backfill finishing, sync, the window
// coming to the front). An answer is shown only if it's newer than the list on screen, so a
// slow, stale list never replaces a fresher one. Every request settles once a list at least as
// fresh as the one it asked for is on screen: its own answer, or a newer one that came first.
// So `await load()` always means "the list is loaded" (launch can check a saved subfolder view
// against the real list), and a request never waits on requests made after it, which could
// otherwise keep it waiting for as long as new ones keep coming (a long scan's live refreshes).
// Pure (no DOM, no Tauri), so `node --test` covers it.

/**
 * Returns `load`. Each call runs `fetch` and shows its answer unless a newer answer is already
 * shown. `epoch` counts changes the answer can't reflect (an on/off switch, a removal): if it
 * moved while a call was waiting, that call asks again. A failed call that a newer one
 * overtook settles with the newest call; otherwise its failure reaches its caller.
 */
export function newestWins<T>(fetch: () => Promise<T>, apply: (value: T) => void, epoch: () => number = () => 0): () => Promise<void> {
  let seq = 0;
  let shown = 0;
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
      if (began !== epoch()) return load(); // something changed mid-flight: ask again
      if (mine > shown) {
        shown = mine;
        apply(value);
      } // else a newer list is already on screen
    })();
    newest = run;
    return run;
  };
  return load;
}
