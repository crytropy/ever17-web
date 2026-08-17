import { describe, expect, it } from "vitest";
import { decodeAdpcm } from "../src/waf/adpcm.js";
import { parseWaf, decodeWaf, decodeRawPcm, pcmToWav, WAF_HEADER_SIZE } from "../src/waf/index.js";
import { RAW_PCM_CHANNELS, RAW_PCM_SAMPLE_RATE } from "../src/library.js";
import { HAVE_GAME, library } from "./helpers.js";

describe("MS-ADPCM decoder (synthetic)", () => {
  /** One mono block: predictor 0, delta 16, s1 = 100, s2 = 50, then nibbles. */
  function monoBlock(nibbles: number[], blockAlign: number): Buffer {
    const b = Buffer.alloc(blockAlign);
    b.writeUInt8(0, 0);
    b.writeInt16LE(16, 1);
    b.writeInt16LE(100, 3);
    b.writeInt16LE(50, 5);
    for (let i = 0; i < nibbles.length; i += 2) {
      b.writeUInt8(((nibbles[i]! & 0xf) << 4) | (nibbles[i + 1]! & 0xf), 7 + i / 2);
    }
    return b;
  }

  it("emits the two priming samples in s2, s1 order", () => {
    const pcm = decodeAdpcm(monoBlock([0, 0], 8), 1, 8);
    expect(pcm.readInt16LE(0)).toBe(50);
    expect(pcm.readInt16LE(2)).toBe(100);
  });

  it("sign-extends nibbles 8..15 as negative", () => {
    // predictor 0 => coef1 = 256, coef2 = 0, so predicted = s1 + nibble*delta
    const pos = decodeAdpcm(monoBlock([1, 0], 8), 1, 8); // +1 * 16
    const neg = decodeAdpcm(monoBlock([0xf, 0], 8), 1, 8); // -1 * 16
    expect(pos.readInt16LE(4)).toBe(100 + 16);
    expect(neg.readInt16LE(4)).toBe(100 - 16);
  });

  it("clamps samples to the signed 16-bit range", () => {
    const b = Buffer.alloc(8);
    b.writeUInt8(0, 0);
    b.writeInt16LE(32767, 1); // huge delta
    b.writeInt16LE(32767, 3);
    b.writeInt16LE(32767, 5);
    b.writeUInt8(0x70, 6 + 1); // nibble 7 = +7 * delta -> overflow
    const pcm = decodeAdpcm(b, 1, 8);
    for (let i = 0; i < pcm.length; i += 2) {
      const v = pcm.readInt16LE(i);
      expect(v).toBeGreaterThanOrEqual(-32768);
      expect(v).toBeLessThanOrEqual(32767);
    }
  });

  it("keeps delta at or above the floor of 16", () => {
    // nibble 0 has adapt factor 230/256 < 1, so delta decays to the floor
    const pcm = decodeAdpcm(monoBlock([0, 0, 0, 0, 0, 0], 12), 1, 12);
    expect(pcm.length).toBe((2 + (12 - 7) * 2) * 2);
  });

  it("interleaves stereo channels", () => {
    const b = Buffer.alloc(16);
    b.writeUInt8(0, 0); // predictor L
    b.writeUInt8(0, 1); // predictor R
    b.writeInt16LE(16, 2);
    b.writeInt16LE(16, 4);
    b.writeInt16LE(1000, 6); // s1 L
    b.writeInt16LE(-1000, 8); // s1 R
    b.writeInt16LE(500, 10); // s2 L
    b.writeInt16LE(-500, 12); // s2 R
    const pcm = decodeAdpcm(b, 2, 16);
    expect([pcm.readInt16LE(0), pcm.readInt16LE(2)]).toEqual([500, -500]);
    expect([pcm.readInt16LE(4), pcm.readInt16LE(6)]).toEqual([1000, -1000]);
  });

  it("rejects unsupported channel counts", () => {
    expect(() => decodeAdpcm(Buffer.alloc(16), 3, 16)).toThrow(/channel count/);
  });
});

