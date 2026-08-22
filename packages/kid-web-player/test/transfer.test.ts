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
    expect(validatePlayerData(doc, GAME)).toMatch(/slot "1": the save is not an object/);
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

describe("deep validation of an imported file", () => {
  /** A minimal valid document to damage in one place at a time. */
  const good = () => ({
    format: PLAYER_DATA_FORMAT,
    version: 1,
    gameId: GAME,
    exportedAt: new Date(0).toISOString(),
    slots: [
      {
        slot: "1",
        meta: { slot: "1", label: "序章", savedAt: 1, scene: "op00", lines: 3 },
        save: fakeSave("op00", 3),
      },
    ],
    config: { version: 2 },
    progress: {
      format: "kid-persistent-state",
      version: 1,
      gameId: GAME,
      vars: [[1039, 1]],
      updatedAt: new Date(0).toISOString(),
    },
    completion: { version: 1, visitedScenes: ["op00"], visitedChoices: [], endings: [], discoveredAssets: [] },
  });

  it("accepts a well-formed document", () => {
    expect(validatePlayerData(good(), GAME)).toBeNull();
  });

  const damaged: [string, (d: ReturnType<typeof good>) => void, RegExp][] = [
    ["a save with a foreign format", (d) => ((d.slots[0]!.save as { format: string }).format = "other"), /unexpected save format/],
    ["a save from a future version", (d) => ((d.slots[0]!.save as { version: number }).version = 99), /unsupported save version/],
    ["a save with no VM state", (d) => delete (d.slots[0]!.save as { vm?: unknown }).vm, /no VM state/],
    ["a save naming no scene", (d) => ((d.slots[0]!.save.vm as { scene: unknown }).scene = 42), /names no scene/],
    ["a save with a bad position", (d) => ((d.slots[0]!.save.vm as { pc: unknown }).pc = "x"), /no position/],
    ["variables that are not numbers", (d) => ((d.slots[0]!.save as { vars: unknown }).vars = [["a", 1]]), /variables are malformed/],
    ["a route that is not names", (d) => ((d.slots[0]!.save as { route: unknown }).route = [{}]), /route is malformed/],
    ["a backlog that is not a list", (d) => ((d.slots[0]!.save as { backlog: unknown }).backlog = "no"), /backlog is malformed/],
    ["an unnamed slot", (d) => ((d.slots[0] as { slot: unknown }).slot = 7), /no usable name/],
    ["a duplicated slot", (d) => d.slots.push({ ...d.slots[0]! }), /twice/],
    ["metadata that is not an object", (d) => ((d.slots[0] as { meta: unknown }).meta = "x"), /metadata is malformed/],
    ["a timestamp that is not a number", (d) => ((d.slots[0]!.meta as { savedAt: unknown }).savedAt = "yesterday"), /timestamp is malformed/],
    ["an oversized thumbnail", (d) => ((d.slots[0]!.meta as { thumb?: string }).thumb = "x".repeat(3_000_000)), /thumbnail is malformed or too large/],
    ["settings that are not an object", (d) => ((d as { config: unknown }).config = "loud"), /settings block is not an object/],
    ["progress for another game", (d) => ((d.progress as { gameId: string }).gameId = "never7"), /progress is for "never7"/],
    ["progress from a future version", (d) => ((d.progress as { version: number }).version = 9), /unsupported progress version/],
    ["progress variables that are not pairs", (d) => ((d.progress as { vars: unknown }).vars = [1039]), /progress variables are malformed/],
    ["completion from a future version", (d) => ((d.completion as { version: number }).version = 7), /unsupported completion version/],
    ["completion missing a list", (d) => delete (d.completion as { endings?: unknown }).endings, /missing endings/],
    ["completion holding non-names", (d) => ((d.completion as { endings: unknown }).endings = [{ a: 1 }]), /not a name/],
  ];

  for (const [what, damage, expected] of damaged) {
    it(`rejects ${what}`, () => {
      const doc = good();
      damage(doc);
      expect(validatePlayerData(doc, GAME)).toMatch(expected);
    });
  }

  it("rejects an implausible number of slots", () => {
    const doc = good();
    doc.slots = Array.from({ length: 500 }, (_, i) => ({ ...doc.slots[0]!, slot: `s${i}` }));
    expect(validatePlayerData(doc, GAME)).toMatch(/too many/);
  });

  it("rejects an oversized backlog", () => {
    const doc = good();
    (doc.slots[0]!.save as { backlog: unknown }).backlog = Array.from({ length: 10_000 }, () => ({ text: "x" }));
    expect(validatePlayerData(doc, GAME)).toMatch(/too large/);
  });

  it("writes nothing at all when a file is rejected", () => {
    for (const [, damage] of damaged) {
      const doc = good();
      damage(doc);
      const s = mockStorage();
      const outcome = applyPlayerDataImport(ctx(s), doc);
      expect(outcome.ok).toBe(false);
      expect(s.map.size, "a rejected file must not touch storage").toBe(0);
    }
  });
});
