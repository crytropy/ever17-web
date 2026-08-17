import { cpsDeobfuscate } from "./deobfuscate.js";
import { rleUnpack } from "./rle.js";
import { parsePrt, prtToRgba } from "./prt.js";
import type { DecodedImage, PrtInfo } from "../types.js";

/**
 * CPS container:
 *   0x00  char magic[4]      "CPS\0"
 *   0x04  u32  fileSize      must equal the archive entry size
 *   0x08  u16  type          0x0066 for every Ever17 image
 *   0x0A  u8   compression   bit 0 set: RLE-compressed body; 0: stored
 *   0x0B  u8   unknown       always 0x01 in this release
 *   0x0C  u32  plainSize     size of the PRT payload
 *   0x10  ...  obfuscated body (see deobfuscate.ts), last 4 bytes = key offset
 */
export interface CpsHeader {
  fileSize: number;
  type: number;
  compression: number;
  plainSize: number;
}

export function parseCpsHeader(buf: Buffer): CpsHeader {
  if (buf.length < 20) throw new Error("CPS file too small");
  if (buf.subarray(0, 4).toString("latin1") !== "CPS\0") {
    throw new Error(`not a CPS file: ${buf.subarray(0, 4).toString("hex")}`);
  }
  const fileSize = buf.readUInt32LE(4);
  if (fileSize !== buf.length) {
    throw new Error(`CPS size mismatch: header says ${fileSize}, got ${buf.length}`);
  }
  const type = buf.readUInt16LE(8);
  if (type !== 0x66) throw new Error(`unexpected CPS type 0x${type.toString(16)}`);
  const compression = buf.readUInt8(10);
  const plainSize = buf.readUInt32LE(12);
  return { fileSize, type, compression, plainSize };
}

/** CPS -> PRT payload (deobfuscated and decompressed). */
export function cpsToPrt(buf: Buffer): Buffer {
  const h = parseCpsHeader(buf);
  const plain = cpsDeobfuscate(buf);
  if (h.compression & 1) {
    return rleUnpack(plain.subarray(20), h.plainSize);
  }
  if (h.compression !== 0) {
    throw new Error(`unknown CPS compression mode 0x${h.compression.toString(16)}`);
  }
  return plain.subarray(20, 20 + h.plainSize);
}

export function decodeCps(buf: Buffer): DecodedImage {
  return prtToRgba(parseCpsPrt(buf));
}

export function parseCpsPrt(buf: Buffer): PrtInfo {
  return parsePrt(cpsToPrt(buf));
}

export { cpsDeobfuscate, rleUnpack, parsePrt, prtToRgba };
