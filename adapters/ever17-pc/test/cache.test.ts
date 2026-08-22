import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GAME_PACKAGE_FORMAT,
  GAME_PACKAGE_SCHEMA_VERSION,
  IMPORT_REPORT_FORMAT,
  IMPORT_REPORT_VERSION,
  IR_SCHEMA_VERSION,
  KID_ENGINE_VERSION,
  MANIFEST_SCHEMA_VERSION,
  PROFILE_VERSION,
  isCompatibleEngineVersion,
  type GamePackageMeta,
  type ImportReport,
} from "kid-contracts";
import { validateCachedPackage } from "../src/cache.js";
import { cleanupAbandonedBuilds, promoteDirectory } from "../src/promotion.js";
import { FINGERPRINT_ALGO } from "../src/fingerprint.js";
import { EVER17_GAME_ID, EVER17_PROFILE, EVER17_START_SCENE } from "../src/profile.js";

/**
 * Cache validation decides whether previously converted game content may be
 * served. These fixtures are synthetic packages - the shapes matter, not the
 * game data - so every rejection path can be exercised cheaply.
 */

const FINGERPRINT = "abcdef0123456789";
const SCENES = ["op00", "t_1a", "y_ed"];

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "e17cache-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Overrides {
  meta?: Partial<GamePackageMeta>;
  report?: Partial<ImportReport>;
  manifest?: unknown;
  scenes?: string[];
  omit?: ("game.json" | "import-report.json" | "manifest.json" | "ir")[];
}

/** Write a package that validates, then apply the requested damage. */
function fixture(o: Overrides = {}): string {
  const dir = join(tempDir(), FINGERPRINT);
  const omit = new Set(o.omit ?? []);
  mkdirSync(join(dir, "assets"), { recursive: true });
  const scenes = o.scenes ?? SCENES;

  if (!omit.has("ir")) {
    mkdirSync(join(dir, "ir"), { recursive: true });
    for (const s of scenes) {
      writeFileSync(
        join(dir, "ir", `${s}.json`),
        JSON.stringify({
          formatVersion: IR_SCHEMA_VERSION,
          scene: s,
          entry: "00000010",
          blocks: { "00000010": { next: null, ops: [{ op: "dialogue", text: "x", speaker: null, voice: null }] } },
          warnings: [],
          meta: { sceneIds: [], textChunks: 1, resources: [], unknownOpcodeCount: 0, coverage: 1 },
        }),
      );
    }
  }
  if (!omit.has("manifest.json")) {
    writeFileSync(
      join(dir, "assets", "manifest.json"),
      JSON.stringify(
        o.manifest ?? {
          formatVersion: MANIFEST_SCHEMA_VERSION,
          assets: { bg01a1: { name: "bg01a1", kind: "image", archive: "bg.dat", file: "images/bg01a1.png" } },
          missing: [],
          generatedFrom: scenes,
        },
      ),
    );
  }
  if (!omit.has("import-report.json")) {
    const report: ImportReport = {
      format: IMPORT_REPORT_FORMAT,
      version: IMPORT_REPORT_VERSION,
      status: "complete",
      gameId: EVER17_GAME_ID,
      sourceFingerprint: FINGERPRINT,
      generatedAt: new Date(0).toISOString(),
      durationMs: 1,
      schemaVersions: {
        package: GAME_PACKAGE_SCHEMA_VERSION,
        manifest: MANIFEST_SCHEMA_VERSION,
        ir: IR_SCHEMA_VERSION,
        profile: PROFILE_VERSION,
        engine: KID_ENGINE_VERSION,
        fingerprintAlgo: FINGERPRINT_ALGO,
      },
      scripts: { discovered: scenes.length, decompiled: scenes.length, failed: 0, scenes, failures: [] },
      assets: { referenced: 1, indexed: 1, missing: 0, missingStory: 0, missingSystem: 0 },
      movies: { referenced: 0, converted: 0, missingSource: 0, unconverted: 0 },
      issues: [],
      warnings: [],
      ...o.report,
    };
    writeFileSync(join(dir, "import-report.json"), JSON.stringify(report));
  }
  if (!omit.has("game.json")) {
    const meta: GamePackageMeta = {
      format: GAME_PACKAGE_FORMAT,
      schemaVersion: GAME_PACKAGE_SCHEMA_VERSION,
      engineVersion: KID_ENGINE_VERSION,
      gameId: EVER17_GAME_ID,
      title: "Ever17",
      sourceFingerprint: FINGERPRINT,
      startScene: EVER17_START_SCENE,
      profile: EVER17_PROFILE,
      paths: { ir: "ir", assets: "assets", movies: "assets/movies" },
      ...o.meta,
    };
    writeFileSync(join(dir, "game.json"), JSON.stringify(meta));
  }
  return dir;
}

