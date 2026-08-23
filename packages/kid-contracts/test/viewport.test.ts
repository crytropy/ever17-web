import { describe, expect, it } from "vitest";
import { transformForViewport, validateViewportState } from "../src/viewport.js";

/**
 * One implementation of "is this a camera", shared by the save migration,
 * player-data validation and the renderer - because three slightly different
 * opinions is how a zero width reaches a division.
 */
const canvas = { width: 800, height: 600 };

describe("what counts as a camera rectangle", () => {
  it("accepts the whole canvas, however it is spelled", () => {
    expect(validateViewportState(null).valid).toBe(true);
    expect(validateViewportState(undefined).valid).toBe(true);
    expect(validateViewportState({ x: null, y: null, w: null, h: null }).valid).toBe(true);
    expect(validateViewportState({ x: 0, y: 0, w: 800, h: 600 }).valid).toBe(true);
  });

  it("accepts a real crop", () => {
    expect(validateViewportState({ x: 100, y: 50, w: 400, h: 300 }).valid).toBe(true);
  });

  it("rejects anything that is not a rectangle", () => {
    for (const bad of ["bad", 7, true, [], [1, 2, 3, 4]]) {
      expect(validateViewportState(bad), JSON.stringify(bad)).toMatchObject({ valid: false });
    }
  });

  it("requires all four members", () => {
    expect(validateViewportState({}).reason).toMatch(/no x/);
    expect(validateViewportState({ x: 0, y: 0, w: 400 }).reason).toMatch(/no h/);
    expect(validateViewportState({ y: 0, w: 400, h: 300 }).reason).toMatch(/no x/);
    expect(validateViewportState({ x: 0, w: 400, h: 300 }).reason).toMatch(/no y/);
    expect(validateViewportState({ x: 0, y: 0, h: 300 }).reason).toMatch(/no w/);
  });

  it("rejects offsets that are not numbers", () => {
    for (const x of [NaN, Infinity, -Infinity, "0", {}]) {
      expect(validateViewportState({ x, y: 0, w: 400, h: 300 }), String(x)).toMatchObject({ valid: false });
    }
    expect(validateViewportState({ x: 0, y: NaN, w: 400, h: 300 }).reason).toMatch(/y is not a number/);
  });

  it("rejects dimensions that are not positive sizes", () => {
    for (const w of [0, -1, -100, NaN, Infinity, "400"]) {
      expect(validateViewportState({ x: 0, y: 0, w, h: 300 }), `w=${String(w)}`).toMatchObject({ valid: false });
    }
    for (const h of [0, -200, NaN, Infinity]) {
      expect(validateViewportState({ x: 0, y: 0, w: 400, h }), `h=${String(h)}`).toMatchObject({ valid: false });
    }
    expect(validateViewportState({ x: 0, y: 0, w: 0, h: 0 }).reason).toMatch(/w is not a positive size/);
  });

  it("allows a negative offset - a crop may sit off the canvas edge", () => {
    expect(validateViewportState({ x: -20, y: -10, w: 400, h: 300 }).valid).toBe(true);
  });
});

describe("the transform a rectangle means", () => {
  it("is identity for the whole canvas", () => {
    expect(transformForViewport(null, canvas)).toEqual({ scale: 1, pivotX: 0, pivotY: 0 });
    expect(transformForViewport({ x: 0, y: 0, w: 800, h: 600 }, canvas)).toEqual({ scale: 1, pivotX: 0, pivotY: 0 });
    expect(transformForViewport({ x: null, y: null, w: null, h: null }, canvas)).toEqual({ scale: 1, pivotX: 0, pivotY: 0 });
  });

  it("scales a crop deterministically", () => {
    expect(transformForViewport({ x: 0, y: 0, w: 400, h: 300 }, canvas)).toEqual({ scale: 2, pivotX: 0, pivotY: 0 });
    expect(transformForViewport({ x: 200, y: 150, w: 400, h: 300 }, canvas)).toEqual({ scale: 2, pivotX: 200, pivotY: 150 });
  });

  it("falls back to identity rather than returning a broken transform", () => {
    // The validator refuses these; this is only the last boundary before Pixi.
    for (const bad of [
      { x: 0, y: 0, w: 0, h: 0 },
      { x: 0, y: 0, w: -100, h: 200 },
      { x: Infinity, y: 0, w: 400, h: 300 },
      { x: 0, y: NaN, w: 400, h: 300 },
      { x: 0, y: 0, w: 400 },
      "bad",
    ] as unknown[]) {
      expect(transformForViewport(bad as never, canvas), JSON.stringify(bad))
        .toEqual({ scale: 1, pivotX: 0, pivotY: 0 });
    }
  });

  it("never returns a value the renderer cannot use", () => {
    const inputs: unknown[] = [
      null, undefined, "x", 0, {},
      { x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: -5, h: -5 },
      { x: Infinity, y: Infinity, w: Infinity, h: Infinity },
      { x: 1e308, y: 1e308, w: 1e-308, h: 1e-308 },
      { x: 0, y: 0, w: 400, h: 300 },
    ];
    for (const input of inputs) {
      const t = transformForViewport(input as never, canvas);
      expect(Number.isFinite(t.scale), `scale for ${JSON.stringify(input)}`).toBe(true);
      expect(t.scale, "a scale is strictly positive").toBeGreaterThan(0);
      expect(Number.isFinite(t.pivotX)).toBe(true);
      expect(Number.isFinite(t.pivotY)).toBe(true);
    }
  });

  it("is identity when the canvas itself is nonsense", () => {
    expect(transformForViewport({ x: 0, y: 0, w: 400, h: 300 }, { width: 0, height: 0 }))
      .toEqual({ scale: 1, pivotX: 0, pivotY: 0 });
  });
});