describe.skipIf(!HAVE_GAME)("WAF decoding (real archives)", () => {
  const load = (name: string): Buffer => {
    const r = library().resolve(name, "audio");
    if (!r) throw new Error(`missing ${name}`);
    return r.entry.data;
  };

  it("parses a mono voice line", () => {
    const w = parseWaf(load("s1a012"));
    expect(w.channels).toBe(1);
    expect(w.sampleRate).toBe(22050);
    expect(w.blockAlign).toBe(512);
    expect(w.bitsPerSample).toBe(4);
    expect(w.data.length % w.blockAlign).toBe(0);
  });

  it("parses stereo SE and BGM", () => {
    for (const name of ["se01_04", "bgm01"]) {
      const w = parseWaf(load(name));
      expect(w.channels, name).toBe(2);
      expect(w.blockAlign, name).toBe(1024);
    }
  });

  it("produces PCM of the length implied by the ADPCM block layout", () => {
    for (const name of ["s1a012", "se01_04"]) {
      const w = parseWaf(load(name));
      const a = decodeWaf(load(name));
      const headerSize = w.channels === 2 ? 14 : 7;
      const blocks = w.data.length / w.blockAlign;
      const valuesPerBlock = w.channels * 2 + (w.blockAlign - headerSize) * 2;
      expect(a.pcm.length, name).toBe(blocks * valuesPerBlock * 2);
      expect(a.duration).toBeGreaterThan(0);
    }
  });

  it("decodes signal, not noise (low zero-crossing rate, non-trivial RMS)", () => {
    const a = decodeWaf(load("s1a012"));
    let sumSq = 0;
    let crossings = 0;
    let prev = 0;
    const n = a.pcm.length / 2;
    for (let i = 0; i < n; i++) {
      const v = a.pcm.readInt16LE(i * 2);
      sumSq += v * v;
      if (i > 0 && v < 0 !== prev < 0) crossings++;
      prev = v;
    }
    expect(Math.sqrt(sumSq / n)).toBeGreaterThan(200); // audible
    expect(crossings / n).toBeLessThan(0.35); // speech, not white noise
  });

  it("wraps PCM in a valid 16-bit RIFF/WAVE container", () => {
    const a = decodeWaf(load("s1a012"));
    const wav = pcmToWav(a);
    expect(wav.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("latin1")).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(a.channels);
    expect(wav.readUInt32LE(24)).toBe(a.sampleRate);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(a.pcm.length);
    expect(wav.length).toBe(44 + a.pcm.length);
  });

  it("decodes a sample from every WAF archive", () => {
    const lib = library();
    for (const file of ["bgm.dat", "se.dat", "voice.dat"]) {
      const entries = lib.archive(file).entries;
      for (let i = 0; i < entries.length; i += Math.max(1, Math.floor(entries.length / 4))) {
        const e = entries[i]!;
        const w = parseWaf(e.data);
        expect(WAF_HEADER_SIZE + w.data.length, `${file}/${e.name}`).toBeLessThanOrEqual(e.size);
        expect(decodeWaf(e.data).pcm.length).toBeGreaterThan(0);
      }
    }
  });

  it("treats sysvoice.dat as headerless PCM, not WAF", () => {
    const lib = library();
    const entries = lib.archive("sysvoice.dat").entries;
    // The archive names entries .wav and stores no WAF header at all.
    expect(entries[0]!.name.endsWith(".wav")).toBe(true);
    expect(entries[0]!.data.subarray(0, 4).toString("latin1")).not.toBe("WAF\0");
    expect(() => parseWaf(entries[0]!.data)).toThrow(/not a WAF file/);

    // Every sysNNN name is shadowed by a same-named SE, so a bare lookup
    // deliberately returns the se.dat asset; the caller must disambiguate.
    expect(lib.resolve("sys001", "audio")?.archive).toBe("se.dat");
    expect(lib.resolveAll("sys001", "audio").map((r) => r.archive)).toEqual([
      "se.dat",
      "sysvoice.dat",
    ]);
    const r = lib.resolve("sys001", "audio", { archive: "sysvoice.dat" });
    expect(r?.format).toBe("pcm");
    expect(r?.name).toBe("sys001.wav");

    // 16-bit LE samples: adjacent-sample correlation is high at even offsets
    // and near zero at odd ones. That alignment is what proves the layout.
    const corr = (data: Buffer, off: number): number => {
      let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      for (let i = off; i + 3 < data.length && n < 60_000; i += 2, n++) {
        const x = data.readInt16LE(i);
        const y = data.readInt16LE(i + 2);
        sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      }
      return (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
    };
    const d = r!.entry.data;
    expect(corr(d, 0)).toBeGreaterThan(0.8);
    expect(Math.abs(corr(d, 1))).toBeLessThan(0.3);

    const audio = decodeRawPcm(d, RAW_PCM_CHANNELS, RAW_PCM_SAMPLE_RATE);
    expect(audio.pcm.length % 2).toBe(0);
    expect(audio.duration).toBeGreaterThan(0.5);
  });
});
