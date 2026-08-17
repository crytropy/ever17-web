/**
 * MS-ADPCM decoder (the codec inside every WAF body).
 *
 * Per block: a small header carries the predictor index, the initial delta and
 * two priming samples per channel; the remaining bytes hold two 4-bit nibbles
 * per byte, high nibble first, alternating channels when stereo.
 *
 * Confidence: Confirmed - output matches the reference implementation
 * bit-for-bit and yields intelligible speech/music (verified by playback).
 */
const ADAPT = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
const COEF1 = [256, 512, 0, 192, 240, 460, 392];
const COEF2 = [0, -256, 0, 64, 0, -208, -232];

/** Divide by 256 rounding toward zero (the reference rounds negatives up). */
function div256(x: number): number {
  return x < 0 ? Math.ceil(x / 256) : Math.floor(x / 256);
}

/** Sign-extend a 4-bit two's-complement nibble: 0..7 stay, 8..15 become -8..-1. */
function signedNibble(n: number): number {
  return n & 8 ? n - 16 : n;
}

class AdpcmChannel {
  private c1: number;
  private c2: number;
  delta: number;
  s1: number;
  s2: number;

  constructor(predictor: number, delta: number, s1: number, s2: number) {
    const p = Math.min(Math.max(predictor, 0), COEF1.length - 1);
    this.c1 = COEF1[p]!;
    this.c2 = COEF2[p]!;
    this.delta = delta;
    this.s1 = s1;
    this.s2 = s2;
  }

  step(nibble: number): number {
    let predicted = div256(this.s1 * this.c1 + this.s2 * this.c2);
    predicted += signedNibble(nibble) * this.delta;
    this.delta = Math.max(div256(ADAPT[nibble]! * this.delta), 16);
    this.s2 = this.s1;
    this.s1 = Math.min(Math.max(predicted, -32768), 32767);
    return this.s1;
  }
}

/** Decode MS-ADPCM to interleaved signed 16-bit LE PCM. */
export function decodeAdpcm(data: Buffer, channels: number, blockAlign: number): Buffer {
  if (channels !== 1 && channels !== 2) {
    throw new Error(`unsupported channel count ${channels}`);
  }
  const stereo = channels === 2;
  const headerSize = stereo ? 14 : 7;
  if (blockAlign <= headerSize) throw new Error(`implausible block align ${blockAlign}`);

  // Each data byte yields two samples (one per channel when stereo, two
  // consecutive mono samples otherwise); each block is primed with two frames.
  const blocks = Math.ceil(data.length / blockAlign);
  const valuesPerBlock = channels * 2 + (blockAlign - headerSize) * 2;
  const out = Buffer.alloc(blocks * valuesPerBlock * 2);
  let o = 0;
  const put = (v: number): void => {
    out.writeInt16LE(v, o);
    o += 2;
  };

  for (let base = 0; base + headerSize <= data.length; base += blockAlign) {
    let left: AdpcmChannel;
    let right: AdpcmChannel;
    if (stereo) {
      left = new AdpcmChannel(
        data.readUInt8(base),
        data.readInt16LE(base + 2),
        data.readInt16LE(base + 6),
        data.readInt16LE(base + 10),
      );
      right = new AdpcmChannel(
        data.readUInt8(base + 1),
        data.readInt16LE(base + 4),
        data.readInt16LE(base + 8),
        data.readInt16LE(base + 12),
      );
      put(left.s2);
      put(right.s2);
      put(left.s1);
      put(right.s1);
    } else {
      left = new AdpcmChannel(
        data.readUInt8(base),
        data.readInt16LE(base + 1),
        data.readInt16LE(base + 3),
        data.readInt16LE(base + 5),
      );
      right = left;
      put(left.s2);
      put(left.s1);
    }
    const end = Math.min(base + blockAlign, data.length);
    for (let p = base + headerSize; p < end; p++) {
      const byte = data[p]!;
      put(left.step(byte >> 4));
      put(right.step(byte & 0x0f));
    }
  }
  return out.subarray(0, o);
}
