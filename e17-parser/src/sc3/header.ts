import { BinaryReader } from "../util/reader.js";
import type { Sc3Header } from "./types.js";

const MAGIC = Buffer.from("SC3\0", "latin1");
export const SC3_HEADER_SIZE = 16;

export class Sc3Error extends Error {}

export function parseSc3Header(buf: Buffer): Sc3Header {
  if (buf.length < SC3_HEADER_SIZE) throw new Sc3Error("file too small for SC3 header");
  if (!buf.subarray(0, 4).equals(MAGIC)) {
    throw new Sc3Error(`bad magic: ${buf.subarray(0, 4).toString("hex")}`);
  }
  const r = new BinaryReader(buf, 4);
  const textTableOffset = r.u32();
  const graphicsListOffset = r.u32();
  const codeStartOffset = r.u32();
  if (textTableOffset > buf.length) throw new Sc3Error("textTableOffset out of bounds");
  if (graphicsListOffset < textTableOffset || graphicsListOffset > buf.length) {
    throw new Sc3Error(
      `graphicsListOffset 0x${graphicsListOffset.toString(16)} outside [textTableOffset, EOF]`,
    );
  }
  if (codeStartOffset < SC3_HEADER_SIZE || codeStartOffset > textTableOffset) {
    throw new Sc3Error(`codeStartOffset 0x${codeStartOffset.toString(16)} out of range`);
  }
  return { textTableOffset, graphicsListOffset, codeStartOffset };
}

/**
 * Parse the entry-address table that begins at 0x10.
 *
 * The table has no explicit length. Empirically it is a non-decreasing list of
 * u32 addresses within [0x10, textTableOffset); it ends where the next u32
 * would be out of range or break monotonicity (the first code instruction's
 * bytes never form a valid address).
 *
 * Returns the addresses and the file offset just past the table.
 */
export function parseEntryTable(
  buf: Buffer,
  header: Sc3Header,
): { entryPoints: number[]; tableEnd: number } {
  const entryPoints: number[] = [];
  let p = SC3_HEADER_SIZE;
  let last = 0;
  while (p + 4 <= header.textTableOffset) {
    const v = buf.readUInt32LE(p);
    if (v < SC3_HEADER_SIZE || v >= header.textTableOffset || v < last) break;
    entryPoints.push(v);
    last = v;
    p += 4;
  }
  return { entryPoints, tableEnd: p };
}
