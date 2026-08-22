import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { fsSceneSource, GameSession } from "vn-runtime";
import type { IrScene } from "e17-parser/ir";
import { buildVarAbstraction, explore } from "../src/explore.js";
import { buildGraphModel } from "../src/build.js";
import { applyExploration } from "../src/analyze.js";
import { explainEnding, formatExplanation } from "../src/explain.js";
import { toJson } from "../src/model.js";
import {
  HAVE_IR,
  IR_DIR,
  scene,
  line,
  choice,
  set,
  jump,
  gotoScene,
  gotoBlock,
  movie,
  memorySource,
} from "./helpers.js";

/* --------------------------------------------------------------- synthetic */

/** Two binary choices -> three endings (one movie-identified, one var-gated). */
function diamondScenes(): IrScene[] {
  return [
    scene("s0", {
      b0: { ops: [line("intro"), choice(1, [{ text: "L", target: "bL" }, { text: "R", target: "bR" }])] },
      bL: { ops: [set(100, 1), gotoScene("mid")] },
      bR: { ops: [set(100, 2), gotoScene("mid")] },
    }),
    scene("mid", {
      b0: { next: "b1", ops: [line("mid"), choice(2, [{ text: "stay" }, { text: "leave" }], 200)] },
      b1: { next: "b2", ops: [jump(200, 0x0c, 1, "bB")] },
      b2: { ops: [gotoScene("enda")] },
      bB: { ops: [gotoScene("endb")] },
    }),
    scene("enda", {
      b0: { next: "b1", ops: [line("ending region"), jump(100, 0x0c, 2, "b2")] },
      b1: { ops: [line("one"), movie("m_one")] },
      b2: { ops: [line("two"), movie("m_two")] },
    }),
    scene("endb", { b0: { ops: [line("b")] } }),
  ];
}

