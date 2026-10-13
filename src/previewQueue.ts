// The queue behind on-demand preview profiles (src/previewProfiles.ts). Reading font files is
// slow on some disks, so:
// - at most one call is in flight; ids that come up meanwhile wait for the next one;
// - a call carries at most `max` ids, the newest first (rows on screen now beat rows passed);
// - a row that leaves the screen before its turn is dropped (it asks again if it comes back).
// Pure (no DOM, no Tauri), so `node --test` covers it.

export class RequestQueue<T> {
  /** Waiting to be sent, oldest first. Only keys some mounted row still wants. */
  private readonly waiting = new Map<string, T>();
  /** How many mounted rows want each waiting key. */
  private readonly wanted = new Map<string, number>();
  private busy = false;
  private scheduled = false;
  private readonly send: (items: T[]) => Promise<unknown>;
  private readonly schedule: (run: () => void) => void;
  private readonly max: number;

  /**
   * @param send makes one call; the next waits until it settles.
   * @param schedule runs the next call soon (once per animation frame in the app), so ids that
   *   come up together go in one call.
   */
  constructor(send: (items: T[]) => Promise<unknown>, schedule: (run: () => void) => void, max: number) {
    this.send = send;
    this.schedule = schedule;
    this.max = max;
  }

  /** A mounted row wants `key` sent. Returns what to call when the row unmounts. */
  want(key: string, item: T): () => void {
    this.wanted.set(key, (this.wanted.get(key) ?? 0) + 1);
    this.waiting.delete(key); // re-added as the newest
    this.waiting.set(key, item);
    this.kick();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.wanted.get(key) ?? 1) - 1;
      if (n > 0) {
        this.wanted.set(key, n);
      } else {
        this.wanted.delete(key);
        this.waiting.delete(key);
      }
    };
  }

  /** Waiting for a call (not yet sent). */
  has(key: string): boolean {
    return this.waiting.has(key);
  }

  get size(): number {
    return this.waiting.size;
  }

  private kick() {
    if (this.busy || this.scheduled || !this.waiting.size) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  private flush() {
    if (this.busy || !this.waiting.size) return;
    const keys = [...this.waiting.keys()].reverse().slice(0, this.max);
    const batch = keys.map((key) => this.waiting.get(key) as T);
    for (const key of keys) {
      this.waiting.delete(key);
      this.wanted.delete(key);
    }
    this.busy = true;
    const done = () => {
      this.busy = false;
      this.kick();
    };
    // A send that throws counts as settled, so the queue never stalls.
    let call: Promise<unknown>;
    try {
      call = this.send(batch);
    } catch {
      call = Promise.resolve();
    }
    call.then(done, done);
  }
}
