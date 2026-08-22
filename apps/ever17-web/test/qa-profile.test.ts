import { describe, expect, it } from "vitest";
import { EVER17_PROFILE } from "ever17-pc";
import { ever17PackageMeta, isQaNamespace, qaStorageNamespace } from "../src/branding.js";

/**
 * Automated browser runs must never write into a real player's profile. A QA
 * run that recorded an ending or a route-clear flag would show up in their
 * Continue button and RECORDS screen, and cross-run progress is exactly the
 * kind of state that is easy to miss and awkward to undo by hand.
 *
 * Everything a player owns is keyed off the storage namespace, so proving the
 * QA namespace is distinct proves saves, progress and the completion database
 * are all isolated together.
 */

const PRODUCTION = EVER17_PROFILE.storageNamespace;

describe("QA player-data isolation", () => {
  it("never collides with the namespace a real player uses", () => {
    for (const profile of ["phase6-abc123", "smoke", "closure audit", "0"]) {
      const ns = qaStorageNamespace(profile);
      expect(ns, profile).not.toBe(PRODUCTION);
      expect(isQaNamespace(ns), profile).toBe(true);
    }
    expect(isQaNamespace(PRODUCTION)).toBe(false);
  });

  it("isolates saves, progress and the completion database together", () => {
    const ns = qaStorageNamespace("phase6-run");
    // every gameplay key derives from the namespace, so one check covers all
    expect(`${ns}:save:1`).not.toBe(`${PRODUCTION}:save:1`);
    expect(`${ns}:progress`).not.toBe(`${PRODUCTION}:progress`);
    expect(`${ns}-completion`).not.toBe(`${PRODUCTION}-completion`);
    expect(`${ns}:playdata`).not.toBe(`${PRODUCTION}:playdata`);
  });

  it("gives different profiles different namespaces", () => {
    expect(qaStorageNamespace("run-a")).not.toBe(qaStorageNamespace("run-b"));
  });

  it("normalizes anything a caller passes into a usable namespace", () => {
    expect(qaStorageNamespace("  Phase 6 / Closure  ")).toBe(`${PRODUCTION}-qa-phase-6-closure`);
    expect(qaStorageNamespace("!!!")).toBe(`${PRODUCTION}-qa-unnamed`);
  });

  it("an ordinary serve still uses the production namespace", () => {
    // the default metadata a plain `ever17 serve` hands the browser
    expect(ever17PackageMeta().profile.storageNamespace).toBe(PRODUCTION);
    expect(isQaNamespace(ever17PackageMeta().profile.storageNamespace)).toBe(false);
  });

  it("a QA override changes only the namespace, not the game package", () => {
    const base = ever17PackageMeta();
    const qa = {
      ...base,
      profile: { ...base.profile, storageNamespace: qaStorageNamespace("run") },
    };
    expect(qa.gameId).toBe(base.gameId);
    expect(qa.startScene).toBe(base.startScene);
    expect(qa.profile.canvas).toEqual(base.profile.canvas);
    expect(qa.profile.endingScenePatterns).toEqual(base.profile.endingScenePatterns);
    expect(qa.profile.storageNamespace).not.toBe(base.profile.storageNamespace);
  });
});
