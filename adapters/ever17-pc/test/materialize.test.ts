import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetManifest } from "kid-contracts";
import { AssetConversionError, createAssetMaterializer, type AssetSource } from "../src/materialize.js";

/**
 * Lazy conversion runs while a player is waiting, so these tests pin the
 * properties that matter under load and failure: nothing outside the manifest
 * is reachable, a failed conversion leaves no file that later looks valid,
 * simultaneous requests decode once, and a retry after a failure works.
 */

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "e17mat-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MANIFEST: AssetManifest = {
  formatVersion: 1,
  assets: {
    bg01a1: { name: "bg01a1", kind: "image", archive: "bg.dat", file: "images/bg01a1.png" },
    s1a012: { name: "S1A012", kind: "audio", archive: "voice.dat", file: "audio/s1a012.wav" },
  },
  missing: [],
  generatedFrom: ["s_1a"],
};

/** A source that resolves anything the manifest names, with no real archives. */
function fakeSource(present = ["bg01a1", "S1A012"]): AssetSource {
  return {
    resolve(name, kind) {
      if (!present.includes(name)) return undefined;
      return {
        name,
        archive: kind === "image" ? "bg.dat" : "voice.dat",
        kind,
        format: kind === "image" ? "cps" : "waf",
        entry: { name, offset: 0, size: 4, data: Buffer.from("DATA"), compressed: false },
      } as never;
    },
  };
}

function setup(opts: {
  convert?: (r: never, k: "image" | "audio") => Buffer;
  source?: AssetSource;
} = {}) {
  const assetsDir = join(tempDir(), "assets");
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, "manifest.json"), JSON.stringify(MANIFEST));
  const calls: string[] = [];
  const materialize = createAssetMaterializer("/no/such/game", assetsDir, {
    source: opts.source ?? fakeSource(),
    convert:
      opts.convert ??
      (((r: { name: string }, k: string) => {
        calls.push(`${k}:${r.name}`);
        return Buffer.from(`converted:${r.name}`);
      }) as never),
  });
  return { assetsDir, materialize, calls };
}

describe("lazy asset materialization", () => {
  it("converts a declared asset and caches it atomically", async () => {
    const { assetsDir, materialize, calls } = setup();
    const out = await materialize("images/bg01a1.png");
    expect(out).toBe(join(assetsDir, "images/bg01a1.png"));
    expect(readFileSync(out!, "utf8")).toBe("converted:bg01a1");
    expect(calls).toEqual(["image:bg01a1"]);
    // no temporary file survives a successful conversion
    expect(readdirSync(join(assetsDir, "images")).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("serves the cached file on the second request without reconverting", async () => {
    const { materialize, calls } = setup();
    await materialize("audio/s1a012.wav");
    await materialize("audio/s1a012.wav");
    expect(calls).toEqual(["audio:S1A012"]);
  });

  it("shares one conversion between simultaneous requests", async () => {
    let started = 0;
    const { materialize } = setup({
      convert: ((r: { name: string }) => {
        started += 1;
        return Buffer.from(`converted:${r.name}`);
      }) as never,
    });
    const results = await Promise.all([
      materialize("images/bg01a1.png"),
      materialize("images/bg01a1.png"),
      materialize("images/bg01a1.png"),
    ]);
    expect(started).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it("refuses paths the manifest does not declare", async () => {
    const { materialize, calls } = setup();
    for (const path of [
      "images/not-in-manifest.png",
      "audio/bg01a1.wav", // right name, wrong kind/path
      "manifest.json",
      "movies/end_tu00.mp4",
    ]) {
      expect(await materialize(path), path).toBeNull();
    }
    expect(calls).toEqual([]); // the archives were never touched
  });

  it("refuses malformed and traversing paths", async () => {
    const { materialize } = setup();
    for (const path of ["", "../../etc/passwd", "images/../../secret.png", "images/", "IMAGES/BG01A1.PNG"]) {
      expect(await materialize(path), path).toBeNull();
    }
  });

  it("reports an asset the manifest declares but the archives lack", async () => {
    const { materialize } = setup({ source: fakeSource([]) });
    await expect(materialize("images/bg01a1.png")).rejects.toThrow(AssetConversionError);
    await expect(materialize("images/bg01a1.png")).rejects.toThrow(/bg01a1.*bg\.dat.*not present/s);
  });

  it("names the asset, archive and reason when decoding fails", async () => {
    const { assetsDir, materialize } = setup({
      convert: (() => {
        throw new Error("unexpected CPS type 0x99");
      }) as never,
    });
    const err = await materialize("images/bg01a1.png").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AssetConversionError);
    const e = err as AssetConversionError;
    expect(e.asset).toBe("bg01a1");
    expect(e.archive).toBe("bg.dat");
    expect(e.message).toMatch(/unexpected CPS type/);
    // nothing that could later be mistaken for a valid cached asset
    expect(existsSync(join(assetsDir, "images/bg01a1.png"))).toBe(false);
    const leftovers = existsSync(join(assetsDir, "images"))
      ? readdirSync(join(assetsDir, "images"))
      : [];
    expect(leftovers).toEqual([]);
  });

  it("recovers on retry after a failed conversion", async () => {
    let attempt = 0;
    const { assetsDir, materialize } = setup({
      convert: ((r: { name: string }) => {
        attempt += 1;
        if (attempt === 1) throw new Error("transient decode failure");
        return Buffer.from(`converted:${r.name}`);
      }) as never,
    });
    await expect(materialize("images/bg01a1.png")).rejects.toThrow(/transient decode failure/);
    const out = await materialize("images/bg01a1.png");
    expect(readFileSync(out!, "utf8")).toBe("converted:bg01a1");
    expect(attempt).toBe(2);
  });

  it("ignores a stale temporary file left by a killed process", async () => {
    const { assetsDir, materialize } = setup();
    mkdirSync(join(assetsDir, "images"), { recursive: true });
    const stale = join(assetsDir, "images/bg01a1.png.tmp-99999-abc-1");
    writeFileSync(stale, "half-written garbage");

    const out = await materialize("images/bg01a1.png");
    expect(readFileSync(out!, "utf8")).toBe("converted:bg01a1");
    // the stale temp was never served and never became the cached file
    expect(readFileSync(stale, "utf8")).toBe("half-written garbage");
  });

  it("reads the package manifest from disk when none is injected", async () => {
    const assetsDir = join(tempDir(), "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "manifest.json"), JSON.stringify(MANIFEST));
    const materialize = createAssetMaterializer("/no/such/game", assetsDir, {
      source: fakeSource(),
      convert: (() => Buffer.from("ok")) as never,
    });
    expect(await materialize("images/bg01a1.png")).not.toBeNull();
    expect(await materialize("images/elsewhere.png")).toBeNull();
  });
});
