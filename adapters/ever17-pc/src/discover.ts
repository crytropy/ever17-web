/**
 * Ever17 installation discovery and validation.
 *
 * The file list is derived from what the pipeline actually reads - script.dat
 * (LNK archive of SC3 scenario scripts) plus the asset archives declared in
 * e17-assets' ARCHIVES table and the movie/*.e17 containers - not from
 * documentation guesswork.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ARCHIVES } from "e17-assets";
import { parseLnk } from "e17-parser";
import { EVER17_START_SCENE } from "./profile.js";

export interface SourceFile {
  /** Path relative to the game directory. */
  name: string;
  size: number;
  required: boolean;
  /** What the pipeline uses it for. */
  role: string;
}

export interface Ever17Installation {
  gameDir: string;
  /** Everything the pipeline will read, present on disk. */
  files: SourceFile[];
  /** Required files that are absent or unreadable. */
  missing: SourceFile[];
  /** movie/*.e17 containers (optional; endings fall back to a placeholder). */
  movieFiles: string[];
  /** Fatal validation problems (wrong magic, no start scene, ...). */
  problems: string[];
  warnings: string[];
  /** Scenario entry count, when script.dat parsed. */
  scriptCount: number;
}

const SCRIPT_DAT = "script.dat";

/** First bytes of a KID LNK archive. */
function hasLnkMagic(path: string): boolean {
  try {
    const fd = openSync(path, "r");
    const head = Buffer.alloc(4);
    readSync(fd, head, 0, 4, 0);
    closeSync(fd);
    return head.toString("latin1") === "LNK\0";
  } catch {
    return false;
  }
}

/** The complete list of files the importer reads, with roles. */
export function expectedFiles(): SourceFile[] {
  return [
    { name: SCRIPT_DAT, size: 0, required: true, role: "scenario scripts (SC3 bytecode)" },
    ...ARCHIVES.map((a) => ({
      name: a.file,
      size: 0,
      required: true,
      role: `${a.kind} archive (${a.format})`,
    })),
    { name: "movie/", size: 0, required: false, role: "ending/opening movies (*.e17, MPEG-1)" },
  ];
}

/**
 * Inspect a directory that should hold an Ever17 PC installation. Reads only
 * headers (plus script.dat's entry table) - cheap enough to run every start.
 */
export function discoverInstallation(gameDir: string): Ever17Installation {
  const files: SourceFile[] = [];
  const missing: SourceFile[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  let scriptCount = 0;

  if (!existsSync(gameDir) || !statSync(gameDir).isDirectory()) {
    return {
      gameDir,
      files,
      missing: expectedFiles().filter((f) => f.required),
      movieFiles: [],
      problems: [`not a directory: ${gameDir}`],
      warnings,
      scriptCount,
    };
  }

  for (const spec of expectedFiles()) {
    if (spec.name.endsWith("/")) continue; // movie dir handled below
    const path = join(gameDir, spec.name);
    if (!existsSync(path)) {
      if (spec.required) missing.push(spec);
      continue;
    }
    const size = statSync(path).size;
    files.push({ ...spec, size });
    if (!hasLnkMagic(path)) {
      problems.push(`${spec.name}: not a KID LNK archive (bad magic)`);
    }
  }

  // scenario sanity: parse the entry table and require the start scene
  const scriptPath = join(gameDir, SCRIPT_DAT);
  if (existsSync(scriptPath) && !problems.some((p) => p.startsWith(SCRIPT_DAT))) {
    try {
      const archive = parseLnk(readFileSync(scriptPath));
      scriptCount = archive.count;
      const names = new Set(archive.entries.map((e) => e.name.toLowerCase().replace(/\.scr$/, "")));
      if (!names.has(EVER17_START_SCENE)) {
        problems.push(
          `${SCRIPT_DAT}: no "${EVER17_START_SCENE}.scr" inside - is this really Ever17? (${archive.count} entries)`,
        );
      }
    } catch (err) {
      problems.push(`${SCRIPT_DAT}: ${(err as Error).message}`);
    }
  }

  const movieDir = join(gameDir, "movie");
  let movieFiles: string[] = [];
  if (existsSync(movieDir) && statSync(movieDir).isDirectory()) {
    movieFiles = readdirSync(movieDir)
      .filter((f) => f.toLowerCase().endsWith(".e17"))
      .sort();
    if (movieFiles.length === 0) warnings.push("movie/ exists but holds no .e17 movies");
  } else {
    warnings.push("no movie/ directory - ending movies will show a text placeholder");
  }

  for (const m of missing) {
    problems.push(`missing required file: ${m.name} (${m.role})`);
  }

  return { gameDir, files, missing, movieFiles, problems, warnings, scriptCount };
}

/**
 * Fingerprint identifying a source installation: content hash of script.dat
 * (what the IR derives from) plus name/size of every asset archive and movie.
 * Cache directories are keyed by this, so an unchanged installation is
 * imported once.
 */
export function fingerprintInstallation(inst: Ever17Installation): string {
  const h = createHash("sha256");
  const scriptPath = join(inst.gameDir, SCRIPT_DAT);
  if (existsSync(scriptPath)) h.update(readFileSync(scriptPath));
  for (const f of [...inst.files].sort((a, b) => a.name.localeCompare(b.name))) {
    h.update(`${f.name}:${f.size};`);
  }
  for (const m of inst.movieFiles) {
    const size = statSync(join(inst.gameDir, "movie", m)).size;
    h.update(`movie/${m}:${size};`);
  }
  return h.digest("hex").slice(0, 16);
}
