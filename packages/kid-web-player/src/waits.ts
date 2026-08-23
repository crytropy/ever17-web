/**
 * Structured timing for the waits a player can feel.
 *
 * The stall this exists for was invisible from the outside: no error, no
 * failed request, nothing on screen, and a per-asset timeout that never fired
 * because no single asset was slow - four cold ones in a row were. Averages
 * and spinners cannot show that. A record per wait can.
 *
 * Diagnostics only. It is armed for QA profiles and for an explicit `?diag`,
 * never for an ordinary session, and its records - which name converted files
 * and scenes - are read from the console, never shown in the game's UI.
 */

export interface WaitEntry {
  /** What was waited on. */
  kind: string;
  outcome: "ok" | "timeout" | "cancelled" | "error";
  ms: number;
  /** Converted file name, when the wait was for one. QA logs only. */
  file?: string;
  /** Scene and block the session was on. QA logs only. */
  scene?: string;
  block?: string;
  /** Identity of the session or apply this belonged to. */
  epoch?: number;
  /** Loads still in flight when this finished. */
  pending?: number;
  /** Milliseconds since the recorder was armed. */
  at: number;
}

export interface WaitSummary {
  count: number;
  slowest: WaitEntry | null;
  totalMs: number;
  byKind: Record<string, { count: number; totalMs: number; maxMs: number }>;
  /** Waits at or over the threshold, worst first. */
  slow: WaitEntry[];
}

export class WaitRecorder {
  private readonly entries: WaitEntry[] = [];
  private readonly started: number;

  constructor(
    /** Off by default: an ordinary session records nothing at all. */
    readonly enabled: boolean,
    private readonly limit = 5000,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.started = this.now();
  }

  note(entry: Omit<WaitEntry, "at">): void {
    if (!this.enabled) return;
    this.entries.push({ ...entry, at: this.now() - this.started });
    // Bounded: a long session must not turn diagnostics into a leak.
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  /** Time a promise, recording however it settles. */
  async time<T>(kind: string, detail: Omit<WaitEntry, "at" | "kind" | "ms" | "outcome">, run: () => Promise<T>): Promise<T> {
    if (!this.enabled) return run();
    const t0 = this.now();
    try {
      const value = await run();
      this.note({ ...detail, kind, outcome: "ok", ms: this.now() - t0 });
      return value;
    } catch (err) {
      this.note({ ...detail, kind, outcome: "error", ms: this.now() - t0 });
      throw err;
    }
  }

  all(): WaitEntry[] {
    return [...this.entries];
  }

  /** Everything at or over `thresholdMs`, worst first. */
  summary(thresholdMs = 1000): WaitSummary {
    const byKind: WaitSummary["byKind"] = {};
    let totalMs = 0;
    let slowest: WaitEntry | null = null;
    for (const e of this.entries) {
      totalMs += e.ms;
      const k = (byKind[e.kind] ??= { count: 0, totalMs: 0, maxMs: 0 });
      k.count++;
      k.totalMs += e.ms;
      k.maxMs = Math.max(k.maxMs, e.ms);
      if (!slowest || e.ms > slowest.ms) slowest = e;
    }
    return {
      count: this.entries.length,
      slowest,
      totalMs,
      byKind,
      slow: this.entries.filter((e) => e.ms >= thresholdMs).sort((a, b) => b.ms - a.ms),
    };
  }

  clear(): void {
    this.entries.length = 0;
  }
}

/**
 * Whether to record. QA profiles always do; anyone else has to ask with
 * `?diag`, so an ordinary playthrough carries no instrumentation.
 */
export function diagnosticsEnabled(storageNamespace: string, search: string): boolean {
  if (/(^|[?&])diag(=1|=true)?($|&)/.test(search)) return true;
  return storageNamespace.includes("-qa-");
}
