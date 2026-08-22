/**
 * The Auto-mode timer.
 *
 * Small on purpose: the bug it exists to prevent is a scheduling one. If a
 * player clicks to advance a line a moment before the pending timer fires,
 * and that timer is not cancelled first, it fires against the *next* line and
 * skips it. Keeping the timer in one place - where scheduling always cancels
 * first, and every manual advance cancels - makes that impossible to get
 * wrong at a call site, and lets it be tested on a fake clock.
 */
import type { IndicatorTimers } from "./loading-indicator.js";

const REAL_TIMERS: IndicatorTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class AutoAdvanceTimer {
  private handle: unknown = null;

  constructor(
    private readonly onFire: () => void,
    private readonly timers: IndicatorTimers = REAL_TIMERS,
  ) {}

  /** True while an advance is scheduled. */
  get pending(): boolean {
    return this.handle !== null;
  }

  /** Schedule the next advance, replacing any pending one. */
  schedule(delayMs: number): void {
    this.cancel();
    this.handle = this.timers.set(() => {
      this.handle = null;
      this.onFire();
    }, delayMs);
  }

  /** Drop a pending advance. Safe to call when nothing is scheduled. */
  cancel(): void {
    if (this.handle === null) return;
    this.timers.clear(this.handle);
    this.handle = null;
  }
}
