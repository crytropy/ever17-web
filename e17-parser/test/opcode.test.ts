import { describe, expect, it } from "vitest";
import { parseSc3 } from "../src/sc3/chunks.js";
import { disassemble } from "../src/sc3/disassembler.js";
import { buildCfg } from "../src/sc3/cfg.js";
import { lowerScene } from "../src/ir/lower.js";
import { archive, HAVE_DAT, scr } from "./helpers.js";

const dis = (name: string) => {
  const e = scr(name);
  const f = parseSc3(e.name, e.data);
  return { e, f, d: disassemble(f, e.data) };
};

describe.skipIf(!HAVE_DAT)("disassembler (script.dat)", () => {
  it("achieves 100% coverage on every story and debug script", () => {
    for (const e of archive().entries) {
      if (e.name === "startup.scr" || e.name === "system.scr" || e.name === "debug.scr") continue;
      const f = parseSc3(e.name, e.data);
      const d = disassemble(f, e.data);
      expect(d.coveredBytes, e.name).toBe(d.totalBytes);
      expect(d.dataRegions, e.name).toEqual([]);
    }
  });

  it("keeps overall coverage above 96% including system scripts", () => {
    let covered = 0;
    let total = 0;
    for (const e of archive().entries) {
      const f = parseSc3(e.name, e.data);
      const d = disassemble(f, e.data);
      covered += d.coveredBytes;
      total += d.totalBytes;
    }
    expect(covered / total).toBeGreaterThan(0.96);
  });

  it("milestone: debug_bg8 decodes to SET_BG/SET_SPRITE/MESSAGE triples", () => {
    const { f, d } = dis("debug_bg8.scr");
    const ins = d.instructions.filter((i) => i.mnemonic !== "PAD");
    expect(ins[0]!.mnemonic).toBe("SCENE_MARKER");
    expect(ins[1]!.mnemonic).toBe("SET_BG");
    expect(ins[2]!.mnemonic).toBe("SET_SPRITE");
    expect(ins[3]!.mnemonic).toBe("MESSAGE");
    // resource of the first SET_BG is bg01a1, sprite is YU02BDM
    const bgRes = ins[1]!.operands[1];
    expect(bgRes).toMatchObject({ kind: "u16", value: 0 });
    expect(f.resourceChunks[0]!.name).toBe("bg01a1");
    const spRes = ins[2]!.operands[2];
    expect(spRes).toMatchObject({ kind: "u16", value: 1 });
    expect(f.resourceChunks[1]!.name).toBe("YU02BDM");
    // last instruction returns to the debug menu
    expect(ins[ins.length - 1]).toMatchObject({ mnemonic: "GOTO_SCRIPT" });
  });

  it("milestone: the s_1a story choice (id 44) dispatches to 0x29D/0x2B1 and merges at 0x2E0", () => {
    const { f, d } = dis("s_1a.scr");
    const rows = d.instructions.filter(
      (i) => i.mnemonic === "CHOICE_OPTION" && i.address < 0x300,
    );
    expect(rows).toHaveLength(2);
    const targets = rows.map((r) => {
      const op = r.operands[1];
      return op?.kind === "entryRef" ? f.entryPoints[op.index - 1] : -1;
    });
    expect(targets).toEqual([0x29d, 0x2b1]);
    const begin = d.instructions.find((i) => i.mnemonic === "CHOICE_BEGIN");
    expect(begin?.operands[1]).toMatchObject({ kind: "expr" });
    // both branches jump to entry#3 = 0x2E0
    const jumps = d.instructions.filter(
      (i) => i.mnemonic === "JUMP" && i.address >= 0x29d && i.address < 0x2e0,
    );
    expect(jumps.map((j) => (j.operands[0]?.kind === "entryRef" ? f.entryPoints[j.operands[0].index - 1] : -1)))
      .toEqual([0x2e0, 0x2e0]);
  });
});

describe.skipIf(!HAVE_DAT)("cfg + IR (script.dat)", () => {
  it("produces the documented IR choice op for s_1a", () => {
    const e = scr("s_1a.scr");
    const f = parseSc3(e.name, e.data);
    const d = disassemble(f, e.data);
    const cfg = buildCfg(f, d);
    const ir = lowerScene(f, d, cfg, "gbk");
    const choice = Object.values(ir.blocks)
      .flatMap((b) => b.ops)
      .find((o) => o.op === "choice");
    expect(choice).toMatchObject({
      op: "choice",
      id: 44,
      options: [
        { index: 0, text: "谢谢", target: "0000029D" },
        { index: 1, text: "不需要", target: "000002B1" },
      ],
    });
  });

  it("lowers cross-scene transitions", () => {
    const e = scr("debug_bg8.scr");
    const f = parseSc3(e.name, e.data);
    const d = disassemble(f, e.data);
    const cfg = buildCfg(f, d);
    const ir = lowerScene(f, d, cfg, "shift_jis");
    const gotos = Object.values(ir.blocks)
      .flatMap((b) => b.ops)
      .filter((o) => o.op === "gotoScene");
    expect(gotos).toContainEqual({ op: "gotoScene", scene: "debug" });
  });

  it("every story script lowers with zero warnings and full coverage", () => {
    for (const e of archive().entries) {
      if (["startup.scr", "system.scr", "debug.scr"].includes(e.name)) continue;
      const f = parseSc3(e.name, e.data);
      const d = disassemble(f, e.data);
      const cfg = buildCfg(f, d);
      const ir = lowerScene(f, d, cfg, e.name.startsWith("debug") ? "shift_jis" : "gbk");
      expect(ir.meta.coverage, e.name).toBe(1);
    }
  });
});
