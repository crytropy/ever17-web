/**
 * KID engine RLE/LZ hybrid used by CPS images and by WAF bodies in voice.dat.
 *
 * Control byte layout (bit 7 = "back-reference or run", bit 6 = sub-select):
 *
 *   0b00xxxxxx  literal run:      len = (c & 0x1F) + 1, + (next << 5) if c & 0x20
 *                                 then `len` literal bytes
 *   0b01xxxxxx  repeated block:   len = (c & 0x3F) + 2, iters = next + 1
 *                                 the same `len` source bytes are emitted `iters` times
 *   0b10xxxxxx  back-reference:   len = ((c >> 2) & 0xF) + 2
 *                                 dist = ((c & 3) << 8) + next + 1   (bytes back in output)
 *   0b11xxxxxx  byte run:         len = (c & 0x1F) + 2, + (next << 5) if c & 0x20
 *                                 then one byte, repeated `len` times
 *
 * Back-references may overlap the write cursor, so they are copied one byte at
 * a time. Runs are clamped to the remaining output.
 *
 * Confidence: Confirmed - decodes every .cps in bg.dat/chara.dat/system.dat to
 * exactly the size declared in the CPS header.
 */
export function rleUnpack(input: Buffer, outputSize: number): Buffer {
  const out = Buffer.alloc(outputSize);
  let i = 0;
  let o = 0;

  const need = (n: number): void => {
    if (i + n > input.length) {
      throw new RangeError(
        `RLE stream truncated at input 0x${i.toString(16)} (need ${n}, have ${input.length - i})`,
      );
    }
  };

  while (o < outputSize) {
    need(1);
    const c = input[i++]!;
    if (c & 0x80) {
      if (c & 0x40) {
        // byte run
        let len = (c & 0x1f) + 2;
        if (c & 0x20) {
          need(1);
          len += input[i++]! << 5;
        }
        need(1);
        const b = input[i++]!;
        len = Math.min(len, outputSize - o);
        out.fill(b, o, o + len);
        o += len;
      } else {
        // back-reference into already-written output
        const len0 = ((c >> 2) & 0xf) + 2;
        need(1);
        const dist = ((c & 3) << 8) + input[i++]! + 1;
        if (dist > o) {
          throw new RangeError(
            `RLE back-reference distance ${dist} exceeds ${o} bytes written`,
          );
        }
        const len = Math.min(len0, outputSize - o);
        let src = o - dist;
        for (let k = 0; k < len; k++) out[o + k] = out[src + k]!;
        o += len;
      }
    } else {
      if (c & 0x40) {
        // repeated block: same source bytes emitted N times
        need(1);
        const iters = input[i++]! + 1;
        const len = (c & 0x3f) + 2;
        need(len);
        for (let n = 0; n < iters && o < outputSize; n++) {
          const chunk = Math.min(len, outputSize - o);
          input.copy(out, o, i, i + chunk);
          o += chunk;
        }
        i += len;
      } else {
        // literal run
        let len = (c & 0x1f) + 1;
        if (c & 0x20) {
          need(1);
          len += input[i++]! << 5;
        }
        const copy = Math.min(len, outputSize - o);
        need(copy);
        input.copy(out, o, i, i + copy);
        i += len;
        o += copy;
      }
    }
  }
  return out;
}
