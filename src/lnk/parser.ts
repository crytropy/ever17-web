import { BinaryReader } from "../util/reader.js";
import type { LnkArchive, LnkEntry } from "./types.js";

const MAGIC = Buffer.from("LNK\0", "latin1");
const HEADER_SIZE = 16;
const ENTRY_SIZE = 32;
const NAME_SIZE = 24;

export class LnkError extends Error {}

/**
 * Parse a KID-engine LNK archive.
 *
 * Layout (validated against every .dat of the Ever17 PC release):
 *   0x00  char magic[4]      "LNK\0"
 *   0x04  u32  entryCount
 *   0x08  u8   reserved[8]   observed all-zero
 *   0x10  entries[entryCount]:
 *           u32  offset      relative to end of the entry table
 *           u32  sizeField   (storedSize << 1) | compressedFlag
 *           char name[24]    NUL-padded ASCII
 *   ....  file data, entries contiguous in index order
 */
export function parseLnk(buf: Buffer): LnkArchive {
  if (buf.length < HEADER_SIZE) throw new LnkError("file too small for LNK header");
  if (!buf.subarray(0, 4).equals(MAGIC)) {
    throw new LnkError(
      `bad magic: expected "LNK\\0", got ${buf.subarray(0, 4).toString("hex")}`,
    );
  }
  const r = new BinaryReader(buf, 4);
  const count = r.u32();
  const reserved = r.bytes(8);
  const warnings: string[] = [];
  if (!reserved.every((b) => b === 0)) {
    warnings.push(`reserved header bytes not zero: ${reserved.toString("hex")}`);
  }
  const dataStart = HEADER_SIZE + count * ENTRY_SIZE;
  if (dataStart > buf.length) {
    throw new LnkError(
      `entry table (${count} entries, ends 0x${dataStart.toString(16)}) exceeds file size 0x${buf.length.toString(16)}`,
    );
  }

  const entries: LnkEntry[] = [];
  const seen = new Map<string, number>();
  let expectedOffset = 0;
  for (let i = 0; i < count; i++) {
    r.pos = HEADER_SIZE + i * ENTRY_SIZE;
    const relOffset = r.u32();
    const sizeField = r.u32();
    const nameBytes = r.bytes(NAME_SIZE);
    const nulAt = nameBytes.indexOf(0);
    const nameRaw = nameBytes.subarray(0, nulAt === -1 ? NAME_SIZE : nulAt);
    if (![...nameRaw].every((b) => b >= 0x20 && b < 0x7f)) {
      throw new LnkError(`entry ${i}: name is not printable ASCII: ${nameRaw.toString("hex")}`);
    }
    const name = nameRaw.toString("latin1");
    if (name.length === 0) throw new LnkError(`entry ${i}: empty name`);

    const size = sizeField >>> 1;
    const compressed = (sizeField & 1) === 1;
    const offset = dataStart + relOffset;
    if (offset + size > buf.length) {
      throw new LnkError(
        `entry ${i} "${name}": data [0x${offset.toString(16)}, +0x${size.toString(16)}) out of bounds`,
      );
    }
    const prev = seen.get(name.toLowerCase());
    if (prev !== undefined) {
      throw new LnkError(`duplicate entry name "${name}" (entries ${prev} and ${i})`);
    }
    seen.set(name.toLowerCase(), i);
    if (relOffset !== expectedOffset) {
      warnings.push(
        `entry ${i} "${name}": offset 0x${relOffset.toString(16)} leaves a gap/overlap (expected 0x${expectedOffset.toString(16)})`,
      );
    }
    expectedOffset = relOffset + size;

    entries.push({
      name,
      offset,
      size,
      compressed,
      data: buf.subarray(offset, offset + size),
    });
  }

  const end = dataStart + expectedOffset;
  if (end !== buf.length) {
    warnings.push(
      `archive has ${buf.length - end} trailing byte(s) after last entry (ends 0x${end.toString(16)}, file 0x${buf.length.toString(16)})`,
    );
  }
  return { count, dataStart, entries, warnings };
}

/** Case-insensitive entry lookup ("SC1A" in bytecode refers to sc1a.scr). */
export function findEntry(archive: LnkArchive, name: string): LnkEntry | undefined {
  const want = name.toLowerCase();
  return archive.entries.find(
    (e) => e.name.toLowerCase() === want || e.name.toLowerCase() === `${want}.scr`,
  );
}
