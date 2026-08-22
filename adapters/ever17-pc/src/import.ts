/**
 * One-shot import: convert a user-owned Ever17 installation into a local
 * game package the web player can serve.
 *
 *   <outDir>/<sourceFingerprint>/
 *     game.json            versioned kid-contracts package metadata
 *     ir/<scene>.json      decompiled scenario (all scripts)
 *     assets/manifest.json all referenced assets, metadata from headers only
 *     assets/images|audio  filled lazily on first request (materializer)
 *     assets/movies/*.mp4  recovered + transcoded eagerly (few files)
 *
 * Design decision - lazy asset conversion: decompiling the scenario and
 * header-probing every referenced asset takes seconds, while eagerly decoding
 * all ~1.3 GB of CPS/WAF media into PNG/WAV would take many minutes and
 * gigabytes before first play. The manifest is therefore built from archive
 * headers (dimensions, anchors, durations), and pixels/samples are converted
 * on first HTTP request, cached on disk next to the manifest. Movies are the
 * exception (a handful of files, needed as whole .mp4s): they are converted
 * eagerly here.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GAME_PACKAGE_FORMAT,
  GAME_PACKAGE_SCHEMA_VERSION,
  KID_ENGINE_VERSION,
  MANIFEST_SCHEMA_VERSION,
  collectSceneAssets,
  collectSceneMovies,
  type AssetManifest,
  type GamePackageMeta,
  type IrScene,
  type ManifestEntry,
  type PlayerBranding,
} from "kid-contracts";
import { buildCfg, disassemble, encodingForScript, lowerScene, parseLnk, parseSc3 } from "e17-parser";
import {
  AssetLibrary,
  RAW_PCM_CHANNELS,
  RAW_PCM_SAMPLE_RATE,
  decodeCps,
  decodeRawPcm,
  decodeWaf,
  encodePng,
  parseCpsMeta,
  parseWaf,
  pcmToWav,
} from "e17-assets";
import { discoverInstallation, type Ever17Installation } from "./discover.js";
import { fingerprintInstallation, type FingerprintResult } from "./fingerprint.js";
import { EVER17_GAME_ID, EVER17_PROFILE, EVER17_START_SCENE, EVER17_TITLE } from "./profile.js";

export interface PrepareOptions {
  gameDir: string;
  /** Cache root; the package lands in `<outDir>/<fingerprint>/`. */
  outDir: string;
  /** Rebuild even when a package for this fingerprint exists. */
  force?: boolean;
  /** Rehash every source file instead of trusting the digest index. */
  verify?: boolean;
  branding?: PlayerBranding;
  log?: (message: string) => void;
}

/** Digest index location for a cache root (never inside the repository). */
export function digestIndexPath(outDir: string): string {
  return join(outDir, "digest-index.json");
}

export interface PreparedPackage {
  packageDir: string;
  irDir: string;
  assetsDir: string;
  meta: GamePackageMeta;
  installation: Ever17Installation;
  /** True when an existing cached package was reused unchanged. */
  reused: boolean;
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

export function prepareGamePackage(opts: PrepareOptions): PreparedPackage {
  const log = opts.log ?? (() => {});
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
  const gameJsonPath = join(packageDir, "game.json");

  if (existsSync(gameJsonPath) && !opts.force) {
    const meta = JSON.parse(readFileSync(gameJsonPath, "utf8")) as GamePackageMeta;
    if (meta.format === GAME_PACKAGE_FORMAT && meta.sourceFingerprint === fingerprint) {
      log(`reusing cached package ${packageDir} (source unchanged)`);
      return { packageDir, irDir, assetsDir, meta, installation: inst, reused: true };
    }
  }
  if (opts.force && existsSync(packageDir)) {
    log(`rebuilding ${packageDir}`);
    rmSync(packageDir, { recursive: true, force: true });
  }
  mkdirSync(irDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });

  // ---- 1. scenario -> IR ------------------------------------------------
  const archive = parseLnk(readFileSync(join(opts.gameDir, "script.dat")));
  const scenes: IrScene[] = [];
  let failed = 0;
  for (const entry of archive.entries) {
    try {
      const file = parseSc3(entry.name, entry.data);
      const d = disassemble(file, entry.data);
      const cfg = buildCfg(file, d);
      const ir = lowerScene(file, d, cfg, encodingForScript(file.name));
      writeFileSync(join(irDir, ir.scene.toLowerCase() + ".json"), JSON.stringify(ir, null, 1));
      scenes.push(ir);
    } catch (err) {
      failed += 1;
      log(`  decompile FAILED ${entry.name}: ${(err as Error).message}`);
    }
  }
  log(`scenario: ${scenes.length}/${archive.entries.length} scripts decompiled -> ${irDir}`);
  if (scenes.length === 0) throw new Error("no script decompiled - aborting");
  if (failed > 0) log(`warning: ${failed} scripts failed to decompile`);

