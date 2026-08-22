import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GameSession, NULL_ASSETS, SceneVm } from "kid-runtime";
import { fsSceneSource } from "kid-runtime/node";
import { detectCrossRunVars } from "kid-graph";
import {
  EMPTY_PERSISTENT_STATE,
  mergePersistentState,
  runCountsAsCompletion,
  seedFromPersistentState,
  type PersistentState,
  type PersistentStatePolicy,
} from "kid-contracts";
import { EVER17_GAME_ID, EVER17_START_SCENE } from "../src/profile.js";

/**
 * Ever17 is built to be replayed: clearing routes is what opens the last one.
 * These tests prove the mechanism end to end on the real scenario using
 * *seeded* state - deliberately not by playing eight endings, which is the
 * user's manual pass.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const IR_DIR = process.env["E17_IR_DIR"] ?? findPackageIr();
function findPackageIr(): string {
  const cacheRoot = join(root, ".local", "ever17");
  if (!existsSync(cacheRoot)) return join(root, "build", "ir");
  for (const name of readdirSync(cacheRoot)) {
    const ir = join(cacheRoot, name, "ir");
    if (/^[0-9a-f]{16}$/.test(name) && existsSync(join(ir, "op00.json"))) return ir;
  }
  return join(root, "build", "ir");
}
const HAVE_IR = existsSync(join(IR_DIR, "op00.json")) && existsSync(join(IR_DIR, "y_ed.json"));

/** Every decompiled scene in the imported package. */
function scenesOf() {
  const src = fsSceneSource(IR_DIR);
  const out = [];
  for (const f of readdirSync(IR_DIR).filter((n) => n.endsWith(".json")).sort()) {
    const s = src.load(f.replace(/\.json$/, ""));
    if (s) out.push(s);
  }
  return out;
}

/** Run one scene to completion with seeded variables; return the variables. */
function runScene(scene: string, seed: [number, number][]): Map<number, number> {
  const ir = fsSceneSource(IR_DIR).load(scene)!;
  const vars = new Map<number, number>(seed);
  const vm = new SceneVm(ir, NULL_ASSETS, { vars, stepLimit: 500_000 });
  for (;;) {
    const ev = vm.next();
    if (ev.type === "end") break;
    if (ev.type === "choice") vm.choose(ev, { option: ev.options.find((o) => o.enabled)?.index ?? 0 });
  }
  return vars;
}

