import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DigestIndex,
  FINGERPRINT_ALGO,
  fingerprintInstallation,
  hashFileChunked,
  type FingerprintSource,
} from "../src/fingerprint.js";

/**
 * Fingerprinting is what stands between a changed installation and a stale
 * converted package, so these tests use synthetic installations with content
 * we control rather than the real archives.
 */

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "e17fp-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake installation: named files with the given contents. */
function fakeInstall(files: Record<string, string>, movies: Record<string, string> = {}): FingerprintSource {
  const dir = tempDir();
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  if (Object.keys(movies).length > 0) {
    mkdirSync(join(dir, "movie"), { recursive: true });
    for (const [name, body] of Object.entries(movies)) writeFileSync(join(dir, "movie", name), body);
  }
  return {
    gameDir: dir,
    files: Object.keys(files).map((name) => ({ name })),
    movieFiles: Object.keys(movies),
  };
}

describe("chunked hashing", () => {
  it("matches a known SHA-256 and streams files larger than one chunk", () => {
    const dir = tempDir();
    const small = join(dir, "small.bin");
    writeFileSync(small, "abc");
    // sha256("abc")
    expect(hashFileChunked(small).digest).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );

    // > 1 MiB chunk boundary: the digest must not depend on chunking
    const big = join(dir, "big.bin");
    const body = Buffer.alloc(3 * (1 << 20) + 12345, 0x5a);
    writeFileSync(big, body);
    const r = hashFileChunked(big);
    expect(r.bytes).toBe(body.length);
    expect(r.digest).toBe(createHash("sha256").update(body).digest("hex"));
  });
});

