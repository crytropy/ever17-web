import { parseExpr, ExprError } from "./expr.js";
import { lookupOpcode, OPCODES, OPCODES1, type OpcodeDef } from "./opcodes.js";
import type { DataRegion, Disassembly, Instruction, Operand, Sc3File } from "./types.js";

class Desync extends Error {}

/** Decode operands for one instruction according to its signature. */
function parseOperands(
  buf: Buffer,
  start: number,
  sig: string,
  entryCount: number,
): { operands: Operand[]; end: number } {
  const operands: Operand[] = [];
  let p = start;
  for (const ch of sig) {
    switch (ch) {
      case "E":
      case "V": {
        try {
          const { expr, end } = parseExpr(buf, p, ch === "E");
          operands.push({ kind: "expr", expr });
          p = end;
        } catch (e) {
          if (e instanceof ExprError) throw new Desync(e.message);
          throw e;
        }
        break;
      }
      case "W":
      case "R":
      case "J": {
        if (p + 2 > buf.length) throw new Desync("u16 operand truncated");
        const v = buf.readUInt16LE(p);
        p += 2;
        if (ch === "J") {
          if (v === 0 || v > entryCount) {
            throw new Desync(`entry reference #${v} out of range (1..${entryCount})`);
          }
          operands.push({ kind: "entryRef", index: v });
        } else {
          operands.push({ kind: "u16", value: v });
        }
        break;
      }
      case "B": {
        if (p >= buf.length) throw new Desync("byte operand truncated");
        operands.push({ kind: "u8", value: buf[p]! });
        p += 1;
        break;
      }
      case "4": {
        if (p + 4 > buf.length) throw new Desync("raw4 operand truncated");
        operands.push({ kind: "raw", bytes: buf.subarray(p, p + 4) });
        p += 4;
        break;
      }
      case "S": {
        const end = buf.indexOf(0, p);
        if (end === -1 || end - p > 64) throw new Desync("string operand unterminated/too long");
        const s = buf.subarray(p, end);
        if (s.length === 0 || ![...s].every((b) => b >= 0x20 && b < 0x7f)) {
          throw new Desync("string operand not printable ASCII");
        }
        operands.push({ kind: "string", value: s.toString("latin1") });
        p = end + 1;
        break;
      }
      case "T": {
        if (buf[p] !== 0xff) throw new Desync(`expected 0xff text ref at 0x${p.toString(16)}`);
        if (p + 3 > buf.length) throw new Desync("text ref truncated");
        operands.push({ kind: "textRef", index: buf.readUInt16LE(p + 1) });
        p += 3;
        break;
      }
      case "L": {
        // Switch jump table: u16 entry indexes. No explicit length; stop when
        // the next two bytes form a known opcode or an implausible index.
        const values: number[] = [];
        while (p + 2 <= buf.length) {
          const b0 = buf[p]!;
          const b1 = buf[p + 1] ?? 0;
          if (lookupOpcode(b0, b1)) break;
          const v = buf.readUInt16LE(p);
          if (v === 0 || v > Math.max(entryCount, 1)) break;
          values.push(v);
          p += 2;
        }
        operands.push({ kind: "u16list", values });
        break;
      }
      default:
        throw new Error(`bad signature char ${ch}`);
    }
  }
  return { operands, end: p };
}

/** True if [start,end) decodes as a table of NUL-terminated printable strings. */
function tryStringTable(buf: Buffer, start: number, end: number): string[] | undefined {
  const out: string[] = [];
  let p = start;
  while (p < end) {
    const nul = buf.indexOf(0, p);
    if (nul === -1 || nul >= end) return undefined;
    const s = buf.subarray(p, nul);
    if (s.length === 0 || ![...s].every((b) => b >= 0x20 && b < 0x7f)) return undefined;
    out.push(s.toString("latin1"));
    p = nul + 1;
  }
  return out.length >= 2 ? out : undefined;
}

/**
 * Linear-sweep disassembler with anchor-based resynchronization.
 *
 * Decoding starts at the end of the entry table and proceeds linearly. On an
 * undecodable byte the region up to the next anchor (entry point) is recorded
 * as a DataRegion - never silently skipped - and decoding resumes there.
 * A resync anchor that itself fails immediately falls through to the next one.
 */
