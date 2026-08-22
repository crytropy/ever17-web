import { describe, expect, it } from "vitest";
import { rleUnpack } from "../src/cps/rle.js";
import { cpsDeobfuscate } from "../src/cps/deobfuscate.js";
import { parseCpsHeader, decodeCps, parseCpsMeta, parseCpsPrt } from "../src/cps/index.js";
import { encodePng } from "../src/png.js";
import { HAVE_GAME, library } from "./helpers.js";

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s/g, ""), "hex");

describe("RLE decompressor (synthetic)", () => {
  it("expands a literal run (0b000xxxxx)", () => {
    // 0x03 -> len (3 & 0x1F) + 1 = 4 literal bytes
    expect(rleUnpack(hex("03 41 42 43 44"), 4).toString("latin1")).toBe("ABCD");
  });

  it("expands a long literal run with the 0x20 extension byte", () => {
    // 0x20 | 0x01 -> len = 1 + 1 + (next << 5) = 2 + 32
    const payload = Buffer.alloc(34, 0x5a);
    const out = rleUnpack(Buffer.concat([hex("21 01"), payload]), 34);
    expect(out.equals(payload)).toBe(true);
  });

  it("expands a byte run (0b11xxxxxx)", () => {
    // 0xC0 | 0x03 -> len = 3 + 2 = 5 copies of 0xAB
    expect(rleUnpack(hex("c3 ab"), 5).toString("hex")).toBe("ababababab");
  });

  it("expands a back-reference (0b10xxxxxx), including overlap", () => {
    // write "AB", then reference dist=2 len=((0>>2)&0xF)+2 = 2
    expect(rleUnpack(hex("01 41 42 80 01"), 4).toString("latin1")).toBe("ABAB");
    // overlapping run: dist 1, len 6 -> repeats the last byte
    expect(rleUnpack(hex("00 58 90 00"), 7).toString("latin1")).toBe("XXXXXXX");
  });

  it("expands a repeated block (0b01xxxxxx)", () => {
    // 0x40 -> len = 2, iters = next + 1 = 3 -> "ABABAB"
    expect(rleUnpack(hex("40 02 41 42"), 6).toString("latin1")).toBe("ABABAB");
  });

  it("clamps runs to the declared output size", () => {
    expect(rleUnpack(hex("c8 ff"), 3).toString("hex")).toBe("ffffff");
  });

  it("rejects a truncated stream instead of emitting zeros", () => {
    expect(() => rleUnpack(hex("0f 41"), 16)).toThrow(/truncated/);
  });

  it("rejects a back-reference pointing before the output", () => {
    expect(() => rleUnpack(hex("80 05"), 8)).toThrow(/back-reference/);
  });
});

describe("CPS deobfuscation (synthetic)", () => {
  it("is the exact inverse of the documented keystream", () => {
    // Build a payload, scramble it with the forward transform, then check the
    // decoder recovers it.
    const plain = Buffer.alloc(64);
    for (let i = 0; i < plain.length; i++) plain[i] = (i * 7) & 0xff;
    const vOff = 0x20;
    const scrambled = Buffer.concat([plain, Buffer.alloc(4)]);
    const len = scrambled.length;
    const seed = scrambled.readUInt32LE(vOff);
    let key = (seed + vOff + 0x03786425) >>> 0;
    const limit = len - 4;
    for (let i = 0x10; i < limit; i += 4) {
      if (i !== vOff) scrambled.writeUInt32LE((scrambled.readUInt32LE(i) + key + len) >>> 0, i);
      key = (Math.imul(key, 0x41c64e6d) + 0x9b06) >>> 0;
    }
    scrambled.writeUInt32LE((vOff + 0x07534682) >>> 0, len - 4);

    const out = cpsDeobfuscate(scrambled);
    expect(out.length).toBe(plain.length);
    expect(out.equals(plain)).toBe(true);
  });

  it("treats a zero seed offset as 'not obfuscated'", () => {
    const data = Buffer.alloc(32, 0x11);
    data.writeUInt32LE(0x07534682, 28); // vOff = 0
    expect(cpsDeobfuscate(data).equals(data.subarray(0, 28))).toBe(true);
  });

  it("rejects a seed offset outside the payload", () => {
    const data = Buffer.alloc(32);
    data.writeUInt32LE((0x07534682 + 1000) >>> 0, 28);
    expect(() => cpsDeobfuscate(data)).toThrow(/outside payload/);
  });
});

