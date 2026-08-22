/**
 * Package promotion, recovery and cleanup.
 *
 * A package is built into a temporary sibling and swapped into place with two
 * renames: the current package steps aside to `<fp>.replacing-<nonce>`, then
 * the new build takes its name. A process that dies between those two renames
 * leaves no package at `<fp>` and the only good copy sitting in a retired
 * directory - so cleanup must never delete a retired copy on age alone, and
 * startup must be able to put it back.
 *
 * Recovery is therefore deterministic and idempotent:
 *   - a valid package at `<fp>` makes every retired copy obsolete;
 *   - otherwise the newest *valid* retired copy is restored;
 *   - an invalid retired copy never replaces a valid package, and the last
 *     recoverable copy is never discarded because it is old.
 *
 * Concurrency: promotion and recovery run under a lock file in the cache root,
 * so two `prepare` processes cannot interleave their renames. The critical
 * section never runs unlocked - a waiting process either acquires the lock or
 * reports that an import is already in progress. A lock is stolen only when
 * its owner is genuinely gone, never because an import is taking a long time.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const BUILD_SUFFIX = ".building-";
export const RETIRE_SUFFIX = ".replacing-";
/** Build directories older than this are leftovers from a dead process. */
export const ABANDONED_BUILD_MS = 6 * 60 * 60 * 1000;
/** A lock older than this is assumed to belong to a dead process. */
export const LOCK_STALE_MS = 10 * 60 * 1000;

const FINGERPRINT_RE = "[0-9a-f]{16}";

export const buildDirName = (fingerprint: string, pid: number, nonce: string): string =>
  `${fingerprint}${BUILD_SUFFIX}${pid}-${nonce}`;

const buildRe = new RegExp(`^(${FINGERPRINT_RE})\\${BUILD_SUFFIX}\\d+-[0-9a-f]+$`);
const retireRe = new RegExp(`^(${FINGERPRINT_RE})\\${RETIRE_SUFFIX}[0-9a-f]+$`);

/** Retired copies of one package, newest first. */
export function retiredCandidates(outDir: string, fingerprint: string): string[] {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .filter((n) => retireRe.exec(n)?.[1] === fingerprint)
    .map((n) => join(outDir, n))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

export interface RecoveryOutcome {
  /** A retired copy was renamed back into place. */
  restored: boolean;
  /** Retired copies deleted because a valid package already exists. */
  discarded: number;
  /** Retired copies kept because nothing valid could be established. */
  kept: number;
  reasons: string[];
}

/**
 * Put the cache back into a consistent state after an interrupted promotion.
 *
 * `isValid` is the same validation a reuse would apply, so a half-written or
 * incompatible directory is never restored over anything.
 */
export function recoverInterruptedPromotion(
  outDir: string,
  fingerprint: string,
  isValid: (packageDir: string) => boolean,
  log: (m: string) => void = () => {},
): RecoveryOutcome {
  const out: RecoveryOutcome = { restored: false, discarded: 0, kept: 0, reasons: [] };
  const candidates = retiredCandidates(outDir, fingerprint);
  if (candidates.length === 0) return out;

  const final = join(outDir, fingerprint);
  let finalOk = existsSync(final) && isValid(final);

  if (!finalOk) {
    for (const candidate of candidates) {
      if (!isValid(candidate)) {
        out.reasons.push(`retired copy ${basename(candidate)} is not usable`);
        continue;
      }
      // The package slot is empty or unusable; put the good copy back.
      if (existsSync(final)) {
        const scrap = `${final}${RETIRE_SUFFIX}broken${Date.now().toString(36)}`;
        renameSync(final, scrap);
        rmSync(scrap, { recursive: true, force: true });
      }
      renameSync(candidate, final);
      out.restored = true;
      finalOk = true;
      log(`recovered the game package from an interrupted import (${basename(candidate)})`);
      break;
    }
  }

  // Retired copies are only ever deleted once a valid package exists.
  for (const candidate of retiredCandidates(outDir, fingerprint)) {
    if (!finalOk) {
      out.kept += 1;
      continue;
    }
    try {
      rmSync(candidate, { recursive: true, force: true });
      out.discarded += 1;
    } catch {
      out.kept += 1;
    }
  }
  if (!finalOk && out.kept > 0) {
    out.reasons.push(`kept ${out.kept} retired copy(ies): no valid package to replace them with`);
  }
  return out;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/**
 * Remove leftovers from processes that died mid-import: stale *build*
 * directories only. Retired copies are deliberately not age-based garbage -
 * they are handled by recoverInterruptedPromotion, which knows whether a
 * valid package exists to replace them.
 */
export function cleanupAbandonedBuilds(outDir: string, keep: string, log: (m: string) => void): void {
  if (!existsSync(outDir)) return;
  for (const name of readdirSync(outDir)) {
    if (name === keep || !buildRe.test(name)) continue;
    const path = join(outDir, name);
    try {
      if (Date.now() - statSync(path).mtimeMs < ABANDONED_BUILD_MS) continue;
      rmSync(path, { recursive: true, force: true });
      log(`removed abandoned build directory ${name}`);
    } catch {
      /* another process may still be using it; leave it alone */
    }
  }
}

/** Move `from` onto `to`, restoring the previous package if the swap fails. */
export function promoteDirectory(from: string, to: string, nonce: string): void {
  const retired = `${to}${RETIRE_SUFFIX}${nonce}`;
  const hadPrevious = existsSync(to);
  if (hadPrevious) renameSync(to, retired);
  try {
    renameSync(from, to);
  } catch (err) {
    if (hadPrevious && existsSync(retired)) renameSync(retired, to);
    throw err;
  }
  if (hadPrevious) rmSync(retired, { recursive: true, force: true });
}

/** Raised when another import holds the lock for longer than we will wait. */
export class ImportInProgressError extends Error {
  constructor(readonly ownerPid: number | null) {
    super(
      ownerPid === null
        ? "another import is already in progress for this cache"
        : `another import (pid ${ownerPid}) is already in progress for this cache`,
    );
    this.name = "ImportInProgressError";
  }
}

interface LockOwner {
  pid: number;
  at: string;
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockOwner>;
    return typeof parsed.pid === "number" ? { pid: parsed.pid, at: String(parsed.at ?? "") } : null;
  } catch {
    return null;
  }
}

/** Whether a process is still running. Unknown pids are assumed alive. */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Sleep without spinning the CPU, in a synchronous call path. */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* SharedArrayBuffer unavailable: fall back to a short spin */
    }
  }
}

