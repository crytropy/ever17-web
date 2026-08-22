import { describe, expect, it } from "vitest";
import {
  EMPTY_PERSISTENT_STATE,
  PERSISTENT_STATE_FORMAT,
  mergePersistentState,
  reconcileSaveWithPersistentState,
  seedFromPersistentState,
  type PersistentStatePolicy,
} from "kid-contracts";
import { PersistentProgress, progressKey } from "../src/progress.js";
import type { StorageLike } from "../src/config.js";

/**
 * Cross-run progress is what makes a second playthrough different from the
 * first, so these tests pin the properties a player would notice: a fresh
 * profile starts clean, finishing a route is remembered, a new run inherits
 * it, and loading an old save never takes it away.
 */

const NS = "e17vn";
const GAME = "ever17";
/** Shape of a real derived policy (ids stand in for any game's flags). */
const POLICY: PersistentStatePolicy = {
  policyVersion: 1,
  vars: [1039, 1040, 1043, 1046, 1049, 1050],
  merge: "max",
  derivedFrom: "test",
};

function mockStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const progress = (s: StorageLike, policy: PersistentStatePolicy | null = POLICY) =>
  new PersistentProgress(s, NS, GAME, policy);

describe("persistent state contract", () => {
  it("keeps only declared variables", () => {
    const state = mergePersistentState(POLICY, EMPTY_PERSISTENT_STATE(GAME), [
      [1039, 1],
      [1203, 7], // a run-local variable: never global
      [1050, 1],
    ]);
    expect(state.vars).toEqual([
      [1039, 1],
      [1050, 1],
    ]);
  });

  it("merges forward under the max rule and never backwards", () => {
    let state = mergePersistentState(POLICY, EMPTY_PERSISTENT_STATE(GAME), [[1039, 1]]);
    state = mergePersistentState(POLICY, state, [[1039, 0], [1040, 1]]);
    expect(new Map(state.vars)).toEqual(new Map([[1039, 1], [1040, 1]]));
  });

  it("honours a last-write policy when a game declares one", () => {
    const last: PersistentStatePolicy = { ...POLICY, merge: "last" };
    let state = mergePersistentState(last, EMPTY_PERSISTENT_STATE(GAME), [[1039, 5]]);
    state = mergePersistentState(last, state, [[1039, 2]]);
    expect(state.vars).toEqual([[1039, 2]]);
  });

  it("reconciles a save against newer global progress", () => {
    const state = mergePersistentState(POLICY, EMPTY_PERSISTENT_STATE(GAME), [
      [1039, 1],
      [1040, 1],
    ]);
    // a save taken before either route was cleared
    const overrides = reconcileSaveWithPersistentState(POLICY, state, [[1039, 0], [1203, 3]]);
    expect(new Map(overrides)).toEqual(new Map([[1039, 1], [1040, 1]]));
  });

  it("produces no overrides when a save is already ahead", () => {
    const state = mergePersistentState(POLICY, EMPTY_PERSISTENT_STATE(GAME), [[1039, 1]]);
    expect(reconcileSaveWithPersistentState(POLICY, state, [[1039, 1]])).toEqual([]);
  });

  it("seeds only declared ids", () => {
    const state = mergePersistentState(POLICY, EMPTY_PERSISTENT_STATE(GAME), [[1039, 1]]);
    const narrower: PersistentStatePolicy = { ...POLICY, vars: [1050] };
    expect(seedFromPersistentState(narrower, state)).toEqual([]);
  });
});

describe("stored cross-run progress", () => {
  it("a fresh profile has no route-clear state", () => {
    const p = progress(mockStorage());
    expect(p.enabled).toBe(true);
    expect(p.seed()).toEqual([]);
    expect(p.snapshot().vars).toEqual([]);
  });

  it("records what a finished run unlocked, and a new game inherits it", () => {
    const s = mockStorage();
    const first = progress(s);
    // a run that clears one route
    const changed = first.record([[1039, 1], [1203, 4]]);
    expect(changed).toEqual([1039]);

    // the next New Game, in the same browser
    const second = progress(s);
    expect(second.seed()).toEqual([[1039, 1]]);
  });

  it("survives a reload (state lives in storage, not memory)", () => {
    const s = mockStorage();
    progress(s).record([[1039, 1], [1040, 1]]);
    expect(s.getItem(progressKey(NS))).not.toBeNull();
    // a completely fresh player object, as after F5
    expect(progress(s).seed()).toEqual([[1039, 1], [1040, 1]]);
  });

  it("recording is idempotent and monotonic", () => {
    const s = mockStorage();
    const p = progress(s);
    expect(p.record([[1039, 1]])).toEqual([1039]);
    expect(p.record([[1039, 1]])).toEqual([]);
    expect(p.record([[1039, 0]])).toEqual([]); // a later run without that route
    expect(p.seed()).toEqual([[1039, 1]]);
  });

  it("loading an older save does not roll global progress backwards", () => {
    const s = mockStorage();
    const p = progress(s);
    p.record([[1039, 1], [1040, 1]]);
    // a save file from before those clears
    const overrides = p.reconcile([[1039, 0], [1203, 2]]);
    expect(new Map(overrides)).toEqual(new Map([[1039, 1], [1040, 1]]));
  });

  it("ignores foreign, corrupt or wrong-game stored state", () => {
    const s = mockStorage();
    s.setItem(progressKey(NS), "{ not json");
    expect(progress(s).seed()).toEqual([]);

    s.setItem(progressKey(NS), JSON.stringify({ format: "something-else", vars: [[1039, 1]] }));
    expect(progress(s).seed()).toEqual([]);

    s.setItem(
      progressKey(NS),
      JSON.stringify({ format: PERSISTENT_STATE_FORMAT, version: 1, gameId: "never7", vars: [[1039, 1]] }),
    );
    expect(progress(s).seed()).toEqual([]);
  });

  it("is inert for a game that declares no cross-run state", () => {
    const s = mockStorage();
    const p = progress(s, null);
    expect(p.enabled).toBe(false);
    expect(p.record([[1039, 1]])).toEqual([]);
    expect(p.seed()).toEqual([]);
    expect(s.getItem(progressKey(NS))).toBeNull();
  });

  it("reset clears global progress explicitly", () => {
    const s = mockStorage();
    const p = progress(s);
    p.record([[1039, 1]]);
    p.reset();
    expect(p.seed()).toEqual([]);
    expect(progress(s).seed()).toEqual([]);
  });

  it("keeps cross-run progress separate from saves and settings", () => {
    const s = mockStorage();
    progress(s).record([[1039, 1]]);
    expect([...s.map.keys()]).toEqual(["e17vn:progress"]);
  });
});