describe.skipIf(!HAVE_GAME)("CPS decoding (real archives)", () => {
  const load = (name: string): Buffer => {
    const r = library().resolve(name, "image");
    if (!r) throw new Error(`missing ${name}`);
    return r.entry.data;
  };

  it("decodes a background to 800x600 opaque RGBA", () => {
    const h = parseCpsHeader(load("bg01a1"));
    expect(h.type).toBe(0x66);
    expect(h.compression & 1).toBe(1);
    const img = decodeCps(load("bg01a1"));
    expect([img.width, img.height]).toEqual([800, 600]);
    expect(img.hasAlpha).toBe(false);
    expect(img.rgba.length).toBe(800 * 600 * 4);
    // fully opaque
    for (let i = 3; i < img.rgba.length; i += 4 * 997) expect(img.rgba[i]).toBe(255);
  });

  it("decodes a character sprite with a real alpha channel and anchor", () => {
    const prt = parseCpsPrt(load("yu02bdm"));
    expect(prt.hasAlpha).toBe(true);
    expect(prt.nominalWidth).toBe(800);
    expect(prt.baseLeftOffset).toBeGreaterThan(0);
    const img = decodeCps(load("yu02bdm"));
    expect([img.width, img.height]).toEqual([412, 535]);
    // a sprite must contain both transparent and opaque pixels
    const alphas = new Set<number>();
    for (let i = 3; i < img.rgba.length; i += 4) alphas.add(img.rgba[i]!);
    expect(alphas.has(0)).toBe(true);
    expect(alphas.has(255)).toBe(true);
  });

  it("declares a plain size consistent with the decoded geometry", () => {
    for (const name of ["bg01a1", "ev_yu01a", "smst05"]) {
      const buf = load(name);
      const h = parseCpsHeader(buf);
      const prt = parseCpsPrt(buf);
      expect(h.plainSize).toBe(prt.stride * prt.height + (prt.hasAlpha ? prt.width * prt.height : 0) + 36);
    }
  });

  it("round-trips through the PNG encoder", () => {
    const img = decodeCps(load("smst05"));
    const png = encodePng(img);
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(img.width);
    expect(png.readUInt32BE(20)).toBe(img.height);
  });

  it("decodes a broad sample of every image archive without error", () => {
    const lib = library();
    for (const file of ["bg.dat", "chara.dat", "system.dat"]) {
      const entries = lib.archive(file).entries;
      for (let i = 0; i < entries.length; i += 37) {
        const e = entries[i]!;
        const img = decodeCps(e.data);
        expect(img.width, `${file}/${e.name}`).toBeGreaterThan(0);
        expect(img.rgba.length).toBe(img.width * img.height * 4);
      }
    }
  });
});

describe.skipIf(!HAVE_GAME)("header-only CPS metadata (real archives)", () => {
  it("parseCpsMeta matches the full decode across every image archive", () => {
    // a handful of entries per archive, spread across the entry list
    for (const archive of ["bg.dat", "chara.dat", "system.dat"]) {
      const a = library().archive(archive);
      const picks = [0, Math.floor(a.count / 2), a.count - 1]
        .map((i) => a.entries[i]!)
        .filter(Boolean);
      for (const entry of picks) {
        const meta = parseCpsMeta(entry.data);
        const full = parseCpsPrt(entry.data);
        expect(meta, `${archive}/${entry.name}`).toEqual({
          width: full.width,
          height: full.height,
          hasAlpha: full.hasAlpha,
          baseLeftOffset: full.baseLeftOffset,
          nominalWidth: full.nominalWidth,
        });
      }
    }
  });
});

describe.skipIf(!HAVE_GAME)("archive index recovery", () => {
  it("retries an archive that was unavailable on the first lookup", async () => {
    // A temporarily missing archive must not poison the index for the life of
    // the process: the server's retry affordance depends on recovery here.
    const { mkdtempSync, symlinkSync, rmSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { AssetLibrary, ARCHIVES } = await import("../src/library.js");
    const { GAME_DIR } = await import("./helpers.js");

    const farm = mkdtempSync(join(tmpdir(), "e17lib-"));
    for (const spec of ARCHIVES) {
      if (spec.file === "bg.dat") continue; // deliberately absent at first
      if (existsSync(join(GAME_DIR, spec.file))) symlinkSync(join(GAME_DIR, spec.file), join(farm, spec.file));
    }
    const lib = new AssetLibrary(farm);
    expect(lib.resolve("bg01a1", "image")).toBeUndefined();

    symlinkSync(join(GAME_DIR, "bg.dat"), join(farm, "bg.dat"));
    expect(lib.resolve("bg01a1", "image")?.archive).toBe("bg.dat");
    rmSync(farm, { recursive: true, force: true });
  });
});
