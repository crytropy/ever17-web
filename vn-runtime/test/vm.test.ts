import { describe, expect, it } from "vitest";
import { SceneVm } from "../src/vm.js";
import { evaluateCondition, REL_EQ, REL_NE } from "../src/conditions.js";
import type { IrCondition, IrScene } from "../src/types.js";

/** Minimal in-memory stand-in for AssetResolver. */
const noAssets = {
  baseDir: "/nowhere",
  get: () => undefined,
  path: () => null,
  relative: () => null,
  missing: [] as string[],
  size: 0,
} as unknown as import("../src/assets.js").AssetResolver;

const dialogue = (text: string) =>
  ({ op: "dialogue", voice: null, speaker: null, text, textIndex: 0, segment: 0 }) as const;

function scene(blocks: IrScene["blocks"], entry = "A"): IrScene {
  return {
    scene: "test",
    entry,
    blocks,
    warnings: [],
    meta: { sceneIds: [], textChunks: 0, resources: [], unknownOpcodeCount: 0, coverage: 1 },
  };
}

const varTest = (varId: number, rel: number, value: number): IrCondition => ({
  type: "varTest",
  varId,
  ops: [0x14, rel],
  rhs: { type: "const", value },
  opcode: "fe28",
});

describe("condition evaluation", () => {
  it("treats 0x14 as equality and 0x17 as inequality", () => {
    const vars = new Map([[1203, 2]]);
    expect(evaluateCondition(varTest(1203, REL_EQ, 2), vars).value).toBe(true);
    expect(evaluateCondition(varTest(1203, REL_EQ, 0), vars).value).toBe(false);
    expect(evaluateCondition(varTest(1203, REL_NE, 2), vars).value).toBe(false);
    expect(evaluateCondition(varTest(1203, REL_NE, 0), vars).value).toBe(true);
  });

  it("defaults unwritten variables to 0", () => {
    expect(evaluateCondition(varTest(999, REL_EQ, 0), new Map()).value).toBe(true);
  });

  it("reports unknown relations as unevaluable rather than guessing", () => {
    expect(evaluateCondition(varTest(1, 0x1b, 0), new Map()).value).toBeUndefined();
    expect(evaluateCondition({ type: "unknownExpr", raw: "??" }, new Map()).value).toBeUndefined();
  });
});

