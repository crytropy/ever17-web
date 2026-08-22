import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { SessionRunner } from "../src/session.js";
import { fsSceneSource } from "../src/scene-source.js";
import { IR_DIR } from "./helpers.js";

const HAVE_IR = existsSync(`${IR_DIR}/op00.json`) && existsSync(`${IR_DIR}/y_ed.json`);

describe.skipIf(!HAVE_IR)("full-route sessions (New Game -> Ending)", () => {
  // Ever17's terminal-scene patterns (the runtime itself has no game default)
  const EVER17_ENDINGS = ["(ep|bd|_ed)$"];
  const run = (opts: ConstructorParameters<typeof SessionRunner>[1]) =>
    new SessionRunner(fsSceneSource(IR_DIR), { endingScenes: EVER17_ENDINGS, ...opts }).run("op00");

  it("policy=first completes the Takeshi/Tsugumi route to the ending", () => {
    const r = run({ policy: "first" });
    expect(r.end).toBe("ending");
    expect(r.route[0]).toBe("op00");
    expect(r.route[1]).toBe("t_1a"); // protagonist choice option 0 = Takeshi
    expect(r.route).toContain("tt6a");
    expect(r.route).toContain("tt7a");
    expect(r.route[r.route.length - 1]).toBe("y_ed");
    expect(r.totalLines).toBeGreaterThan(10_000);
    // no reachable unevaluable jumps and no unknown write modifications
    expect([...r.gaps.unevaluableJumps.keys()]).toEqual([]);
    expect([...r.gaps.unknownMods.keys()].filter((m) => m !== 0x14 && m !== 0x17)).toEqual([]);
  });

  it("the Kid-side protagonist choice routes into the s_* scenes", () => {
    const r = run({ policy: "first", choiceByScene: { "op00:7": 1 } });
    expect(r.end).toBe("ending");
    expect(r.route[1]).toBe("s_1a");
    // low affection under policy-first lands the You bad end
    expect(r.route).toContain("sybd");
    expect(r.route[r.route.length - 1]).toBe("y_ed");
  });

  it("policy=last reaches the Sara ending with its epilogue sandwich", () => {
    const r = run({ policy: "last" });
    expect(r.end).toBe("ending");
    expect(r.route).toContain("ss7a");
    // y_ed dispatches to the epilogue and returns for the coda
    const yi = r.route.indexOf("y_ed");
    expect(yi).toBeGreaterThan(0);
    expect(r.route.slice(yi)).toEqual(["y_ed", "ssep", "y_ed"]);
  });

  it("investigation menus terminate through their own gates", () => {
    const r = run({ policy: "first" });
    // t_1c presents its 3-location menu three times, then moves on
    const t1c = r.scenes.find((s) => s.scene === "t_1c");
    expect(t1c).toBeDefined();
    const menuPicks = t1c!.choices.filter((c) => c.id === 135);
    expect(menuPicks.map((c) => c.option)).toEqual([0, 1, 2]);
    // t_6b's ask-menu exits after two of three
    const t6b = r.scenes.find((s) => s.scene === "t_6b");
    expect(t6b!.choices.filter((c) => c.id === 214)).toHaveLength(2);
  });

  it("carries the cross-scene variable state the scripts rely on", () => {
    const r = run({ policy: "first" });
    // date variables end at the ending's reset, affection accumulated en route
    expect(r.vars.get(1207)).toBeGreaterThan(10); // Tsugumi affection from policy-first picks
    expect(r.vars.get(1033)).toBe(1); // "Tsugumi ending seen" completion flag set by y_ed
  });
});
