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
 * so two `prepare` processes cannot interleave their renames. The lock is
 * advisory and self-healing (a stale lock is stolen after LOCK_STALE_MS).
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

/**
 * Run `fn` while holding the cache lock. Advisory: it serializes the
 * promotion window between cooperating processes, and a lock left behind by a
 * dead process is stolen once it goes stale.
 */
export function withCacheLock<T>(outDir: string, fn: () => T, log: (m: string) => void = () => {}): T {
  mkdirSync(outDir, { recursive: true });
  const lockPath = join(outDir, ".import.lock");
  let held = false;
  for (let attempt = 0; attempt < 2 && !held; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      held = true;
    } catch {
      let age = Number.POSITIVE_INFINITY;
      try {
        age = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        continue; // vanished between open and stat: retry
      }
      if (age > LOCK_STALE_MS) {
        log(`ignoring a stale import lock (${Math.round(age / 1000)}s old)`);
        rmSync(lockPath, { force: true });
        continue;
      }
      // Another import is in flight. Proceed unlocked rather than blocking a
      // person's game start; the renames themselves stay atomic.
      log(`another import holds the cache lock; continuing without it`);
      break;
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
        if (owner.pid === process.pid) rmSync(lockPath, { force: true });
      } catch {
        rmSync(lockPath, { force: true });
      }
    }
  }
}
