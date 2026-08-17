import type { DecodedImage, PrtInfo } from "../types.js";

/**
 * PRT: the plain bitmap container found inside every CPS file.
 *
 *   0x00  char magic[4]   "PRT\0"
 *   0x04  u16  version    0x65 (short header) or 0x66 (long header)
 *   0x06  u16  colorDepth bits per pixel (8 = paletted, 24 = BGR)
 *   0x08  u16  paletteOffset
 *   0x0A  u16  dataOffset
 *   0x0C  u16  width
 *   0x0E  u16  height
 *   0x10  u32  hasAlpha   nonzero: an 8-bit alpha plane follows the BGR plane
 *   -- version 0x66 only --
 *   0x14  u32  baseLeftOffset   sprite anchor: x offset of `width` inside the
 *                               nominal 0x0C width (used with the SET_SPRITE x operand)
 *   0x18  u32  unknown
 *   0x1C  u32  width2     when nonzero, the real width  (0x0C is then nominal)
 *   0x20  u32  height2    when nonzero, the real height
 *
 * Pixel rows are bottom-up (BMP convention) and padded to a 4-byte boundary.
 * The alpha plane, when present, is stored top-down and unpadded.
 *
 * Confidence: Confirmed - decoded images render correctly (verified visually
 * for backgrounds, event CGs, alpha-masked character sprites and UI parts).
 */
export function parsePrt(prt: Buffer): PrtInfo {
  if (prt.length < 20 || prt.subarray(0, 4).toString("latin1") !== "PRT\0") {
    throw new Error(`not a PRT payload: ${prt.subarray(0, 4).toString("hex")}`);
  }
  const version = prt.readUInt16LE(4);
  if (version !== 0x65 && version !== 0x66) {
    throw new Error(`unsupported PRT version 0x${version.toString(16)}`);
  }
  const colorDepth = prt.readUInt16LE(6);
  const paletteOffset = prt.readUInt16LE(8);
  const dataOffset = prt.readUInt16LE(10);
  let width = prt.readUInt16LE(12);
  let height = prt.readUInt16LE(14);
  const hasAlpha = prt.readUInt32LE(16) !== 0;

  let baseLeftOffset = 0;
  let nominalWidth = width;
  if (version === 0x66) {
    if (prt.length < 36) throw new Error("PRT v0x66 header truncated");
    baseLeftOffset = prt.readUInt32LE(20);
    const width2 = prt.readUInt32LE(28);
    const height2 = prt.readUInt32LE(32);
    if (width2 !== 0) width = width2;
    if (height2 !== 0) height = height2;
  }
  if (width === 0 || height === 0) throw new Error(`degenerate PRT size ${width}x${height}`);
  if (colorDepth % 8 !== 0) throw new Error(`unsupported colour depth ${colorDepth}`);

  const bytesPerPixel = colorDepth / 8;
  const stride = (((width * bytesPerPixel + 3) / 4) | 0) * 4;
  const planeSize = stride * height;

  let palette: Buffer | undefined;
  if (dataOffset > paletteOffset) {
    palette = prt.subarray(paletteOffset, dataOffset);
    const expected = (1 << colorDepth) * 4;
    if (palette.length !== expected) {
      throw new Error(`palette is ${palette.length} bytes, expected ${expected}`);
    }
  }
  const body = prt.subarray(dataOffset, dataOffset + planeSize);
  if (body.length < planeSize) {
    throw new Error(`PRT pixel plane truncated: ${body.length}/${planeSize}`);
  }
  const alpha = hasAlpha ? prt.subarray(dataOffset + planeSize) : undefined;
  if (alpha !== undefined && alpha.length < width * height) {
    throw new Error(`PRT alpha plane truncated: ${alpha.length}/${width * height}`);
  }

  return {
    version,
    width,
    height,
    nominalWidth,
    baseLeftOffset,
    colorDepth,
    stride,
    hasAlpha,
    ...(palette ? { palette } : {}),
    body,
    ...(alpha ? { alpha } : {}),
  };
}

/** Convert a parsed PRT into top-down straight-alpha RGBA. */
export function prtToRgba(p: PrtInfo): DecodedImage {
  const { width, height, stride } = p;
  const rgba = Buffer.alloc(width * height * 4);
  const paletted = p.palette !== undefined;
  if (paletted && p.colorDepth !== 8) {
    throw new Error(`paletted ${p.colorDepth}-bit images are not supported`);
  }
  if (!paletted && p.colorDepth !== 24) {
    throw new Error(`unsupported non-paletted colour depth ${p.colorDepth}`);
  }

  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * stride; // stored bottom-up
    const dstRow = y * width * 4;
    for (let x = 0; x < width; x++) {
      const d = dstRow + x * 4;
      if (paletted) {
        const idx = p.body[srcRow + x]! * 4;
        rgba[d] = p.palette![idx + 2]!;
        rgba[d + 1] = p.palette![idx + 1]!;
        rgba[d + 2] = p.palette![idx]!;
        rgba[d + 3] = 255;
      } else {
        const s = srcRow + x * 3;
        rgba[d] = p.body[s + 2]!; // R  (stored BGR)
        rgba[d + 1] = p.body[s + 1]!;
        rgba[d + 2] = p.body[s]!;
        rgba[d + 3] = p.alpha ? p.alpha[y * width + x]! : 255;
      }
    }
  }
  return { width, height, rgba, hasAlpha: p.hasAlpha, baseLeftOffset: p.baseLeftOffset, nominalWidth: p.nominalWidth };
}
