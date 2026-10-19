/**
 * How many loaded fonts the page keeps (fontLoader.ts). Every preview adds a FontFace to the
 * page, and a fast scroll through Tiles would otherwise leave thousands of them loaded for the
 * rest of the session. So faces no row shows any more are kept only up to a limit: past it, the
 * one unused longest is let go (fontLoader removes it from `document.fonts` and its caches) and
 * simply loads again if a row shows it later. Faces a row (or a font page) shows are never let
 * go.
 *
 * Pure (no DOM), so `npm run test:ui` covers it.
 */
export class FaceMemory<T> {
  /** Loaded faces, in use or not. */
  private readonly held = new Map<string, T>();
  /** Loaded faces no row shows, longest unused first. */
  private readonly idle = new Set<string>();
  /** Rows showing each face (loaded or not yet). */
  private readonly users = new Map<string, number>();
  private readonly limit: number;
  private readonly release: (name: string, value: T) => void;

  /**
   * @param limit how many unused faces to keep.
   * @param release lets a face go (removes it from the page).
   */
  constructor(limit: number, release: (name: string, value: T) => void) {
    this.limit = limit;
    this.release = release;
  }

  /** A row started showing `name`. */
  use(name: string): void {
    this.users.set(name, (this.users.get(name) ?? 0) + 1);
    this.idle.delete(name);
  }

  /** A row stopped showing `name`. The last one makes a loaded face unused (the newest). */
  unuse(name: string): void {
    const left = (this.users.get(name) ?? 1) - 1;
    if (left > 0) {
      this.users.set(name, left);
      return;
    }
    this.users.delete(name);
    if (this.held.has(name)) {
      this.idle.add(name);
      this.trim();
    }
  }

  /** How many rows show `name`. */
  usersOf(name: string): number {
    return this.users.get(name) ?? 0;
  }

  /** `name` finished loading. Unused already (its row scrolled away meanwhile): it's idle. */
  loaded(name: string, value: T): void {
    const before = this.held.get(name);
    if (before !== undefined && before !== value) this.release(name, before);
    this.held.set(name, value);
    if (this.usersOf(name) === 0) {
      this.idle.delete(name);
      this.idle.add(name);
      this.trim();
    }
  }

  /** Loaded faces kept, in use or not. */
  get size(): number {
    return this.held.size;
  }

  /** Loaded faces no row shows. */
  get unused(): number {
    return this.idle.size;
  }

  private trim(): void {
    for (const name of this.idle) {
      if (this.idle.size <= this.limit) break;
      this.idle.delete(name);
      const value = this.held.get(name);
      this.held.delete(name);
      if (value !== undefined) this.release(name, value);
    }
  }
}
