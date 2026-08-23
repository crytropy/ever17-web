import { describe, expect, it } from "vitest";
import { parseSc3 } from "../src/sc3/chunks.js";
import { parseExpr, exprImm, exprVarTest } from "../src/sc3/expr.js";
import { decodeDbcs, parseTextChunk } from "../src/sc3/text.js";
import { archive, HAVE_DAT, scr } from "./helpers.js";

describe("expression parser (synthetic)", () => {
  const parse = (hex: string, pad = true) => parseExpr(Buffer.from(hex.replace(/ /g, ""), "hex"), 0, pad);

  it("decodes 1-byte immediates 0x80|v", () => {
    const { expr, end } = parse("83 00 00");
    expect(exprImm(expr)).toBe(3);
    expect(expr.immPad).toBe(true);
    expect(end).toBe(3);
  });

  it("decodes 2-byte immediates big-endian with 5 head bits", () => {
    expect(exprImm(parse("a1 40 00 00").expr)).toBe(320); // sprite center-x
    expect(exprImm(parse("a3 e8 00 00").expr)).toBe(1000);
    expect(exprImm(parse("a0 2c 00 00").expr)).toBe(44); // s_1a choice id
  });

  it("decodes 3-byte and full-u32 immediates", () => {
    expect(exprImm(parse("c0 12 27 00 00").expr)).toBe(0x1227);
    // 0xE0 class carries a full big-endian u32 in the next 4 bytes
    expect(exprImm(parse("e0 00 00 28 00 00 00").expr)).toBe(0x2800);
    expect(exprImm(parse("e0 29 00 5d 00 00 00").expr)).toBe(0x29005d00);
  });

  it("requires the pad byte after a trailing immediate", () => {
    expect(() => parse("83 00 05")).toThrow(/pad/);
    expect(parse("83 00 05", false).end).toBe(2); // V-type operands skip the pad
  });

  it("parses operator-terminated expressions without a pad", () => {
    const { expr, end } = parse("0a a4 b3 14 14 00");
    expect(end).toBe(6);
    expect(expr.immPad).toBe(false);
    const vt = exprVarTest(expr);
    expect(vt).toEqual({ varId: 1203, ops: [0x14, 0x14] });
  });

  it("parses the empty expression as a single terminator byte", () => {
    const { expr, end } = parse("00");
    expect(expr.tokens).toEqual([]);
    expect(end).toBe(1);
  });
});

describe("text chunk parser (synthetic)", () => {
  it("parses a dialogue segment with voice and speaker", () => {
    // 0e 0d "S1A012" 00 05 <expr 0> 【？？】 01 「...」 02 03 00  (structure from s_1a text#19)
    const gbk = (s: string) => {
      // minimal GBK bytes for the test: use ASCII-compatible text
      return Buffer.from(s, "latin1");
    };
    const data = Buffer.concat([
      Buffer.from([0x0e, 0x0d]),
      Buffer.from("S1A012\0", "latin1"),
      Buffer.from([0x05, 0x80, 0x00, 0x00]),
      gbk("NAME"),
      Buffer.from([0x01]),
      gbk("hello"),
      Buffer.from([0x02, 0x03, 0x00]),
    ]);
    const parsed = parseTextChunk({ index: 0, offset: 0, data }, "gbk");
    expect(parsed.warnings).toEqual([]);
    const kinds = parsed.tokens.map((t) => t.kind);
    expect(kinds).toEqual([
      "segmentStart",
      "voice",
      "segmentParam",
      "text",
      "lineBreak",
      "text",
      "messageEnd",
      "pageEnd",
    ]);
    expect(parsed.tokens[1]).toMatchObject({ kind: "voice", id: "S1A012" });
  });

  it("parses a choice chunk with id and options", () => {
    const data = Buffer.concat([
      Buffer.from([0x05, 0x80, 0x00, 0x00]),
      Buffer.from([0x0b, 0x00, 0x2c, 0x00]), // choice id 44
      Buffer.from([0x0b, 0x01]),
      Buffer.from("yes", "latin1"),
      Buffer.from([0x01]),
      Buffer.from([0x0b, 0x01]),
      Buffer.from("no", "latin1"),
      Buffer.from([0x01, 0x00]),
    ]);
    const parsed = parseTextChunk({ index: 0, offset: 0, data }, "gbk");
    expect(parsed.warnings).toEqual([]);
    expect(parsed.tokens).toContainEqual({ kind: "choiceHeader", choiceId: 44 });
    const opts = parsed.tokens.filter((t) => t.kind === "optionText");
    expect(opts.map((o) => (o.kind === "optionText" ? o.text : ""))).toEqual(["yes", "no"]);
  });
});

