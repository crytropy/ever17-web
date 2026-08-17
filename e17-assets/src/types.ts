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

/** One entry of an extracted asset set. */
export interface ManifestEntry {
  /** Logical name as referenced by the scenario (e.g. "bg01a1", "SE01_04"). */
  name: string;
  kind: "image" | "audio";
  /** Source archive file, e.g. "bg.dat". */
  archive: string;
  /** Path of the converted file, relative to the manifest. */
  file: string;
  width?: number;
  height?: number;
  hasAlpha?: boolean;
  baseLeftOffset?: number;
  channels?: number;
  sampleRate?: number;
  duration?: number;
}

export interface AssetManifest {
  /** Asset entries keyed by lowercased logical name. */
  assets: Record<string, ManifestEntry>;
  /** Names referenced by the scenario that could not be found in any archive. */
  missing: string[];
  generatedFrom: string[];
}
