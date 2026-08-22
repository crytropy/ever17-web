/**
 * CPS obfuscation layer.
 *
 * A CPS file's payload (everything from 0x10 up to the last 4 bytes) is
 * scrambled with a linear congruential keystream. The trailer u32 encodes the
 * offset of the 4-byte seed *within the payload itself*; that slot is skipped
 * while unscrambling.
 *
 *   vOff   = u32le(data[len-4]) - 0x07534682
 *   key    = u32le(data[vOff]) + vOff + 0x03786425
 *   for i = 0x10; i < len-4; i += 4:
 *     if i != vOff: u32le(data[i]) -= key + len
 *     key = key * 0x41C64E6D + 0x9B06
 *
 * All arithmetic is mod 2^32. The trailer is dropped afterwards. A vOff of 0
 * means "not obfuscated".
 *
 * Confidence: Confirmed - reproduces byte-identical PRT payloads whose
 * declared sizes match width*height*bytesPerPixel + header for every image
 * tested across bg.dat, chara.dat and system.dat.
 */
export function cpsDeobfuscate(input: Buffer, limitBytes?: number): Buffer {
  if (input.length < 24) {
    throw new RangeError(`CPS payload too small: ${input.length} bytes`);
  }
  const data = Buffer.from(input); // copy: never mutate the archive mapping
  const len = data.length;
  const vOff = (data.readUInt32LE(len - 4) - 0x07534682) >>> 0;
  if (vOff === 0) return data.subarray(0, len - 4);
  if (vOff + 4 > len - 4 || vOff < 0x10) {
    throw new RangeError(`CPS seed offset 0x${vOff.toString(16)} outside payload`);
  }

  let key = (data.readUInt32LE(vOff) + vOff + 0x03786425) >>> 0;
  // The keystream is sequential from 0x10, so a caller that only needs the
  // start of the payload (header probing) can stop early; bytes past the
  // limit are left scrambled.
  const limit = limitBytes === undefined ? len - 4 : Math.min(len - 4, 0x10 + limitBytes);
  for (let i = 0x10; i < limit; i += 4) {
    if (i + 4 <= limit && i !== vOff) {
      const v = (data.readUInt32LE(i) - key - len) >>> 0;
      data.writeUInt32LE(v, i);
    }
    // key = key * 0x41C64E6D + 0x9B06 (mod 2^32), done in 16-bit halves to
    // stay inside the float53 exact-integer range.
    const lo = key & 0xffff;
    const hi = key >>> 16;
    const m = 0x41c64e6d;
    const mLo = m & 0xffff;
    const mHi = m >>> 16;
    const p0 = lo * mLo;
    const p1 = (lo * mHi + hi * mLo) >>> 0;
    key = (((p1 << 16) >>> 0) + p0 + 0x9b06) >>> 0;
  }
  return data.subarray(0, len - 4);
}
