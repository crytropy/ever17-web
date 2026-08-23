import { describe, expect, it } from "vitest";
import { SceneVm } from "../src/vm.js";

/**
 * STAGE 0 REGRESSION 3: a viewport set by viewportRect persists across
 * dialogue events (verified in real scenario data: one rect is followed by
 * four presented lines before the next), but nothing records it, so a save
 * taken inside a zoomed moment cannot restore the camera.
 */
const zoomed = {
  formatVersion: 1, scene: "z", entry: "b0",
  blocks: { b0: { next: null, ops: [
    { op: "viewportRect" as const, x: 0, y: 0, w: 400, h: 300, frames: 30 },
    { op: "dialogue" as const, voice: null, speaker: null, text: "zoomed in", textIndex: 0, segment: 0 },
    { op: "dialogue" as const, voice: null, speaker: null, text: "still zoomed", textIndex: 0, segment: 0 },
  ] } },
  warnings: [], meta: { sceneIds: [], textChunks: 0, resources: [], unknownOpcodeCount: 0, coverage: 1 },
};
const assets = { get: () => undefined, relative: () => null };

describe("a viewport that outlives the event that set it", () => {
  it("is part of the presented state", () => {
    const vm = new SceneVm(zoomed as never, assets as never, {});
    const ev = vm.next();
    const state = ev.type === "dialogue" ? (ev.state as Record<string, unknown>) : {};
    expect(state["viewport"], "the camera is part of the picture").toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });

  it("survives into the next event, which carries no viewport action of its own", () => {
    const vm = new SceneVm(zoomed as never, assets as never, {});
    vm.next();
    const second = vm.next();
    const state = second.type === "dialogue" ? (second.state as Record<string, unknown>) : {};
    expect(state["viewport"], "still zoomed on the following line").toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });

  it("is recorded in a save, so a load can restore the camera", () => {
    const vm = new SceneVm(zoomed as never, assets as never, {});
    vm.next();
    const presentation = vm.getSaveState().presentation as Record<string, unknown>;
    expect(presentation["viewport"]).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });
});

describe("viewport save/resume identity", () => {
  it("restores the camera a save was taken under", () => {
    const vm = new SceneVm(zoomed as never, assets as never, {});
    vm.next();
    const save = JSON.parse(JSON.stringify(vm.getSaveState()));
    const resumed = new SceneVm(zoomed as never, assets as never, { resume: save });
    const ev = resumed.next();
    const state = ev.type === "dialogue" ? (ev.state as Record<string, unknown>) : {};
    expect(state["viewport"]).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });

  it("carries the camera forward to lines that set none of their own", () => {
    const vm = new SceneVm(zoomed as never, assets as never, {});
    vm.next();
    vm.next();
    const save = vm.getSaveState();
    expect(save.presentation.viewport, "the second line is still framed by the first's rect")
      .toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });

  it("records the whole canvas as the rect the scenario uses to zoom out", () => {
    const back = {
      ...zoomed,
      blocks: { b0: { next: null, ops: [
        ...zoomed.blocks.b0.ops,
        { op: "viewportRect" as const, x: 0, y: 0, w: 800, h: 600, frames: 30 },
        { op: "dialogue" as const, voice: null, speaker: null, text: "wide again", textIndex: 0, segment: 0 },
      ] } },
    };
    const vm = new SceneVm(back as never, assets as never, {});
    vm.next(); vm.next(); vm.next();
    expect(vm.getSaveState().presentation.viewport).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });

  it("treats a save written before the camera existed as unknowable, not as identity", () => {
    const vm = new SceneVm(zoomed as never, assets as never, {});
    vm.next();
    const save = JSON.parse(JSON.stringify(vm.getSaveState()));
    delete save.presentation.viewport;
    const resumed = new SceneVm(zoomed as never, assets as never, { resume: save });
    const ev = resumed.next();
    const state = ev.type === "dialogue" ? (ev.state as Record<string, unknown>) : {};
    // The VM itself defaults to the whole canvas; refusing such a save is the
    // migration's job, which is why v1/v2 never reach the VM directly.
    expect(state["viewport"]).toBeNull();
  });
});
