/**
 * Authored time: tweens, `wait` actions, and the transitionSync barrier.
 *
 * Separated from PixiStage for the same reason the asset loader was - a stage
 * needs a WebGL context to exist, while the rules here are about *when* a
 * promise settles and *whether* an animation gets to paint its last frame.
 * Those are the two things that go wrong.
 *
 * The distinction that matters is between finishing and abandoning:
 *
 *   - `skip()` is the player clicking through a transition they do not want
 *     to watch. Every tween jumps to its final frame, because the picture the
 *     author intended is still the picture that should be on screen.
 *   - `cancel()` is the scene itself being thrown away - a load, a rewind, a
 *     return to the title. Nothing may paint: an abandoned animation's last
 *     frame would land on whatever replaces it. The promises still settle, or
 *     the loop waiting on them never unwinds.
 */

export interface Tween {
  /** Advance by dt; false when finished. */
  update(dtMs: number): boolean;
  /** Jump to the final frame and settle. */
  finish(): void;
  /** Settle without painting. */
  cancel(): void;
}

export interface AnimatorTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: AnimatorTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class Animator {
  private readonly tweens = new Set<Tween>();
  /** Resolvers for authored waits and settle barriers currently parked. */
  private readonly parked = new Set<() => void>();

  constructor(private readonly timers: AnimatorTimers = REAL_TIMERS) {}

  /** Animations currently running. */
  get active(): number {
    return this.tweens.size;
  }

  /** Promises parked on an authored wait or a settle barrier. */
  get waiting(): number {
    return this.parked.size;
  }

  /** Advance every running animation. */
  tick(dtMs: number): void {
    for (const t of [...this.tweens]) {
      // A tween cancelled mid-tick is no longer in the set; skip it rather
      // than letting a stale entry paint one more frame.
      if (!this.tweens.has(t)) continue;
      if (!t.update(dtMs)) this.tweens.delete(t);
    }
  }

  /** Run `step` from 0 to 1 over `durationMs`, or instantly. */
  tween(durationMs: number, step: (k: number) => void, instant: boolean): Promise<void> {
    if (instant || durationMs <= 0) {
      step(1);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let elapsed = 0;
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        this.tweens.delete(t);
        resolve();
      };
      const t: Tween = {
        update: (dt) => {
          if (settled) return false;
          elapsed += dt;
          const k = Math.min(1, elapsed / durationMs);
          step(k);
          if (k >= 1) {
            done();
            return false;
          }
          return true;
        },
        finish: () => {
          if (settled) return;
          step(1);
          done();
        },
        cancel: done,
      };
      this.tweens.add(t);
    });
  }

  /**
   * An authored pause. Skippable by the player, and released outright when
   * the scene is abandoned.
   */
  wait(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        this.timers.clear(handle);
        this.parked.delete(done);
        resolve();
      };
      const handle = this.timers.set(done, ms);
      this.parked.add(done);
    });
  }

  /** Barrier: resolve once nothing is animating (or the scene is abandoned). */
  settle(): Promise<void> {
    if (this.tweens.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        this.parked.delete(done);
        resolve();
      };
      const check = (): void => {
        if (settled) return;
        if (this.tweens.size === 0) done();
        else this.timers.set(check, 16);
      };
      this.parked.add(done);
      check();
    });
  }

  /**
   * The player clicking through. Every animation lands on its final frame -
   * the authored picture is still the one that belongs on screen - and any
   * authored pause is released.
   */
  skip(): void {
    for (const t of [...this.tweens]) t.finish();
    this.tweens.clear();
    this.release();
  }

  /**
   * The scene is being thrown away. Nothing paints, because whatever replaces
   * it owns the screen now; everything parked is released so the loop that
   * was waiting can unwind at once.
   */
  cancel(): void {
    for (const t of [...this.tweens]) t.cancel();
    this.tweens.clear();
    this.release();
  }

  private release(): void {
    const parked = [...this.parked];
    this.parked.clear();
    for (const done of parked) done();
  }
}