  // ---- 2. asset manifest from headers (conversion itself is lazy) -------
  const lib = new AssetLibrary(opts.gameDir);
  const assets: Record<string, ManifestEntry> = {};
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const scene of scenes) {
    for (const ref of collectSceneAssets(scene, EVER17_PROFILE)) {
      const key = `${ref.kind}:${ref.name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const resolved = lib.resolve(ref.name, ref.kind);
      if (!resolved) {
        missing.push(`${ref.kind}:${ref.name} (${ref.via})`);
        continue;
      }
      const base = ref.name.toLowerCase().replace(/\.[^.]+$/, "");
      try {
        if (ref.kind === "image") {
          const m = parseCpsMeta(resolved.entry.data);
          assets[ref.name.toLowerCase()] = {
            name: ref.name,
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
          assets[ref.name.toLowerCase()] = {
            name: ref.name,
            kind: "audio",
            archive: resolved.archive,
            file: `audio/${base}.wav`,
            channels: RAW_PCM_CHANNELS,
            sampleRate: RAW_PCM_SAMPLE_RATE,
            duration: Number((bytes / 2 / RAW_PCM_CHANNELS / RAW_PCM_SAMPLE_RATE).toFixed(3)),
          };
        } else {
          const w = parseWaf(resolved.entry.data);
          assets[ref.name.toLowerCase()] = {
            name: ref.name,
            kind: "audio",
            archive: resolved.archive,
            file: `audio/${base}.wav`,
            channels: w.channels,
            sampleRate: w.sampleRate,
            duration: Number((w.data.length / w.byteRate).toFixed(3)),
          };
        }
      } catch (err) {
        missing.push(`${ref.kind}:${ref.name} (${ref.via}) - ${(err as Error).message}`);
      }
    }
  }
  const manifest: AssetManifest = {
    formatVersion: MANIFEST_SCHEMA_VERSION,
    assets,
    missing,
    generatedFrom: scenes.map((s) => s.scene).sort(),
  };
  writeFileSync(join(assetsDir, "manifest.json"), JSON.stringify(manifest, null, 1));
  log(
    `assets: ${Object.keys(assets).length} referenced assets indexed` +
      (missing.length ? ` (${missing.length} missing)` : "") +
      ` -> ${join(assetsDir, "manifest.json")} (files convert on first play)`,
  );

  // ---- 3. movies (eager: few files, whole-file containers) --------------
  const movieNames = new Set<string>();
  for (const scene of scenes) for (const m of collectSceneMovies(scene)) movieNames.add(m);
  if (movieNames.size > 0) {
    const movieOut = join(assetsDir, "movies");
    mkdirSync(movieOut, { recursive: true });
    let converted = 0;
    let absent = 0;
    let noFfmpeg = false;
    for (const name of [...movieNames].sort()) {
      const src = join(opts.gameDir, "movie", `${name}.e17`);
      const mp4 = join(movieOut, `${name}.mp4`);
      if (existsSync(mp4)) {
        converted += 1;
        continue;
      }
      if (!existsSync(src)) {
        absent += 1;
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
        rmSync(mpg);
      } else {
        noFfmpeg = true;
      }
    }
    log(
      `movies: ${converted}/${movieNames.size} converted -> ${movieOut}` +
        (absent ? ` (${absent} not in movie/)` : "") +
        (noFfmpeg ? " (ffmpeg missing: unconverted movies will show a placeholder)" : ""),
    );
  }

  // ---- 4. game.json -----------------------------------------------------
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
    ...(opts.branding ? { branding: opts.branding } : {}),
    generatedAt: new Date().toISOString(),
    source: { files: inst.files.map((f) => ({ name: f.name, size: f.size })) },
  };
  writeFileSync(gameJsonPath, JSON.stringify(meta, null, 1));
  log(`package ready: ${packageDir}`);
  return { packageDir, irDir, assetsDir, meta, installation: inst, reused: false };
}

/**
 * Lazy asset conversion for the web server: given a missing path under the
 * package's assets/ root ("images/<base>.png" or "audio/<base>.wav"), decode
 * it from the original archives into the cache and return the absolute path.
 */
export function createAssetMaterializer(
  gameDir: string,
  assetsDir: string,
): (relPath: string) => string | null {
  const lib = new AssetLibrary(gameDir);
  return (relPath: string): string | null => {
    const m = relPath.replace(/\\/g, "/").match(/^(images|audio)\/([a-z0-9_\-.]+)\.(png|wav)$/i);
    if (!m) return null;
    const kind = m[1]!.toLowerCase() === "images" ? ("image" as const) : ("audio" as const);
    const base = m[2]!.toLowerCase();
    const resolved = lib.resolve(base, kind);
    if (!resolved) return null;
    const outPath = join(assetsDir, m[1]!.toLowerCase(), `${base}.${m[3]!.toLowerCase()}`);
    if (existsSync(outPath)) return outPath;
    mkdirSync(join(assetsDir, m[1]!.toLowerCase()), { recursive: true });
    const tmp = `${outPath}.tmp-${process.pid}`;
    if (kind === "image") {
      writeFileSync(tmp, encodePng(decodeCps(resolved.entry.data)));
    } else {
      const audio =
        resolved.format === "pcm"
          ? decodeRawPcm(resolved.entry.data, RAW_PCM_CHANNELS, RAW_PCM_SAMPLE_RATE)
          : decodeWaf(resolved.entry.data);
      writeFileSync(tmp, pcmToWav(audio));
    }
    renameSync(tmp, outPath);
    return outPath;
  };
}
