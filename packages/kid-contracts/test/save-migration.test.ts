import { describe, expect, it } from "vitest";
import { SAVE_FORMAT, SAVE_VERSION } from "../src/save.js";
import { LEGACY_PICTURE_INCOMPLETE_MESSAGE, migrateSave } from "../src/save-migration.js";

/**
 * v2 records the full-screen CG; v1 did not record it at all. "The format
 * never asked" is a different fact from "there was no CG", and reading the
 * first as the second is what restored a white fill where the artwork
 * belonged. These pin which legacy saves can be proven and which cannot.
 */

const layer = (asset: string) => ({ asset, file: `images/${asset}.png`, width: 800, height: 600, x: null, slot: null });

const save = (presentation: Record<string, unknown>, opts: { version?: number; actions?: unknown[] } = {}) => ({
  format: SAVE_FORMAT,
  version: opts.version ?? 1,
  vm: {
    scene: "s",
    block: "b0",
    pc: 0,
    steps: 1,
    presentation: { background: null, sprites: [], bgm: null, fill: null, ...presentation },
    ...(opts.actions ? { actions: opts.actions } : {}),
  },
  vars: [],
  sysVars: [],
  counters: { lines: 1, scenes: 1 },
  route: ["s"],
  backlog: [],
});

const cgOf = (r: ReturnType<typeof migrateSave>) => (r.ok ? r.save.vm.presentation.cg : "refused");

describe("a current save", () => {
  it("round-trips an active CG exactly, untouched", () => {
    const doc = save({ cg: layer("cg01"), fill: 1 }, { version: 2 });
    const result = migrateSave(doc);
    expect(result.ok).toBe(true);
    expect(result.ok && result.migrated, "nothing to migrate").toBe(false);
    expect(cgOf(result)).toMatchObject({ asset: "cg01", file: "images/cg01.png" });
  });

  it("round-trips a proven absence of CG", () => {
    const result = migrateSave(save({ cg: null, background: layer("bg01") }, { version: 2 }));
    expect(result.ok).toBe(true);
    expect(cgOf(result)).toBeNull();
  });

  it("rejects a v2 save that is missing its CG state", () => {
    // absent at v2 is malformed, not legacy: it must not fall into either path
    const result = migrateSave(save({ fill: 1 }, { version: 2 }));
    expect(result).toMatchObject({ ok: false, reason: "invalid-save" });
  });

  it("rejects a malformed v2 CG", () => {
    for (const bad of [{ file: "x.png" }, 7, "cg01", { asset: "" }]) {
      expect(migrateSave(save({ cg: bad }, { version: 2 })), String(bad)).toMatchObject({
        ok: false,
        reason: "invalid-save",
      });
    }
  });
});

