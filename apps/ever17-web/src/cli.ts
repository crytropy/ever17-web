#!/usr/bin/env node
/**
 * ever17 - play Ever17 in the browser from your own PC installation.
 *
 * One command finds the game files, converts them into a local cache
 * (never into the repository), and serves the player on localhost:
 *
 *   npm run ever17 -- serve --game-dir "/path/to/Ever17"
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  createAssetMaterializer,
  digestIndexPath,
  discoverInstallation,
  fingerprintInstallation,
  prepareGamePackage,
} from "ever17-pc";
import { KID_ENGINE_VERSION, type ImportReport } from "kid-contracts";
import { EVER17_BRANDING } from "./branding.js";

function usage(): never {
  console.log(`ever17 - play Ever17 in the browser from your own installation

usage:
  ever17 serve   [gameDir] [options]   validate + convert (cached) + play at http://127.0.0.1:<port>/
  ever17 prepare [gameDir] [options]   validate + convert only (no server)
  ever17 check   [gameDir]             validate the installation and report the file list
  ever17 diagnostics [gameDir]         print versions + import summary for a bug report (no game content)

options:
  --game-dir <dir>   the Ever17 PC installation (default: ./ever17games when present)
  --out <dir>        cache root for generated packages (default: .local/ever17)
  --port <n>         server port (default 8017)
  --host <addr>      bind address (default 127.0.0.1; keep it local)
  --rebuild          regenerate the package even if the cache is current
  --verify           rehash every source file instead of trusting the digest index
  --no-open          do not open the browser after the server starts

The generated package (decompiled scenario, converted assets) is derived from
your copyrighted game files: it stays under --out, which is gitignored, and
must never be committed or redistributed.`);
  process.exit(2);
}

interface Args {
  cmd: string;
  gameDir: string | null;
  out: string;
  port: number;
  host: string;
  rebuild: boolean;
  verify: boolean;
  open: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    cmd: "",
    gameDir: null,
    out: ".local/ever17",
    port: 8017,
    host: "127.0.0.1",
    rebuild: false,
    verify: false,
    open: true,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--game-dir") a.gameDir = argv[++i] ?? null;
    else if (arg === "--out") a.out = argv[++i] ?? a.out;
    else if (arg === "--port") a.port = Number(argv[++i] ?? "8017");
    else if (arg === "--host") a.host = argv[++i] ?? a.host;
    else if (arg === "--rebuild") a.rebuild = true;
    else if (arg === "--verify") a.verify = true;
    else if (arg === "--no-open") a.open = false;
    else if (arg.startsWith("-")) usage();
    else positional.push(arg);
  }
  a.cmd = positional.shift() ?? "";
  if (positional.length > 0) a.gameDir ??= positional.shift()!;
  if (positional.length > 0) usage();
  return a;
}

function resolveGameDir(a: Args): string {
  if (a.gameDir) return resolve(a.gameDir);
  const dev = resolve("ever17games");
  if (existsSync(dev)) {
    console.log(`no --game-dir given; using ${dev}`);
    return dev;
  }
  console.error(
    'no game directory: pass it as "ever17 serve --game-dir /path/to/Ever17"\n' +
      "(the directory that holds script.dat, bg.dat, chara.dat, ...)",
  );
  process.exit(2);
}

function check(gameDir: string, a: Args): number {
  const inst = discoverInstallation(gameDir);
  console.log(`Ever17 installation check: ${gameDir}\n`);
  for (const f of inst.files) {
    console.log(`  found    ${f.name.padEnd(14)} ${String(f.size).padStart(11)} bytes  ${f.role}`);
  }
  for (const m of inst.missing) {
    console.log(`  MISSING  ${m.name.padEnd(14)} ${" ".repeat(11)}        ${m.role}`);
  }
  console.log(
    `  ${inst.movieFiles.length > 0 ? "found" : "none "}    ${"movie/*.e17".padEnd(14)}` +
      ` ${String(inst.movieFiles.length).padStart(11)} files  ending/opening movies (optional)`,
  );
  if (inst.scriptCount) console.log(`\n  script.dat: ${inst.scriptCount} scenario scripts`);
  for (const w of inst.warnings) console.log(`  warning: ${w}`);
  if (inst.problems.length > 0) {
    console.log(`\nProblems:`);
    for (const p of inst.problems) console.log(`  - ${p}`);
    return 1;
  }
  const fp = fingerprintInstallation(inst, {
    indexPath: digestIndexPath(resolve(a.out)),
    ...(a.verify ? { verify: true } : {}),
  });
  console.log(
    `\nOK: ready to import (fingerprint ${fp.fingerprint}; ` +
      `${fp.hashedFiles} file(s) hashed, ${fp.reusedFiles} cached digest(s) reused` +
      `${a.verify ? ", full verification" : ""})`,
  );
  return 0;
}

/** Cached packages under the cache root, newest first. */
function cachedPackages(outDir: string): { dir: string; fingerprint: string; report: ImportReport | null }[] {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .filter((n) => /^[0-9a-f]{16}$/.test(n))
    .map((n) => {
      const dir = join(outDir, n);
      const reportPath = join(dir, "import-report.json");
      let report: ImportReport | null = null;
      try {
        report = existsSync(reportPath) ? (JSON.parse(readFileSync(reportPath, "utf8")) as ImportReport) : null;
      } catch {
        report = null;
      }
      return { dir, fingerprint: n, report, mtime: statSync(dir).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ dir, fingerprint, report }) => ({ dir, fingerprint, report }));
}

