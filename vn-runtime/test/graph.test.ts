import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { buildRouteGraph, standardTraversals } from "../src/graph.js";
import { fsSceneSource } from "../src/scene-source.js";
import type { IrScene } from "../src/types.js";
import { IR_DIR } from "./helpers.js";

const HAVE_IR = existsSync(`${IR_DIR}/op00.json`);

function loadAll(): Map<string, IrScene> {
  const source = fsSceneSource(IR_DIR);
  const scenes = new Map<string, IrScene>();
  for (const f of readdirSync(IR_DIR).filter((f) => f.endsWith(".json"))) {
    const s = source.load(f.replace(/\.json$/, ""));
    if (s) scenes.set(s.scene.toLowerCase(), s);
  }
  return scenes;
}

describe.skipIf(!HAVE_IR)("route graph", () => {
  const scenes = HAVE_IR ? loadAll() : new Map<string, IrScene>();
  const graph = HAVE_IR
    ? buildRouteGraph(scenes, "op00", standardTraversals(fsSceneSource(IR_DIR), "op00"))
    : null!;

  it("covers every scene and is closed except the known dev leftover", () => {
    expect(Object.keys(graph.nodes).length).toBe(scenes.size);
    // debug.scr references ztp_op00, a script that never shipped
    expect(graph.missingScenes).toEqual(["ztp_op00"]);
    // system UI scripts sit outside the story graph
    expect(graph.unreferenced).toEqual(["startup", "system"]);
  });

  it("branches at the protagonist choice: op00 reaches both perspectives", () => {
    const targets = graph.edges.filter((e) => e.from === "op00").map((e) => e.to);
    expect(targets).toContain("t_1a");
    expect(targets).toContain("s_1a");
  });

  it("t_6b fans out to both Takeshi routes", () => {
    const targets = graph.edges.filter((e) => e.from === "t_6b").map((e) => e.to);
    expect(targets).toContain("tt6a"); // Tsugumi
    expect(targets).toContain("tl6a"); // Sora
  });

  it("transitions into y_ed set either the ending register or the coda resume flag", () => {
    const intoEd = graph.edges.filter((e) => e.to === "y_ed" && e.from !== "debug");
    expect(intoEd.length).toBeGreaterThan(5);
    for (const e of intoEd) {
      const setsEnding = e.writes.some((w) => w.varId === 1223);
      // epilogues return with 1203=1, which y_ed's head row dispatches to the coda
      const setsResume = e.writes.some((w) => w.varId === 1203 && w.value === 1);
      expect(setsEnding || setsResume, `${e.from} -> y_ed writes ${JSON.stringify(e.writes)}`).toBe(true);
    }
    // and both kinds exist: route ends carry 1223, epilogue returns carry 1203=1
    expect(intoEd.some((e) => e.writes.some((w) => w.varId === 1223))).toBe(true);
    expect(intoEd.some((e) => e.writes.some((w) => w.varId === 1203 && w.value === 1))).toBe(true);
  });

  it("terminal scenes are exactly the dead-end nodes", () => {
    const terminals = Object.values(graph.nodes).filter((n) => n.terminal).map((n) => n.scene).sort();
    for (const t of terminals) {
      expect(graph.edges.filter((e) => e.from === t)).toHaveLength(0);
    }
    // y_ed is NOT statically terminal: it fans out to the epilogues, which
    // return to it with 1203=1 for the coda (the "epilogue sandwich"); its
    // ending happens dynamically when the coda path runs out.
    expect(terminals).not.toContain("y_ed");
    expect(graph.edges.filter((e) => e.from === "y_ed").map((e) => e.to)).toContain("ssep");
  });

  it("all standard traversals reach an ending and only walk static edges", () => {
    const edgeSet = new Set(graph.edges.map((e) => `${e.from}>${e.to}`));
    for (const [label, t] of Object.entries(graph.traversals)) {
      expect(t.end, label).toMatch(/^ending:/);
      for (let i = 0; i + 1 < t.route.length; i++) {
        const key = `${t.route[i]!.toLowerCase()}>${t.route[i + 1]!.toLowerCase()}`;
        expect(edgeSet.has(key), `${label}: dynamic edge ${key} missing statically`).toBe(true);
      }
    }
  });

  it("head dispatch rows exist where shared scenes resume (s_1a2)", () => {
    const n = graph.nodes["s_1a2"];
    expect(n).toBeDefined();
    expect(n!.headDispatch.some((d) => d.startsWith("var1203 == 1"))).toBe(true);
    expect(n!.headDispatch.some((d) => d.startsWith("var1203 == 2"))).toBe(true);
  });
});
