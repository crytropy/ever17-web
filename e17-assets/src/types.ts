/** Parsed PRT bitmap container (the plain image inside a CPS). */
export interface PrtInfo {
  version: number;
  width: number;
  height: number;
  /** Header width field before the v0x66 override; sprite anchoring uses it. */
  nominalWidth: number;
  /** x offset of this image inside the nominal sprite frame (v0x66 only). */
  baseLeftOffset: number;
  colorDepth: number;
  /** Row stride of the stored (bottom-up) pixel plane, padded to 4 bytes. */
  stride: number;
  hasAlpha: boolean;
  palette?: Buffer;
  body: Buffer;
  alpha?: Buffer;
}

/** Top-down straight-alpha RGBA image. */
export interface DecodedImage {
  width: number;
  height: number;
  rgba: Buffer;
  hasAlpha: boolean;
  baseLeftOffset: number;
  nominalWidth: number;
}

/** Decoded WAF audio. */
export interface DecodedAudio {
  channels: number;
  sampleRate: number;
  /** Signed 16-bit little-endian interleaved PCM. */
  pcm: Buffer;
  /** Duration in seconds. */
  duration: number;
}

export interface WafInfo {
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  /** 34-byte MS-ADPCM extra format data (coefficient table), passed through to WAV. */
  extraFormat: Buffer;
  data: Buffer;
}

/** The manifest contract is owned by kid-contracts; re-exported for callers. */
export type { AssetManifest, ManifestEntry } from "kid-contracts/manifest";
