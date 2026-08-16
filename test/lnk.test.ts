import { describe, expect, it } from "vitest";
import { parseLnk, LnkError, findEntry } from "../src/lnk/parser.js";
import { archive, HAVE_DAT } from "./helpers.js";

describe("LNK parser (synthetic)", () => {
  function build(entries: { name: string; data: Buffer; sizeField?: number }[]): Buffer {
    const header = Buffer.alloc(16);
    header.write("LNK\0", 0, "latin1");
    header.writeUInt32LE(entries.length, 4);
    const index = Buffer.alloc(entries.length * 32);
    let off = 0;
    const blobs: Buffer[] = [];
    entries.forEach((e, i) => {
      index.writeUInt32LE(off, i * 32);
      index.writeUInt32LE(e.sizeField ?? e.data.length << 1, i * 32 + 4);
      index.write(e.name, i * 32 + 8, "latin1");
      blobs.push(e.data);
      off += e.data.length;
    });
    return Buffer.concat([header, index, ...blobs]);
  }

  it("parses a well-formed archive", () => {
    const a = parseLnk(
      build([
        { name: "a.scr", data: Buffer.from("AAAA") },
        { name: "b.scr", data: Buffer.from("BB") },
      ]),
    );
    expect(a.count).toBe(2);
    expect(a.entries[0]!.name).toBe("a.scr");
    expect(a.entries[0]!.size).toBe(4);
    expect(a.entries[1]!.data.toString()).toBe("BB");
    expect(a.warnings).toEqual([]);
  });

  it("decodes the compressed flag from bit 0 of the size field", () => {
    const a = parseLnk(build([{ name: "c.bin", data: Buffer.from("XY"), sizeField: (2 << 1) | 1 }]));
    expect(a.entries[0]!.compressed).toBe(true);
    expect(a.entries[0]!.size).toBe(2);
  });

  it("rejects bad magic", () => {
    expect(() => parseLnk(Buffer.from("NOPE0000000000000"))).toThrow(LnkError);
  });

  it("rejects out-of-bounds entries", () => {
    const buf = build([{ name: "a", data: Buffer.from("AAAA") }]);
    buf.writeUInt32LE(9999, 16 + 4); // size field
    expect(() => parseLnk(buf)).toThrow(/out of bounds/);
  });

  it("rejects duplicate names", () => {
    const buf = build([
      { name: "dup.scr", data: Buffer.from("A") },
      { name: "DUP.scr", data: Buffer.from("B") },
    ]);
    expect(() => parseLnk(buf)).toThrow(/duplicate/);
  });

  it("warns about gaps between entries", () => {
    const buf = build([
      { name: "a", data: Buffer.from("AA") },
      { name: "b", data: Buffer.from("BB") },
    ]);
    buf.writeUInt32LE(1, 16 + 32); // second entry overlaps the first -> warning
    const a = parseLnk(buf);
    expect(a.warnings.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAVE_DAT)("LNK parser (script.dat)", () => {
  it("parses all 104 entries with no warnings", () => {
    const a = archive();
    expect(a.count).toBe(104);
    expect(a.entries).toHaveLength(104);
    expect(a.warnings).toEqual([]);
    expect(a.entries.every((e) => e.data.subarray(0, 4).toString("latin1") === "SC3\0")).toBe(true);
  });

  it("resolves script names case-insensitively with or without extension", () => {
    expect(findEntry(archive(), "SC1A")?.name).toBe("sc1a.scr");
    expect(findEntry(archive(), "s_1a.scr")?.name).toBe("s_1a.scr");
  });
});
