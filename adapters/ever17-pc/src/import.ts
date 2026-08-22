/**
 * One-shot import: convert a user-owned Ever17 installation into a local
 * game package the web player can serve.
 *
 *   <outDir>/<sourceFingerprint>/
 *     game.json            versioned kid-contracts package metadata
 *     import-report.json   machine-readable record of this import
 *     ir/<scene>.json      decompiled scenario (every script, or none)
 *     assets/manifest.json all referenced assets, metadata from headers only
 *     assets/images|audio  filled lazily on first request (materializer)
 *     assets/movies/*.mp4  recovered + transcoded during import
 *
 * Lifecycle: the package is built into a temporary sibling directory, fully
 * validated, and only then promoted into place atomically. A failed import -
 * including a single script that will not decompile - never produces a
 * reusable package and never destroys the previous working one.
 *
 * Design decision - lazy asset conversion: decompiling the scenario and
 * header-probing every referenced asset takes seconds, while eagerly decoding
 * all ~1.3 GB of CPS/WAF media into PNG/WAV would take many minutes and
 * gigabytes before first play. The manifest is therefore built from archive
 * headers (dimensions, anchors, durations), and pixels/samples are converted
 * on first HTTP request, cached on disk next to the manifest. Movies are the
 * exception (a handful of files, needed as whole .mp4s): they are converted
 * here.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  collectSceneAssets,
  collectSceneMovies,
  type AssetManifest,
  type GamePackageMeta,
  type ImportIssue,
  type ImportReport,
  type IrScene,
  type ManifestEntry,
  type PersistentStatePolicy,
  type PlayerBranding,
} from "kid-contracts";
import { buildCfg, disassemble, encodingForScript, lowerScene, parseLnk, parseSc3 } from "e17-parser";
import { detectCrossRunVars } from "kid-graph";
import { AssetLibrary, RAW_PCM_CHANNELS, RAW_PCM_SAMPLE_RATE, parseCpsMeta, parseWaf } from "e17-assets";
import { discoverInstallation, type Ever17Installation } from "./discover.js";
import { FINGERPRINT_ALGO, fingerprintInstallation } from "./fingerprint.js";
import { validateCachedPackage, validateSceneIr, type CacheValidation } from "./cache.js";
import {
  buildDirName,
  cleanupAbandonedBuilds,
  promoteDirectory,
  recoverInterruptedPromotion,
  withCacheLock,
} from "./promotion.js";
import { EVER17_GAME_ID, EVER17_PROFILE, EVER17_START_SCENE, EVER17_TITLE } from "./profile.js";

export interface PrepareOptions {
  gameDir: string;
  /** Cache root; the package lands in `<outDir>/<fingerprint>/`. */
  outDir: string;
  /** Rebuild even when a valid package for this fingerprint exists. */
  force?: boolean;
  /** Rehash every source file instead of trusting the digest index. */
  verify?: boolean;
  branding?: PlayerBranding;
  log?: (message: string) => void;
}

export interface PreparedPackage {
  packageDir: string;
  irDir: string;
  assetsDir: string;
  meta: GamePackageMeta;
  installation: Ever17Installation;
  /** True when an existing valid package was reused. */
  reused: boolean;
  /** True when a reused package only needed its metadata refreshed. */
  migrated: boolean;
  /** Why a cached package was rejected, when one was. */
  rejectedBecause: string[];
  report: ImportReport | null;
}

/** Digest index location for a cache root (never inside the repository). */
export function digestIndexPath(outDir: string): string {
  return join(outDir, "digest-index.json");
}

/** Validate + report; throws with full diagnostics when the dir is unusable. */
export function validateInstallation(gameDir: string): Ever17Installation {
  const inst = discoverInstallation(gameDir);
  if (inst.problems.length > 0) {
    throw new Error(
      `"${gameDir}" is not a usable Ever17 installation:\n` +
        inst.problems.map((p) => `  - ${p}`).join("\n") +
        `\n\nExpected files (from the actual import pipeline):\n` +
        `  script.dat            scenario scripts (required)\n` +
        `  bg.dat chara.dat system.dat          image archives (required)\n` +
        `  bgm.dat se.dat voice.dat sysvoice.dat audio archives (required)\n` +
        `  movie/*.e17           movies (optional)`,
    );
  }
  return inst;
}