describe("explorer (synthetic)", () => {
  it("finds every ending with full coverage and aggregates paths", async () => {
    const scenes = diamondScenes();
    const source = memorySource(scenes);
    const result = await explore(source, {
      start: "s0",
      abstraction: buildVarAbstraction(scenes),
      now: () => 0,
    });

    expect(result.endings.map((e) => e.id).sort()).toEqual(["ENDB", "M_ONE", "M_TWO"]);
    expect(result.stats.capped).toBe(false);
    expect(result.scenesVisited).toEqual(["enda", "endb", "mid", "s0"]);
    expect(Object.keys(result.choicesSeen).sort()).toEqual(["mid:2", "s0:1"]);
    expect(result.anomalies).toEqual([]);
    expect(Object.keys(result.unknownOps)).toEqual([]);

    // M_TWO requires choice 1 = option 1 (sets 100=2) and choice 2 = option 0
    const two = result.endings.find((e) => e.id === "M_TWO")!;
    expect(two.paths).toBe(1);
    expect(two.requiredChoices.map((c) => `${c.key}=${c.option}`)).toEqual(["s0:1=1", "mid:2=0"]);
    expect(two.finalVars).toContainEqual([100, 2]);

    // ENDB is reached from both sides of choice 1: it is a free choice there
    const endb = result.endings.find((e) => e.id === "ENDB")!;
    expect(endb.paths).toBe(2);
    expect(endb.requiredChoices.map((c) => c.key)).toEqual(["mid:2"]);
    expect(endb.freeChoices.map((c) => c.key)).toEqual(["s0:1"]);
    expect(endb.criticalScenes).toEqual(["s0", "mid", "endb"]);
  });

  it("explains an ending from graph + traces (never hand-written)", async () => {
    const scenes = diamondScenes();
    const source = memorySource(scenes);
    const exploration = await explore(source, {
      start: "s0",
      abstraction: buildVarAbstraction(scenes),
      now: () => 0,
    });
    const model = buildGraphModel(new Map(scenes.map((s) => [s.scene, s])), "s0");
    applyExploration(model, exploration);

    // observed movie endings claimed the static dispatch rows in enda
    const mTwo = model.endings.find((e) => e.id === "M_TWO")!;
    expect(mTwo.evidence).toBe("static+observed");
    expect(mTwo.conditions.map((c) => c.text)).toEqual(["var100 == 2"]);

    const x = explainEnding(toJson(model), exploration, "m_two")!;
    expect(x).not.toBeNull();
    expect(x.requiredChoices.map((c) => c.option)).toEqual([1, 0]);
    expect(x.dispatchConditions.map((c) => c.text)).toEqual(["var100 == 2"]);
    expect(x.criticalScenes).toEqual(["s0", "mid", "enda"]);
    const text = formatExplanation(x);
    expect(text).toContain("M_TWO");
    expect(text).toContain("var100 == 2");
  });

  it("menu loops converge via visibility flags and dedup", async () => {
    // a menu whose options hide after being taken (like t_1c) plus an exit
    const scenes = [
      scene("menu", {
        b0: { ops: [set(300, 1), set(301, 1), gotoBlock("bM")] },
        bM: {
          next: "bM",
          ops: [
            {
              op: "choice" as const,
              id: 9,
              resultVar: 1203,
              options: [
                { index: 0, text: "topic A", target: "bA", condition: { type: "varCompare" as const, varId: 300, rel: 0x0d, value: { type: "const" as const, value: 0 } } },
                { index: 1, text: "topic B", target: "bB", condition: { type: "varCompare" as const, varId: 301, rel: 0x0d, value: { type: "const" as const, value: 0 } } },
                { index: 2, text: "leave", target: "bX" },
              ],
            },
          ],
        },
        bA: { next: "bM", ops: [line("a"), set(300, 0)] },
        bB: { next: "bM", ops: [line("b"), set(301, 0)] },
        bX: { ops: [gotoScene("out")] },
      }),
      scene("out", { b0: { ops: [line("done")] } }),
    ];
    const source = memorySource(scenes);
    const result = await explore(source, {
      start: "menu",
      abstraction: buildVarAbstraction(scenes),
      now: () => 0,
    });
    expect(result.stats.capped).toBe(false);
    expect(result.endings.map((e) => e.id)).toEqual(["OUT"]);
    // orders: A,B / B,A / A leave / B leave / leave ... all converge
    expect(result.choicesSeen["menu:9"]!.options.sort()).toEqual([0, 1, 2]);
  });

  it("caps runaway state spaces instead of hanging", async () => {
    // an unbounded accumulator read by a gate that can never fire
    const scenes = [
      scene("loop", {
        b0: {
          next: "b0",
          ops: [choice(1, [{ text: "again", target: "bA" }, { text: "quit", target: "bQ" }])],
        },
        bA: { next: "b0", ops: [set(500, 1, 0x17), jump(500, 0x0c, -1, "bQ")] },
        bQ: { ops: [gotoScene("out")] },
      }),
      scene("out", { b0: { ops: [line("x")] } }),
    ];
    const source = memorySource(scenes);
    const result = await explore(source, {
      start: "loop",
      abstraction: buildVarAbstraction(scenes),
      maxStates: 50,
      maxSessions: 200,
      now: () => 0,
    });
    expect(result.stats.capped).toBe(true);
    expect(result.endings.map((e) => e.id)).toEqual(["OUT"]);
  });

  it("is deterministic", async () => {
    const scenes = diamondScenes();
    const run = () =>
      explore(memorySource(scenes), { start: "s0", abstraction: buildVarAbstraction(scenes), now: () => 0 });
    const [a, b] = await Promise.all([run(), run()]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

/* --------------------------------------------------------------- real data */

function loadAll(): Map<string, IrScene> {
  const source = fsSceneSource(IR_DIR);
  const scenes = new Map<string, IrScene>();
  for (const f of readdirSync(IR_DIR).filter((f) => f.endsWith(".json"))) {
    const s = source.load(f.replace(/\.json$/, ""));
    if (s) scenes.set(s.scene.toLowerCase(), s);
  }
  return scenes;
}

describe.skipIf(!HAVE_IR)("explorer (real script.dat IR)", () => {
  it(
    "a bounded exploration is sound: policy playthroughs are a subset of what it finds",
    { timeout: 120_000 },
    async () => {
      const scenes = loadAll();
      const source = fsSceneSource(IR_DIR);
      const result = await explore(source, {
        start: "op00",
        abstraction: buildVarAbstraction(scenes.values()),
        maxSessions: 4_000,
        maxStates: 20_000,
      });

      // the four standard policy runs are real playthroughs; every scene and
      // transition they walk must be discoverable by exploration too, and
      // exploration must reach at least one real ending
      expect(result.endings.length).toBeGreaterThanOrEqual(1);
      expect(result.anomalies).toEqual([]);
      const visited = new Set(result.scenesVisited);
      for (const s of ["op00", "t_1a", "s_1a"]) {
        expect(visited.has(s), `${s} visited`).toBe(true);
      }

      // identity: restore-driven branching must not corrupt state. Replay a
      // discovered ending's recorded choices in sequence through a fresh
      // GameSession - no save/restore anywhere - and require the exact same
      // scene route and terminal scene.
      const target = result.endings.find((e) => e.movie !== null) ?? result.endings[0]!;
      const session = await GameSession.start(fsSceneSource(IR_DIR), "op00", { backlogLimit: 1 });
      const script = [...target.samplePath.choices];
      for (;;) {
        const ev = await session.next();
        if (ev.type === "dialogue") continue;
        if (ev.type === "choice") {
          const next = script.shift();
          expect(next, "replay ran out of recorded choices").toBeDefined();
          session.choose(next!.option);
          continue;
        }
        expect(ev.reason).toBe("ending");
        break;
      }
      expect(script).toHaveLength(0);
      expect(session.route.map((s) => s.toLowerCase())).toEqual(target.samplePath.route);
    },
  );
});
