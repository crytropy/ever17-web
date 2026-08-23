import { describe, expect, it } from "vitest";
import { SAVE_FORMAT, SAVE_VERSION } from "../src/save.js";
import { LEGACY_PICTURE_INCOMPLETE_MESSAGE, migrateSave } from "../src/save-migration.js";

/**
 * Each save version added a piece of the picture that outlives the event
 * which set it: v2 the full-screen CG, v3 the camera. An older save cannot
 * say what it never recorded, and "the format never asked" is not the same
 * fact as "there was none" - reading the first as the second is what restored
 * a white fill where the artwork belonged.
 *
 * So the only thing that can speak for a missing piece is an action in the
 * saved event that touches it. Everything else is a guess.
 */

const layer = (asset: string) => ({ asset, file: `images/${asset}.png`, width: 800, height: 600, x: null, slot: null });
const rect = (w: number, h: number) => ({ kind: "viewportRect", x: 0, y: 0, w, h, frames: 30 });
const cgAction = (asset: string) => ({ kind: "cgEffect", asset, file: `images/${asset}.png`, args: [] });

const save = (presentation: Record<string, unknown>, opts: { version?: number; actions?: unknown[] } = {}) => ({
  format: SAVE_FORMAT,
  version: opts.version ?? 1,
  vm: {
    scene: "s", block: "b0", pc: 0, steps: 1,
    presentation: { background: null, sprites: [], bgm: null, fill: null, ...presentation },
    ...(opts.actions ? { actions: opts.actions } : {}),
  },
  vars: [], sysVars: [], counters: { lines: 1, scenes: 1 }, route: ["s"], backlog: [],
});

const cgOf = (r: ReturnType<typeof migrateSave>) => (r.ok ? r.save.vm.presentation.cg : "refused");
const viewOf = (r: ReturnType<typeof migrateSave>) => (r.ok ? r.save.vm.presentation.viewport : "refused");

describe("a current save", () => {
  const v3 = (p: Record<string, unknown>) => save({ cg: null, viewport: null, ...p }, { version: SAVE_VERSION });

  it("round-trips untouched", () => {
    const r = migrateSave(v3({ cg: layer("cg01"), viewport: { x: 0, y: 0, w: 400, h: 300 } }));
    expect(r).toMatchObject({ ok: true, migrated: false });
    expect(cgOf(r)).toMatchObject({ asset: "cg01" });
    expect(viewOf(r)).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });

  it("round-trips proven absences", () => {
    const r = migrateSave(v3({ background: layer("bg01") }));
    expect(r).toMatchObject({ ok: true, migrated: false });
    expect(cgOf(r)).toBeNull();
    expect(viewOf(r)).toBeNull();
  });

  it("must be explicit about everything that outlives an event", () => {
    const noCg = save({ viewport: null, fill: 1 }, { version: SAVE_VERSION });
    expect(migrateSave(noCg)).toMatchObject({ ok: false, reason: "invalid-save" });
    const noViewport = save({ cg: null, fill: 1 }, { version: SAVE_VERSION });
    expect(migrateSave(noViewport)).toMatchObject({ ok: false, reason: "invalid-save" });
  });

  it("rejects a malformed CG", () => {
    for (const bad of [{ file: "x.png" }, 7, "cg01", { asset: "" }]) {
      expect(migrateSave(v3({ cg: bad })), String(bad)).toMatchObject({ ok: false, reason: "invalid-save" });
    }
  });
});

