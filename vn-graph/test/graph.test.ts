import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { fsSceneSource } from "vn-runtime";
import type { IrScene } from "e17-parser/ir";
import { buildGraphModel } from "../src/build.js";
import { toJson, fromJson } from "../src/model.js";
import { layoutGraph } from "../src/layout.js";
import { toDot } from "../src/export.js";
import { HAVE_IR, IR_DIR, scene, line, choice, set, jump, gotoScene, gotoBlock, movie } from "./helpers.js";

/* ------------------------------------------------------------- synthetic */

describe("static graph (synthetic)", () => {
  const scenes = new Map<string, IrScene>([
    // s0: choice with per-option dispatch -> distinct scenes
    [
      "s0",
      scene("s0", {
        b0: { ops: [line("intro"), choice(7, [{ text: "L", target: "bL" }, { text: "R", target: "bR" }])] },
        bL: { ops: [set(100, 1), gotoScene("mid")] },
        bR: { ops: [set(100, 2), gotoScene("mid")] },
      }),
    ],
    // mid: conditional split on var 100 + a linear tail
    [
      "mid",
      scene("mid", {
        b0: { next: "b1", ops: [line("mid"), jump(100, 0x0c, 2, "b2")] },
        b1: { ops: [gotoScene("enda")] },
        b2: { ops: [gotoScene("endb")] },
      }),
    ],
    // enda: dispatches endings on var 100 (written by inbound edges? no - by s0)
    [
      "enda",
      scene("enda", {
        b0: { next: "b1", ops: [line("a")] },
        b1: { ops: [] }, // terminates
      }),
    ],
    ["endb", scene("endb", { b0: { ops: [line("b"), movie("m_end")] } })],
  ]);
  const model = buildGraphModel(scenes, "s0");

  it("classifies choice, conditional and linear transitions", () => {
    const kinds = new Map(model.transitions.map((t) => [`${t.from}>${t.to}${t.choice ? "#" + t.choice.option : ""}`, t]));
    const l = kinds.get("s0>mid#0")!;
    const r = kinds.get("s0>mid#1")!;
    expect(l.type).toBe("choice");
    expect(l.choice).toMatchObject({ id: 7, option: 0, text: "L" });
    expect(r.choice).toMatchObject({ id: 7, option: 1, text: "R" });
    expect(l.writes).toEqual([{ varId: 100, value: 1, mod: "assign" }]);
    const cond = model.transitions.find((t) => t.to === "endb")!;
    expect(cond.type).toBe("conditional");
    expect(cond.condition).toMatchObject({ varId: 100, rel: "==", value: 2 });
    const lin = model.transitions.find((t) => t.to === "enda")!;
    expect(lin.type).toBe("linear");
  });

  it("detects terminal/ending scenes and totals", () => {
    expect(model.nodes.get("enda")!.terminal).toBe(true);
    expect(model.nodes.get("enda")!.canEnd).toBe(true);
    expect(model.nodes.get("endb")!.movies).toEqual(["m_end"]);
    expect(model.endings.map((e) => e.id).sort()).toEqual(["ENDA", "ENDB"]);
    expect(model.totals).toMatchObject({ scenes: 4, reachableScenes: 4, choiceSites: 1, choiceOptions: 2 });
  });

  it("node outgoing/incoming wire to the same transition objects", () => {
    const s0 = model.nodes.get("s0")!;
    expect(s0.outgoing).toHaveLength(2);
    const mid = model.nodes.get("mid")!;
    expect(mid.incoming).toHaveLength(2);
    expect(mid.incoming[0]).toBe(s0.outgoing[0]);
  });

  it("is deterministic and JSON round-trips", () => {
    const again = buildGraphModel(scenes, "s0");
    expect(JSON.stringify(toJson(again))).toBe(JSON.stringify(toJson(model)));
    const back = fromJson(JSON.parse(JSON.stringify(toJson(model))));
    expect(back.nodes.get("mid")!.incoming).toHaveLength(2);
    expect(back.transitions).toHaveLength(model.transitions.length);
    expect(back.nodes.get("s0")!.outgoing[0]).toBe(back.transitions[back.nodes.get("s0")!.outgoing[0] === back.transitions[0] ? 0 : back.transitions.indexOf(back.nodes.get("s0")!.outgoing[0]!)]);
  });

  it("no transition references a scene outside nodes+missing", () => {
    for (const t of model.transitions) {
      expect(model.nodes.has(t.from)).toBe(true);
      expect(model.nodes.has(t.to) || model.missingScenes.includes(t.to)).toBe(true);
    }
  });

  it("layout places every node deterministically", () => {
    const json = toJson(model);
    const a = layoutGraph(json);
    const b = layoutGraph(json);
    expect(a).toEqual(b);
    for (const n of json.nodes) {
      const p = a.positions[n.id]!;
      expect(p).toBeDefined();
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    // start on the first layer, endings later
    expect(a.layers[0]).toContain("s0");
  });

  it("dot export mentions every scene", () => {
    const dot = toDot(toJson(model));
    for (const id of scenes.keys()) expect(dot).toContain(`"${id}"`);
  });
});

describe("intra-scene loops do not break the builder", () => {
  it("menu loop with option dispatch classifies and terminates", () => {
    const s = scene("menu", {
      b0: { next: "b0", ops: [choice(9, [{ text: "again", target: "b0" }, { text: "go", target: "bX" }])] },
      bX: { ops: [gotoBlock("bY")] },
      bY: { ops: [gotoScene("out")] },
    });
    const model = buildGraphModel(new Map([["menu", s], ["out", scene("out", { b0: { ops: [line("x")] } })]]), "menu");
    const t = model.transitions.find((x) => x.to === "out")!;
    expect(t.type).toBe("choice");
    expect(t.choice).toMatchObject({ id: 9, option: 1 });
  });
});

/* ------------------------------------------------------------- real data */

function loadAll(): Map<string, IrScene> {
  const source = fsSceneSource(IR_DIR);
  const scenes = new Map<string, IrScene>();
  for (const f of readdirSync(IR_DIR).filter((f) => f.endsWith(".json"))) {
    const s = source.load(f.replace(/\.json$/, ""));
    if (s) scenes.set(s.scene.toLowerCase(), s);
  }
  return scenes;
}

describe.skipIf(!HAVE_IR)("route graph (real script.dat IR)", () => {
  const scenes = HAVE_IR ? loadAll() : new Map<string, IrScene>();
  const model = HAVE_IR ? buildGraphModel(scenes, "op00") : null!;

  it("covers every scene and is closed except the known dev leftover", () => {
    expect(model.nodes.size).toBe(scenes.size);
    // debug.scr references ztp_op00, a script that never shipped
    expect(model.missingScenes).toEqual(["ztp_op00"]);
    // system UI scripts sit outside the story graph
    expect(model.unreferenced).toEqual(["startup", "system"]);
  });

  it("branches at the protagonist choice: op00 reaches both perspectives", () => {
    const targets = model.nodes.get("op00")!.outgoing.map((t) => t.to);
    expect(targets).toContain("t_1a");
    expect(targets).toContain("s_1a");
  });

  it("t_6b fans out to both Takeshi routes", () => {
    const targets = model.nodes.get("t_6b")!.outgoing.map((t) => t.to);
    expect(targets).toContain("tt6a"); // Tsugumi
    expect(targets).toContain("tl6a"); // Sora
  });

  it("transitions into y_ed set either the ending register or the coda resume flag", () => {
    const intoEd = model.nodes.get("y_ed")!.incoming.filter((t) => t.from !== "debug");
    expect(intoEd.length).toBeGreaterThan(5);
    for (const t of intoEd) {
      const setsEnding = t.writes.some((w) => w.varId === 1223);
      const setsResume = t.writes.some((w) => w.varId === 1203 && w.value === 1);
      expect(setsEnding || setsResume, `${t.from} -> y_ed writes ${JSON.stringify(t.writes)}`).toBe(true);
    }
    expect(intoEd.some((t) => t.writes.some((w) => w.varId === 1223))).toBe(true);
    expect(intoEd.some((t) => t.writes.some((w) => w.varId === 1203 && w.value === 1))).toBe(true);
  });

  it("edges that assign the y_ed dispatch register classify as ending edges", () => {
    const endingEdges = model.transitions.filter((t) => t.type === "ending");
    expect(endingEdges.length).toBeGreaterThan(3);
    for (const t of endingEdges) {
      expect(model.nodes.get(t.to)!.canEnd).toBe(true);
    }
  });

  it("terminal scenes are exactly the dead-end nodes; y_ed can end but is not terminal", () => {
    for (const n of model.nodes.values()) {
      expect(n.terminal).toBe(n.outgoing.length === 0);
    }
    const yed = model.nodes.get("y_ed")!;
    expect(yed.terminal).toBe(false);
    expect(yed.canEnd).toBe(true);
    expect(yed.outgoing.map((t) => t.to)).toContain("ssep");
  });

  it("static endings enumerate the y_ed dispatch rows on inbound-written values", () => {
    const yedEndings = model.endings.filter((e) => e.scene === "y_ed");
    expect(yedEndings.length).toBeGreaterThan(5);
    const vars = new Set(yedEndings.flatMap((e) => e.conditions.map((c) => c.varId)));
    expect(vars).toContain(1223);
  });

  it("head dispatch rows exist where shared scenes resume (s_1a2)", () => {
    const n = model.nodes.get("s_1a2")!;
    expect(n.headDispatch.some((d) => d.startsWith("var1203 == 1"))).toBe(true);
    expect(n.headDispatch.some((d) => d.startsWith("var1203 == 2"))).toBe(true);
  });

  it("build is deterministic on the full corpus", () => {
    const again = buildGraphModel(scenes, "op00");
    expect(JSON.stringify(toJson(again))).toBe(JSON.stringify(toJson(model)));
  });
});

describe("matchEndings (client-side award)", async () => {
  const { matchEndings } = await import("../src/model.js");
  const endings = [
    { id: "END_A", scene: "y_ed", movie: "end_a", conditions: [{ varId: 1223, rel: "==", value: 0, text: "var1223 == 0" }], evidence: "static+observed" as const },
    { id: "END_B", scene: "y_ed", movie: null, conditions: [{ varId: 1223, rel: "==", value: 5, text: "var1223 == 5" }], evidence: "static" as const },
    { id: "TCX", scene: "tcx", movie: null, conditions: [], evidence: "static" as const },
  ];

  it("awards by scene + conditions + movie evidence", () => {
    const vars = new Map([[1223, 0]]);
    expect(matchEndings(endings, "Y_ED", vars, new Set(["end_a"])).map((e) => e.id)).toEqual(["END_A"]);
    // movie required but not played -> no award
    expect(matchEndings(endings, "y_ed", vars, new Set())).toEqual([]);
    // dispatch mismatch -> the other row
    expect(matchEndings(endings, "y_ed", new Map([[1223, 5]]), new Set()).map((e) => e.id)).toEqual(["END_B"]);
  });

  it("never awards unverifiable endings (no conditions, no movie)", () => {
    expect(matchEndings(endings, "tcx", new Map(), new Set())).toEqual([]);
  });
});