describe("SceneVm", () => {
  it("walks blocks and emits dialogue in order", () => {
    const vm = new SceneVm(
      scene({
        A: { next: "B", ops: [dialogue("one")] },
        B: { next: null, ops: [dialogue("two")] },
      }),
      noAssets,
    );
    expect(vm.next()).toMatchObject({ type: "dialogue", text: "one" });
    expect(vm.next()).toMatchObject({ type: "dialogue", text: "two" });
    expect(vm.next()).toMatchObject({ type: "end", reason: "terminated" });
  });

  it("follows gotoBlock and reports gotoScene", () => {
    const vm = new SceneVm(
      scene({
        A: { next: null, ops: [{ op: "gotoBlock", target: "C" }] },
        B: { next: null, ops: [dialogue("skipped")] },
        C: { next: null, ops: [dialogue("jumped"), { op: "gotoScene", scene: "S_1A2" }] },
      }),
      noAssets,
    );
    expect(vm.next()).toMatchObject({ text: "jumped" });
    expect(vm.next()).toMatchObject({ type: "end", reason: "gotoScene", nextScene: "S_1A2" });
  });

  it("takes a guarded instruction when the condition holds and skips it otherwise", () => {
    const build = (rhs: number) =>
      scene({
        A: {
          next: null,
          ops: [
            { op: "branch", condition: varTest(1203, REL_EQ, rhs), takenTarget: "T", skipTarget: "S" },
          ],
        },
        T: { next: null, ops: [dialogue("taken")] },
        S: { next: null, ops: [dialogue("skipped")] },
      });
    // var 1203 defaults to 0
    expect(new SceneVm(build(0), noAssets).next()).toMatchObject({ text: "taken" });
    expect(new SceneVm(build(7), noAssets).next()).toMatchObject({ text: "skipped" });
  });

  it("honours a forced branch policy", () => {
    const s = scene({
      A: {
        next: null,
        ops: [{ op: "branch", condition: varTest(1, REL_EQ, 99), takenTarget: "T", skipTarget: "S" }],
      },
      T: { next: null, ops: [dialogue("taken")] },
      S: { next: null, ops: [dialogue("skipped")] },
    });
    expect(new SceneVm(s, noAssets, { branchPolicy: "take" }).next()).toMatchObject({ text: "taken" });
    expect(new SceneVm(s, noAssets, { branchPolicy: "skip" }).next()).toMatchObject({ text: "skipped" });
  });

  it("defaults an unevaluable guard to skip and reports it", () => {
    const seen: unknown[] = [];
    const vm = new SceneVm(
      scene({
        A: {
          next: null,
          ops: [
            {
              op: "branch",
              condition: { type: "unknownExpr", raw: "mystery" },
              takenTarget: "T",
              skipTarget: "S",
            },
          ],
        },
        T: { next: null, ops: [dialogue("taken")] },
        S: { next: null, ops: [dialogue("skipped")] },
      }),
      noAssets,
      { onBranch: (i) => seen.push(i) },
    );
    expect(vm.next()).toMatchObject({ text: "skipped" });
    expect(seen).toEqual([{ block: "A", condition: "mystery", value: undefined, taken: false }]);
  });

  it("dispatches a choice to the selected target and records the result variable", () => {
    const s = scene({
      A: {
        next: null,
        ops: [
          {
            op: "choice",
            id: 44,
            resultVar: 1203,
            options: [
              { index: 0, text: "yes", target: "Y" },
              { index: 1, text: "no", target: "N" },
            ],
          },
        ],
      },
      Y: { next: "M", ops: [dialogue("yes-branch")] },
      N: { next: "M", ops: [dialogue("no-branch")] },
      M: { next: null, ops: [dialogue("merge")] },
    });
    for (const [option, expected] of [[0, "yes-branch"], [1, "no-branch"]] as const) {
      const vm = new SceneVm(s, noAssets);
      const ev = vm.next();
      expect(ev).toMatchObject({ type: "choice", id: 44 });
      if (ev.type !== "choice") throw new Error("expected a choice");
      vm.choose(ev, { option });
      expect(vm.next()).toMatchObject({ text: expected });
      expect(vm.next()).toMatchObject({ text: "merge" });
      expect(vm.vars.get(1203)).toBe(option);
    }
  });

  it("falls through a choice that has no dispatch rows", () => {
    const vm = new SceneVm(
      scene({
        A: {
          next: "B",
          ops: [
            { op: "choice", id: 7, resultVar: 1203, options: [{ index: 0, text: "a", target: null }] },
          ],
        },
        B: { next: null, ops: [dialogue("after")] },
      }),
      noAssets,
    );
    const ev = vm.next();
    if (ev.type !== "choice") throw new Error("expected a choice");
    vm.choose(ev, { option: 0 });
    expect(vm.next()).toMatchObject({ text: "after" });
    expect(vm.vars.get(1203)).toBe(0);
  });

  it("rejects a choice answer that is not on offer", () => {
    const vm = new SceneVm(
      scene({ A: { next: null, ops: [{ op: "choice", id: 1, resultVar: null, options: [] }] } }),
      noAssets,
    );
    const ev = vm.next();
    if (ev.type !== "choice") throw new Error("expected a choice");
    expect(() => vm.choose(ev, { option: 3 })).toThrow(/no option 3/);
  });

  it("tracks presentation state across ops", () => {
    const vm = new SceneVm(
      scene({
        A: {
          next: null,
          ops: [
            { op: "setBackground", asset: "bg01a1", resource: 0, fade: 0, arg2: 2 },
            { op: "showSprite", asset: "yu02bdm", resource: 1, slot: 1, x: 320, mode: 3 },
            dialogue("with sprite"),
            { op: "hideSprite", slot: 1, mode: 3 },
            dialogue("without sprite"),
            { op: "fillScreen", color: 1, fade: 6, plane: 2 },
            dialogue("filled"),
          ],
        },
      }),
      noAssets,
    );
    const a = vm.next();
    expect(a).toMatchObject({ type: "dialogue" });
    if (a.type !== "dialogue") throw new Error();
    expect(a.state.background?.asset).toBe("bg01a1");
    expect(a.state.sprites.map((s) => s.asset)).toEqual(["yu02bdm"]);

    const b = vm.next();
    if (b.type !== "dialogue") throw new Error();
    expect(b.state.sprites).toEqual([]);

    const c = vm.next();
    if (c.type !== "dialogue") throw new Error();
    expect(c.state.fill).toBe(1);
    expect(c.state.background).toBeNull();
  });

  it("terminates on a cyclic block graph instead of hanging", () => {
    const vm = new SceneVm(
      scene({ A: { next: null, ops: [{ op: "gotoBlock", target: "A" }] } }),
      noAssets,
      { stepLimit: 100 },
    );
    expect(vm.next()).toMatchObject({ type: "end", reason: "stepLimit" });
  });

  it("preserves unknown ops without crashing", () => {
    const seen: string[] = [];
    const vm = new SceneVm(
      scene({
        A: {
          next: null,
          ops: [
            { op: "unknown", opcode: "1020", mnemonic: "EFFECT_ON", raw: "1020ac", operands: ["[44]"] },
            dialogue("after unknown"),
          ],
        },
      }),
      noAssets,
      { onOp: (op) => seen.push(op.op) },
    );
    expect(vm.next()).toMatchObject({ text: "after unknown" });
    expect(seen).toEqual(["unknown"]);
  });
});
