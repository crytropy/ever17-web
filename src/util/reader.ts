/** Bounds-checked little-endian binary reader over a Buffer. */
export class BinaryReader {
  readonly buf: Buffer;
  pos: number;

  constructor(buf: Buffer, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  get length(): number {
    return this.buf.length;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new RangeError(
        `read of ${n} bytes at 0x${this.pos.toString(16)} exceeds buffer size 0x${this.buf.length.toString(16)}`,
      );
    }
  }

  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.pos++);
  }

  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  bytes(n: number): Buffer {
    this.need(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  peek(offset = 0): number {
    const p = this.pos + offset;
    if (p >= this.buf.length) return -1;
    return this.buf[p]!;
  }

  /** Read a NUL-terminated byte string (not including the NUL). */
  cstringBytes(maxLen = 1024): Buffer {
    const end = this.buf.indexOf(0, this.pos);
    if (end === -1 || end - this.pos > maxLen) {
      throw new RangeError(`unterminated string at 0x${this.pos.toString(16)}`);
    }
    const v = this.buf.subarray(this.pos, end);
    this.pos = end + 1;
    return v;
  }
}

export function hex(n: number, width = 8): string {
  return n.toString(16).toUpperCase().padStart(width, "0");
}

export function hexdump(buf: Buffer, base = 0): string {
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i += 16) {
    const chunk = buf.subarray(i, i + 16);
    const hexs = [...chunk].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const asc = [...chunk]
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
      .join("");
    lines.push(`${hex(base + i)}: ${hexs.padEnd(47)} ${asc}`);
  }
  return lines.join("\n");
}