export interface CacheLockOptions {
  /** How long to wait for another import before giving up. */
  waitMs?: number;
  /** Poll interval while waiting. */
  pollMs?: number;
  /** Injected for tests; the real one blocks this synchronous call path. */
  sleep?: (ms: number) => void;
}

/**
 * Run `fn` while holding the cache lock, or not at all.
 *
 * Promotion and recovery rename directories; two processes interleaving those
 * renames could leave one import's build promoted over another's. So this
 * never runs the critical section unlocked: it waits for the current owner,
 * and if that owner is still alive when the wait runs out it raises
 * ImportInProgressError rather than proceeding.
 *
 * A lock is only stolen when its owner is genuinely gone - a dead process, or
 * a stale file with no readable owner. A long-running import is not stale.
 */
export function withCacheLock<T>(
  outDir: string,
  fn: () => T,
  log: (m: string) => void = () => {},
  opts: CacheLockOptions = {},
): T {
  mkdirSync(outDir, { recursive: true });
  const lockPath = join(outDir, ".import.lock");
  const waitMs = opts.waitMs ?? 5 * 60 * 1000;
  const pollMs = opts.pollMs ?? 250;
  const deadline = Date.now() + waitMs;
  let announced = false;

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() } satisfies LockOwner));
      closeSync(fd);
      break; // acquired
    } catch {
      const owner = readOwner(lockPath);
      let age = Number.POSITIVE_INFINITY;
      try {
        age = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        continue; // vanished between open and stat: try again immediately
      }
      const ownerGone = owner === null ? age > LOCK_STALE_MS : !processAlive(owner.pid);
      if (ownerGone) {
        log(
          owner === null
            ? `ignoring an unreadable import lock (${Math.round(age / 1000)}s old)`
            : `ignoring an import lock left by a process that is gone (pid ${owner.pid})`,
        );
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new ImportInProgressError(owner?.pid ?? null);
      if (!announced) {
        announced = true;
        log(`waiting for another import to finish${owner ? ` (pid ${owner.pid})` : ""}...`);
      }
      (opts.sleep ?? sleepSync)(pollMs);
    }
  }

  try {
    return fn();
  } finally {
    // only ever release our own lock
    const owner = readOwner(lockPath);
    if (owner === null || owner.pid === process.pid) rmSync(lockPath, { force: true });
  }
}
