import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AssetResolver } from "../src/assets.js";
import { runScene } from "../src/player.js";
import { SceneVm } from "../src/vm.js";
import { renderFrame } from "../src/frame.js";
import type { IrScene } from "../src/types.js";
import { HAVE_PIPELINE, S1A_IR, S1A_MANIFEST } from "./helpers.js";

describe.skipIf(!HAVE_PIPELINE)("s_1a end-to-end (IR + extracted assets)", () => {
  const scene = (): IrScene => JSON.parse(readFileSync(S1A_IR, "utf8")) as IrScene;
  const assets = (): AssetResolver => new AssetResolver(S1A_MANIFEST);

  it("every asset the scene references was extracted", () => {
    const a = assets();
    expect(a.missing).toEqual([]);
    expect(a.size).toBeGreaterThan(200);
  });

  it("plays the whole scene with no unresolved assets and exits to S_1A2", () => {
    const r = runScene(scene(), assets(), { choiceById: { 44: 0 } });
    expect(r.unresolved).toEqual([]);
    expect(r.lines).toBeGreaterThan(500);
    expect(r.end).toMatchObject({ type: "end", reason: "gotoScene", nextScene: "S_1A2" });
  });

  it("opens on the infirmary narration", () => {
    const r = runScene(scene(), assets(), { maxLines: 1 });
    const first = r.events.find((e) => e.type === "dialogue");
    expect(first).toMatchObject({ type: "dialogue" });
    if (first?.type !== "dialogue") throw new Error();
    expect(first.text).toContain("醒");
  });

  it("attaches voice files to voiced lines", () => {
    const r = runScene(scene(), assets(), { maxLines: 40 });
    const voiced = r.events.filter((e) => e.type === "dialogue" && e.voice);
    expect(voiced.length).toBeGreaterThan(3);
    for (const ev of voiced) {
      if (ev.type !== "dialogue") continue;
      expect(ev.voiceFile, ev.voice ?? "").toMatch(/^audio\/.+\.wav$/);
    }
    const s1a000 = voiced.find((e) => e.type === "dialogue" && e.voice === "S1A000");
    expect(s1a000).toMatchObject({ speaker: "？？" });
  });

  it("offers choice 44 with both documented options", () => {
    const r = runScene(scene(), assets(), { choiceById: { 44: 0 } });
    const choice = r.events.find((e) => e.type === "choice" && e.id === 44);
    expect(choice).toBeDefined();
    if (choice?.type !== "choice") throw new Error();
    expect(choice.resultVar).toBe(1203);
    expect(choice.options).toEqual([
      { index: 0, text: "谢谢", target: "0000029D", enabled: true },
      { index: 1, text: "不需要", target: "000002B1", enabled: true },
    ]);
  });

  it("plays the branch-specific reply on each side of choice 44", () => {
    const linesAfter = (option: number, count: number): string[] => {
      const vm = new SceneVm(scene(), assets());
      for (;;) {
        const ev = vm.next();
        if (ev.type === "end") throw new Error("scene ended before choice 44");
        if (ev.type !== "choice") continue;
        if (ev.id !== 44) {
          vm.choose(ev, { option: 0 });
          continue;
        }
        vm.choose(ev, { option });
        break;
      }
      const out: string[] = [];
      while (out.length < count) {
        const ev = vm.next();
        if (ev.type === "end") break;
        if (ev.type === "dialogue") out.push(ev.text);
      }
      return out;
    };
    // Option 0 accepts the medicine; the reply is guarded by a conditional
    // that only plays when the guard's relation holds.
    expect(linesAfter(0, 2)[0]).toContain("谢谢");
    // Option 1 refuses.
    expect(linesAfter(1, 2)[0]).toContain("不需要");
  });

  it("merges both branches of choice 44 at the same block and converges after", () => {
    const runs = [0, 1].map((option) => runScene(scene(), assets(), { choiceById: { 44: option } }));
    const [a, b] = runs;
    if (!a || !b) throw new Error();

    // The traces must diverge at the choice block and reconverge.
    const divergeAt = a.blockTrace.findIndex((blk, i) => b.blockTrace[i] !== blk);
    expect(divergeAt).toBeGreaterThan(0);
    expect(a.blockTrace[divergeAt]).toBe("0000029D"); // option 0 target
    expect(b.blockTrace[divergeAt]).toBe("000002B1"); // option 1 target

    // Find the first block both paths visit again after diverging.
    const tailA = a.blockTrace.slice(divergeAt);
    const tailB = b.blockTrace.slice(divergeAt);
    const merge = tailA.find((blk) => tailB.includes(blk));
    expect(merge).toBe("000002E0");

    // After the merge the two runs are identical to the end of the scene.
    const restA = a.blockTrace.slice(a.blockTrace.indexOf(merge!));
    const restB = b.blockTrace.slice(b.blockTrace.indexOf(merge!));
    expect(restA).toEqual(restB);
    expect(restA[restA.length - 1]).toBe("0000139A");
  });

  it("answers a second, independent choice by id", () => {
    const r = runScene(scene(), assets(), { choiceById: { 44: 1, 46: 1 } });
    expect(r.choicesMade.map((c) => [c.id, c.option])).toEqual([
      [44, 1],
      [46, 1],
    ]);
    expect(r.choicesMade[1]!.text).toBe("不听");
  });

  it("positions sprites using the IR operand and the PRT anchor", () => {
    const r = runScene(scene(), assets(), { choiceById: { 44: 0 } });
    const withSprite = r.events.find(
      (e) => e.type === "dialogue" && e.state.sprites.length > 0,
    );
    expect(withSprite).toBeDefined();
    if (withSprite?.type !== "dialogue") throw new Error();
    const sprite = withSprite.state.sprites[0]!;
    expect(sprite.file).toMatch(/^images\/.+\.png$/);
    expect(sprite.width).toBeGreaterThan(0);
    // x must land inside the 800-wide frame, not at a nonsense coordinate
    expect(sprite.x).not.toBeNull();
    expect(sprite.x!).toBeGreaterThanOrEqual(-sprite.width!);
    expect(sprite.x!).toBeLessThan(800);
  });

  it("composites a frame from decoded assets", () => {
    const vm = new SceneVm(scene(), assets());
    let frameState: import("../src/types.js").SceneStateSnapshot | null = null;
    for (let i = 0; i < 400 && !frameState; i++) {
      const ev = vm.next();
      if (ev.type === "end") break;
      if (ev.type === "choice") {
        vm.choose(ev, { option: 0 });
        continue;
      }
      if (ev.state.background?.file && ev.state.sprites.some((s) => s.file)) {
        frameState = ev.state;
      }
    }
    expect(frameState, "no frame with both a background and a sprite").not.toBeNull();
    const png = renderFrame(frameState!, assets(), { speaker: null, text: "" });
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(800);
    expect(png.readUInt32BE(20)).toBe(600);
  });
});
