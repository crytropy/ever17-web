import { decodeAdpcm } from "./adpcm.js";
import type { DecodedAudio, WafInfo } from "../types.js";

/**
 * WAF: a stripped WAV header followed by a raw MS-ADPCM stream.
 *
 *   0x00  char magic[4]     "WAF\0"
 *   0x04  u16  unknown      0 in every file of this release
 *   0x06  u16  channels     1 (voice) or 2 (SE, BGM)
 *   0x08  u32  sampleRate   22050 throughout
 *   0x0C  u32  byteRate
 *   0x10  u16  blockAlign   512 (mono) / 1024 (stereo)
 *   0x12  u8   extra[34]    MS-ADPCM extra format data: bitsPerSample (u16),
 *                           coefficient count and the 7 standard coefficient
 *                           pairs - copied verbatim into a WAV `fmt ` chunk
 *   0x34  u32  dataLength
 *   0x38  ...  ADPCM body
 *
 * Confidence: Confirmed - every .waf in bgm.dat/se.dat/voice.dat/sysvoice.dat
 * parses with dataLength exactly matching the archive entry size minus 56.
 */
export const WAF_HEADER_SIZE = 56;

export function parseWaf(buf: Buffer): WafInfo {
  if (buf.length < WAF_HEADER_SIZE) throw new Error("WAF file too small");
  if (buf.subarray(0, 4).toString("latin1") !== "WAF\0") {
    throw new Error(`not a WAF file: ${buf.subarray(0, 4).toString("hex")}`);
  }
  const channels = buf.readUInt16LE(6);
  const sampleRate = buf.readUInt32LE(8);
  const byteRate = buf.readUInt32LE(12);
  const blockAlign = buf.readUInt16LE(16);
  const extraFormat = buf.subarray(18, 52);
  const bitsPerSample = extraFormat.readUInt16LE(0);
  const dataLength = buf.readUInt32LE(52);
  if (WAF_HEADER_SIZE + dataLength > buf.length) {
    throw new Error(
      `WAF data length ${dataLength} exceeds file (${buf.length - WAF_HEADER_SIZE} available)`,
    );
  }
  if (bitsPerSample !== 4) {
    throw new Error(`unexpected WAF bits/sample ${bitsPerSample} (expected 4-bit ADPCM)`);
  }
  return {
    channels,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample,
    extraFormat,
    data: buf.subarray(WAF_HEADER_SIZE, WAF_HEADER_SIZE + dataLength),
  };
}

export function decodeWaf(buf: Buffer): DecodedAudio {
  const info = parseWaf(buf);
  const pcm = decodeAdpcm(info.data, info.channels, info.blockAlign);
  return {
    channels: info.channels,
    sampleRate: info.sampleRate,
    pcm,
    duration: pcm.length / (2 * info.channels * info.sampleRate),
  };
}

/** Wrap decoded PCM in a 16-bit RIFF/WAVE container (browser- and player-friendly). */
export function pcmToWav(audio: DecodedAudio): Buffer {
  const { channels, sampleRate, pcm } = audio;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Wrap a headerless 16-bit LE PCM body (sysvoice.dat) as DecodedAudio.
 * See ARCHIVES in library.ts for the evidence that this is the layout.
 */
export function decodeRawPcm(buf: Buffer, channels: number, sampleRate: number): DecodedAudio {
  // Drop a trailing odd byte rather than reading past a sample boundary.
  const pcm = buf.length % 2 === 0 ? buf : buf.subarray(0, buf.length - 1);
  return {
    channels,
    sampleRate,
    pcm,
    duration: pcm.length / (2 * channels * sampleRate),
  };
}

export { decodeAdpcm };
