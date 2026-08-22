import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  promoteDirectory,
  recoverInterruptedPromotion,
  retiredCandidates,
  withCacheLock,
} from "../src/promotion.js";

/**
 * The import swaps a package into place with two renames. A process that dies
 * between them leaves the only good copy in a retired directory, so these
 * tests walk every interruption point and assert the same invariant: the last
 * recoverable package is never lost, and an unusable directory never replaces
 * a usable one.
 *
 * Packages here are marker files, not real game packages - what matters is
 * which directory ends up under the package name. "Valid" is whatever the
 * injected predicate says, exactly as the real caller injects cache
 * validation.
 */

const FP = "abcdef0123456789";

const dirs: string[] = [];
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "e17promo-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A package directory carrying a label and a validity marker. */
function pkg(path: string, label: string, valid = true): string {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "marker"), JSON.stringify({ label, valid }));
  return path;
}

const labelOf = (path: string): string =>
  (JSON.parse(readFileSync(join(path, "marker"), "utf8")) as { label: string }).label;

const isValid = (path: string): boolean => {
  try {
    return (JSON.parse(readFileSync(join(path, "marker"), "utf8")) as { valid: boolean }).valid;
  } catch {
    return false;
  }
};

const finalDir = (root: string): string => join(root, FP);
const names = (root: string): string[] => readdirSync(root).sort();

describe("interrupted promotion recovery", () => {
  it("does nothing when there is only a healthy package", () => {
    const root = tempRoot();
    pkg(finalDir(root), "current");
    const out = recoverInterruptedPromotion(root, FP, isValid);
    expect(out).toMatchObject({ restored: false, discarded: 0, kept: 0 });
    expect(labelOf(finalDir(root))).toBe("current");
  });

  it("crash before retiring: the package is untouched, the build is left alone", () => {
    const root = tempRoot();
    pkg(finalDir(root), "current");
    pkg(join(root, `${FP}.building-123-aa`), "half-built");
    recoverInterruptedPromotion(root, FP, isValid);
    expect(labelOf(finalDir(root))).toBe("current");
    expect(existsSync(join(root, `${FP}.building-123-aa`))).toBe(true);
  });

  it("crash after retiring, before promoting: the retired package is restored", () => {
    const root = tempRoot();
    // the state a crash between the two renames leaves behind
    pkg(join(root, `${FP}.replacing-aa`), "previous");
    pkg(join(root, `${FP}.building-123-bb`), "half-built");
    expect(existsSync(finalDir(root))).toBe(false);

    const out = recoverInterruptedPromotion(root, FP, isValid);
    expect(out.restored).toBe(true);
    expect(labelOf(finalDir(root))).toBe("previous");
    expect(retiredCandidates(root, FP)).toEqual([]);
  });

  it("crash after promoting, before cleanup: the new package wins and the retired copy goes", () => {
    const root = tempRoot();
    pkg(finalDir(root), "new");
    pkg(join(root, `${FP}.replacing-aa`), "previous");

    const out = recoverInterruptedPromotion(root, FP, isValid);
    expect(out.restored).toBe(false);
    expect(out.discarded).toBe(1);
    expect(labelOf(finalDir(root))).toBe("new");
    expect(retiredCandidates(root, FP)).toEqual([]);
  });

  it("restores the newest valid candidate when several are retired", () => {
    const root = tempRoot();
    const older = pkg(join(root, `${FP}.replacing-aa`), "older");
    const newer = pkg(join(root, `${FP}.replacing-bb`), "newer");
    const past = new Date(Date.now() - 60_000);
    utimesSync(older, past, past);
    void newer;

    const out = recoverInterruptedPromotion(root, FP, isValid);
    expect(out.restored).toBe(true);
    expect(labelOf(finalDir(root))).toBe("newer");
    expect(retiredCandidates(root, FP)).toEqual([]);
  });

  it("skips a corrupt newest candidate and restores an older valid one", () => {
    const root = tempRoot();
    const older = pkg(join(root, `${FP}.replacing-aa`), "older-good");
    pkg(join(root, `${FP}.replacing-bb`), "newest-broken", false);
    const past = new Date(Date.now() - 60_000);
    utimesSync(older, past, past);

    const out = recoverInterruptedPromotion(root, FP, isValid);
    expect(out.restored).toBe(true);
    expect(labelOf(finalDir(root))).toBe("older-good");
    expect(out.reasons.join()).toMatch(/not usable/);
  });

  it("never lets an invalid retired copy replace a valid package", () => {
    const root = tempRoot();
    pkg(finalDir(root), "current");
    pkg(join(root, `${FP}.replacing-aa`), "broken", false);
    recoverInterruptedPromotion(root, FP, isValid);
    expect(labelOf(finalDir(root))).toBe("current");
  });

  it("replaces an invalid package with a valid retired copy", () => {
    const root = tempRoot();
    pkg(finalDir(root), "half-written", false);
    pkg(join(root, `${FP}.replacing-aa`), "previous-good");
    const out = recoverInterruptedPromotion(root, FP, isValid);
    expect(out.restored).toBe(true);
    expect(labelOf(finalDir(root))).toBe("previous-good");
  });

  it("keeps retired copies when nothing valid can be established", () => {
    const root = tempRoot();
    pkg(join(root, `${FP}.replacing-aa`), "broken-a", false);
    pkg(join(root, `${FP}.replacing-bb`), "broken-b", false);
    const out = recoverInterruptedPromotion(root, FP, isValid);
    expect(out.restored).toBe(false);
    expect(out.kept).toBe(2);
    expect(out.discarded).toBe(0);
    // nothing was thrown away: the user can still be helped by hand
    expect(retiredCandidates(root, FP)).toHaveLength(2);
    expect(out.reasons.join()).toMatch(/no valid package/);
  });

  it("never deletes the sole recoverable package because it is old", () => {
    const root = tempRoot();
    const retired = pkg(join(root, `${FP}.replacing-aa`), "ancient");
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(retired, longAgo, longAgo);
    const out = recoverInterruptedPromotion(root, FP, isValid);
    expect(out.restored).toBe(true);
    expect(labelOf(finalDir(root))).toBe("ancient");
  });

  it("is idempotent", () => {
    const root = tempRoot();
    pkg(join(root, `${FP}.replacing-aa`), "previous");
    const first = recoverInterruptedPromotion(root, FP, isValid);
    const second = recoverInterruptedPromotion(root, FP, isValid);
    const third = recoverInterruptedPromotion(root, FP, isValid);
    expect(first.restored).toBe(true);
    expect(second).toMatchObject({ restored: false, discarded: 0, kept: 0 });
    expect(third).toMatchObject({ restored: false, discarded: 0, kept: 0 });
    expect(labelOf(finalDir(root))).toBe("previous");
    expect(names(root)).toEqual([FP]);
  });

  it("leaves another package's retired copies alone", () => {
    const root = tempRoot();
    const other = "0123456789abcdef";
    pkg(finalDir(root), "current");
    pkg(join(root, `${other}.replacing-zz`), "other-game-state");
    recoverInterruptedPromotion(root, FP, isValid);
    expect(existsSync(join(root, `${other}.replacing-zz`))).toBe(true);
  });

  it("round-trips a real promote-then-recover cycle", () => {
    const root = tempRoot();
    pkg(finalDir(root), "v1");
    const build = pkg(join(root, `${FP}.building-1-cc`), "v2");
    promoteDirectory(build, finalDir(root), "cc");
    expect(labelOf(finalDir(root))).toBe("v2");
    const out = recoverInterruptedPromotion(root, FP, isValid);
    expect(out).toMatchObject({ restored: false, discarded: 0 });
    expect(names(root)).toEqual([FP]);
  });
});

