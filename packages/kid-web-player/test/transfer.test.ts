import { describe, expect, it } from "vitest";
import {
  PLAYER_DATA_FORMAT,
  PLAYER_DATA_LIMITS,
  playerDataSizeProblem,
  migrateSave,
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
    vm: { scene, block: "00000010", pc: 0, steps: 1, presentation: { background: null, cg: null, sprites: [], bgm: null, fill: 0 }, actions: [] },
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

  it("embeds no converted assets - it references them by name", () => {
    const s = mockStorage();
    new SaveSlots(s, NS).put("1", fakeSave("t_1a", 100));
    const text = JSON.stringify(buildPlayerDataExport(ctx(s), null));
    // Note the narrow claim. An export is NOT free of game content: a save
    // carries its backlog, so the file holds recently read story text, and
    // slot metadata may carry a thumbnail. What it must never do is embed a
    // converted image, audio or movie file.
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
    ["a save with a bad position", (d) => ((d.slots[0]!.save.vm as { pc: unknown }).pc = "x"), /position is not a whole number/],
    ["variables that are not numbers", (d) => ((d.slots[0]!.save as { vars: unknown }).vars = [["a", 1]]), /variables are malformed/],
    ["a route that is not names", (d) => ((d.slots[0]!.save as { route: unknown }).route = [{}]), /route names something that is not a scene/],
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

describe("structural validation of a SessionSave", () => {
  /**
   * Anything accepted here is written to storage and later handed to
   * GameSession.restore, so the bar is "the runtime can actually load this",
   * not "it looks roughly like a save". Each case damages one field of an
   * otherwise valid document.
   */
  const doc = (mutate: (save: Record<string, unknown>) => void) => {
    const save = JSON.parse(JSON.stringify(fakeSave("op00", 3))) as Record<string, unknown>;
    // a realistic presentation state, so the sprite cases have something to break
    (save["vm"] as Record<string, unknown>)["presentation"] = {
      background: { asset: "bg01", file: "images/bg01.png", width: 800, height: 600, x: 0, slot: null },
      cg: null,
      sprites: [[1, { asset: "ch01", file: "images/ch01.png", width: 200, height: 400, x: 10, slot: 1 }]],
      bgm: "bgm01",
      fill: null,
    };
    mutate(save);
    return {
      format: PLAYER_DATA_FORMAT,
      version: 1,
      gameId: GAME,
      exportedAt: new Date(0).toISOString(),
      slots: [{ slot: "1", meta: { slot: "1", label: "序章", savedAt: 1, scene: "op00", lines: 3 }, save }],
    };
  };
  const vm = (s: Record<string, unknown>) => s["vm"] as Record<string, unknown>;
  const pres = (s: Record<string, unknown>) => vm(s)["presentation"] as Record<string, unknown>;

  it("accepts a save carrying a full presentation state", () => {
    expect(validatePlayerData(doc(() => {}), GAME)).toBeNull();
  });

  const cases: [string, (s: Record<string, unknown>) => void, RegExp][] = [
    // presentation
    ["sprites missing entirely", (s) => delete pres(s)["sprites"], /no sprite list/],
    ["sprites that are not a list", (s) => (pres(s)["sprites"] = {}), /no sprite list/],
    ["a sprite that is a bare layer, not a pair", (s) => (pres(s)["sprites"] = [{ asset: "ch01" }]), /not a \[slot, layer\] pair/],
    ["a sprite pair of the wrong length", (s) => (pres(s)["sprites"] = [[1]]), /not a \[slot, layer\] pair/],
    ["a sprite slot that is not a number", (s) => (pres(s)["sprites"] = [["front", { asset: "a", file: null, width: null, height: null, x: null, slot: null }]]), /has no slot/],
    ["a sprite layer missing its asset", (s) => (pres(s)["sprites"] = [[1, { file: null, width: null, height: null, x: null, slot: null }]]), /layer is malformed/],
    ["a sprite layer with a non-numeric width", (s) => (pres(s)["sprites"] = [[1, { asset: "a", file: null, width: "wide", height: null, x: null, slot: null }]]), /layer is malformed/],
    ["too many sprites", (s) => (pres(s)["sprites"] = Array.from({ length: 100 }, () => [1, { asset: "a", file: null, width: null, height: null, x: null, slot: null }])), /too many sprites/],
    ["a background of the wrong shape", (s) => (pres(s)["background"] = { asset: 5 }), /background is malformed/],
    ["a background that is absent rather than null", (s) => delete pres(s)["background"], /background is malformed/],
    ["bgm that is not a string", (s) => (pres(s)["bgm"] = 7), /music track is malformed/],
    ["a fill that is not finite", (s) => (pres(s)["fill"] = Number.NaN), /screen fill is malformed/],
    ["presentation missing entirely", (s) => delete vm(s)["presentation"], /no presentation state/],
    // position
    ["a negative position", (s) => (vm(s)["pc"] = -1), /position is not a whole number/],
    ["a fractional position", (s) => (vm(s)["pc"] = 1.5), /position is not a whole number/],
    ["a negative step count", (s) => (vm(s)["steps"] = -3), /step count is not a whole number/],
    ["a missing step count", (s) => delete vm(s)["steps"], /step count is not a whole number/],
    ["a missing block", (s) => delete vm(s)["block"], /names no block/],
    ["an empty block", (s) => (vm(s)["block"] = ""), /names no block/],
    // actions
    ["actions that are not a list", (s) => (vm(s)["actions"] = "none"), /presentation actions are malformed/],
    ["an action that is not an object", (s) => (vm(s)["actions"] = ["setBackground"]), /an action is not an object/],
    ["an action with an unknown kind", (s) => (vm(s)["actions"] = [{ kind: "selfDestruct" }]), /unknown action kind "selfDestruct"/],
    ["an action missing its layer", (s) => (vm(s)["actions"] = [{ kind: "showSprite", mode: 1 }]), /showSprite: its layer is malformed/],
    ["an action whose layer is malformed", (s) => (vm(s)["actions"] = [{ kind: "setBackground", layer: { asset: 1 }, fade: null }]), /setBackground: its layer is malformed/],
    ["a spriteOrder that is not a list", (s) => (vm(s)["actions"] = [{ kind: "spriteOrder", order: 3 }]), /spriteOrder: order must be a list/],
    ["too many actions", (s) => (vm(s)["actions"] = Array.from({ length: 600 }, () => ({ kind: "transitionSync" }))), /too many presentation actions/],
    // counters
    ["counters missing entirely", (s) => delete s["counters"], /no counters/],
    ["a line count that is not a number", (s) => (s["counters"] = { lines: "many", scenes: 1 }), /line count is malformed/],
    ["a negative line count", (s) => (s["counters"] = { lines: -1, scenes: 1 }), /line count is malformed/],
    ["a fractional scene count", (s) => (s["counters"] = { lines: 1, scenes: 2.5 }), /scene count is malformed/],
    ["a missing scene count", (s) => (s["counters"] = { lines: 1 }), /scene count is malformed/],
    // vars
    ["a variable id that is not an integer", (s) => (s["vars"] = [[1.5, 1]]), /variables are malformed/],
    ["a variable value that is not finite", (s) => (s["vars"] = [[1039, Number.POSITIVE_INFINITY]]), /variables are malformed/],
    ["system variables that are not pairs", (s) => (s["sysVars"] = [[1]]), /system variables are malformed/],
    // route
    ["a route that is not a list", (s) => (s["route"] = "op00"), /route is malformed/],
    ["a route holding an empty name", (s) => (s["route"] = ["op00", ""]), /route names something that is not a scene/],
    ["an oversized route", (s) => (s["route"] = Array.from({ length: 6000 }, () => "op00")), /route is too long/],
    // backlog
    ["a backlog entry naming no scene", (s) => (s["backlog"] = [{ text: "hello" }]), /backlog entry names no scene/],
    ["a backlog entry with no text", (s) => (s["backlog"] = [{ scene: "op00" }]), /text is malformed or too long/],
    ["a backlog entry with oversized text", (s) => (s["backlog"] = [{ scene: "op00", text: "x".repeat(5000) }]), /text is malformed or too long/],
    ["a backlog speaker that is not a string", (s) => (s["backlog"] = [{ scene: "op00", text: "hi", speaker: 5 }]), /speaker is malformed/],
    ["a backlog voice file that is not a string", (s) => (s["backlog"] = [{ scene: "op00", text: "hi", voiceFile: {} }]), /voice file is malformed/],
  ];

  for (const [what, damage, expected] of cases) {
    it(`rejects ${what}`, () => {
      expect(validatePlayerData(doc(damage), GAME)).toMatch(expected);
    });
  }

  it("writes zero keys for every one of these", () => {
    for (const [, damage] of cases) {
      const s = mockStorage();
      const outcome = applyPlayerDataImport(ctx(s), doc(damage));
      expect(outcome.ok).toBe(false);
      expect(s.map.size, "a rejected save must not touch storage").toBe(0);
    }
  });

  it("accepts null where null is legal, and absent where absent is legal", () => {
    // the permissive half of the contract: a real save from a scene with no
    // background, music or voice must still load
    expect(
      validatePlayerData(
        doc((s) => {
          pres(s)["background"] = null;
          pres(s)["bgm"] = null;
          pres(s)["fill"] = null;
          pres(s)["sprites"] = [];
          delete vm(s)["actions"]; // optional in the contract
          s["backlog"] = [{ scene: "op00", text: "hi", speaker: null, voice: null, voiceFile: null }];
        }),
        GAME,
      ),
    ).toBeNull();
  });
});

describe("file size limit", () => {
  it("accepts an ordinary file and names the problem for a huge one", () => {
    expect(playerDataSizeProblem(0)).toBeNull();
    expect(playerDataSizeProblem(1024)).toBeNull();
    expect(playerDataSizeProblem(PLAYER_DATA_LIMITS.maxFileBytes)).toBeNull();
    expect(playerDataSizeProblem(PLAYER_DATA_LIMITS.maxFileBytes + 1)).toMatch(/at most 32 MB/);
    expect(playerDataSizeProblem(200 * 1024 * 1024)).toMatch(/200\.0 MB/);
  });

  it("refuses a size it cannot trust", () => {
    expect(playerDataSizeProblem(Number.NaN)).toMatch(/could not be determined/);
    expect(playerDataSizeProblem(-1)).toMatch(/could not be determined/);
  });
});

describe("every PresentationAction kind", () => {
  /**
   * One valid and several invalid fixtures per variant. The validator is an
   * exhaustive switch with a `never` default, so a new action kind is a
   * compile error there; this table is what proves each existing kind is
   * actually checked rather than merely named.
   */
  const LAYER = { asset: "bg01", file: "images/bg01.png", width: 800, height: 600, x: 0, slot: null };

  const withActions = (actions: unknown[]) => {
    const save = JSON.parse(JSON.stringify(fakeSave("op00", 3))) as Record<string, unknown>;
    (save["vm"] as Record<string, unknown>)["actions"] = actions;
    return {
      format: PLAYER_DATA_FORMAT,
      version: 1,
      gameId: GAME,
      exportedAt: new Date(0).toISOString(),
      slots: [{ slot: "1", meta: { slot: "1", label: "x", savedAt: 1, scene: "op00", lines: 3 }, save }],
    };
  };

  const VALID: Record<string, unknown> = {
    setBackground: { kind: "setBackground", layer: LAYER, fade: 12 },
    fillScreen: { kind: "fillScreen", color: 0, fade: null },
    showSprite: { kind: "showSprite", layer: LAYER, mode: null },
    hideSprite: { kind: "hideSprite", slot: 2, mode: null },
    spriteOrder: { kind: "spriteOrder", order: [1, null, 3] },
    transitionTime: { kind: "transitionTime", frames: 30, mode: null },
    transitionSync: { kind: "transitionSync" },
    wait: { kind: "wait", amount: 5, unit: "vm" },
    effectOn: { kind: "effectOn", effect: 7 },
    effectOff: { kind: "effectOff", category: null },
    shake: { kind: "shake", mode: 1, amplitude: null },
    viewportRect: { kind: "viewportRect", x: 0, y: 0, w: 800, h: 600, frames: null },
    cgEffect: { kind: "cgEffect", asset: "cg01", file: null, args: [1, null] },
  };

  it("accepts a save carrying one of every action kind", () => {
    expect(validatePlayerData(withActions(Object.values(VALID)), GAME)).toBeNull();
  });

  for (const [kind, action] of Object.entries(VALID)) {
    it(`accepts a well-formed ${kind}`, () => {
      expect(validatePlayerData(withActions([action]), GAME)).toBeNull();
    });
  }

  it("accepts setBackground with its optional variant, and rejects a non-string one", () => {
    expect(validatePlayerData(withActions([{ ...VALID.setBackground as object, variant: "b" }]), GAME)).toBeNull();
    expect(validatePlayerData(withActions([{ ...VALID.setBackground as object, variant: 5 }]), GAME))
      .toMatch(/setBackground: variant must be a string/);
  });

  it("ignores an unknown extra field rather than rejecting a readable file", () => {
    // a file written by a newer build may carry more than this one reads
    expect(validatePlayerData(withActions([{ ...VALID.transitionSync as object, futureField: 1 }]), GAME)).toBeNull();
  });

  const INVALID: [string, unknown, RegExp][] = [
    // required number|null fields: absent, wrong type, and non-finite
    ["setBackground missing fade", { kind: "setBackground", layer: LAYER }, /setBackground: fade must be a number or null/],
    ["setBackground with a string fade", { kind: "setBackground", layer: LAYER, fade: "fast" }, /setBackground: fade/],
    ["setBackground with a NaN fade", { kind: "setBackground", layer: LAYER, fade: Number.NaN }, /setBackground: fade/],
    ["setBackground missing its layer", { kind: "setBackground", fade: null }, /setBackground: its layer is malformed/],
    ["fillScreen missing color", { kind: "fillScreen", fade: null }, /fillScreen: color/],
    ["fillScreen missing fade", { kind: "fillScreen", color: null }, /fillScreen: fade/],
    ["showSprite missing mode", { kind: "showSprite", layer: LAYER }, /showSprite: mode/],
    ["showSprite with a broken layer", { kind: "showSprite", layer: { asset: 1 }, mode: null }, /showSprite: its layer/],
    ["hideSprite missing slot", { kind: "hideSprite", mode: null }, /hideSprite: slot/],
    ["hideSprite missing mode", { kind: "hideSprite", slot: 1 }, /hideSprite: mode/],
    ["spriteOrder missing order", { kind: "spriteOrder" }, /spriteOrder: order must be a list/],
    ["spriteOrder holding a string", { kind: "spriteOrder", order: ["front"] }, /spriteOrder: order holds a non-number/],
    ["spriteOrder that is too long", { kind: "spriteOrder", order: new Array(100).fill(1) }, /spriteOrder: order is too long/],
    ["transitionTime missing frames", { kind: "transitionTime", mode: null }, /transitionTime: frames/],
    ["transitionTime missing mode", { kind: "transitionTime", frames: 1 }, /transitionTime: mode/],
    ["wait missing amount", { kind: "wait", unit: "vm" }, /wait: amount/],
    ["wait missing unit", { kind: "wait", amount: 1 }, /wait: unit must be "vm" or "frames"/],
    ["wait with an invented unit", { kind: "wait", amount: 1, unit: "seconds" }, /wait: unit must be "vm" or "frames"/],
    ["wait with a null unit", { kind: "wait", amount: 1, unit: null }, /wait: unit must be "vm" or "frames"/],
    ["effectOn missing effect", { kind: "effectOn" }, /effectOn: effect/],
    ["effectOff missing category", { kind: "effectOff" }, /effectOff: category/],
    ["shake missing mode", { kind: "shake", amplitude: 1 }, /shake: mode/],
    ["shake missing amplitude", { kind: "shake", mode: 1 }, /shake: amplitude/],
    ["viewportRect missing h", { kind: "viewportRect", x: 0, y: 0, w: 1, frames: null }, /viewportRect: h/],
    ["viewportRect with an infinite x", { kind: "viewportRect", x: Infinity, y: 0, w: 1, h: 1, frames: null }, /viewportRect: x/],
    ["cgEffect with a numeric asset", { kind: "cgEffect", asset: 5, file: null, args: [] }, /cgEffect: asset must be a string or null/],
    ["cgEffect with a numeric file", { kind: "cgEffect", asset: null, file: 5, args: [] }, /cgEffect: file must be a string or null/],
    ["cgEffect missing args", { kind: "cgEffect", asset: null, file: null }, /cgEffect: args must be a list/],
    ["cgEffect with a string arg", { kind: "cgEffect", asset: null, file: null, args: ["x"] }, /cgEffect: args holds a non-number/],
    ["an action with no kind at all", { layer: LAYER }, /an action has no kind/],
    ["an action whose kind is a number", { kind: 7 }, /an action has no kind/],
  ];

  for (const [what, action, expected] of INVALID) {
    it(`rejects ${what}`, () => {
      expect(validatePlayerData(withActions([action]), GAME)).toMatch(expected);
    });
  }

  it("writes zero keys for every malformed action", () => {
    for (const [, action] of INVALID) {
      const s = mockStorage();
      const outcome = applyPlayerDataImport(ctx(s), withActions([action]));
      expect(outcome.ok).toBe(false);
      expect(s.map.size, "a rejected action must not touch storage").toBe(0);
    }
  });

  it("rejects the whole document when one action among many is bad", () => {
    const actions = [VALID.transitionSync, VALID.fillScreen, { kind: "wait", amount: 1, unit: "furlongs" }];
    const s = mockStorage();
    expect(validatePlayerData(withActions(actions), GAME)).toMatch(/wait: unit/);
    expect(applyPlayerDataImport(ctx(s), withActions(actions)).ok).toBe(false);
    expect(s.map.size).toBe(0);
  });
});

describe("save versions across import and export", () => {
  /**
   * A v1 save is structurally importable - refusing it here would throw away
   * data the player may still want to keep or move to another browser. What
   * it *cannot* do is be displayed without the picture state, and that is
   * decided at load time by migrateSave, not here.
   */
  const v1Save = (scene: string) => {
    const s = JSON.parse(JSON.stringify(fakeSave(scene, 3))) as Record<string, unknown>;
    s["version"] = 1;
    delete (s["vm"] as Record<string, Record<string, unknown>>)["presentation"]["cg"];
    return s;
  };

  const docOf = (save: unknown) => ({
    format: PLAYER_DATA_FORMAT,
    version: 1,
    gameId: GAME,
    exportedAt: new Date(0).toISOString(),
    slots: [{ slot: "1", meta: { slot: "1", label: "x", savedAt: 1, scene: "op00", lines: 3 }, save }],
  });

  it("accepts a v1 document so the player does not lose it", () => {
    expect(validatePlayerData(docOf(v1Save("op00")), GAME)).toBeNull();
  });

  it("accepts a current v2 document", () => {
    expect(validatePlayerData(docOf(fakeSave("op00", 3)), GAME)).toBeNull();
  });

  it("requires v2 to be explicit about its CG state", () => {
    const s = JSON.parse(JSON.stringify(fakeSave("op00", 3))) as Record<string, unknown>;
    delete (s["vm"] as Record<string, Record<string, unknown>>)["presentation"]["cg"];
    expect(validatePlayerData(docOf(s), GAME)).toMatch(/missing its CG state/);
  });

  it("rejects a malformed CG at either version", () => {
    for (const version of [1, 2]) {
      const s = JSON.parse(JSON.stringify(fakeSave("op00", 3))) as Record<string, unknown>;
      s["version"] = version;
      (s["vm"] as Record<string, Record<string, unknown>>)["presentation"]["cg"] = { file: "x.png" };
      expect(validatePlayerData(docOf(s), GAME), `v${version}`).toMatch(/CG layer is malformed/);
    }
  });

  it("still refuses a version it has never heard of", () => {
    const s = JSON.parse(JSON.stringify(fakeSave("op00", 3))) as Record<string, unknown>;
    s["version"] = 7;
    expect(validatePlayerData(docOf(s), GAME)).toMatch(/unsupported save version 7/);
  });

  it("imports a v1 save verbatim, leaving migration to load time", () => {
    const s = mockStorage();
    const outcome = applyPlayerDataImport(ctx(s), docOf(v1Save("op00")));
    expect(outcome.ok).toBe(true);
    const stored = (JSON.parse(s.map.get(`${NS}:save:1`)!) as { save: Record<string, unknown> }).save;
    expect(stored["version"], "stored as written, not silently upgraded").toBe(1);
    expect((stored["vm"] as Record<string, Record<string, unknown>>)["presentation"]).not.toHaveProperty("cg");
  });

  it("exports an incompatible save rather than dropping it", () => {
    // an old save the current build cannot display is still the player's
    const s = mockStorage();
    new SaveSlots(s, NS).put("1", v1Save("op00") as never);
    const doc = buildPlayerDataExport(ctx(s), null);
    expect(doc.slots.map((x) => x.slot)).toEqual(["1"]);
    expect((doc.slots[0]!.save as unknown as Record<string, unknown>)["version"]).toBe(1);
    expect(validatePlayerData(doc, GAME), "and it round-trips").toBeNull();
  });

  it("writes a current save with explicit CG state", () => {
    const s = mockStorage();
    new SaveSlots(s, NS).put("1", fakeSave("op00", 3));
    const stored = (JSON.parse(s.map.get(`${NS}:save:1`)!) as { save: Record<string, unknown> }).save;
    const presentation = (stored["vm"] as Record<string, Record<string, unknown>>)["presentation"];
    expect(stored["version"]).toBe(SAVE_VERSION);
    expect("cg" in presentation, "a save this build writes always says").toBe(true);
  });
});

describe("migration at load time", () => {
  const v1 = (presentation: Record<string, unknown>, actions?: unknown[]) => {
    const s = JSON.parse(JSON.stringify(fakeSave("op00", 3))) as Record<string, unknown>;
    s["version"] = 1;
    const vm = s["vm"] as Record<string, unknown>;
    vm["presentation"] = { background: null, sprites: [], bgm: null, fill: null, ...presentation };
    if (actions) vm["actions"] = actions;
    else delete vm["actions"];
    return s;
  };

  it("recovers a save whose deltas prove the CG", () => {
    const bg = { asset: "bg01", file: "images/bg01.png", width: null, height: null, x: null, slot: null };
    const r = migrateSave(v1({ background: bg }, [{ kind: "setBackground", layer: bg, fade: null }]));
    expect(r).toMatchObject({ ok: true, migrated: true });
    expect(r.ok && r.save.vm.presentation.cg).toBeNull();
  });

  it("refuses a background whose deltas say nothing - a CG may still cover it", () => {
    const bg = { asset: "bg01", file: "images/bg01.png", width: null, height: null, x: null, slot: null };
    expect(migrateSave(v1({ background: bg }))).toMatchObject({ ok: false, reason: "legacy-picture-incomplete" });
  });

  it("refuses a bare fill it cannot explain, and touches no storage", () => {
    const s = mockStorage();
    const save = v1({ fill: 1 });
    new SaveSlots(s, NS).put("1", save as never);
    const sizeBefore = s.map.size;
    const before = s.map.get(`${NS}:save:1`);

    const r = migrateSave(save);
    expect(r).toMatchObject({ ok: false, reason: "legacy-picture-incomplete" });
    expect(s.map.size, "refusing writes nothing").toBe(sizeBefore);
    expect(s.map.get(`${NS}:save:1`), "and changes nothing").toBe(before);
  });

  it("leaves another slot loadable", () => {
    const s = mockStorage();
    const slots = new SaveSlots(s, NS);
    slots.put("1", v1({ fill: 1 }) as never);
    slots.put("2", fakeSave("t_1a", 9));
    expect(migrateSave(slots.get("1")).ok).toBe(false);
    expect(migrateSave(slots.get("2")).ok, "a good slot is unaffected").toBe(true);
  });
});
