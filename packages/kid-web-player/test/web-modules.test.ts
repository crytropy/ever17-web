import { describe, expect, it } from "vitest";
import { CONFIG_KEY, DEFAULT_CONFIG, loadConfig, saveConfig, type StorageLike } from "../src/config.js";
import { ALL_SLOTS, SaveSlots } from "../src/slots.js";
import { SAVE_FORMAT, SAVE_VERSION, type SessionSave } from "kid-contracts/save";

function mockStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function fakeSave(scene = "op00", lines = 42): SessionSave {
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    vm: {
      scene,
      block: "00000010",
      pc: 0,
      steps: 1,
      presentation: { background: null, sprites: [], bgm: null, fill: 0 },
      actions: [],
    },
    vars: [[1203, 0]],
    sysVars: [],
    counters: { lines, scenes: 1 },
    route: [scene],
    backlog: [],
  };
}

describe("config", () => {
  it("returns defaults when empty and round-trips values", () => {
    const s = mockStorage();
    expect(loadConfig(s)).toEqual(DEFAULT_CONFIG);
    saveConfig(s, { ...DEFAULT_CONFIG, bgmVolume: 0.25, transitionSpeed: 2 });
    expect(loadConfig(s).bgmVolume).toBe(0.25);
    expect(loadConfig(s).transitionSpeed).toBe(2);
  });

  it("clamps out-of-range and non-numeric values", () => {
    const s = mockStorage();
    s.setItem(
      CONFIG_KEY,
      JSON.stringify({ version: 1, bgmVolume: 9, voiceVolume: -1, autoDelayFactor: "x", transitionSpeed: 100 }),
    );
    const c = loadConfig(s);
    expect(c.bgmVolume).toBe(1);
    expect(c.voiceVolume).toBe(0);
    expect(c.autoDelayFactor).toBe(DEFAULT_CONFIG.autoDelayFactor);
    expect(c.transitionSpeed).toBe(4);
  });

  it("falls back to defaults on unknown versions or corrupt JSON", () => {
    const s = mockStorage();
    s.setItem(CONFIG_KEY, JSON.stringify({ version: 99, bgmVolume: 0.1 }));
    expect(loadConfig(s)).toEqual(DEFAULT_CONFIG);
    s.setItem(CONFIG_KEY, "{corrupt");
    expect(loadConfig(s)).toEqual(DEFAULT_CONFIG);
  });
});

describe("save slots", () => {
  it("stores, lists, loads and removes across the fixed slot set", () => {
    const s = mockStorage();
    const slots = new SaveSlots(s);
    expect(slots.list()).toEqual([]);
    slots.put("1", fakeSave("op00", 10));
    slots.put("quick", fakeSave("t_1a", 99), "data:image/jpeg;base64,AAAA");
    const metas = slots.list();
    expect(metas.map((m) => m.slot)).toEqual(["quick", "1"]); // ALL_SLOTS order
    expect(metas[0]!.thumb).toBe("data:image/jpeg;base64,AAAA");
    expect(metas[1]!.label).toBe("op00 · line 10");
    expect(slots.get("1")?.counters.lines).toBe(10);
    slots.remove("1");
    expect(slots.get("1")).toBeNull();
    expect(slots.list().map((m) => m.slot)).toEqual(["quick"]);
  });

  it("rejects unknown slot names", () => {
    expect(() => new SaveSlots(mockStorage()).put("99", fakeSave())).toThrow(/unknown slot/);
    expect(ALL_SLOTS).toContain("auto");
  });

  it("migrates the phase-4A single slot into slot 1, once", () => {
    const s = mockStorage();
    s.setItem("e17vn:slot0", JSON.stringify({ label: "x", savedAt: 123, save: fakeSave("s_1a", 7) }));
    const slots = new SaveSlots(s);
    expect(s.getItem("e17vn:slot0")).toBeNull();
    const meta = slots.peek("1");
    expect(meta?.scene).toBe("s_1a");
    expect(meta?.savedAt).toBe(123);
    // a second construction must not clobber anything
    slots.put("1", fakeSave("t_2a", 50));
    new SaveSlots(s);
    expect(slots.peek("1")?.scene).toBe("t_2a");
  });

  it("keeps the save when a thumbnail overflows the storage quota", () => {
    const s = mockStorage();
    const limited: StorageLike = {
      getItem: (k) => s.getItem(k),
      removeItem: (k) => s.removeItem(k),
      setItem: (k, v) => {
        if (v.length > 4000) throw new Error("QuotaExceeded");
        s.setItem(k, v);
      },
    };
    const slots = new SaveSlots(limited);
    const meta = slots.put("2", fakeSave(), "X".repeat(5000));
    expect(meta.thumb).toBeUndefined();
    expect(slots.get("2")).not.toBeNull();
  });

  it("ignores corrupt slot payloads", () => {
    const s = mockStorage();
    s.setItem("e17vn:save:3", "{nope");
    const slots = new SaveSlots(s);
    expect(slots.peek("3")).toBeNull();
    expect(slots.get("3")).toBeNull();
  });
});

describe("completion tracking", async () => {
  const { CompletionTracker, MemoryCompletionStore } = await import("../src/completion.js");

  it("records progress and persists it through the store", async () => {
    const store = new MemoryCompletionStore();
    const t = await CompletionTracker.open(store);
    t.scene("OP00");
    t.choice("op00", 7, 1);
    t.ending("end_tu00");
    t.asset("BG_M_I");
    await t.flush();

    const reopened = await CompletionTracker.open(store);
    expect([...reopened.scenes]).toEqual(["op00"]);
    expect([...reopened.choices]).toEqual(["op00:7:1"]);
    expect([...reopened.endings]).toEqual(["END_TU00"]);
    expect([...reopened.assets]).toEqual(["bg_m_i"]);
  });

  it("replaying the same route does not duplicate progress", async () => {
    const store = new MemoryCompletionStore();
    const t = await CompletionTracker.open(store);
    const playRoute = (): void => {
      for (const s of ["op00", "t_1a", "t_1b"]) t.scene(s);
      t.choice("op00", 7, 0);
      t.ending("SYBD");
      t.asset("bg01a");
    };
    playRoute();
    await t.flush();
    const first = t.snapshot();
    playRoute();
    playRoute();
    await t.flush();
    expect(t.snapshot()).toEqual(first);
    expect(t.scenes.size).toBe(3);
    expect(t.choices.size).toBe(1);
  });

  it("progress accumulates across separate sessions (set union)", async () => {
    const store = new MemoryCompletionStore();
    const a = await CompletionTracker.open(store);
    a.scene("op00");
    a.ending("END_TU00");
    await a.flush();
    const b = await CompletionTracker.open(store);
    b.scene("s_1a");
    b.ending("END_SA00");
    await b.flush();
    const c = await CompletionTracker.open(store);
    expect([...c.scenes].sort()).toEqual(["op00", "s_1a"]);
    expect([...c.endings].sort()).toEqual(["END_SA00", "END_TU00"]);
  });

  it("gameplay saves and completion are separate stores", async () => {
    // loading an old save must never rewind completion: the tracker never
    // reads or writes save slots, and SaveSlots never touches completion
    const store = new MemoryCompletionStore();
    const t = await CompletionTracker.open(store);
    t.scene("t_6b");
    t.ending("END_TU00");
    await t.flush();
    const slots = new SaveSlots(mockStorage());
    expect(slots.list()).toEqual([]);
    const after = await store.load();
    expect(after?.visitedScenes).toEqual(["t_6b"]);
    expect(after?.endings).toEqual(["END_TU00"]);
  });
});
