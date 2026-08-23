/**
 * Loading textures, with the two things the renderer actually needs from it:
 * a way to stop waiting, and a way to wait for several at once.
 *
 * Separated from PixiStage because the bugs here have nothing to do with
 * drawing. A stage needs a WebGL context to exist; the rules below - what
 * counts as a failure, what a cancelled load may still touch, how long four
 * cold assets take - can then be pinned exactly.
 *
 * Two properties are the whole point:
 *
 *   - a load can be abandoned. The per-asset timeout is a backstop for a
 *     broken server, not a way to get the player moving again; without
 *     cancellation, returning to the title mid-conversion meant waiting the
 *     conversion out, because nothing could interrupt the await.
 *   - loads for one event overlap. The authored transition order is a
 *     sequence of awaits, so warming them one at a time made a cold event
 *     cost the sum of its assets - four serial conversions, each comfortably
 *     under the timeout, none of them individually slow.
 */

/** Thrown internally when a load is abandoned. Never a failure. */
export class LoadCancelled extends Error {
  constructor() {
    super("load cancelled");
    this.name = "LoadCancelled";
  }
}

export interface AssetProgress {
  done: number;
  total: number;
}

export interface WaitRecord {
  kind: "texture" | "prefetch" | "apply";
  file?: string;
  outcome: "ok" | "timeout" | "cancelled" | "error";
  ms: number;
  pending: number;
  epoch: number;
}

export interface AssetLoaderDeps<T> {
  /** The underlying loader. Its late result is discarded after a cancel. */
  load: (url: string) => Promise<T>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

export class AssetLoader<T> {
  /** How long one load may take before it is treated as broken. */
  timeoutMs = 10_000;
  onActivity: ((pending: number, progress?: AssetProgress) => void) | null = null;
  onError: ((file: string, error: unknown) => void) | null = null;
  onWait: ((record: WaitRecord) => void) | null = null;

  private generation = 0;
  private inFlight = 0;
  private readonly cancelWaiters = new Set<(err: unknown) => void>();
  private readonly failedFiles = new Set<string>();
  private readonly retryCount = new Map<string, number>();
  private batch: AssetProgress | null = null;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly now: () => number;

  constructor(private readonly deps: AssetLoaderDeps<T>) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.now = deps.now ?? (() => Date.now());
  }

  /** Identity of the current picture; a load from an older one is discarded. */
  get epoch(): number {
    return this.generation;
  }

  get pending(): number {
    return this.inFlight;
  }

  get failed(): string[] {
    return [...this.failedFiles];
  }

  /** True when `epoch` no longer names the picture being built. */
  stale(epoch: number): boolean {
    return epoch !== this.generation;
  }

  /**
   * Abandon everything in flight. Loads settle as cancelled: nothing is
   * recorded as failed and the host is not told to offer a retry for
   * something nobody is waiting for.
   */
  cancel(): void {
    this.generation++;
    this.batch = null;
    const waiters = [...this.cancelWaiters];
    this.cancelWaiters.clear();
    for (const reject of waiters) reject(new LoadCancelled());
    this.report();
  }

  /** URL for a file, carrying its retry counter when it has one. */
  urlFor(file: string, base: string): string {
    const attempt = this.retryCount.get(file) ?? 0;
    if (attempt === 0) return base;
    return `${base}${base.includes("?") ? "&" : "?"}retry=${attempt}`;
  }

  /** Note that these files should be re-requested rather than served stale. */
  retry(files: string[]): void {
    for (const f of files) this.retryCount.set(f, (this.retryCount.get(f) ?? 0) + 1);
  }

  clearFailed(): void {
    this.failedFiles.clear();
  }

  /**
   * Load one asset. Resolves null when it fails, times out, or is abandoned -
   * the caller checks `stale()` to tell the last of those apart.
   */
  async get(file: string, base: string): Promise<T | null> {
    const epoch = this.generation;
    const url = this.urlFor(file, base);
    this.inFlight += 1;
    this.report();
    const started = this.now();
    let timer: unknown;
    let cancelReject: ((err: unknown) => void) | undefined;
    try {
      const load = this.deps.load(url);
      // An abandoned load still settles; without a handler of its own its
      // rejection would surface as an unhandled one.
      void load.catch(() => undefined);
      const value = await Promise.race<T>([
        load,
        new Promise<never>((_r, reject) => {
          timer = this.setTimer(() => reject(new Error(`load timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
        }),
        new Promise<never>((_r, reject) => {
          cancelReject = reject;
          this.cancelWaiters.add(reject);
        }),
      ]);
      if (this.stale(epoch)) {
        this.note({ kind: "texture", file, outcome: "cancelled", ms: this.now() - started, pending: this.inFlight - 1, epoch });
        return null;
      }
      this.failedFiles.delete(file);
      this.note({ kind: "texture", file, outcome: "ok", ms: this.now() - started, pending: this.inFlight - 1, epoch });
      return value;
    } catch (err) {
      if (err instanceof LoadCancelled || this.stale(epoch)) {
        this.note({ kind: "texture", file, outcome: "cancelled", ms: this.now() - started, pending: this.inFlight - 1, epoch });
        return null;
      }
      this.failedFiles.add(file);
      this.onError?.(file, err);
      this.note({
        kind: "texture",
        file,
        outcome: /timed out/.test(String((err as Error)?.message)) ? "timeout" : "error",
        ms: this.now() - started,
        pending: this.inFlight - 1,
        epoch,
      });
      return null;
    } finally {
      if (timer !== undefined) this.clearTimer(timer);
      if (cancelReject) this.cancelWaiters.delete(cancelReject);
      this.inFlight -= 1;
      if (this.batch) this.batch.done = Math.min(this.batch.total, this.batch.done + 1);
      this.report();
    }
  }

  /**
   * Warm several assets together, so the authored sequence that follows finds
   * them already loaded and runs at its intended speed.
   */
  async warm(files: { file: string; base: string }[]): Promise<void> {
    const seen = new Set<string>();
    const wanted = files.filter((f) => f.file && !seen.has(f.file) && seen.add(f.file));
    if (wanted.length <= 1) return; // nothing to overlap
    const epoch = this.generation;
    const started = this.now();
    this.batch = { total: wanted.length, done: 0 };
    this.report();
    await Promise.all(wanted.map((f) => this.get(f.file, f.base)));
    if (!this.stale(epoch)) this.batch = null;
    this.report();
    this.note({
      kind: "prefetch",
      outcome: this.stale(epoch) ? "cancelled" : "ok",
      ms: this.now() - started,
      pending: this.inFlight,
      epoch,
    });
  }

  private report(): void {
    this.onActivity?.(this.inFlight, this.batch ? { ...this.batch } : undefined);
  }

  private note(record: WaitRecord): void {
    this.onWait?.(record);
  }
}