describe("installation fingerprint", () => {
  it("is stable for an unchanged installation", () => {
    const inst = fakeInstall({ "script.dat": "SCRIPT", "bg.dat": "IMAGES" });
    const a = fingerprintInstallation(inst);
    const b = fingerprintInstallation(inst);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(a.algo).toBe(FINGERPRINT_ALGO);
  });

  it("changes when an archive's CONTENT changes at the same size", () => {
    // the phase-6A hole: same-size replacement reused a stale package
    const inst = fakeInstall({ "script.dat": "SCRIPT", "bg.dat": "AAAAAA" });
    const before = fingerprintInstallation(inst).fingerprint;
    const bg = join(inst.gameDir, "bg.dat");
    expect(statSync(bg).size).toBe(6);
    writeFileSync(bg, "BBBBBB");
    expect(statSync(bg).size).toBe(6);
    expect(fingerprintInstallation(inst).fingerprint).not.toBe(before);
  });

  it("changes when a same-size movie changes", () => {
    const inst = fakeInstall({ "script.dat": "S" }, { "end_tu00.e17": "MOVIE1" });
    const before = fingerprintInstallation(inst).fingerprint;
    writeFileSync(join(inst.gameDir, "movie", "end_tu00.e17"), "MOVIE2");
    expect(fingerprintInstallation(inst).fingerprint).not.toBe(before);
  });

  it("changes when a movie is added or removed", () => {
    const inst = fakeInstall({ "script.dat": "S" }, { "a.e17": "A" });
    const one = fingerprintInstallation(inst).fingerprint;
    writeFileSync(join(inst.gameDir, "movie", "b.e17"), "B");
    const two = fingerprintInstallation({ ...inst, movieFiles: ["a.e17", "b.e17"] }).fingerprint;
    expect(two).not.toBe(one);
  });

  it("does not depend on directory enumeration order", () => {
    const inst = fakeInstall(
      { "script.dat": "S", "bg.dat": "B", "voice.dat": "V" },
      { "m1.e17": "1", "m2.e17": "2" },
    );
    const forward = fingerprintInstallation(inst).fingerprint;
    const shuffled = fingerprintInstallation({
      ...inst,
      files: [...inst.files].reverse(),
      movieFiles: [...inst.movieFiles].reverse(),
    }).fingerprint;
    expect(shuffled).toBe(forward);
  });

  it("hashes every source file, not just the scenario", () => {
    const inst = fakeInstall({ "script.dat": "S", "bg.dat": "B" }, { "m.e17": "M" });
    const r = fingerprintInstallation(inst);
    expect(r.files.map((f) => f.path)).toEqual(["bg.dat", "movie/m.e17", "script.dat"]);
    expect(r.hashedFiles).toBe(3);
    for (const f of r.files) expect(f.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores files that are absent rather than failing", () => {
    const inst = fakeInstall({ "script.dat": "S" });
    const r = fingerprintInstallation({ ...inst, files: [{ name: "script.dat" }, { name: "gone.dat" }] });
    expect(r.files.map((f) => f.path)).toEqual(["script.dat"]);
  });
});

describe("digest index", () => {
  it("reuses digests while the stat identity holds, and rehashes when it changes", () => {
    const inst = fakeInstall({ "script.dat": "SCRIPT", "bg.dat": "IMAGES" });
    const indexPath = join(tempDir(), "digest-index.json");

    const first = fingerprintInstallation(inst, { indexPath });
    expect(first.hashedFiles).toBe(2);
    expect(first.reusedFiles).toBe(0);

    const second = fingerprintInstallation(inst, { indexPath });
    expect(second.hashedFiles).toBe(0);
    expect(second.reusedFiles).toBe(2);
    expect(second.fingerprint).toBe(first.fingerprint);

    // touching content changes size/mtime -> rehash and a new fingerprint
    writeFileSync(join(inst.gameDir, "bg.dat"), "IMAGES-CHANGED");
    const third = fingerprintInstallation(inst, { indexPath });
    expect(third.hashedFiles).toBe(1);
    expect(third.fingerprint).not.toBe(first.fingerprint);
  });

  it("verify: true rehashes even when the index looks current", () => {
    const inst = fakeInstall({ "script.dat": "S" });
    const indexPath = join(tempDir(), "digest-index.json");
    fingerprintInstallation(inst, { indexPath });
    const reused = fingerprintInstallation(inst, { indexPath });
    expect(reused.reusedFiles).toBe(1);
    const verified = fingerprintInstallation(inst, { indexPath, verify: true });
    expect(verified.hashedFiles).toBe(1);
    expect(verified.reusedFiles).toBe(0);
    expect(verified.fingerprint).toBe(reused.fingerprint);
  });

  it("verify: true catches content that the stat identity could not see", () => {
    // The fast path trusts (size, ns-mtime, inode). That is sound for ordinary
    // edits - even restoring a timestamp with utimes changes the nanosecond
    // mtime, so the digest is recomputed - but a perfectly forged stat
    // identity would slip through. Forge one directly in the index to pin the
    // documented trade-off and prove --verify is the answer to it.
    const inst = fakeInstall({ "script.dat": "AAAA" });
    const indexPath = join(tempDir(), "digest-index.json");
    const before = fingerprintInstallation(inst, { indexPath }).fingerprint;

    const path = join(inst.gameDir, "script.dat");
    writeFileSync(path, "BBBB"); // same size, different content
    const st = statSync(path, { bigint: true });
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
      entries: Record<string, { size: number; mtimeNs: string; ino: string; digest: string }>;
    };
    const key = Object.keys(index.entries)[0]!;
    index.entries[key] = {
      ...index.entries[key]!, // keeps the now-stale digest
      size: Number(st.size),
      mtimeNs: String(st.mtimeNs),
      ino: String(st.ino),
    };
    writeFileSync(indexPath, JSON.stringify(index));

    expect(fingerprintInstallation(inst, { indexPath }).fingerprint).toBe(before);
    expect(fingerprintInstallation(inst, { indexPath, verify: true }).fingerprint).not.toBe(before);
  });

  it("an ordinary same-size edit is caught even without --verify", () => {
    // utimes cannot restore the nanosecond mtime the index recorded
    const inst = fakeInstall({ "script.dat": "AAAA" });
    const indexPath = join(tempDir(), "digest-index.json");
    const before = fingerprintInstallation(inst, { indexPath }).fingerprint;
    const path = join(inst.gameDir, "script.dat");
    const st = statSync(path);
    writeFileSync(path, "BBBB");
    utimesSync(path, st.atime, st.mtime);
    expect(fingerprintInstallation(inst, { indexPath }).fingerprint).not.toBe(before);
  });

  it("survives a corrupt or foreign index file", () => {
    const inst = fakeInstall({ "script.dat": "S" });
    const indexPath = join(tempDir(), "digest-index.json");
    writeFileSync(indexPath, "{not json");
    const r1 = fingerprintInstallation(inst, { indexPath });
    expect(r1.hashedFiles).toBe(1);

    writeFileSync(indexPath, JSON.stringify({ format: "something-else", version: 9, entries: {} }));
    const r2 = fingerprintInstallation(inst, { indexPath });
    expect(r2.hashedFiles).toBe(1);
    expect(r2.fingerprint).toBe(r1.fingerprint);
  });

  it("persists a well-formed index that a fresh DigestIndex can read", () => {
    const inst = fakeInstall({ "script.dat": "S" });
    const indexPath = join(tempDir(), "digest-index.json");
    fingerprintInstallation(inst, { indexPath });
    const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as {
      format: string;
      version: number;
      entries: Record<string, { digest: string }>;
    };
    expect(parsed.format).toBe("e17-digest-index");
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.entries)).toHaveLength(1);

    const reopened = DigestIndex.open(indexPath);
    expect(reopened.digestOf(join(inst.gameDir, "script.dat"))).toBe(
      Object.values(parsed.entries)[0]!.digest,
    );
    expect(reopened.reusedFiles).toBe(1);
  });

  it("works with no index at all", () => {
    const inst = fakeInstall({ "script.dat": "S" });
    const r = fingerprintInstallation(inst, { indexPath: null });
    expect(r.hashedFiles).toBe(1);
    expect(r.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});