describe("cache lock", () => {
  it("runs the critical section and releases the lock", () => {
    const root = tempRoot();
    const ran = withCacheLock(root, () => "done");
    expect(ran).toBe("done");
    expect(existsSync(join(root, ".import.lock"))).toBe(false);
  });

  it("releases the lock even when the critical section throws", () => {
    const root = tempRoot();
    expect(() => withCacheLock(root, () => { throw new Error("boom"); })).toThrow(/boom/);
    expect(existsSync(join(root, ".import.lock"))).toBe(false);
  });

  it("does not block on a live lock, and never removes someone else's", () => {
    const root = tempRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".import.lock"), JSON.stringify({ pid: 999999, at: "now" }));
    const notes: string[] = [];
    const ran = withCacheLock(root, () => "still ran", (m) => notes.push(m));
    expect(ran).toBe("still ran");
    expect(notes.join()).toMatch(/holds the cache lock/);
    expect(existsSync(join(root, ".import.lock"))).toBe(true);
  });

  it("steals a stale lock", () => {
    const root = tempRoot();
    mkdirSync(root, { recursive: true });
    const lock = join(root, ".import.lock");
    writeFileSync(lock, JSON.stringify({ pid: 999999, at: "long ago" }));
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(lock, longAgo, longAgo);
    const notes: string[] = [];
    withCacheLock(root, () => undefined, (m) => notes.push(m));
    expect(notes.join()).toMatch(/stale import lock/);
    expect(existsSync(lock)).toBe(false);
  });
});
