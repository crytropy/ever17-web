import { describe, expect, it } from "vitest";
import {
  activePlayDataKey,
  advanceGeneration,
  discardGeneration,
  keysOfGeneration,
  readActiveGeneration,
  readActiveScope,
  scopeFor,
} from "../src/play-data.js";
import { SaveSlots } from "../src/slots.js";
import { PersistentProgress } from "../src/progress.js";
import { DEFAULT_CONFIG, saveConfig, loadConfig, type StorageLike } from "../src/config.js";
import { SAVE_FORMAT, SAVE_VERSION, type PersistentStatePolicy, type SessionSave } from "kid-contracts";

/**
 * "Start completely fresh" has to be safe on a machine that may lose power
 * halfway through, and it must not take the player's settings with it. These
 * tests pin the two properties that make that work: generation 0 is the old
 * layout (so nothing needs migrating), and moving to a new generation is a
 * single write that immediately makes an empty world active.
 */

const NS = "e17vn";
const GAME = "ever17";
const POLICY: PersistentStatePolicy = { policyVersion: 1, vars: [1039, 1050], merge: "max", derivedFrom: "test" };

function mockStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

function fakeSave(scene: string): SessionSave {
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    vm: { scene, block: "00000010", pc: 0, steps: 1, presentation: { background: null, cg: null, sprites: [], bgm: null, fill: 0 }, actions: [] },
    vars: [],
    sysVars: [],
    counters: { lines: 1, scenes: 1 },
    route: [scene],
    backlog: [],
  };
}

describe("generation scopes", () => {
  it("generation 0 is the historical layout, so existing saves need no migration", () => {
    const scope = scopeFor(NS, 0);
    expect(scope.storagePrefix).toBe(NS);
    expect(scope.completionDb).toBe("e17vn-completion");
    // exactly the keys phases 5A-6 wrote
    const s = mockStorage();
    new SaveSlots(s, scope.storagePrefix).put("1", fakeSave("t_1a"));
    expect([...s.map.keys()].sort()).toEqual(["e17vn:save:1", "e17vn:slots"]);
  });

  it("later generations are namespaced away from the old ones", () => {
    const scope = scopeFor(NS, 2);
    expect(scope.storagePrefix).toBe("e17vn:play:2");
    expect(scope.completionDb).toBe("e17vn-play-2-completion");
  });

  it("a browser that has never reset is on generation 0", () => {
    const s = mockStorage();
    expect(readActiveGeneration(s, NS)).toBe(0);
    expect(readActiveScope(s, NS).storagePrefix).toBe(NS);
  });

  it("ignores a corrupt or foreign pointer rather than losing the player's data", () => {
    const s = mockStorage();
    for (const bad of ["{ not json", JSON.stringify({ version: 99, generation: 5 }), JSON.stringify({ version: 1, generation: -3 }), JSON.stringify({ version: 1 })]) {
      s.setItem(activePlayDataKey(NS), bad);
      expect(readActiveGeneration(s, NS), bad).toBe(0);
    }
  });
});

describe("starting completely fresh", () => {
  it("one write makes an empty world active", () => {
    const s = mockStorage();
    const before = readActiveScope(s, NS);
    new SaveSlots(s, before.storagePrefix).put("1", fakeSave("t_1a"));
    new PersistentProgress(s, before.storagePrefix, GAME, POLICY).record([[1039, 1]]);

    const after = advanceGeneration(s, NS);
    expect(after.generation).toBe(1);
    // the new world is empty even though nothing has been deleted yet
    expect(new SaveSlots(s, after.storagePrefix).list()).toEqual([]);
    expect(new PersistentProgress(s, after.storagePrefix, GAME, POLICY).seed()).toEqual([]);
    // and the old data is still sitting there, harmlessly unreachable
    expect(s.getItem("e17vn:save:1")).not.toBeNull();
  });

  it("survives a crash before cleanup: the new generation stays active", () => {
    const s = mockStorage();
    new SaveSlots(s, readActiveScope(s, NS).storagePrefix).put("1", fakeSave("t_1a"));
    advanceGeneration(s, NS); // power cut here
    const reopened = readActiveScope(s, NS);
    expect(reopened.generation).toBe(1);
    expect(new SaveSlots(s, reopened.storagePrefix).list()).toEqual([]);
  });

  it("keeps settings, which live outside any generation", () => {
    const s = mockStorage();
    saveConfig(s, NS, { ...DEFAULT_CONFIG, autoSpeed: "slow", bgmVolume: 0.3 });
    advanceGeneration(s, NS);
    const cfg = loadConfig(s, NS);
    expect(cfg.autoSpeed).toBe("slow");
    expect(cfg.bgmVolume).toBe(0.3);
  });

  it("can be repeated", () => {
    const s = mockStorage();
    expect(advanceGeneration(s, NS).generation).toBe(1);
    expect(advanceGeneration(s, NS).generation).toBe(2);
    expect(readActiveGeneration(s, NS)).toBe(3 - 1);
  });
});

describe("cleaning up an old generation", () => {
  it("names only gameplay keys, never settings or the pointer", () => {
    const s = mockStorage();
    saveConfig(s, NS, DEFAULT_CONFIG);
    new SaveSlots(s, NS).put("1", fakeSave("t_1a"));
    new PersistentProgress(s, NS, GAME, POLICY).record([[1039, 1]]);
    advanceGeneration(s, NS);

    const keys = keysOfGeneration(s, NS, 0);
    expect(keys.sort()).toEqual(["e17vn:progress", "e17vn:save:1", "e17vn:slots"]);
    expect(keys).not.toContain("e17vn:config");
    expect(keys).not.toContain(activePlayDataKey(NS));
  });

  it("discards an old generation without touching the live one", () => {
    const s = mockStorage();
    saveConfig(s, NS, { ...DEFAULT_CONFIG, autoSpeed: "fast" });
    new SaveSlots(s, NS).put("1", fakeSave("t_1a"));
    const next = advanceGeneration(s, NS);
    new SaveSlots(s, next.storagePrefix).put("2", fakeSave("sy4a"));

    const removed = discardGeneration(s, NS, 0);
    expect(removed).toBeGreaterThan(0);
    expect(s.getItem("e17vn:save:1")).toBeNull();
    expect(new SaveSlots(s, next.storagePrefix).get("2")?.vm.scene).toBe("sy4a");
    expect(loadConfig(s, NS).autoSpeed).toBe("fast");
  });

  it("scopes a later generation's keys by its own prefix", () => {
    const s = mockStorage();
    advanceGeneration(s, NS);
    const scope = readActiveScope(s, NS);
    new SaveSlots(s, scope.storagePrefix).put("1", fakeSave("t_1a"));
    expect(keysOfGeneration(s, NS, 1)).toContain("e17vn:play:1:save:1");
    expect(keysOfGeneration(s, NS, 1)).not.toContain("e17vn:config");
  });
});
