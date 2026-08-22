import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { EVER17_PROFILE, EVER17_START_SCENE } from "../src/profile.js";
import { discoverInstallation, expectedFiles, fingerprintInstallation } from "../src/discover.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GAME_DIR = process.env["E17_GAME_DIR"] ?? join(root, "ever17games");
const HAVE_GAME = existsSync(join(GAME_DIR, "script.dat"));

describe("Ever17 profile", () => {
  it("carries the game knowledge the generic engine must not hardcode", () => {
    expect(EVER17_START_SCENE).toBe("op00");
    expect(EVER17_PROFILE.canvas).toEqual({ width: 800, height: 600 });
    expect(EVER17_PROFILE.spriteLogicalWidth).toBe(640);
    expect(EVER17_PROFILE.endingScenePatterns.length).toBeGreaterThan(0);
    // terminal-scene classification matches the phase-5 exploration results
    const res = EVER17_PROFILE.endingScenePatterns.map((s) => new RegExp(s, "i"));
    for (const ending of ["y_ed", "sybd", "ssep", "kbd", "ttep"]) {
      expect(res.some((re) => re.test(ending)), ending).toBe(true);
    }
    for (const ordinary of ["op00", "t_1a", "s_1a2", "tt6a", "kid07a"]) {
      expect(res.some((re) => re.test(ordinary)), ordinary).toBe(false);
    }
    // storage namespace pinned: changing it silently orphans existing saves
    expect(EVER17_PROFILE.storageNamespace).toBe("e17vn");
  });

  it("declares the expected source files from the actual pipeline", () => {
    const names = expectedFiles().map((f) => f.name);
    expect(names).toContain("script.dat");
    expect(names).toContain("bg.dat");
    expect(names).toContain("voice.dat");
  });
});

describe.skipIf(!HAVE_GAME)("installation discovery (real game files)", () => {
  it("validates the installation and fingerprints it stably", () => {
    const inst = discoverInstallation(GAME_DIR);
    expect(inst.problems).toEqual([]);
    expect(inst.missing).toEqual([]);
    expect(inst.scriptCount).toBeGreaterThan(100);
    const fp1 = fingerprintInstallation(inst);
    const fp2 = fingerprintInstallation(discoverInstallation(GAME_DIR));
    expect(fp1.fingerprint).toBe(fp2.fingerprint);
    expect(fp1.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    // every source file contributes a content digest, not just the scenario
    expect(fp1.files.map((f) => f.path)).toContain("script.dat");
    expect(fp1.files.map((f) => f.path)).toContain("voice.dat");
    expect(fp1.files.some((f) => f.path.startsWith("movie/"))).toBe(true);
  });

  it("refuses a directory that is not an Ever17 installation", () => {
    const inst = discoverInstallation(join(root, "packages"));
    expect(inst.problems.length).toBeGreaterThan(0);
  });
});