describe("a legacy save the data can vouch for", () => {
  it("refuses a background whose deltas say nothing about the CG layer", () => {
    // A CG shown by an earlier event stays over this background until a later
    // setBackground or fillScreen replaces it, so a recorded background does
    // not prove the background is what the player was looking at.
    expect(migrateSave(save({ background: layer("bg01"), fill: null })))
      .toMatchObject({ ok: false, reason: "legacy-picture-incomplete" });
  });

  it("migrates one whose actions show a CG still standing", () => {
    const result = migrateSave(save({ fill: 1 }, {
      actions: [
        { kind: "fillScreen", color: 1, fade: null },
        { kind: "cgEffect", asset: "cg01", file: "images/cg01.png", args: [] },
      ],
    }));
    expect(result).toMatchObject({ ok: true, migrated: true });
    expect(cgOf(result)).toMatchObject({ asset: "cg01", file: "images/cg01.png" });
  });

  it("migrates one whose actions replace the CG with a background", () => {
    const result = migrateSave(save({ background: layer("bg01") }, {
      actions: [
        { kind: "cgEffect", asset: "cg01", file: "images/cg01.png", args: [] },
        { kind: "setBackground", layer: layer("bg01"), fade: null },
      ],
    }));
    expect(result).toMatchObject({ ok: true, migrated: true });
    expect(cgOf(result), "the background took the screen back").toBeNull();
  });

  it("migrates one whose actions replace the CG with a fill", () => {
    const result = migrateSave(save({ fill: 0 }, {
      actions: [
        { kind: "cgEffect", asset: "cg01", file: "images/cg01.png", args: [] },
        { kind: "fillScreen", color: 0, fade: null },
      ],
    }));
    expect(result).toMatchObject({ ok: true, migrated: true });
    expect(cgOf(result)).toBeNull();
  });

  it("lets the actions outrank the settled state when a CG is drawn over a background", () => {
    const result = migrateSave(save({ background: layer("bg01") }, {
      actions: [
        { kind: "setBackground", layer: layer("bg01"), fade: null },
        { kind: "cgEffect", asset: "cg02", file: "images/cg02.png", args: [] },
      ],
    }));
    expect(cgOf(result)).toMatchObject({ asset: "cg02" });
  });

  it("treats a cgEffect with no resolved file as nothing drawn", () => {
    const result = migrateSave(save({ fill: 1 }, {
      actions: [{ kind: "cgEffect", asset: "missing", file: null, args: [] }],
    }));
    expect(result).toMatchObject({ ok: true });
    expect(cgOf(result)).toBeNull();
  });

  it("refuses an empty picture, which an earlier CG may still be covering", () => {
    expect(migrateSave(save({ background: null, fill: null })))
      .toMatchObject({ ok: false, reason: "legacy-picture-incomplete" });
  });

  it("leaves the stored save untouched while migrating a copy", () => {
    const doc = save({ fill: 1 }, { actions: [{ kind: "cgEffect", asset: "cg01", file: "images/cg01.png", args: [] }] });
    const before = JSON.stringify(doc);
    migrateSave(doc);
    expect(JSON.stringify(doc), "migration reads; it does not edit").toBe(before);
  });
});

describe("a legacy save the data cannot vouch for", () => {
  it("refuses a bare fill with nothing to identify what was over it", () => {
    const result = migrateSave(save({ background: null, fill: 1 }));
    expect(result).toMatchObject({ ok: false, reason: "legacy-picture-incomplete" });
    expect(result.ok === false && result.message).toBe(LEGACY_PICTURE_INCOMPLETE_MESSAGE);
  });

  it("refuses a bare fill of any colour, not just white", () => {
    // black is no more knowable than white; both may be hiding a CG
    expect(migrateSave(save({ background: null, fill: 0 }))).toMatchObject({
      ok: false,
      reason: "legacy-picture-incomplete",
    });
  });

  it("refuses even when unrelated deltas are present", () => {
    const result = migrateSave(save({ fill: 1 }, {
      actions: [{ kind: "wait", amount: 5, unit: "vm" }, { kind: "transitionSync" }],
    }));
    expect(result).toMatchObject({ ok: false, reason: "legacy-picture-incomplete" });
  });

  it("says so in words a player can act on", () => {
    const result = migrateSave(save({ fill: 1 }));
    expect(result.ok === false && result.message).toMatch(/older build/);
    expect(result.ok === false && result.message).toMatch(/Load another save or start a new game/);
    expect(result.ok === false && result.message, "no jargon, no file names").not.toMatch(/cg|null|version|presentation/i);
  });
});

describe("input that is not a save at all", () => {
  it("refuses nonsense, foreign formats and versions from the future", () => {
    expect(migrateSave(null)).toMatchObject({ ok: false, reason: "invalid-save" });
    expect(migrateSave("save")).toMatchObject({ ok: false, reason: "invalid-save" });
    expect(migrateSave({ format: "other", version: 1 })).toMatchObject({ ok: false, reason: "invalid-save" });
    expect(migrateSave({ format: SAVE_FORMAT, version: 99 })).toMatchObject({ ok: false, reason: "unsupported-version" });
    expect(migrateSave({ format: SAVE_FORMAT, version: 2 })).toMatchObject({ ok: false, reason: "invalid-save" });
    expect(migrateSave({ format: SAVE_FORMAT, version: 1, vm: {} })).toMatchObject({ ok: false, reason: "invalid-save" });
  });
});