describe.skipIf(!HAVE_DAT)("SC3 container (script.dat)", () => {
  it("splits every script without exceptions", () => {
    for (const e of archive().entries) {
      const f = parseSc3(e.name, e.data);
      expect(f.header.textTableOffset).toBeLessThanOrEqual(e.data.length);
      // entry table addresses always land inside the code region
      for (const ep of f.entryPoints) {
        expect(ep).toBeGreaterThanOrEqual(0x10);
        expect(ep).toBeLessThan(f.header.textTableOffset);
      }
    }
  });

  it("recovers the documented layout of debug_ch11.scr", () => {
    const f = parseSc3("debug_ch11.scr", scr("debug_ch11.scr").data);
    expect(f.header).toEqual({
      textTableOffset: 0x138,
      graphicsListOffset: 0x160,
      codeStartOffset: 0x21,
    });
    expect(f.entryPoints).toEqual([0x44, 0x53, 0x5e]);
    expect(f.textChunks).toHaveLength(10);
    expect(f.resourceChunks).toHaveLength(9);
    expect(f.resourceChunks.map((r) => r.name)).toEqual([
      "my01adl", "my01adm", "my01ads",
      "my04adl", "my04adm", "my04ads",
      "my19adl", "my19adm", "my19ads",
    ]);
  });

  it("decodes GBK story text with speaker and voice (s_1a text#19)", () => {
    const f = parseSc3("s_1a.scr", scr("s_1a.scr").data);
    const parsed = parseTextChunk(f.textChunks[19]!, "gbk");
    const voice = parsed.tokens.find((t) => t.kind === "voice");
    expect(voice).toMatchObject({ id: "S1A012" });
    const text = parsed.tokens.filter((t) => t.kind === "text").map((t) => (t.kind === "text" ? t.text : ""));
    expect(text.join("")).toContain("止痛药");
  });
});

describe("the engine's private word-space code", () => {
  /**
   * KID's font is indexed by DBCS code, not Unicode, and its inter-word space
   * sits in the last circled-number slot of each encoding's symbol row. A
   * conformant decoder turns that into a number glyph, which is how
   * `Insel null` reached the screen as `Insel⒇null`.
   */
  it("decodes the GBK slot as a space, not a parenthesized twenty", () => {
    // full-width "Insel" + A2D8 + full-width "null"
    const raw = Buffer.from("a3c9a3eea3f3a3e5a3ec" + "a2d8" + "a3eea3f5a3eca3ec", "hex");
    expect(decodeDbcs(raw, "gbk")).toBe("Ｉｎｓｅｌ　ｎｕｌｌ");
    expect(decodeDbcs(raw, "gbk")).not.toContain("⒇");
  });

  it("decodes the Shift-JIS slot as a space, not a circled twenty", () => {
    // 田中 + 8753 + 優, as debug.scr writes every character's name
    const raw = Buffer.from("9363928687539744", "hex");
    expect(decodeDbcs(raw, "shift_jis")).toBe("田中　優");
    expect(decodeDbcs(raw, "shift_jis")).not.toContain("⑳");
  });

  it("leaves the other circled numbers alone", () => {
    // debug.scr uses these literally in a font test string
    const raw = Buffer.from("8749874a874b", "hex");
    expect(decodeDbcs(raw, "shift_jis")).toBe("⑩⑪⑫");
  });
});
