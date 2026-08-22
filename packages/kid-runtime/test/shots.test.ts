import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decodePng } from "../src/frame.js";

/**
 * Visual regression over the Pixi renderer.
 *
 * Shots are produced by the browser harness (`vn serve`, then open
 * /shots.html) into build/shots/current, from the committed fixtures in
 * test/__shots__/fixtures.json. Baselines live in build/shots/baseline -
 * intentionally OUTSIDE git, because every pixel derives from the user's
 * copyrighted game assets; the committed artefacts are the fixtures (asset
 * names + coordinates only) and this comparator.
 *
 * Flow: `cp -r build/shots/current build/shots/baseline` once to accept,
 * then any renderer change is checked by regenerating current shots.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CURRENT = process.env["E17_SHOTS_CURRENT"] ?? join(root, "build", "shots", "current");
const BASELINE = process.env["E17_SHOTS_BASELINE"] ?? join(root, "build", "shots", "baseline");
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__shots__", "fixtures.json");

const HAVE = existsSync(CURRENT) && existsSync(BASELINE) && existsSync(FIXTURES);

/** Fraction of pixels differing by more than `tol` in any channel. */
function diffFraction(a: ReturnType<typeof decodePng>, b: ReturnType<typeof decodePng>, tol = 8): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let bad = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (
      Math.abs(a.rgba[o]! - b.rgba[o]!) > tol ||
      Math.abs(a.rgba[o + 1]! - b.rgba[o + 1]!) > tol ||
      Math.abs(a.rgba[o + 2]! - b.rgba[o + 2]!) > tol
    ) {
      bad += 1;
    }
  }
  return bad / n;
}

describe.skipIf(!HAVE)("visual regression shots (Pixi renderer)", () => {
  const fixtures = HAVE
    ? (JSON.parse(readFileSync(FIXTURES, "utf8")) as { name: string }[])
    : [];

  it("every committed fixture has a current shot", () => {
    for (const f of fixtures) {
      expect(existsSync(join(CURRENT, `${f.name}.png`)), f.name).toBe(true);
    }
  });

  it("shots are stage-sized and mostly non-trivial", () => {
    let nonFlat = 0;
    for (const f of fixtures) {
      const img = decodePng(readFileSync(join(CURRENT, `${f.name}.png`)));
      expect([img.width, img.height], f.name).toEqual([800, 600]);
      // count distinct sampled colours: a broken render is a flat frame
      const seen = new Set<number>();
      for (let i = 0; i < img.rgba.length; i += 4 * 997) {
        seen.add((img.rgba[i]! << 16) | (img.rgba[i + 1]! << 8) | img.rgba[i + 2]!);
      }
      if (seen.size > 8) nonFlat += 1;
    }
    // fill/effect fixtures are legitimately flat; the scene fixtures must not be
    expect(nonFlat).toBeGreaterThanOrEqual(4);
  });

  for (const name of readdirSync(existsSync(BASELINE) ? BASELINE : ".").filter((f) => f.endsWith(".png"))) {
    it(`matches baseline: ${name}`, () => {
      const cur = join(CURRENT, name);
      expect(existsSync(cur), `current shot missing for baseline ${name}`).toBe(true);
      const a = decodePng(readFileSync(cur));
      const b = decodePng(readFileSync(join(BASELINE, name)));
      const frac = diffFraction(a, b);
      expect(frac, `${name}: ${(frac * 100).toFixed(2)}% of pixels differ`).toBeLessThan(0.01);
    });
  }
});
