/**
 * Cross-run persistent state.
 *
 * Some KID-engine games are built around playing more than once: a flag
 * written near the end of one run is read by a later run to open content that
 * a first-time player cannot reach. That state is neither part of a save file
 * (it outlives any single run) nor part of completion tracking (it is real
 * scenario state the VM reads), so it gets its own contract.
 *
 * Which variables persist is game knowledge and belongs to an adapter, which
 * ideally derives it from the scenario rather than hardcoding ids. The engine
 * only ever sees the resulting policy.
 */

export const PERSISTENT_STATE_FORMAT = "kid-persistent-state";
export const PERSISTENT_STATE_VERSION = 1;

/**
 * How a finished run's value folds into stored state.
 *
 * - `max`: keep the larger value. Right for progression flags and counters,
 *   which only ever move forward; it also means loading an old save can
 *   never roll global progress backwards.
 * - `last`: the most recent run wins.
 */
export type PersistentMergeRule = "max" | "last";

/** Adapter-declared description of what survives a New Game. */
export interface PersistentStatePolicy {
  policyVersion: number;
  /** Scenario variable ids carried across runs, ascending. */
  vars: number[];
  merge: PersistentMergeRule;
  /** How this policy was established, for diagnostics and documentation. */
  derivedFrom?: string;
}

/** Stored cross-run state for one game. */
export interface PersistentState {
  format: typeof PERSISTENT_STATE_FORMAT;
  version: number;
  gameId: string;
  /** Variable id -> value, ascending by id (stable serialization). */
  vars: [number, number][];
  updatedAt: string;
}

export const EMPTY_PERSISTENT_STATE = (gameId: string): PersistentState => ({
  format: PERSISTENT_STATE_FORMAT,
  version: PERSISTENT_STATE_VERSION,
  gameId,
  vars: [],
  updatedAt: new Date(0).toISOString(),
});

/** Keep only what the policy declares, in a stable order. */
export function projectPersistentVars(
  policy: PersistentStatePolicy,
  vars: Iterable<readonly [number, number]>,
): [number, number][] {
  const declared = new Set(policy.vars);
  return [...vars]
    .filter(([id]) => declared.has(id))
    .map(([id, value]) => [id, value] as [number, number])
    .sort((a, b) => a[0] - b[0]);
}

/**
 * Fold a finished run's variables into stored state under the policy's merge
 * rule. Pure: returns new state, never mutates either input.
 */
export function mergePersistentState(
  policy: PersistentStatePolicy,
  stored: PersistentState,
  runVars: Iterable<readonly [number, number]>,
  now: string = new Date().toISOString(),
): PersistentState {
  const merged = new Map<number, number>(stored.vars);
  for (const [id, value] of projectPersistentVars(policy, runVars)) {
    const previous = merged.get(id);
    if (previous === undefined || policy.merge === "last") merged.set(id, value);
    else merged.set(id, Math.max(previous, value));
  }
  return {
    format: PERSISTENT_STATE_FORMAT,
    version: PERSISTENT_STATE_VERSION,
    gameId: stored.gameId,
    vars: [...merged.entries()].sort((a, b) => a[0] - b[0]),
    updatedAt: now,
  };
}

/**
 * Variables a new run should start from. Only declared ids appear, so a
 * policy change cannot resurrect state the game no longer treats as global.
 */
export function seedFromPersistentState(
  policy: PersistentStatePolicy,
  stored: PersistentState,
): [number, number][] {
  return projectPersistentVars(policy, stored.vars);
}

/**
 * Restoring a save must not roll global progress backwards: for declared
 * variables the merge rule decides between the save's value and the stored
 * global one. Returns the overrides to apply on top of the save.
 */
export function reconcileSaveWithPersistentState(
  policy: PersistentStatePolicy,
  stored: PersistentState,
  saveVars: Iterable<readonly [number, number]>,
): [number, number][] {
  const fromSave = new Map<number, number>(projectPersistentVars(policy, saveVars));
  const out: [number, number][] = [];
  for (const [id, globalValue] of seedFromPersistentState(policy, stored)) {
    const saved = fromSave.get(id);
    if (saved === undefined) {
      out.push([id, globalValue]);
      continue;
    }
    const winner = policy.merge === "last" ? saved : Math.max(saved, globalValue);
    if (winner !== saved) out.push([id, winner]);
  }
  return out;
}

/**
 * Whether a finished run may update global cross-run progress.
 *
 * Only a story that actually reached its ending counts. This matters because
 * a game may write its route-clear flags near the *start* of a long ending
 * scene: a player who saves there and quits has those flags in their save
 * file, but has not finished the route, and must not be credited with it.
 * A run that died on a missing scene or hit the step limit never counts.
 */
export function runCountsAsCompletion(reason: string): boolean {
  return reason === "ending";
}