const baseVersions = {
  package: GAME_PACKAGE_SCHEMA_VERSION,
  manifest: MANIFEST_SCHEMA_VERSION,
  ir: IR_SCHEMA_VERSION,
  profile: PROFILE_VERSION,
  engine: KID_ENGINE_VERSION,
  fingerprintAlgo: FINGERPRINT_ALGO,
};

const check = (packageDir: string, extra: Partial<Parameters<typeof validateCachedPackage>[0]> = {}) =>
  validateCachedPackage({
    packageDir,
    fingerprint: FINGERPRINT,
    fingerprintAlgo: FINGERPRINT_ALGO,
    gameId: EVER17_GAME_ID,
    startScene: EVER17_START_SCENE,
    ...extra,
  });

describe("cache validation", () => {
  it("accepts a complete, current package", () => {
    const v = check(fixture());
    expect(v.reasons).toEqual([]);
    expect(v.valid).toBe(true);
    expect(v.mustRebuild).toBe(false);
    expect(v.meta?.gameId).toBe(EVER17_GAME_ID);
    expect(v.report?.status).toBe("complete");
  });

  it("rejects a package directory that does not exist", () => {
    const v = check(join(tempDir(), "nope"));
    expect(v.valid).toBe(false);
    expect(v.mustRebuild).toBe(true);
    expect(v.reasons[0]).toMatch(/no cached package/);
  });

  it("rejects a missing or corrupt game.json", () => {
    expect(check(fixture({ omit: ["game.json"] })).reasons[0]).toMatch(/game\.json is missing/);
    const dir = fixture();
    writeFileSync(join(dir, "game.json"), "{ not json");
    const v = check(dir);
    expect(v.valid).toBe(false);
    expect(v.mustRebuild).toBe(true);
    expect(v.reasons[0]).toMatch(/game\.json is corrupt/);
  });

  it("rejects a foreign package format", () => {
    const v = check(fixture({ meta: { format: "some-other-format" as never } }));
    expect(v.reasons.join()).toMatch(/not a game package/);
  });

  it("rejects an unsupported package schema version", () => {
    const v = check(fixture({ meta: { schemaVersion: GAME_PACKAGE_SCHEMA_VERSION + 1 } }));
    expect(v.mustRebuild).toBe(true);
    expect(v.reasons.join()).toMatch(/unsupported package schemaVersion/);
  });

  it("rejects a package built by an incompatible engine", () => {
    // pre-1.0: a different major.minor may lay packages out differently
    expect(isCompatibleEngineVersion("0.6.0")).toBe(false);
    expect(isCompatibleEngineVersion(KID_ENGINE_VERSION)).toBe(true);
    const v = check(fixture({ meta: { engineVersion: "0.6.0" } }));
    expect(v.reasons.join()).toMatch(/incompatible engine/);
  });

  it("tolerates a patch-level engine difference", () => {
    const patch = KID_ENGINE_VERSION.replace(/\.\d+$/, ".99");
    expect(check(fixture({ meta: { engineVersion: patch } })).valid).toBe(true);
  });

  it("rejects an unsupported profile version", () => {
    const v = check(
      fixture({ meta: { profile: { ...EVER17_PROFILE, profileVersion: 99 as never } } }),
    );
    expect(v.reasons.join()).toMatch(/unsupported game profile version/);
  });

  it("rejects a package for another game", () => {
    expect(check(fixture({ meta: { gameId: "never7" } })).reasons.join()).toMatch(/gameId/);
  });

  it("rejects a package whose source fingerprint moved on", () => {
    const v = check(fixture(), { fingerprint: "0000000000000000" });
    expect(v.mustRebuild).toBe(true);
    expect(v.reasons.join()).toMatch(/source changed/);
  });

  it("rejects a package with no import report, or an incomplete one", () => {
    expect(check(fixture({ omit: ["import-report.json"] })).reasons.join()).toMatch(/import-report\.json is missing/);
    expect(check(fixture({ report: { status: "failed" } })).reasons.join()).toMatch(/did not complete/);
  });

  it("rejects an import report whose own version or gameId is wrong", () => {
    expect(check(fixture({ report: { version: 99 as never } })).reasons.join()).toMatch(/unsupported import-report version/);
    expect(check(fixture({ report: { gameId: "never7" } })).reasons.join()).toMatch(/import-report\.json is for gameId/);
  });

  it("rejects a package fingerprinted by a different algorithm", () => {
    // the digests are not comparable, so "same fingerprint" means nothing
    const v = check(fixture({
      report: { schemaVersions: { ...baseVersions, fingerprintAlgo: "e17-fp-1" } },
    }));
    expect(v.mustRebuild).toBe(true);
    expect(v.reasons.join()).toMatch(/fingerprint algorithm/);
  });

  it("rejects an import recorded against unsupported schema versions", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["package schema", { package: 99 }],
      ["manifest schema", { manifest: 99 }],
      ["IR schema", { ir: 99 }],
      ["profile version", { profile: 99 }],
      ["incompatible engine", { engine: "0.1.0" }],
    ];
    for (const [what, patch] of cases) {
      const v = check(fixture({ report: { schemaVersions: { ...baseVersions, ...patch } as never } }));
      expect(v.mustRebuild, what).toBe(true);
      expect(v.reasons.join(), what).toMatch(/unsupported|incompatible/);
    }
  });

  it("rejects a report whose scene list disagrees with its own counts", () => {
    const v = check(fixture({
      report: { scripts: { discovered: 3, decompiled: 3, failed: 0, scenes: ["op00"], failures: [] } },
    }));
    expect(v.reasons.join()).toMatch(/lists 1 scenes but recorded 3/);
  });

  it("rejects a report that recorded failed scripts", () => {
    const v = check(fixture({
      report: {
        scripts: { discovered: 3, decompiled: 3, failed: 2, scenes: SCENES, failures: [] },
      },
    }));
    expect(v.reasons.join()).toMatch(/2 failed script/);
  });

  it("rejects a package whose start-scene IR is corrupt or foreign", () => {
    // a nominally complete report cannot vouch for the bytes on disk
    const corrupt = fixture();
    writeFileSync(join(corrupt, "ir", "op00.json"), "{ truncated");
    expect(check(corrupt).reasons.join()).toMatch(/start scene IR is corrupt/);

    const foreign = fixture();
    writeFileSync(
      join(foreign, "ir", "op00.json"),
      JSON.stringify({ formatVersion: 99, scene: "op00", entry: "a", blocks: { a: { ops: [] } } }),
    );
    expect(check(foreign).reasons.join()).toMatch(/unsupported IR schema/);

    const headless = fixture();
    writeFileSync(
      join(headless, "ir", "op00.json"),
      JSON.stringify({ formatVersion: IR_SCHEMA_VERSION, scene: "op00", entry: "missing", blocks: { a: { ops: [] } } }),
    );
    expect(check(headless).reasons.join()).toMatch(/entry block "missing" is missing/);

    const empty = fixture();
    writeFileSync(join(empty, "ir", "op00.json"), JSON.stringify({ formatVersion: IR_SCHEMA_VERSION, scene: "op00", entry: "a", blocks: {} }));
    expect(check(empty).reasons.join()).toMatch(/no blocks/);
  });

  it("rejects a missing, corrupt or unsupported manifest", () => {
    expect(check(fixture({ omit: ["manifest.json"] })).reasons.join()).toMatch(/manifest\.json is missing/);
    const dir = fixture();
    writeFileSync(join(dir, "assets", "manifest.json"), "]]nope");
    expect(check(dir).reasons.join()).toMatch(/manifest\.json is corrupt/);
    expect(
      check(fixture({ manifest: { formatVersion: 99, assets: {}, missing: [], generatedFrom: [] } })).reasons.join(),
    ).toMatch(/unsupported manifest schema/);
  });

  it("rejects a manifest that disagrees with the recorded import", () => {
    // a truncated manifest must not pass as "source unchanged"
    const v = check(fixture({ manifest: { formatVersion: MANIFEST_SCHEMA_VERSION, assets: {}, missing: [], generatedFrom: [] } }));
    expect(v.mustRebuild).toBe(true);
    expect(v.reasons.join()).toMatch(/the import recorded/);
  });

  it("rejects a missing IR directory, a missing start scene and an incomplete IR set", () => {
    expect(check(fixture({ omit: ["ir"] })).reasons.join()).toMatch(/IR directory is missing/);

    const noStart = fixture({ scenes: ["t_1a", "y_ed"], report: { scripts: { discovered: 2, decompiled: 2, failed: 0, scenes: ["t_1a", "y_ed"], failures: [] } } });
    expect(check(noStart).reasons.join()).toMatch(/start scene .* has no IR/);

    // every scene the report claims must be on disk
    const partial = fixture();
    rmSync(join(partial, "ir", "t_1a.json"));
    const v = check(partial);
    expect(v.mustRebuild).toBe(true);
    expect(v.reasons.join()).toMatch(/scene files are missing/);
  });

  it("rejects a package that starts somewhere the product does not", () => {
    const v = check(fixture({ meta: { startScene: "t_1a" } }));
    expect(v.reasons.join()).toMatch(/package starts at/);
  });

  it("treats branding drift as migratable rather than a rebuild", () => {
    const branding = { title: "Ever17", subtitle: "-the out of infinity-" };
    const dir = fixture({ meta: { branding } });
    expect(check(dir, { branding }).valid).toBe(true);

    const v = check(dir, { branding: { ...branding, hint: "click to start" } });
    expect(v.valid).toBe(false);
    expect(v.canMigrate).toBe(true);
    expect(v.mustRebuild).toBe(false);
    expect(v.reasons.join()).toMatch(/branding changed/);
  });

  it("never modifies the package it inspects", () => {
    const dir = fixture();
    const before = readFileSync(join(dir, "game.json"), "utf8");
    check(dir, { fingerprint: "0000000000000000" });
    check(dir);
    expect(readFileSync(join(dir, "game.json"), "utf8")).toBe(before);
    expect(existsSync(join(dir, "ir", "op00.json"))).toBe(true);
  });
});