export function disassemble(file: Sc3File, buf: Buffer): Disassembly {
  const instructions: Instruction[] = [];
  const dataRegions: DataRegion[] = [];
  const start = file.codeRegionStart;
  const end = file.codeRegionEnd;
  const anchors = [...new Set(file.entryPoints)].sort((a, b) => a - b);
  const entryCount = file.entryPoints.length;

  let covered = 0;
  let p = start;

  const pushData = (from: number, to: number, reason: string) => {
    if (to <= from) return;
    const bytes = buf.subarray(from, to);
    const region: DataRegion = { address: from, bytes, reason };
    const strings = tryStringTable(buf, from, to);
    if (strings) region.strings = strings;
    dataRegions.push(region);
  };

  while (p < end) {
    // trailing zero padding
    if (buf[p] === 0) {
      let q = p;
      while (q < end && buf[q] === 0) q++;
      if (q === end) {
        // pure padding to the text table
        covered += q - p;
        p = q;
        break;
      }
      // interior zero run: single pad bytes occur before instructions
      // (e.g. between option rows and before 10 20); consume them one at a
      // time only when what follows decodes - handled below via lookahead.
    }

    const b0 = buf[p]!;
    const b1 = p + 1 < end ? buf[p + 1]! : 0;
    let hit = lookupOpcode(b0, b1);

    // A lone 0x00 that does not begin a known 00xx opcode but is followed by
    // a decodable instruction is a pad byte (observed between choice option
    // rows and ahead of 10-class ops).
    if (!hit && b0 === 0x00 && p + 1 < end) {
      const n0 = buf[p + 1]!;
      const n1 = p + 2 < end ? buf[p + 2]! : 0;
      if (lookupOpcode(n0, n1)) {
        instructions.push({
          address: p,
          raw: buf.subarray(p, p + 1),
          mnemonic: "PAD",
          opcode: buf.subarray(p, p + 1),
          operands: [],
          confidence: "confirmed",
        });
        covered += 1;
        p += 1;
        continue;
      }
    }

    let decoded: Instruction | undefined;
    if (hit) {
      try {
        const { operands, end: instrEnd } = parseOperands(
          buf,
          p + hit.key.length,
          hit.def.signature,
          entryCount,
        );
        // guard: op_0010's mode byte is only ever 0/1; other values mean we
        // actually hit a pad byte followed by a 0x10-class instruction.
        if (
          hit.def.mnemonic === "op_0010" &&
          operands[0]?.kind === "u8" &&
          operands[0].value > 1
        ) {
          throw new Desync("op_0010 mode byte out of range");
        }
        decoded = {
          address: p,
          raw: buf.subarray(p, instrEnd),
          mnemonic: hit.def.mnemonic,
          opcode: hit.key,
          operands,
          confidence: hit.def.confidence,
        };
      } catch (e) {
        if (!(e instanceof Desync)) throw e;
        // fall through to pad-retry / data region
        if (b0 === 0x00 && p + 1 < end) {
          const n0 = buf[p + 1]!;
          const n1 = p + 2 < end ? buf[p + 2]! : 0;
          if (lookupOpcode(n0, n1)) {
            instructions.push({
              address: p,
              raw: buf.subarray(p, p + 1),
              mnemonic: "PAD",
              opcode: buf.subarray(p, p + 1),
              operands: [],
              confidence: "confirmed",
            });
            covered += 1;
            p += 1;
            continue;
          }
        }
      }
    }

    if (decoded) {
      instructions.push(decoded);
      covered += decoded.raw.length;
      p += decoded.raw.length;
      continue;
    }

    // Cannot decode here: record everything up to the next anchor as data.
    const next = anchors.find((a) => a > p) ?? end;
    pushData(p, next, hit ? "operand decode failed" : `unknown opcode ${b0.toString(16).padStart(2, "0")} ${b1.toString(16).padStart(2, "0")}`);
    p = next;
  }

  return { instructions, dataRegions, coveredBytes: covered, totalBytes: end - start };
}

export { OPCODES, OPCODES1 };
export type { OpcodeDef };