/** A scene that is UI or developer tooling rather than story content. */
function isNonStoryScene(scene: string): boolean {
  const patterns = EVER17_PROFILE.nonStoryScenePatterns ?? [];
  return patterns.some((p) => new RegExp(p, "i").test(scene));
}


export function prepareGamePackage(opts: PrepareOptions): PreparedPackage {
  const log = opts.log ?? (() => {});
  const startedAt = Date.now();
  const inst = validateInstallation(opts.gameDir);
  for (const w of inst.warnings) log(`warning: ${w}`);

  const fp = fingerprintInstallation(inst, {
    indexPath: digestIndexPath(opts.outDir),
    ...(opts.verify ? { verify: true } : {}),
  });
  const fingerprint = fp.fingerprint;
  if (fp.hashedFiles > 0) {
    log(
      `fingerprint ${fingerprint}: hashed ${fp.hashedFiles} file(s), ` +
        `${(fp.hashedBytes / 1e9).toFixed(2)} GB` +
        (fp.reusedFiles ? `, reused ${fp.reusedFiles} cached digest(s)` : ""),
    );
  }

  const packageDir = join(opts.outDir, fingerprint);
  const irDir = join(packageDir, "ir");
  const assetsDir = join(packageDir, "assets");

  /** The check any candidate package must pass, wherever it sits. */
  const expectationFor = (dir: string): Parameters<typeof validateCachedPackage>[0] => ({
    packageDir: dir,
    fingerprint,
    fingerprintAlgo: FINGERPRINT_ALGO,
    gameId: EVER17_GAME_ID,
    startScene: EVER17_START_SCENE,
    ...(opts.branding ? { branding: opts.branding } : {}),
  });
  /** Ignores branding drift: a retired copy is worth restoring regardless. */
  const isUsable = (dir: string): boolean => {
    const v = validateCachedPackage({ ...expectationFor(dir), branding: undefined as never });
    return v.valid;
  };

  // A previous run may have died mid-promotion, leaving the only good copy in
  // a retired directory. Put the cache back together before judging it.
  withCacheLock(
    opts.outDir,
    () => {
      const rec = recoverInterruptedPromotion(opts.outDir, fingerprint, isUsable, log);
      if (rec.restored || rec.kept > 0) {
        for (const r of rec.reasons) log(`  ${r}`);
      }
    },
    log,
  );

  // ---- 0. can the existing package be reused? ---------------------------
  let rejected: string[] = [];
  if (!opts.force) {
    const check: CacheValidation = validateCachedPackage(expectationFor(packageDir));
    if (check.valid && check.meta) {
      log(`reusing cached package ${packageDir} (validated)`);
      return {
        packageDir,
        irDir,
        assetsDir,
        meta: check.meta,
        installation: inst,
        reused: true,
        migrated: false,
        rejectedBecause: [],
        report: check.report ?? null,
      };
    }
    if (check.canMigrate && check.meta) {
      // Converted content is intact; only regenerable metadata drifted.
      const meta: GamePackageMeta = {
        ...check.meta,
        ...(opts.branding ? { branding: opts.branding } : {}),
        engineVersion: KID_ENGINE_VERSION,
      };
      writeFileSync(join(packageDir, "game.json"), JSON.stringify(meta, null, 1));
      log(`refreshed package metadata in place (${check.reasons.join("; ")})`);
      return {
        packageDir,
        irDir,
        assetsDir,
        meta,
        installation: inst,
        reused: true,
        migrated: true,
        rejectedBecause: check.reasons,
        report: check.report ?? null,
      };
    }
    rejected = check.reasons;
    if (existsSync(packageDir)) {
      log(`cached package rejected:`);
      for (const r of rejected) log(`  - ${r}`);
      log(`rebuilding from source`);
    }
  } else if (existsSync(packageDir)) {
    log(`--rebuild: regenerating ${packageDir} (the current one stays in place until it succeeds)`);
  }

  // ---- build into a temporary sibling, promote only on success ----------
  const nonce = randomBytes(4).toString("hex");
  const buildName = buildDirName(fingerprint, process.pid, nonce);
  const buildDir = join(opts.outDir, buildName);
  mkdirSync(opts.outDir, { recursive: true });
  cleanupAbandonedBuilds(opts.outDir, buildName, log);

  try {
    const meta = buildPackage({ buildDir, fingerprint, fp, inst, opts, log, startedAt });
    // The swap itself is serialized so two imports cannot interleave renames.
    withCacheLock(opts.outDir, () => promoteDirectory(buildDir, packageDir, nonce), log);
    log(`package ready: ${packageDir}`);
    const report = JSON.parse(readFileSync(join(packageDir, "import-report.json"), "utf8")) as ImportReport;
    return {
      packageDir,
      irDir,
      assetsDir,
      meta,
      installation: inst,
      reused: false,
      migrated: false,
      rejectedBecause: rejected,
      report,
    };
  } catch (err) {
    rmSync(buildDir, { recursive: true, force: true });
    throw err;
  }
}