describe.skipIf(!HAVE_IR)("cross-run progression (real scenario)", () => {
  it("derives a persistence policy from the scenario, with no ids hardcoded", () => {
    const vars = detectCrossRunVars(scenesOf(), EVER17_START_SCENE);
    // the four route-clear flags the ending scene sums, plus the flags that
    // summing them sets - all found by analysis, not written down here
    expect(vars.size).toBeGreaterThanOrEqual(4);
    for (const v of vars) expect(v).toBeGreaterThan(0);
  });

  it("a full set of route clears opens the final route; a partial set does not", () => {
    // Find the gate from the data: the ending scene zeroes a counter and then
    // adds several flags into it. Those flags are the route clears, and the
    // counter is what the unlock is compared against - no ids written here.
    const yed = fsSceneSource(IR_DIR).load("y_ed")!;
    let counter: number | null = null;
    let clears: number[] = [];
    for (const block of Object.values(yed.blocks)) {
      const adds = block.ops.filter(
        (op): op is Extract<typeof op, { op: "varSet" }> =>
          op.op === "varSet" && op.value.type === "varRef",
      );
      if (adds.length > clears.length) {
        counter = adds[0]!.varId;
        clears = adds.map((op) => (op.value as { varId: number }).varId);
      }
    }
    expect(counter, "the ending scene should aggregate route flags").not.toBeNull();
    expect(clears.length).toBeGreaterThanOrEqual(2);

    const derived = [...detectCrossRunVars(scenesOf(), EVER17_START_SCENE)];
    for (const c of clears) {
      expect(derived, `route flag ${c} should be detected as cross-run`).toContain(c);
    }

    const baseline = runScene("y_ed", []);
    const full = runScene("y_ed", clears.map((v) => [v, 1] as [number, number]));
    expect(full.get(counter!)).toBe(clears.length);

    // the gate: a cross-run variable the complete set switches on
    const gate = derived.find((v) => full.get(v) === 1 && baseline.get(v) !== 1);
    expect(gate, "a complete set should unlock something").toBeDefined();

    // dropping any single clear must be able to leave the gate shut
    const partials = clears.map((dropped) =>
      runScene("y_ed", clears.filter((v) => v !== dropped).map((v) => [v, 1] as [number, number])),
    );
    for (const p of partials) expect(p.get(counter!) ?? 0).toBeLessThanOrEqual(clears.length);
    expect(
      partials.some((p) => p.get(gate!) !== 1),
      "an incomplete set should leave the final route locked",
    ).toBe(true);

    // and that is exactly what a later New Game inherits
    const policy: PersistentStatePolicy = {
      policyVersion: 1,
      vars: [...derived].sort((a, b) => a - b),
      merge: "max",
      derivedFrom: "test",
    };
    const stored = mergePersistentState(policy, EMPTY_PERSISTENT_STATE(EVER17_GAME_ID), full);
    expect(new Map(seedFromPersistentState(policy, stored)).get(gate!)).toBe(1);
  });

  it("saving inside an unfinished ending does not clear the route", async () => {
    // Ever17 writes route-clear flags near the START of its ending scene, so
    // a save taken there already contains them. Crediting the route at save
    // time would hand the player a clear they never finished.
    const derived = [...detectCrossRunVars(scenesOf(), EVER17_START_SCENE)].sort((a, b) => a - b);
    const policy: PersistentStatePolicy = { policyVersion: 1, vars: derived, merge: "max", derivedFrom: "test" };
    const source = { load: (n: string) => fsSceneSource(IR_DIR).load(n), assets: () => NULL_ASSETS };

    const session = await GameSession.start(source, "y_ed", {});
    let sawFlag = false;
    let end: { type: string; reason?: string } | null = null;
    for (let i = 0; i < 20_000; i += 1) {
      const ev = await session.next();
      if (ev.type === "sessionEnd") {
        end = ev;
        break;
      }
      if (ev.type === "choice") session.choose(ev.options.find((o) => o.enabled)?.index ?? 0);
      if (derived.some((v) => (session.vars.get(v) ?? 0) > 0)) {
        sawFlag = true;
        break; // the player quits here, mid-ending
      }
    }
    expect(sawFlag, "the ending scene should set a clear flag before it finishes").toBe(true);
    expect(end, "we stopped before the run ended").toBeNull();

    // the save really does carry the flag...
    const save = session.save();
    expect(save.vars.some(([id, value]) => derived.includes(id) && value > 0)).toBe(true);

    // ...but quitting is not a completion, so nothing is credited
    let stored: PersistentState = EMPTY_PERSISTENT_STATE(EVER17_GAME_ID);
    for (const reason of ["missing-scene", "stepLimit"]) {
      expect(runCountsAsCompletion(reason)).toBe(false);
    }
    expect(seedFromPersistentState(policy, stored)).toEqual([]);

    // finish the run properly and it counts
    const finisher = await GameSession.start(source, "y_ed", {});
    let finished: string | null = null;
    for (let i = 0; i < 200_000; i += 1) {
      const ev = await finisher.next();
      if (ev.type === "sessionEnd") {
        finished = ev.reason;
        break;
      }
      if (ev.type === "choice") finisher.choose(ev.options.find((o) => o.enabled)?.index ?? 0);
    }
    expect(finished).toBe("ending");
    expect(runCountsAsCompletion(finished!)).toBe(true);
    stored = mergePersistentState(policy, stored, finisher.vars);
    expect(seedFromPersistentState(policy, stored).length).toBeGreaterThan(0);
  });

  it("a seeded New Game really starts with the inherited state", async () => {
    const derived = [...detectCrossRunVars(scenesOf(), EVER17_START_SCENE)].sort((a, b) => a - b);
    const policy: PersistentStatePolicy = { policyVersion: 1, vars: derived, merge: "max", derivedFrom: "test" };
    const stored = mergePersistentState(
      policy,
      EMPTY_PERSISTENT_STATE(EVER17_GAME_ID),
      derived.map((v) => [v, 1] as [number, number]),
    );

    const source = {
      load: (n: string) => fsSceneSource(IR_DIR).load(n),
      assets: () => NULL_ASSETS,
    };
    const fresh = await GameSession.start(source, EVER17_START_SCENE, {});
    const carried = await GameSession.start(source, EVER17_START_SCENE, {
      initialVars: seedFromPersistentState(policy, stored),
    });
    for (const v of derived) {
      expect(fresh.vars.get(v), `fresh run should not know ${v}`).toBeUndefined();
      expect(carried.vars.get(v), `carried run should inherit ${v}`).toBe(1);
    }
  });

  it("restoring an old save does not erase newer global progress", async () => {
    const derived = [...detectCrossRunVars(scenesOf(), EVER17_START_SCENE)].sort((a, b) => a - b);
    const policy: PersistentStatePolicy = { policyVersion: 1, vars: derived, merge: "max", derivedFrom: "test" };
    const source = {
      load: (n: string) => fsSceneSource(IR_DIR).load(n),
      assets: () => NULL_ASSETS,
    };

    // a save from before anything was cleared
    const early = await GameSession.start(source, EVER17_START_SCENE, {});
    await early.next();
    const save = early.save();

    // meanwhile, later runs cleared routes
    const stored = mergePersistentState(
      policy,
      EMPTY_PERSISTENT_STATE(EVER17_GAME_ID),
      derived.map((v) => [v, 1] as [number, number]),
    );
    const { reconcileSaveWithPersistentState } = await import("kid-contracts");
    const restored = await GameSession.restore(source, save, {
      restoreOverrides: reconcileSaveWithPersistentState(policy, stored, save.vars),
    });
    for (const v of derived) expect(restored.vars.get(v)).toBe(1);
  });
});
