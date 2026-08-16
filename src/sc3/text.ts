import { parseExpr } from "./expr.js";
import type { Chunk, RawExpr } from "./types.js";

/**
 * Text chunks are token streams mixing control codes (< 0x20) with DBCS text
 * (GBK in this Chinese release's story scripts, Shift-JIS in the debug
 * scripts). Grammar recovered from 12k+ chunks (docs/sc3-format.md):
 *
 *   chunk        := element* 0x00
 *   element      := 0x0E                       segment start (new message)
 *                 | 0x0D <cstring>             voice id for next line ("S1A012")
 *                 | 0x05 <expr>                segment param (observed always [0])
 *                 | 0x0B 0x00 <u16>            choice header: choice id
 *                 | 0x0B 0x01 text... 0x01     choice option text
 *                 | 0x0A <expr>                option visibility condition
 *                 | 0x01                       line break / name-body separator
 *                 | 0x02                       message end (wait for input)
 *                 | 0x03                       page end
 *                 | 0x04 <expr>                inline wait/param
 *                 | 0x10 <u8>                  unknown 2-byte control
 *                 | 0x11 <u8> | 0x14 <u8>      unknown 2-byte controls (rare)
 *                 | 0x0C                       unknown 1-byte control (rare)
 *                 | text bytes                 >=0x80 starts a 2-byte char
 */

export type TextToken =
  | { kind: "segmentStart" }
  | { kind: "voice"; id: string }
  | { kind: "segmentParam"; expr: RawExpr }
  | { kind: "choiceHeader"; choiceId: number }
  | { kind: "optionCondition"; expr: RawExpr }
  | { kind: "optionText"; raw: Buffer; text: string }
  | { kind: "text"; raw: Buffer; text: string }
  | { kind: "lineBreak" }
  | { kind: "messageEnd" }
  | { kind: "pageEnd" }
  | { kind: "wait"; expr: RawExpr }
  | { kind: "control"; code: number; arg?: number }
  | { kind: "unknown"; raw: Buffer };

export interface ParsedTextChunk {
  index: number;
  tokens: TextToken[];
  warnings: string[];
}

export type TextEncoding = "gbk" | "shift_jis";

const decoders = new Map<TextEncoding, InstanceType<typeof TextDecoder>>();
export function decodeDbcs(raw: Buffer, encoding: TextEncoding): string {
  let d = decoders.get(encoding);
  if (!d) {
    d = new TextDecoder(encoding, { fatal: false });
    decoders.set(encoding, d);
  }
  return d.decode(raw);
}

/** Read a run of text bytes (stops at control bytes < 0x20). */
function readTextRun(data: Buffer, start: number): { raw: Buffer; end: number } {
  let p = start;
  while (p < data.length) {
    const b = data[p]!;
    if (b < 0x20) break;
    p += b >= 0x80 ? 2 : 1;
  }
  return { raw: data.subarray(start, Math.min(p, data.length)), end: Math.min(p, data.length) };
}

export function parseTextChunk(
  chunk: Chunk,
  encoding: TextEncoding,
): ParsedTextChunk {
  const data = chunk.data;
  const tokens: TextToken[] = [];
  const warnings: string[] = [];
  let p = 0;
  let terminated = false;

  const expr = (): RawExpr => {
    const r = parseExpr(data, p);
    p = r.end;
    return r.expr;
  };

  while (p < data.length) {
    const b = data[p]!;
    if (b === 0x00) {
      p += 1;
      terminated = true;
      if (p !== data.length) {
        // trailing bytes after the terminator (alignment padding is not
        // expected inside the chunk area - report, keep going)
        if ([...data.subarray(p)].every((x) => x === 0)) {
          warnings.push(`${data.length - p} trailing zero byte(s) after terminator`);
          p = data.length;
        } else {
          warnings.push(`content after terminator at +0x${p.toString(16)}; re-parsing`);
          terminated = false;
        }
      }
      continue;
    }
    if (b >= 0x20) {
      const { raw, end } = readTextRun(data, p);
      tokens.push({ kind: "text", raw, text: decodeDbcs(raw, encoding) });
      p = end;
      continue;
    }
    switch (b) {
      case 0x0e:
        tokens.push({ kind: "segmentStart" });
        p += 1;
        break;
      case 0x0d: {
        p += 1;
        const nul = data.indexOf(0, p);
        if (nul === -1) {
          warnings.push("voice tag unterminated");
          tokens.push({ kind: "unknown", raw: data.subarray(p - 1) });
          p = data.length;
          break;
        }
        tokens.push({ kind: "voice", id: data.subarray(p, nul).toString("latin1") });
        p = nul + 1;
        break;
      }
      case 0x05: {
        p += 1;
        tokens.push({ kind: "segmentParam", expr: expr() });
        break;
      }
      case 0x0b: {
        const sub = data[p + 1];
        if (sub === 0x00) {
          const id = data.readUInt16LE(p + 2);
          tokens.push({ kind: "choiceHeader", choiceId: id });
          p += 4;
        } else if (sub === 0x01) {
          p += 2;
          // option text runs to the next lone 0x01
          const start = p;
          while (p < data.length && data[p] !== 0x01) {
            p += data[p]! >= 0x80 ? 2 : 1;
          }
          const raw = data.subarray(start, p);
          tokens.push({ kind: "optionText", raw, text: decodeDbcs(raw, encoding) });
          if (data[p] === 0x01) p += 1;
          else warnings.push("option text missing 0x01 terminator");
        } else {
          warnings.push(`0x0b with unexpected subtype ${sub?.toString(16)}`);
          tokens.push({ kind: "unknown", raw: data.subarray(p, p + 2) });
          p += 2;
        }
        break;
      }
      case 0x0a: {
        p += 1;
        tokens.push({ kind: "optionCondition", expr: expr() });
        break;
      }
      case 0x01:
        tokens.push({ kind: "lineBreak" });
        p += 1;
        break;
      case 0x02:
        tokens.push({ kind: "messageEnd" });
        p += 1;
        break;
      case 0x03:
        tokens.push({ kind: "pageEnd" });
        p += 1;
        break;
      case 0x04: {
        p += 1;
        tokens.push({ kind: "wait", expr: expr() });
        break;
      }
      case 0x10:
      case 0x11:
      case 0x14: {
        const arg = data[p + 1];
        tokens.push(arg === undefined ? { kind: "control", code: b } : { kind: "control", code: b, arg });
        p += 2;
        break;
      }
      case 0x0c:
        tokens.push({ kind: "control", code: b });
        p += 1;
        break;
      default: {
        tokens.push({ kind: "unknown", raw: data.subarray(p, p + 1) });
        warnings.push(`unknown control byte 0x${b.toString(16).padStart(2, "0")} at +0x${p.toString(16)}`);
        p += 1;
      }
    }
  }
  if (!terminated) warnings.push("chunk missing 0x00 terminator");
  return { index: chunk.index, tokens, warnings };
}

/** Guess the text encoding for a script by its name (debug scripts are SJIS
 * in this release, story scripts GBK). */
export function encodingForScript(name: string): TextEncoding {
  return name.toLowerCase().startsWith("debug") ? "shift_jis" : "gbk";
}
