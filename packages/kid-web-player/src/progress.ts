/**
 * Cross-run progress kept in browser storage.
 *
 * Distinct from both saves and completion tracking: this is real scenario
 * state (variables the VM reads) that outlives any single run, so that a game
 * built around replaying opens up as the player finishes routes. What
 * persists is declared by the adapter's policy - this module never interprets
 * a variable, it only stores, seeds and merges.
 */
import {
  EMPTY_PERSISTENT_STATE,
  PERSISTENT_STATE_FORMAT,
  PERSISTENT_STATE_VERSION,
  mergePersistentState,
  reconcileSaveWithPersistentState,
  seedFromPersistentState,
  type PersistentState,
  type PersistentStatePolicy,
} from "kid-contracts";
import type { StorageLike } from "./config.js";

export const progressKey = (ns: string): string => `${ns}:progress`;

/** Storage-backed cross-run progress for one game. */
export class PersistentProgress {
  private state: PersistentState;

  constructor(
    private readonly storage: StorageLike,
    private readonly ns: string,
    private readonly gameId: string,
    private readonly policy: PersistentStatePolicy | null,
  ) {
    this.state = this.read();
  }

  /** True when the game declares any cross-run state at all. */
  get enabled(): boolean {
    return (this.policy?.vars.length ?? 0) > 0;
  }

  /** Current stored state (a copy; callers cannot mutate it in place). */
  snapshot(): PersistentState {
    return { ...this.state, vars: this.state.vars.map(([k, v]) => [k, v] as [number, number]) };
  }

  private read(): PersistentState {
    const empty = EMPTY_PERSISTENT_STATE(this.gameId);
    try {
      const raw = this.storage.getItem(progressKey(this.ns));
      if (!raw) return empty;
      const parsed = JSON.parse(raw) as Partial<PersistentState>;
      if (parsed.format !== PERSISTENT_STATE_FORMAT) return empty;
      if (parsed.version !== PERSISTENT_STATE_VERSION) return empty; // future format: start clean
      if (parsed.gameId !== this.gameId) return empty;
      if (!Array.isArray(parsed.vars)) return empty;
      const vars = parsed.vars
        .filter(
          (e): e is [number, number] =>
            Array.isArray(e) && e.length === 2 && typeof e[0] === "number" && typeof e[1] === "number",
        )
        .sort((a, b) => a[0] - b[0]);
      return { ...empty, vars, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : empty.updatedAt };
    } catch {
      return empty;
    }
  }

  private write(next: PersistentState): void {
    // Whole-value write: storage sees either the old state or the new one.
    this.state = next;
    try {
      this.storage.setItem(progressKey(this.ns), JSON.stringify(next));
    } catch {
      /* storage full or unavailable: the run still plays, progress is lost */
    }
  }

  /** Variables a New Game should start from. */
  seed(): [number, number][] {
    if (!this.policy) return [];
    return seedFromPersistentState(this.policy, this.state);
  }

  /** Overrides that keep a restored save from rolling global progress back. */
  reconcile(saveVars: Iterable<readonly [number, number]>): [number, number][] {
    if (!this.policy) return [];
    return reconcileSaveWithPersistentState(this.policy, this.state, saveVars);
  }

  /**
   * Fold a run's variables into stored progress. Safe to call often (at
   * saves as well as at endings): the merge rule is monotonic, so recording
   * early never loses anything and never moves progress backwards.
   * Returns the ids whose stored value changed.
   */
  record(runVars: Iterable<readonly [number, number]>): number[] {
    if (!this.policy) return [];
    const before = new Map(this.state.vars);
    const next = mergePersistentState(this.policy, this.state, runVars);
    const changed = next.vars.filter(([id, value]) => before.get(id) !== value).map(([id]) => id);
    if (changed.length > 0) this.write(next);
    return changed;
  }

  /** Discard all cross-run progress (an explicit, confirmed player action). */
  reset(): void {
    this.write(EMPTY_PERSISTENT_STATE(this.gameId));
  }
}
