import { describe, expect, it } from "vitest";
import {
  CompletionTracker,
  MemoryCompletionStore,
  dialogueLineId,
  type CompletionState,
} from "../src/completion.js";

describe("dialogue read tracking", () => {
  it("builds a stable line id from scene, block and IR text coordinates", () => {
    expect(dialogueLineId("S_1A", "00AB", 37, 2)).toBe("s_1a:00ab:37:2");
    expect(dialogueLineId("S_1A", "00AC", 37, 2)).not.toBe(
      dialogueLineId("S_1A", "00AB", 37, 2),
    );
  });

  it("opens legacy v1 completion data with no visitedLines without losing anything", async () => {
    const store = new MemoryCompletionStore();
    const legacy: CompletionState = {
      version: 1,
      visitedScenes: ["op00", "s_1a"],
      visitedChoices: ["s_1a:7:0"],
      endings: ["END_TEST"],
      discoveredAssets: ["bg01a1"],
    };
    await store.save(legacy);

    const tracker = await CompletionTracker.open(store);

    expect([...tracker.scenes].sort()).toEqual(["op00", "s_1a"]);
    expect([...tracker.choices]).toEqual(["s_1a:7:0"]);
    expect([...tracker.endings]).toEqual(["END_TEST"]);
    expect([...tracker.assets]).toEqual(["bg01a1"]);
    expect([...tracker.lines]).toEqual([]);
    expect(tracker.snapshot().visitedLines).toEqual([]);
  });
});