describe("atomic package promotion", () => {
  it("replaces a previous package only once the new one is complete", () => {
    const root = tempDir();
    const final = join(root, "pkg");
    mkdirSync(final, { recursive: true });
    writeFileSync(join(final, "game.json"), "old");
    const build = join(root, "pkg.building-1-aa");
    mkdirSync(build, { recursive: true });
    writeFileSync(join(build, "game.json"), "new");

    promoteDirectory(build, final, "aa");
    expect(readFileSync(join(final, "game.json"), "utf8")).toBe("new");
    expect(existsSync(build)).toBe(false);
    // no retired copy is left behind
    expect(existsSync(`${final}.replacing-aa`)).toBe(false);
  });

  it("promotes into place when there is no previous package", () => {
    const root = tempDir();
    const build = join(root, "pkg.building-1-bb");
    mkdirSync(build, { recursive: true });
    writeFileSync(join(build, "game.json"), "new");
    promoteDirectory(build, join(root, "pkg"), "bb");
    expect(readFileSync(join(root, "pkg", "game.json"), "utf8")).toBe("new");
  });

  it("restores the previous package if promotion fails", () => {
    const root = tempDir();
    const final = join(root, "pkg");
    mkdirSync(final, { recursive: true });
    writeFileSync(join(final, "game.json"), "old");
    expect(() => promoteDirectory(join(root, "does-not-exist"), final, "cc")).toThrow();
    expect(readFileSync(join(final, "game.json"), "utf8")).toBe("old");
  });
});

describe("abandoned build cleanup", () => {
  it("removes only stale build directories, never packages, fresh builds or retired copies", () => {
    const root = tempDir();
    const stale = join(root, "abcdef0123456789.building-999-deadbeef");
    const fresh = join(root, "abcdef0123456789.building-1000-cafebabe");
    const retired = join(root, "abcdef0123456789.replacing-feedface");
    const realPackage = join(root, "abcdef0123456789");
    const unrelated = join(root, "notes.building-oops");
    for (const d of [stale, fresh, retired, realPackage, unrelated]) mkdirSync(d, { recursive: true });
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    utimesSync(retired, old, old);

    const removed: string[] = [];
    cleanupAbandonedBuilds(root, "abcdef0123456789.building-1000-cafebabe", (m) => removed.push(m));

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(realPackage)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    // a retired copy may be the only recoverable package: age alone never
    // justifies deleting it (recoverInterruptedPromotion owns that decision)
    expect(existsSync(retired)).toBe(true);
    expect(removed).toHaveLength(1);
  });

  it("does nothing when the cache root does not exist", () => {
    expect(() => cleanupAbandonedBuilds(join(tempDir(), "absent"), "x", () => {})).not.toThrow();
  });
});
