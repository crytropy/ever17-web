/**
 * The movie surface, and who is allowed to end a movie.
 *
 * A movie is the one place the player loop hands control to an element and
 * waits. That await is resolved by the element's own `ended`/`click`
 * handlers - so anything that clears those handlers without resolving leaves
 * the loop parked forever, which is how "return to title during a movie" used
 * to freeze the whole game.
 *
 * So the resolver is owned here rather than left on the element:
 *
 *   - `stop()` settles the pending `play()` instead of orphaning it, and is
 *     safe to call any number of times, including when nothing is playing;
 *   - each `play()` carries its own identity, so a HEAD response, an
 *     autoplay rejection or a skip timer belonging to a movie that has since
 *     been cancelled cannot touch the one playing now;
 *   - the element is torn down once, in one place.
 */

/** How a movie finished. `missing` means the file is not in the package. */
export type MovieOutcome = "played" | "cancelled" | "missing";

/**
 * A handler slot on the element. Written permissively so a real
 * HTMLVideoElement - whose handlers receive an Event - satisfies it, while a
 * plain zero-argument callback can still be assigned into it.
 */
type MovieHandler = ((...args: never[]) => unknown) | null;

/** The bits of a <video> this needs, so tests can supply a plain object. */
export interface MovieElement {
  src: string;
  onended: MovieHandler;
  onclick: MovieHandler;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
  classList: { add(token: string): void; remove(token: string): void };
}

export interface MovieDeps {
  el: MovieElement;
  /** True when the movie file is actually available. */
  exists: (url: string, signal: AbortSignal) => Promise<boolean>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Active {
  resolve: (outcome: MovieOutcome) => void;
  abort: AbortController;
  timer: unknown;
  settled: boolean;
}

export class MoviePlayer {
  private active: Active | null = null;

  constructor(private readonly deps: MovieDeps) {}

  get playing(): boolean {
    return this.active !== null;
  }

  /**
   * Show a movie and resolve when it is over, cancelled, or found to be
   * missing. Starting a movie cancels any movie already running.
   */
  play(url: string, opts: { skipAfterMs?: number | null } = {}): Promise<MovieOutcome> {
    this.stop();
    return new Promise<MovieOutcome>((resolve) => {
      const entry: Active = { resolve, abort: new AbortController(), timer: null, settled: false };
      this.active = entry;
      void this.run(entry, url, opts.skipAfterMs ?? null);
    });
  }

  /**
   * End whatever is on screen. Idempotent, and safe when nothing is playing:
   * the point is that the caller never has to know which of those it is.
   */
  stop(): void {
    const entry = this.active;
    if (!entry) {
      this.teardown();
      return;
    }
    entry.abort.abort();
    this.settle(entry, "cancelled");
  }

  private async run(entry: Active, url: string, skipAfterMs: number | null): Promise<void> {
    let ok = false;
    try {
      ok = await this.deps.exists(url, entry.abort.signal);
    } catch {
      ok = false;
    }
    // Cancelled while the HEAD request was in flight: the run that replaced
    // this one owns the screen now, so do not put a movie on it.
    if (entry.settled) return;
    if (!ok) {
      this.settle(entry, "missing");
      return;
    }

    const el = this.deps.el;
    el.src = url;
    el.classList.remove("hidden");
    const done = (): void => this.settle(entry, "played");
    el.onended = done;
    el.onclick = done;
    try {
      await el.play();
    } catch {
      /* autoplay refused: a click still ends it */
    }
    if (entry.settled) return;

    if (skipAfterMs !== null && this.deps.setTimer) {
      entry.timer = this.deps.setTimer(() => {
        // A timer from a cancelled movie must not end a newer one.
        if (this.active === entry) this.settle(entry, "played");
      }, skipAfterMs);
    }
  }

  private settle(entry: Active, outcome: MovieOutcome): void {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timer !== null) this.deps.clearTimer?.(entry.timer);
    entry.timer = null;
    if (this.active === entry) {
      this.active = null;
      this.teardown();
    }
    entry.resolve(outcome);
  }

  private teardown(): void {
    const el = this.deps.el;
    el.onended = null;
    el.onclick = null;
    try {
      el.pause();
    } catch {
      /* nothing was playing */
    }
    el.removeAttribute("src");
    el.classList.add("hidden");
  }
}
