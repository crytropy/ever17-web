import { describe, expect, it } from "vitest";
import {
  PLAYER_DATA_FORMAT,
  SAVE_FORMAT,
  SAVE_VERSION,
  summarizePlayerData,
  validatePlayerData,
  type PersistentStatePolicy,
  type SessionSave,
} from "kid-contracts";
import { applyPlayerDataImport, buildPlayerDataExport, mergeCompletion } from "../src/transfer.js";
import { SaveSlots } from "../src/slots.js";
import { PersistentProgress } from "../src/progress.js";
import { DEFAULT_CONFIG, saveConfig, loadConfig, type StorageLike } from "../src/config.js";
import type { CompletionState } from "../src/completion.js";

/**
 * Browser storage is easy to lose, so a player must be able to take their
 * saves elsewhere and bring them back. Importing is additive on purpose:
 * these tests pin that restoring an old backup cannot take away a slot or an
 * unlock the player already has.
 */

const NS = "e17vn";
const GAME = "ever17";
const POLICY: PersistentStatePolicy = { policyVersion: 1, vars: [1039, 1040, 1050], merge: "max", derivedFrom: "test" };

function mockStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

const ctx = (storage: StorageLike, policy: PersistentStatePolicy | null = POLICY) => ({
  storage,
  // generation 0: its prefix is the namespace itself
  storagePrefix: NS,
  settingsNamespace: NS,
  gameId: GAME,
  policy,
  engineVersion: "0.7.0",
});

function fakeSave(scene: string, lines: number, vars: [number, number][] = []): SessionSave {
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    vm: { scene, block: "00000010", pc: 0, steps: 1, presentation: { background: null, sprites: [], bgm: null, fill: 0 }, actions: [] },
    vars,
    sysVars: [],
    counters: { lines, scenes: 1 },
    route: [scene],
    backlog: [],
  };
}

const completion = (scenes: string[], endings: string[] = []): CompletionState => ({
  version: 1,
  visitedScenes: scenes,
  visitedChoices: [],
  endings,
  discoveredAssets: [],
});

describe("export", () => {
  it("collects saves, settings, progress and completion", () => {
    const s = mockStorage();
    new SaveSlots(s, NS).put("1", fakeSave("t_1a", 100));
    new SaveSlots(s, NS).put("quick", fakeSave("tt6a", 900));
    saveConfig(s, NS, { ...DEFAULT_CONFIG, autoSpeed: "fast" });
    new PersistentProgress(s, NS, GAME, POLICY).record([[1039, 1]]);

    const doc = buildPlayerDataExport(ctx(s), completion(["op00", "t_1a"], ["END_TU00"]));
    expect(doc.format).toBe(PLAYER_DATA_FORMAT);
    expect(doc.gameId).toBe(GAME);
    expect(doc.slots.map((x) => x.slot).sort()).toEqual(["1", "quick"]);
    expect(summarizePlayerData(doc)).toMatchObject({ slots: 2, hasConfig: true, hasProgress: true, hasCompletion: true });
  });

  it("exports cleanly from an empty profile", () => {
    const doc = buildPlayerDataExport(ctx(mockStorage()), null);
    expect(doc.slots).toEqual([]);
    expect(validatePlayerData(doc, GAME)).toBeNull();
  });

  it("carries no game content, only the player's own data", () => {
    const s = mockStorage();
    new SaveSlots(s, NS).put("1", fakeSave("t_1a", 100));
    const text = JSON.stringify(buildPlayerDataExport(ctx(s), null));
    // a save references scenes by name; it must not embed story text or assets
    expect(text).not.toMatch(/\.png|\.wav|\.mp4/);
  });
});

describe("validation", () => {
  it("rejects files that are not ours, are the wrong version, or are for another game", () => {
    expect(validatePlayerData(null, GAME)).toMatch(/not a player-data file/);
    expect(validatePlayerData({ format: "other" }, GAME)).toMatch(/not a player-data file/);
    expect(validatePlayerData({ format: PLAYER_DATA_FORMAT, version: 99 }, GAME)).toMatch(/unsupported/);
    expect(validatePlayerData({ format: PLAYER_DATA_FORMAT, version: 1, gameId: "never7" }, GAME)).toMatch(/is for "never7"/);
  });

  it("rejects a malformed slot instead of importing half of it", () => {
    const doc = { format: PLAYER_DATA_FORMAT, version: 1, gameId: GAME, exportedAt: "", slots: [{ slot: "1" }] };
    expect(validatePlayerData(doc, GAME)).toMatch(/malformed/);
    const s = mockStorage();
    expect(applyPlayerDataImport(ctx(s), doc).ok).toBe(false);
    expect(s.map.size).toBe(0); // nothing was written
  });
});