describe("what the deltas can prove", () => {
  it("migrates a v1 whose last relevant action is a cgEffect", () => {
    const r = migrateSave(save({ fill: 1 }, { actions: [rect(800, 600), cgAction("cg01")] }));
    expect(r).toMatchObject({ ok: true, migrated: true });
    expect(cgOf(r)).toMatchObject({ asset: "cg01" });
    expect(viewOf(r)).toEqual({ x: 0, y: 0, w: 800, h: 600 });
    expect(r.ok && r.save.version).toBe(SAVE_VERSION);
  });

  it("migrates a v1 whose last relevant action is a setBackground", () => {
    const r = migrateSave(save({ background: layer("bg01") }, {
      actions: [cgAction("cg01"), { kind: "setBackground", layer: layer("bg01"), fade: null }, rect(800, 600)],
    }));
    expect(r).toMatchObject({ ok: true, migrated: true });
    expect(cgOf(r), "the background took the screen back").toBeNull();
  });

  it("migrates a v1 whose last relevant action is a fillScreen", () => {
    const r = migrateSave(save({ fill: 0 }, {
      actions: [cgAction("cg01"), { kind: "fillScreen", color: 0, fade: null }, rect(800, 600)],
    }));
    expect(r).toMatchObject({ ok: true, migrated: true });
    expect(cgOf(r)).toBeNull();
  });

  it("keeps action order authoritative", () => {
    const r = migrateSave(save({ background: layer("bg01") }, {
      actions: [{ kind: "setBackground", layer: layer("bg01"), fade: null }, cgAction("cg02"), rect(800, 600)],
    }));
    expect(cgOf(r), "the CG was drawn after the background").toMatchObject({ asset: "cg02" });
  });

  it("recovers the camera from the last viewportRect", () => {
    const r = migrateSave(save({ fill: 1 }, { actions: [cgAction("cg01"), rect(400, 300), rect(200, 150)] }));
    expect(viewOf(r)).toEqual({ x: 0, y: 0, w: 200, h: 150 });
  });

  it("treats a cgEffect with no resolved file as nothing drawn", () => {
    const r = migrateSave(save({ fill: 1 }, {
      actions: [{ kind: "cgEffect", asset: "missing", file: null, args: [] }, rect(800, 600)],
    }));
    expect(r).toMatchObject({ ok: true });
    expect(cgOf(r)).toBeNull();
  });

  it("upgrades a v2 whose deltas prove the camera", () => {
    const r = migrateSave(save({ cg: layer("cg01"), fill: 1 }, { version: 2, actions: [rect(400, 300)] }));
    expect(r).toMatchObject({ ok: true, migrated: true });
    expect(cgOf(r), "v2 already knew its CG").toMatchObject({ asset: "cg01" });
    expect(viewOf(r)).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });
});

describe("what nothing can prove", () => {
  const refused = { ok: false, reason: "legacy-picture-incomplete" };

  it("refuses a v1 background whose deltas are silent", () => {
    // a CG from an earlier event may still be covering this background
    expect(migrateSave(save({ background: layer("bg01") }))).toMatchObject(refused);
  });

  it("refuses a v1 fill whose deltas are silent", () => {
    expect(migrateSave(save({ fill: 1 }))).toMatchObject(refused);
    expect(migrateSave(save({ fill: 0 }))).toMatchObject(refused);
  });

  it("refuses a v1 empty picture whose deltas are silent", () => {
    // an earlier persistent CG may be on screen even with nothing recorded
    expect(migrateSave(save({ background: null, fill: null }))).toMatchObject(refused);
  });

  it("refuses when the deltas touch neither layer", () => {
    expect(migrateSave(save({ background: layer("bg01") }, {
      actions: [{ kind: "wait", amount: 5, unit: "vm" }, { kind: "transitionSync" }],
    }))).toMatchObject(refused);
  });

  it("refuses a v1 that proves the CG but not the camera", () => {
    expect(migrateSave(save({ fill: 1 }, { actions: [cgAction("cg01")] }))).toMatchObject(refused);
  });

  it("refuses a v2 whose deltas do not prove the camera", () => {
    expect(migrateSave(save({ cg: null, background: layer("bg01") }, { version: 2 }))).toMatchObject(refused);
  });

  it("says so in words a player can act on", () => {
    const r = migrateSave(save({ fill: 1 }));
    expect(r.ok === false && r.message).toBe(LEGACY_PICTURE_INCOMPLETE_MESSAGE);
    expect(r.ok === false && r.message).toMatch(/Load another save or start a new game/);
    expect(r.ok === false && r.message, "no jargon").not.toMatch(/cg|viewport|null|version/i);
  });
});

describe("migration is a read", () => {
  it("never edits the stored bytes", () => {
    for (const doc of [
      save({ background: layer("bg01") }),
      save({ fill: 1 }, { actions: [cgAction("cg01"), rect(800, 600)] }),
      save({ cg: null, viewport: null }, { version: SAVE_VERSION }),
    ]) {
      const before = JSON.stringify(doc);
      migrateSave(doc);
      expect(JSON.stringify(doc), "migration reads; it does not edit").toBe(before);
    }
  });
});

describe("input that is not a save at all", () => {
  it("refuses nonsense, foreign formats and versions from the future", () => {
    expect(migrateSave(null)).toMatchObject({ ok: false, reason: "invalid-save" });
    expect(migrateSave("save")).toMatchObject({ ok: false, reason: "invalid-save" });
    expect(migrateSave({ format: "other", version: 1 })).toMatchObject({ ok: false, reason: "invalid-save" });
    expect(migrateSave({ format: SAVE_FORMAT, version: 99 })).toMatchObject({ ok: false, reason: "unsupported-version" });
    expect(migrateSave({ format: SAVE_FORMAT, version: 1, vm: {} })).toMatchObject({ ok: false, reason: "invalid-save" });
  });
});
