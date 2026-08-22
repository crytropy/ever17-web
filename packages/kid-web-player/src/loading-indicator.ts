/**
 * Debounced "something is loading" state.
 *
 * Assets are converted from the original archives on first use, so a load can
 * take long enough to look like a frozen game - but most loads are cached and
 * instant, and flashing an indicator for those is worse than showing nothing.
 * This shows the indicator only once activity has lasted `delayMs`, and hides
 * it the moment everything settles.
 */
export interface IndicatorTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: IndicatorTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class LoadingIndicator {
  private handle: unknown = null;
  private shown = false;

  constructor(
    private readonly onShow: () => void,
    private readonly onHide: () => void,
    private readonly delayMs: number,
    private readonly timers: IndicatorTimers = REAL_TIMERS,
  ) {}

  /** True while the indicator is on screen (for tests and diagnostics). */
  get visible(): boolean {
    return this.shown;
  }

  /** Report how many loads are in flight. */
  update(pending: number): void {
    if (pending > 0) {
      if (this.handle === null && !this.shown) {
        this.handle = this.timers.set(() => {
          this.handle = null;
          this.shown = true;
          this.onShow();
        }, this.delayMs);
      }
      return;
    }
    if (this.handle !== null) {
      this.timers.clear(this.handle);
      this.handle = null;
    }
    if (this.shown) {
      this.shown = false;
      this.onHide();
    }
  }
}
