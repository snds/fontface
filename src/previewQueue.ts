// The queue behind on-demand preview profiles (src/previewProfiles.ts). Reading font files is
// slow on some disks, so:
// - at most one call is in flight; ids that come up meanwhile wait for the next one;
// - a call that hasn't settled after `timeoutMs` stops holding the queue: its rows are told
//   (`timedOut`) so they draw their names, and the next call can go. A stuck file read (a
//   network share that stopped answering) then never stops later rows getting profiles;
// - a call carries at most `max` ids, the newest first (rows on screen now beat rows passed);
// - a row that leaves the screen before its turn is dropped (it asks again if it comes back).
//   Each want has its own token, so a row whose request was already sent can't drop a newer
//   row's request for the same key.
// Pure (no DOM, no Tauri), so `node --test` covers it.

export interface QueueTimeout<T> {
  /** How long a call may hold the queue. */
  ms: number;
  /** Gets the items of a call that ran out of time. Its answer still counts if it comes later. */
  timedOut: (items: T[]) => void;
  /** Runs `run` after `ms`; returns what cancels it. setTimeout by default (tests pass their own). */
  after?: (ms: number, run: () => void) => () => void;
}

const afterTimeout = (ms: number, run: () => void) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

export class RequestQueue<T> {
  /** Waiting to be sent, oldest first. Only keys some mounted row still wants. */
  private readonly waiting = new Map<string, T>();
  /** The mounted rows wanting each waiting key, one token per want. */
  private readonly wanted = new Map<string, Set<symbol>>();
  private busy = false;
  private scheduled = false;
  private readonly send: (items: T[]) => Promise<unknown>;
  private readonly schedule: (run: () => void) => void;
  private readonly max: number;
  private readonly timeout?: QueueTimeout<T>;

  /**
   * @param send makes one call; the next waits until it settles (or times out).
   * @param schedule runs the next call soon (once per animation frame in the app), so ids that
   *   come up together go in one call.
   * @param timeout how long one call may hold the queue; none: until it settles.
   */
  constructor(send: (items: T[]) => Promise<unknown>, schedule: (run: () => void) => void, max: number, timeout?: QueueTimeout<T>) {
    this.send = send;
    this.schedule = schedule;
    this.max = max;
    this.timeout = timeout;
  }

  /** A mounted row wants `key` sent. Returns what to call when the row unmounts. */
  want(key: string, item: T): () => void {
    const token = Symbol(key);
    const tokens = this.wanted.get(key) ?? new Set<symbol>();
    tokens.add(token);
    this.wanted.set(key, tokens);
    this.waiting.delete(key); // re-added as the newest
    this.waiting.set(key, item);
    this.kick();
    return () => {
      // Not there: released already, or sent (the wants a call carried end with it, and a
      // newer want of the same key has its own token).
      const tokens = this.wanted.get(key);
      if (!tokens?.delete(token)) return;
      if (!tokens.size) {
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
    // Whichever comes first, the answer or the timeout, frees the queue; the other does nothing.
    let finished = false;
    let cancelTimer = () => {};
    const done = () => {
      if (finished) return;
      finished = true;
      cancelTimer();
      this.busy = false;
      this.kick();
    };
    const timeout = this.timeout;
    if (timeout) {
      cancelTimer = (timeout.after ?? afterTimeout)(timeout.ms, () => {
        if (finished) return;
        done();
        timeout.timedOut(batch);
      });
    }
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
