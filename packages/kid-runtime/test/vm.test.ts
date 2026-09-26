import { describe, expect, it } from "vitest";
import { SceneVm } from "../src/vm.js";
import { evaluateCondition } from "../src/conditions.js";
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

const compare = (varId: number, rel: number, value: number): IrCondition => ({
  type: "varCompare",
  varId,
  rel,
  value: { type: "const", value },
});

describe("condition evaluation (VAR_JUMP relations)", () => {
  it("evaluates == (0x0c) and != (0x0d)", () => {
    const vars = new Map([[1203, 2]]);
    expect(evaluateCondition(compare(1203, 0x0c, 2), vars).value).toBe(true);
    expect(evaluateCondition(compare(1203, 0x0c, 0), vars).value).toBe(false);
    expect(evaluateCondition(compare(1203, 0x0d, 2), vars).value).toBe(false);
    expect(evaluateCondition(compare(1203, 0x0d, 0), vars).value).toBe(true);
  });

  it("evaluates the provisional route-gate relations >= (0x10), > (0x11), <= (0x0f)", () => {
    const vars = new Map([[1207, 17]]);
    expect(evaluateCondition(compare(1207, 0x10, 17), vars).value).toBe(true);
    expect(evaluateCondition(compare(1207, 0x10, 18), vars).value).toBe(false);
    // 0x11 is strictly-greater: t_6b's ask-menu exits on 1211 > 1
    expect(evaluateCondition(compare(1207, 0x11, 16), vars).value).toBe(true);
    expect(evaluateCondition(compare(1207, 0x11, 17), vars).value).toBe(false);
    expect(evaluateCondition(compare(1207, 0x0f, 17), vars).value).toBe(true);
  });

  it("defaults unwritten variables to 0", () => {
    expect(evaluateCondition(compare(999, 0x0c, 0), new Map()).value).toBe(true);
  });

  it("evaluates sysVarTest against the system table", () => {
    expect(evaluateCondition({ type: "sysVarTest", varId: 7 }, new Map(), new Map()).value).toBe(false);
    expect(
      evaluateCondition({ type: "sysVarTest", varId: 7 }, new Map(), new Map([[7, 1]])).value,
    ).toBe(true);
  });

  it("reports unknown relations as unevaluable rather than guessing", () => {
    expect(evaluateCondition(compare(1, 0x1b, 0), new Map()).value).toBeUndefined();
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
    expect(vm.next()).toMatchObject({
      type: "dialogue",
      text: "one",
      textIndex: 0,
      segment: 0,
    });
    expect(vm.next()).toMatchObject({
      type: "dialogue",
      text: "two",
      textIndex: 0,
      segment: 0,
    });
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

  it("executes varSet: assign (0x14) and add (0x17)", () => {
    const vm = new SceneVm(
      scene({
        A: {
          next: null,
          ops: [
            { op: "varSet", varId: 1200, mod: 0x14, value: { type: "const", value: 5 } },
            { op: "varSet", varId: 1206, mod: 0x17, value: { type: "const", value: 1 } },
            { op: "varSet", varId: 1206, mod: 0x17, value: { type: "const", value: 1 } },
            dialogue("done"),
          ],
        },
      }),
      noAssets,
    );
    expect(vm.next()).toMatchObject({ text: "done" });
    expect(vm.vars.get(1200)).toBe(5);
    expect(vm.vars.get(1206)).toBe(2);
  });

  it("takes a varJump when the comparison holds and falls through otherwise", () => {
    const build = (initial: number) =>
      scene({
        A: {
          next: "F",
          ops: [
            { op: "varSet", varId: 1203, mod: 0x14, value: { type: "const", value: initial } },
            { op: "varJump", condition: compare(1203, 0x0c, 1), target: "T" },
          ],
        },
        F: { next: null, ops: [dialogue("fellthrough")] },
        T: { next: null, ops: [dialogue("jumped")] },
      });
    expect(new SceneVm(build(1), noAssets).next()).toMatchObject({ text: "jumped" });
    expect(new SceneVm(build(0), noAssets).next()).toMatchObject({ text: "fellthrough" });
  });

  it("reports an unevaluable varJump and falls through by default", () => {
    const seen: unknown[] = [];
    const vm = new SceneVm(
      scene({
        A: {
          next: "F",
          ops: [{ op: "varJump", condition: { type: "unknownExpr", raw: "mystery" }, target: "T" }],
        },
        F: { next: null, ops: [dialogue("fellthrough")] },
        T: { next: null, ops: [dialogue("jumped")] },
      }),
      noAssets,
      { onVarJump: (i) => seen.push(i) },
    );
    expect(vm.next()).toMatchObject({ text: "fellthrough" });
    expect(seen).toEqual([
      { block: "A", condition: "mystery", value: undefined, jumped: false, target: "T" },
    ]);
  });

  it("shares an external variable table across VMs (cross-scene persistence)", () => {
    const vars = new Map<number, number>();
    const sceneA = scene({
      A: { next: null, ops: [
        { op: "varSet", varId: 1203, mod: 0x14, value: { type: "const", value: 2 } },
        { op: "gotoScene", scene: "B" },
      ] },
    });
    const sceneB = scene({
      H: { next: "F", ops: [{ op: "varJump", condition: compare(1203, 0x0c, 2), target: "R" }] },
      F: { next: null, ops: [dialogue("fresh")] },
      R: { next: null, ops: [dialogue("resumed")] },
    }, "H");
    const vmA = new SceneVm(sceneA, noAssets, { vars });
    expect(vmA.next()).toMatchObject({ type: "end", reason: "gotoScene", nextScene: "B" });
    const vmB = new SceneVm(sceneB, noAssets, { vars });
    expect(vmB.next()).toMatchObject({ text: "resumed" });
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
