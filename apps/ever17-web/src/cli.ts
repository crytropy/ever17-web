#!/usr/bin/env node
/**
 * ever17 - play Ever17 in the browser from your own PC installation.
 *
 * One command finds the game files, converts them into a local cache
 * (never into the repository), and serves the player on localhost:
 *
 *   npm run ever17 -- serve --game-dir "/path/to/Ever17"
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  createAssetMaterializer,
  digestIndexPath,
  discoverInstallation,
  fingerprintInstallation,
  prepareGamePackage,
} from "ever17-pc";
import { EVER17_BRANDING } from "./branding.js";

function usage(): never {
  console.log(`ever17 - play Ever17 in the browser from your own installation

usage:
  ever17 serve   [gameDir] [options]   validate + convert (cached) + play at http://127.0.0.1:<port>/
  ever17 prepare [gameDir] [options]   validate + convert only (no server)
  ever17 check   [gameDir]             validate the installation and report the file list

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
if (!["serve", "prepare", "check"].includes(a.cmd)) usage();
const gameDir = resolveGameDir(a);

if (a.cmd === "check") {
  process.exit(check(gameDir, a));
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

if (a.cmd === "prepare") {
  console.log(
    `\nDone. Play it with:\n  npm run ever17 -- serve --game-dir "${gameDir}"` +
      (a.out !== ".local/ever17" ? ` --out "${a.out}"` : ""),
  );
  process.exit(0);
}

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