describe("import", () => {
  it("round-trips saves, settings and progress", () => {
    const source = mockStorage();
    new SaveSlots(source, NS).put("1", fakeSave("t_1a", 100));
    saveConfig(source, NS, { ...DEFAULT_CONFIG, autoSpeed: "slow", bgmVolume: 0.25 });
    new PersistentProgress(source, NS, GAME, POLICY).record([[1039, 1], [1050, 1]]);
    const doc = buildPlayerDataExport(ctx(source), completion(["op00"], ["END_TU00"]));

    const target = mockStorage();
    const outcome = applyPlayerDataImport(ctx(target), doc);
    expect(outcome).toMatchObject({ ok: true, slotsRestored: 1, configRestored: true, progressMerged: true });
    expect(new SaveSlots(target, NS).get("1")?.vm.scene).toBe("t_1a");
    expect(loadConfig(target, NS).autoSpeed).toBe("slow");
    expect(new PersistentProgress(target, NS, GAME, POLICY).seed()).toEqual([[1039, 1], [1050, 1]]);
    expect(outcome.completion?.endings).toEqual(["END_TU00"]);
  });

  it("keeps slots the file does not mention", () => {
    const s = mockStorage();
    new SaveSlots(s, NS).put("2", fakeSave("sy4a", 500));
    const doc = buildPlayerDataExport(ctx(mockStorage()), null);
    doc.slots = [{ slot: "1", meta: { slot: "1", label: "x", savedAt: 1, scene: "t_1a", lines: 1 }, save: fakeSave("t_1a", 1) }];

    applyPlayerDataImport(ctx(s), doc);
    expect(new SaveSlots(s, NS).get("1")?.vm.scene).toBe("t_1a");
    expect(new SaveSlots(s, NS).get("2")?.vm.scene).toBe("sy4a");
  });

  it("an older backup cannot revoke an unlock the player already has", () => {
    const s = mockStorage();
    new PersistentProgress(s, NS, GAME, POLICY).record([[1039, 1], [1040, 1], [1050, 1]]);
    // a backup taken before any of that
    const stale = buildPlayerDataExport(ctx(mockStorage()), null);

    applyPlayerDataImport(ctx(s), stale);
    expect(new PersistentProgress(s, NS, GAME, POLICY).seed()).toEqual([
      [1039, 1],
      [1040, 1],
      [1050, 1],
    ]);
  });

  it("ignores unknown slot names", () => {
    const s = mockStorage();
    const doc = buildPlayerDataExport(ctx(mockStorage()), null);
    doc.slots = [{ slot: "99", meta: { slot: "99", label: "x", savedAt: 1, scene: "t_1a", lines: 1 }, save: fakeSave("t_1a", 1) }];
    expect(applyPlayerDataImport(ctx(s), doc).slotsRestored).toBe(0);
  });

  it("works for a game with no cross-run progress", () => {
    const s = mockStorage();
    const doc = buildPlayerDataExport(ctx(mockStorage(), null), null);
    expect(doc.progress).toBeUndefined();
    expect(applyPlayerDataImport(ctx(s, null), doc)).toMatchObject({ ok: true, progressMerged: false });
  });
});

describe("completion merging", () => {
  it("is a union - discovering something is never undone", () => {
    const merged = mergeCompletion(completion(["op00", "t_1a"], ["END_TU00"]), completion(["t_1a", "sy4a"], ["END_SA00"]));
    expect(merged.visitedScenes).toEqual(["op00", "sy4a", "t_1a"]);
    expect(merged.endings).toEqual(["END_SA00", "END_TU00"]);
  });

  it("handles an empty local state", () => {
    expect(mergeCompletion(null, completion(["op00"])).visitedScenes).toEqual(["op00"]);
  });
});
