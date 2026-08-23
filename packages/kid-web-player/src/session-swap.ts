/**
 * Replacing the live session, without breaking the one already playing.
 *
 * Loading a slot and rewinding through the backlog both mean "throw away the
 * session you have and run this one instead". The tempting order is to tear
 * the old one down first and then build the replacement - which is wrong,
 * because building can fail. It used to: a corrupt or unreadable save left
 * the player with the audio stopped, the waiters discarded, the overlays
 * hidden and no session at all, i.e. a game that could not be advanced.
 *
 * So the replacement is built first and nothing is released until it exists.
 * Everything belonging to the outgoing session - its pending media, its
 * autosave counter, its rewind points - is released in `release`, which only
 * runs on the success path.
 */

export interface SwapHooks<S> {
  /**
   * Release what the outgoing session owned. Runs only after the replacement
   * has been built successfully, so a failed swap releases nothing.
   */
  release?: (previous: S | null) => void;
  /** Runs once the replacement is the live session. */
  commit?: (next: S, previous: S | null) => void;
}

export type SwapResult<S> =
  | { ok: true; session: S; previous: S | null }
  | { ok: false; session: S | null; reason: string; alreadySwapping?: true; superseded?: true };

export class SessionSwap<S> {
  private current: S | null = null;
  private swapping = false;
  /** Bumped by every direct `set`, so an in-flight build can tell it is stale. */
  private generation = 0;

  /** The live session, or null before one exists. */
  get session(): S | null {
    return this.current;
  }

  /** True while a replacement is being built. */
  get inProgress(): boolean {
    return this.swapping;
  }

  /** Install a session outright (New Game), or clear it (return to title). */
  set(session: S | null): void {
    this.generation++;
    this.current = session;
  }

  /**
   * Build a replacement and, only if that works, make it live.
   *
   * On failure the live session, and everything `release` would have torn
   * down, are exactly as they were.
   */
  async replace(build: () => Promise<S>, hooks: SwapHooks<S> = {}): Promise<SwapResult<S>> {
    if (this.swapping) {
      // Two loads at once would race over which one released the other's
      // state; the second is refused rather than interleaved.
      return { ok: false, session: this.current, reason: "a load is already in progress", alreadySwapping: true };
    }
    this.swapping = true;
    const generation = this.generation;
    try {
      const next = await build();
      if (this.generation !== generation) {
        // Something decisive happened while this was building - returning to
        // the title, or starting a new game. Committing now would resurrect a
        // session the player has already left.
        return { ok: false, session: this.current, reason: "superseded", superseded: true };
      }
      const previous = this.current;
      // --- the commit point: past here the old session is gone
      hooks.release?.(previous);
      this.current = next;
      hooks.commit?.(next, previous);
      return { ok: true, session: next, previous };
    } catch (err) {
      return { ok: false, session: this.current, reason: (err as Error)?.message ?? String(err) };
    } finally {
      this.swapping = false;
    }
  }
}
