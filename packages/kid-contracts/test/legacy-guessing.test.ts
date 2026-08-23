import { describe, expect, it } from "vitest";
import { SAVE_FORMAT } from "../src/save.js";
import { migrateSave } from "../src/save-migration.js";

/** STAGE 0 REGRESSION 1: migration still guesses from background/fill alone. */
const v1 = (presentation: Record<string, unknown>, actions: unknown[] = []) => ({
  format: SAVE_FORMAT, version: 1,
  vm: { scene: "s", block: "b0", pc: 0, steps: 1,
        presentation: { background: null, sprites: [], bgm: null, fill: null, ...presentation },
        actions },
  vars: [], sysVars: [], counters: { lines: 1, scenes: 1 }, route: ["s"], backlog: [],
});

const bg = { asset: "bg01", file: "images/bg01.png", width: null, height: null, x: null, slot: null };

describe("v1 migration must not guess", () => {
  it("refuses a background whose actions say nothing about the CG layer", () => {
    // A CG shown by an EARLIER event stays over this background until a later
    // setBackground/fillScreen replaces it. This event's deltas are silent, so
    // the picture is not proven.
    expect(migrateSave(v1({ background: bg }))).toMatchObject({
      ok: false, reason: "legacy-picture-incomplete",
    });
  });

  it("refuses an empty picture whose actions say nothing", () => {
    expect(migrateSave(v1({ background: null, fill: null }))).toMatchObject({
      ok: false, reason: "legacy-picture-incomplete",
    });
  });
});
