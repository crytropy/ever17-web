/**
 * Source fingerprinting for an Ever17 installation.
 *
 * Every file the importer reads - script.dat, all asset archives and every
 * movie - contributes a SHA-256 content digest, so a replacement of the same
 * size can never reuse a stale converted package. (Phase 6A hashed only
 * script.dat and used name+size for the rest; the algorithm id below is
 * therefore versioned, and bumping it re-imports once.)
 *
 * Files are hashed in bounded 1 MiB chunks rather than read whole: an
 * installation is ~1.4 GB and must never be resident in memory. Hashing is
 * synchronous by design - the CLI has nothing else to do while it runs, and
 * keeping it sync keeps the whole import path straightforward.
 *
 * To avoid rehashing 1.4 GB on every launch, digests are cached in a digest
 * index keyed by (canonical path, size, high-resolution mtime, inode). When
 * the stat identity is unchanged the stored digest is reused; `verify: true`
 * ignores the index and rehashes everything.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Bumping this invalidates every cached fingerprint and forces re-import. */
export const FINGERPRINT_ALGO = "e17-fp-3";

const DIGEST_INDEX_FORMAT = "e17-digest-index";
const DIGEST_INDEX_VERSION = 1;
const CHUNK_BYTES = 1 << 20;

export interface DigestEntry {
  size: number;
  /** Nanosecond mtime as a decimal string (JSON-safe bigint). */
  mtimeNs: string;
  /** Inode as a decimal string; a replaced file usually changes it. */
  ino: string;
  digest: string;
}

interface DigestIndexFile {
  format: typeof DIGEST_INDEX_FORMAT;
  version: typeof DIGEST_INDEX_VERSION;
  entries: Record<string, DigestEntry>;
}

/** SHA-256 of a file, read in bounded chunks. */
export function hashFileChunked(path: string): { digest: string; bytes: number } {
  const h = createHash("sha256");
  const fd = openSync(path, "r");
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  let bytes = 0;
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK_BYTES, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      bytes += n;
    }
  } finally {
    closeSync(fd);
  }
  return { digest: h.digest("hex"), bytes };
}

/**
 * Persistent per-file digest cache. Stored inside the ignored local cache
 * directory because its keys are absolute paths into the user's installation.
 */
export class DigestIndex {
  private entries: Record<string, DigestEntry>;
  private dirty = false;
  hashedFiles = 0;
  hashedBytes = 0;
  reusedFiles = 0;

  private constructor(
    private readonly path: string | null,
    entries: Record<string, DigestEntry>,
  ) {
    this.entries = entries;
  }

  /** Load an index; a missing, unreadable or foreign file starts empty. */
  static open(path: string | null): DigestIndex {
    if (!path || !existsSync(path)) return new DigestIndex(path, {});
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DigestIndexFile>;
      if (parsed.format !== DIGEST_INDEX_FORMAT || parsed.version !== DIGEST_INDEX_VERSION) {
        return new DigestIndex(path, {});
      }
      return new DigestIndex(path, parsed.entries ?? {});
    } catch {
      return new DigestIndex(path, {});
    }
  }

  /** Digest of a file, reusing the cached value when its stat identity holds. */
  digestOf(path: string, opts: { verify?: boolean } = {}): string {
    const key = resolve(path);
    const st = statSync(key, { bigint: true });
    const identity = {
      size: Number(st.size),
      mtimeNs: String(st.mtimeNs),
      ino: String(st.ino),
    };
    const cached = this.entries[key];
    if (
      !opts.verify &&
      cached &&
      cached.size === identity.size &&
      cached.mtimeNs === identity.mtimeNs &&
      cached.ino === identity.ino
    ) {
      this.reusedFiles += 1;
      return cached.digest;
    }
    const { digest, bytes } = hashFileChunked(key);
    this.entries[key] = { ...identity, digest };
    this.dirty = true;
    this.hashedFiles += 1;
    this.hashedBytes += bytes;
    return digest;
  }

  /** Persist the index (atomically); silently gives up if it cannot write. */
  save(): void {
    if (!this.path || !this.dirty) return;
    const body: DigestIndexFile = {
      format: DIGEST_INDEX_FORMAT,
      version: DIGEST_INDEX_VERSION,
      entries: this.entries,
    };
    const tmp = `${this.path}.tmp-${process.pid}`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(tmp, JSON.stringify(body));
      renameSync(tmp, this.path);
      this.dirty = false;
    } catch {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* nothing further we can do; the index is only an optimization */
      }
    }
  }
}

/** One hashed source file, as it enters the fingerprint. */
export interface FingerprintedFile {
  /** Path relative to the game directory, forward-slashed. */
  path: string;
  size: number;
  digest: string;
}

export interface FingerprintResult {
  fingerprint: string;
  algo: string;
  files: FingerprintedFile[];
  hashedFiles: number;
  hashedBytes: number;
  reusedFiles: number;
}

export interface FingerprintOptions {
  /** Digest index location (inside the ignored local cache). */
  indexPath?: string | null;
  /** Rehash every file, ignoring cached digests. */
  verify?: boolean;
}

/** Shape fingerprinting needs from a discovered installation. */
export interface FingerprintSource {
  gameDir: string;
  files: { name: string }[];
  movieFiles: string[];
}

/**
 * Content fingerprint of an installation. Deterministic: entries are sorted by
 * relative path, so directory enumeration order cannot affect the result.
 */
export function fingerprintInstallation(
  inst: FingerprintSource,
  opts: FingerprintOptions = {},
): FingerprintResult {
  const index = DigestIndex.open(opts.indexPath ?? null);
  const files: FingerprintedFile[] = [];

  const add = (relPath: string): void => {
    const abs = join(inst.gameDir, relPath);
    if (!existsSync(abs)) return;
    const size = statSync(abs).size;
    files.push({ path: relPath, size, digest: index.digestOf(abs, { verify: opts.verify ?? false }) });
  };

  for (const f of inst.files) add(f.name);
  for (const m of inst.movieFiles) add(`movie/${m}`);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const h = createHash("sha256");
  h.update(`${FINGERPRINT_ALGO}\n`);
  for (const f of files) h.update(`${f.path}\0${f.size}\0${f.digest}\n`);

  index.save();
  return {
    fingerprint: h.digest("hex").slice(0, 16),
    algo: FINGERPRINT_ALGO,
    files,
    hashedFiles: index.hashedFiles,
    hashedBytes: index.hashedBytes,
    reusedFiles: index.reusedFiles,
  };
}