/**
 * Environment facts a bug report needs. Deliberately prints no story text,
 * asset bytes or IR - only names, sizes, versions and counts.
 */
function diagnostics(gameDir: string, a: Args): number {
  const outDir = resolve(a.out);
  console.log(`ever17-web diagnostics`);
  console.log(`  node        ${process.version} on ${process.platform} ${process.arch}`);
  console.log(`  engine      ${KID_ENGINE_VERSION}`);
  console.log(`  game dir    ${gameDir}`);
  console.log(`  cache root  ${outDir}`);

  const inst = discoverInstallation(gameDir);
  console.log(`\ninstallation`);
  for (const f of inst.files) console.log(`  ${f.name.padEnd(14)} ${String(f.size).padStart(11)} bytes`);
  console.log(`  movie/*.e17    ${String(inst.movieFiles.length).padStart(11)} files`);
  console.log(`  scripts inside script.dat: ${inst.scriptCount}`);
  for (const w of inst.warnings) console.log(`  warning: ${w}`);
  for (const p of inst.problems) console.log(`  PROBLEM: ${p}`);
  if (inst.problems.length === 0) {
    const fp = fingerprintInstallation(inst, {
      indexPath: digestIndexPath(outDir),
      ...(a.verify ? { verify: true } : {}),
    });
    console.log(`  fingerprint ${fp.fingerprint} (${fp.algo}${a.verify ? ", fully verified" : ""})`);
  }

  const packages = cachedPackages(outDir);
  console.log(`\ncached packages: ${packages.length}`);
  for (const p of packages) {
    const r = p.report;
    if (!r) {
      console.log(`  ${p.fingerprint}  (no import report - obsolete, safe to delete)`);
      continue;
    }
    const bySeverity = r.issues.reduce<Record<string, number>>((acc, i) => {
      acc[i.severity] = (acc[i.severity] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `  ${p.fingerprint}  status=${r.status} scripts=${r.scripts.decompiled}/${r.scripts.discovered} ` +
        `assets=${r.assets.indexed}/${r.assets.referenced} (missing story=${r.assets.missingStory}, ` +
        `system=${r.assets.missingSystem}) movies=${r.movies.converted}/${r.movies.referenced}`,
    );
    console.log(
      `    schema pkg=${r.schemaVersions.package} manifest=${r.schemaVersions.manifest} ir=${r.schemaVersions.ir} ` +
        `profile=${r.schemaVersions.profile} engine=${r.schemaVersions.engine} fp=${r.schemaVersions.fingerprintAlgo}`,
    );
    console.log(`    issues: ${Object.entries(bySeverity).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`);
    console.log(`    generated ${r.generatedAt} in ${(r.durationMs / 1000).toFixed(1)}s`);
  }
  console.log(`\nNo story text, artwork, audio or IR is included above.`);
  return inst.problems.length === 0 ? 0 : 1;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* best effort; the URL is printed either way */
  }
}

const a = parseArgs(process.argv.slice(2));
if (!["serve", "prepare", "check", "diagnostics"].includes(a.cmd)) usage();
const gameDir = resolveGameDir(a);

if (a.cmd === "check") {
  process.exit(check(gameDir, a));
}
if (a.cmd === "diagnostics") {
  process.exit(diagnostics(gameDir, a));
}

let prepared: ReturnType<typeof prepareGamePackage>;
try {
  prepared = prepareGamePackage({
    gameDir,
    outDir: resolve(a.out),
    force: a.rebuild,
    verify: a.verify,
    branding: EVER17_BRANDING,
    log: (m) => console.log(m),
  });
} catch (err) {
  console.error(`\n${(err as Error).message}`);
  process.exit(1);
}

/** One-line summary of what the package contains, from its import report. */
function summarize(p: typeof prepared): void {
  const r = p.report;
  if (!r) return;
  console.log(
    `\npackage ${p.meta.sourceFingerprint}: ${r.scripts.decompiled} scripts, ` +
      `${r.assets.indexed} assets, ${r.movies.converted}/${r.movies.referenced} movies` +
      `${p.reused ? " (reused)" : ""}`,
  );
  if (r.assets.missingStory > 0) {
    console.log(`  ${r.assets.missingStory} asset(s) reachable in play are missing - see import-report.json`);
  }
  if (r.assets.missingSystem > 0) {
    console.log(`  ${r.assets.missingSystem} missing asset(s) are system/UI-only (harmless)`);
  }
  if (r.movies.missingSource + r.movies.unconverted > 0) {
    console.log(
      `  ${r.movies.missingSource + r.movies.unconverted} movie(s) unavailable - a text placeholder is shown`,
    );
  }
  console.log(`  report: ${join(p.packageDir, "import-report.json")}`);
}

if (a.cmd === "prepare") {
  summarize(prepared);
  console.log(
    `\nDone. Play it with:\n  npm run ever17 -- serve --game-dir "${gameDir}"` +
      (a.out !== ".local/ever17" ? ` --out "${a.out}"` : ""),
  );
  process.exit(0);
}
summarize(prepared);

// serve
const { serve } = await import("kid-web-player/serve");
serve({
  irDir: prepared.irDir,
  assetsDir: prepared.assetsDir,
  meta: prepared.meta,
  port: a.port,
  host: a.host,
  materializeAsset: createAssetMaterializer(gameDir, prepared.assetsDir),
  onReady: (url) => {
    console.log(`\nEver17 is ready: ${url} (starts at New Game)`);
    if (a.open) openBrowser(url);
  },
});