interface BuildContext {
  buildDir: string;
  fingerprint: string;
  fp: ReturnType<typeof fingerprintInstallation>;
  inst: Ever17Installation;
  opts: PrepareOptions;
  log: (m: string) => void;
  startedAt: number;
}

/** Produce a complete package inside `buildDir`, or throw. */
function buildPackage(ctx: BuildContext): GamePackageMeta {
  const { buildDir, fingerprint, inst, opts, log } = ctx;
  const irDir = join(buildDir, "ir");
  const assetsDir = join(buildDir, "assets");
  mkdirSync(irDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
  const issues: ImportIssue[] = [];

  // ---- 1. scenario -> IR (all or nothing) -------------------------------
  const archive = parseLnk(readFileSync(join(opts.gameDir, "script.dat")));
  const scenes: IrScene[] = [];
  const failures: { script: string; reason: string }[] = [];
  for (const entry of archive.entries) {
    try {
      const file = parseSc3(entry.name, entry.data);
      const d = disassemble(file, entry.data);
      const cfg = buildCfg(file, d);
      const ir = lowerScene(file, d, cfg, encodingForScript(file.name));
      // Every scene is checked here, while we still have it in hand: cache
      // reuse only re-parses the start scene, so this is the pass that proves
      // the whole set is executable.
      const problem = validateSceneIr(ir, entry.name);
      if (problem) throw new Error(`decompiled to unusable IR - ${problem}`);
      writeFileSync(join(irDir, ir.scene.toLowerCase() + ".json"), JSON.stringify(ir, null, 1));
      scenes.push(ir);
    } catch (err) {
      failures.push({ script: entry.name, reason: (err as Error).message });
    }
  }
  for (const f of failures) {
    issues.push({ severity: "fatal", code: "script-failed", subject: f.script, detail: f.reason });
  }
  if (failures.length > 0) {
    throw new Error(
      `scenario import incomplete: ${failures.length} of ${archive.entries.length} scripts failed to decompile.\n` +
        failures.map((f) => `  - ${f.script}: ${f.reason}`).join("\n") +
        `\nNo package was written; any previously working package is untouched.`,
    );
  }
  const startScene = EVER17_START_SCENE.toLowerCase();
  if (!scenes.some((s) => s.scene.toLowerCase() === startScene)) {
    throw new Error(`scenario import produced no "${EVER17_START_SCENE}" scene - is this an Ever17 script.dat?`);
  }
  log(`scenario: ${scenes.length}/${archive.entries.length} scripts decompiled -> ${irDir}`);

  // ---- 2. asset manifest from headers (conversion itself is lazy) -------
  const lib = new AssetLibrary(opts.gameDir);
  const assets: Record<string, ManifestEntry> = {};
  const missing: string[] = [];
  /** asset key -> scenes referencing it, for severity classification. */
  const refs = new Map<string, string[]>();
  /** asset key -> the scenario's own spelling of the name. */
  const logicalName = new Map<string, string>();
  const seen = new Set<string>();
  let referenced = 0;

  for (const scene of scenes) {
    for (const ref of collectSceneAssets(scene, EVER17_PROFILE)) {
      const key = `${ref.kind}:${ref.name.toLowerCase()}`;
      const list = refs.get(key);
      if (list) list.push(scene.scene);
      else refs.set(key, [scene.scene]);
      if (seen.has(key)) continue;
      seen.add(key);
      logicalName.set(key, ref.name);
      referenced += 1;
    }
  }

  const noteMissing = (key: string, name: string, kind: string, detail: string): void => {
    const by = refs.get(key) ?? [];
    const storyRefs = by.filter((s) => !isNonStoryScene(s));
    missing.push(`${kind}:${name}${detail ? ` - ${detail}` : ""}`);
    issues.push({
      severity: storyRefs.length > 0 ? "story" : "system",
      code: "asset-missing",
      subject: name,
      detail: detail || `not found in any archive (${kind})`,
      referencedBy: [...new Set(by)].sort(),
    });
  };

  for (const key of seen) {
    const [kind, lowerName] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    const assetKind = kind as "image" | "audio";
    const name = logicalName.get(key) ?? lowerName;
    const resolved = lib.resolve(lowerName, assetKind);
    if (!resolved) {
      noteMissing(key, name, kind, "");
      continue;
    }
    const base = lowerName.replace(/\.[^.]+$/, "");
    try {
      if (assetKind === "image") {
        const m = parseCpsMeta(resolved.entry.data);
        assets[lowerName] = {
          name,
          kind: "image",
          archive: resolved.archive,
          file: `images/${base}.png`,
          width: m.width,
          height: m.height,
          hasAlpha: m.hasAlpha,
          baseLeftOffset: m.baseLeftOffset,
        };
      } else if (resolved.format === "pcm") {
        const bytes = resolved.entry.data.length;
        assets[lowerName] = {
          name,
          kind: "audio",
          archive: resolved.archive,
          file: `audio/${base}.wav`,
          channels: RAW_PCM_CHANNELS,
          sampleRate: RAW_PCM_SAMPLE_RATE,
          duration: Number((bytes / 2 / RAW_PCM_CHANNELS / RAW_PCM_SAMPLE_RATE).toFixed(3)),
        };
      } else {
        const w = parseWaf(resolved.entry.data);
        assets[lowerName] = {
          name,
          kind: "audio",
          archive: resolved.archive,
          file: `audio/${base}.wav`,
          channels: w.channels,
          sampleRate: w.sampleRate,
          duration: Number((w.data.length / w.byteRate).toFixed(3)),
        };
      }
    } catch (err) {
      noteMissing(key, name, kind, (err as Error).message);
    }
  }

  const manifest: AssetManifest = {
    formatVersion: MANIFEST_SCHEMA_VERSION,
    assets,
    missing,
    generatedFrom: scenes.map((s) => s.scene).sort(),
  };
  writeFileSync(join(assetsDir, "manifest.json"), JSON.stringify(manifest, null, 1));

  const missingStory = issues.filter((i) => i.code === "asset-missing" && i.severity === "story").length;
  const missingSystem = issues.filter((i) => i.code === "asset-missing" && i.severity === "system").length;
  log(
    `assets: ${Object.keys(assets).length} of ${referenced} referenced assets indexed (files convert on first play)`,
  );
  if (missingStory > 0) {
    log(`  WARNING: ${missingStory} asset(s) reachable in play are missing from the archives`);
    for (const i of issues.filter((x) => x.severity === "story").slice(0, 10)) {
      log(`    - ${i.subject} (${(i.referencedBy ?? []).slice(0, 3).join(", ")})`);
    }
  }
  if (missingSystem > 0) {
    log(`  ${missingSystem} missing asset(s) are referenced only by system/UI or developer scripts (harmless)`);
  }

  // ---- 3. movies --------------------------------------------------------
  const movieNames = new Set<string>();
  for (const scene of scenes) for (const m of collectSceneMovies(scene)) movieNames.add(m);
  let converted = 0;
  let missingSource = 0;
  let unconverted = 0;
  if (movieNames.size > 0) {
    const movieOut = join(assetsDir, "movies");
    mkdirSync(movieOut, { recursive: true });
    for (const name of [...movieNames].sort()) {
      const src = join(opts.gameDir, "movie", `${name}.e17`);
      const mp4 = join(movieOut, `${name}.mp4`);
      if (!existsSync(src)) {
        missingSource += 1;
        issues.push({
          severity: "movie",
          code: "movie-missing",
          subject: name,
          detail: "no movie/<name>.e17 in the installation; a text placeholder is shown instead",
        });
        continue;
      }
      // .e17 movies are MPEG-1 program streams with the first byte
      // overwritten (00 -> FF); restoring it yields a valid file.
      const data = readFileSync(src);
      data[0] = 0x00;
      const mpg = join(movieOut, `${name}.mpg`);
      writeFileSync(mpg, data);
      const res = spawnSync("ffmpeg", ["-y", "-v", "error", "-i", mpg, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", mp4]);
      if (res.status === 0) {
        converted += 1;
        rmSync(mpg, { force: true });
      } else {
        unconverted += 1;
        issues.push({
          severity: "movie",
          code: "movie-unconverted",
          subject: name,
          detail: `ffmpeg did not transcode it (${res.error?.message ?? `exit ${String(res.status)}`}); the raw .mpg was kept`,
        });
      }
    }
    log(
      `movies: ${converted}/${movieNames.size} converted -> ${movieOut}` +
        (missingSource ? ` (${missingSource} absent from movie/)` : "") +
        (unconverted ? ` (${unconverted} not transcoded: is ffmpeg installed?)` : ""),
    );
  }

  // ---- 4. cross-run persistence policy ---------------------------------
  // Derived from the scenario, not hardcoded: a variable persists when some
  // scene writes it as a flag and some scene that cannot be reached from
  // that write reads it - i.e. the write can only matter to a later run.
  const persistentVars = detectCrossRunVars(scenes, EVER17_START_SCENE);
  const persistence: PersistentStatePolicy = {
    policyVersion: 1,
    vars: [...persistentVars].sort((a, b) => a - b),
    // progression flags only move forward, so a newer run never loses to an
    // older save, and loading one cannot roll global progress back
    merge: "max",
    derivedFrom: "scenario analysis (cross-run flag detection) at import",
  };
  log(
    persistence.vars.length > 0
      ? `cross-run progress: ${persistence.vars.length} variable(s) carry into a new game`
      : `cross-run progress: none detected`,
  );

  // ---- 5. report + metadata --------------------------------------------
  const report: ImportReport = {
    format: IMPORT_REPORT_FORMAT,
    version: IMPORT_REPORT_VERSION,
    status: "complete",
    gameId: EVER17_GAME_ID,
    sourceFingerprint: fingerprint,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - ctx.startedAt,
    schemaVersions: {
      package: GAME_PACKAGE_SCHEMA_VERSION,
      manifest: MANIFEST_SCHEMA_VERSION,
      ir: IR_SCHEMA_VERSION,
      profile: PROFILE_VERSION,
      engine: KID_ENGINE_VERSION,
      fingerprintAlgo: ctx.fp.algo,
    },
    scripts: {
      discovered: archive.entries.length,
      decompiled: scenes.length,
      failed: 0,
      scenes: scenes.map((s) => s.scene.toLowerCase()).sort(),
      failures: [],
    },
    assets: {
      referenced,
      indexed: Object.keys(assets).length,
      missing: missing.length,
      missingStory,
      missingSystem,
    },
    movies: {
      referenced: movieNames.size,
      converted,
      missingSource,
      unconverted,
    },
    issues,
    warnings: inst.warnings,
  };
  writeFileSync(join(buildDir, "import-report.json"), JSON.stringify(report, null, 1));

  const meta: GamePackageMeta = {
    format: GAME_PACKAGE_FORMAT,
    schemaVersion: GAME_PACKAGE_SCHEMA_VERSION,
    engineVersion: KID_ENGINE_VERSION,
    gameId: EVER17_GAME_ID,
    title: EVER17_TITLE,
    sourceFingerprint: fingerprint,
    startScene: EVER17_START_SCENE,
    profile: EVER17_PROFILE,
    paths: { ir: "ir", assets: "assets", movies: "assets/movies" },
    persistence,
    ...(opts.branding ? { branding: opts.branding } : {}),
    generatedAt: new Date().toISOString(),
    source: { files: inst.files.map((f) => ({ name: f.name, size: f.size })) },
  };
  writeFileSync(join(buildDir, "game.json"), JSON.stringify(meta, null, 1));

  // The freshly built package must pass the very check a reuse would apply.
  const verdict = validateCachedPackage({
    packageDir: buildDir,
    fingerprint,
    fingerprintAlgo: FINGERPRINT_ALGO,
    gameId: EVER17_GAME_ID,
    startScene: EVER17_START_SCENE,
    ...(opts.branding ? { branding: opts.branding } : {}),
  });
  if (!verdict.valid) {
    throw new Error(
      `the generated package failed its own validation and was discarded:\n` +
        verdict.reasons.map((r) => `  - ${r}`).join("\n"),
    );
  }
  return meta;
}
