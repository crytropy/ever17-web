import { Sc3Error, SC3_HEADER_SIZE, parseSc3Header, parseEntryTable } from "./header.js";
import type { Chunk, ResourceChunk, Sc3File } from "./types.js";

/**
 * Split one .scr into container regions:
 *
 *   0x00                 SC3 header
 *   0x10                 entry-address table (u32[], sorted, self-delimiting)
 *   tableEnd             code (optionally starting with the `10 24 <sceneId>` preamble;
 *                        codeStartOffset points just past that preamble)
 *   textTableOffset      chunk-offset table: u32[] absolute offsets;
 *                        [textTableOffset, graphicsListOffset)  -> text chunks
 *                        [graphicsListOffset, firstChunkOffset) -> resource chunks
 *   firstChunkOffset     chunk payloads, contiguous to EOF
 */
export function parseSc3(name: string, buf: Buffer): Sc3File {
  const header = parseSc3Header(buf);
  const warnings: string[] = [];
  const { entryPoints, tableEnd } = parseEntryTable(buf, header);

  const { textTableOffset, graphicsListOffset } = header;
  if ((graphicsListOffset - textTableOffset) % 4 !== 0) {
    throw new Sc3Error(`${name}: text chunk table size not a multiple of 4`);
  }
  const textCount = (graphicsListOffset - textTableOffset) / 4;
  const textOffsets: number[] = [];
  for (let i = 0; i < textCount; i++) {
    textOffsets.push(buf.readUInt32LE(textTableOffset + i * 4));
  }

  // Resource offset entries run from graphicsListOffset up to the first chunk
  // payload. The table length is implicit: keep reading u32s until the read
  // position reaches the smallest payload offset seen so far (payloads may be
  // ordered text-first in story scripts or resource-first in startup/system).
  let firstPayload = textOffsets.length > 0 ? Math.min(...textOffsets) : buf.length;
  const resourceOffsets: number[] = [];
  let p = graphicsListOffset;
  while (p + 4 <= buf.length && p + 4 <= firstPayload) {
    const v = buf.readUInt32LE(p);
    if (v < graphicsListOffset || v > buf.length) {
      throw new Sc3Error(
        `${name}: resource offset table entry at 0x${p.toString(16)} out of bounds: 0x${v.toString(16)}`,
      );
    }
    resourceOffsets.push(v);
    firstPayload = Math.min(firstPayload, v);
    p += 4;
  }
  if (textOffsets.length === 0 && resourceOffsets.length > 0) {
    warnings.push("file has resource chunks but no text chunks");
  }

  // Chunk payloads are contiguous; each chunk ends at the nearest following
  // payload offset (payload order differs between story and system scripts).
  const sortedOffsets = [...new Set([...textOffsets, ...resourceOffsets])].sort((a, b) => a - b);
  const chunkEnd = (offset: number): number => {
    let lo = 0;
    let hi = sortedOffsets.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedOffsets[mid]! <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo < sortedOffsets.length ? sortedOffsets[lo]! : buf.length;
  };

  const textChunks: Chunk[] = textOffsets.map((offset, index) => ({
    index,
    offset,
    data: buf.subarray(offset, chunkEnd(offset)),
  }));
  const resourceChunks: ResourceChunk[] = resourceOffsets.map((offset, i) => {
    const data = buf.subarray(offset, chunkEnd(offset));
    const chunk: ResourceChunk = { index: i, offset, data };
    const name = decodeResourceName(data);
    if (name !== undefined) chunk.name = name;
    else warnings.push(`resource chunk ${i} at 0x${offset.toString(16)} is not a clean ASCII name`);
    return chunk;
  });

  return {
    name,
    header,
    entryPoints,
    codeRegionStart: tableEnd,
    codeRegionEnd: textTableOffset,
    textChunks,
    resourceChunks,
    warnings,
  };
}

/** Resource chunks are expected to be NUL-terminated ASCII asset names. */
export function decodeResourceName(data: Buffer): string | undefined {
  const nul = data.indexOf(0);
  if (nul === -1) return undefined;
  const body = data.subarray(0, nul);
  if (body.length === 0) return undefined;
  if (![...body].every((b) => b >= 0x20 && b < 0x7f)) return undefined;
  // anything after the NUL must be padding-free (chunks are exactly sized)
  if (nul !== data.length - 1) return undefined;
  return body.toString("latin1");
}

export { SC3_HEADER_SIZE, parseSc3Header, parseEntryTable };
