import type { ExprToken, RawExpr } from "./types.js";

export class ExprError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

/**
 * SC3 expression encoding (derived empirically; see docs/sc3-format.md):
 *
 * A stream of tokens terminated by 0x00.
 *   - byte >= 0x80: immediate. (byte & 0xE0) selects the width:
 *       0x80: value = byte & 0x1F                      (1 byte,  0..31)
 *       0xA0: value = (byte & 0x1F) << 8  | b1         (2 bytes, 0..8191)
 *       0xC0: value = (byte & 0x1F) << 16 | b1..b2     (3 bytes, big-endian)
 *       0xE0: value = u32 big-endian from b1..b4       (5 bytes; head bits unused)
 *   - byte < 0x80: operator (semantics table below, partially known).
 *
 * The 5-byte 0xE0 form is confirmed at three independent sites: the quake
 * parameter writes in debug.scr/system.scr (`e0 00 00 28 00 06 00` = imm
 * 0x2800 followed by operator 0x06) and system.scr's `01 01 <E> <E>` pairs.
 *
 * Empirical rule with zero exceptions in 104/104 scripts: when the token
 * before the 0x00 terminator is an immediate, one extra 0x00 follows the
 * terminator ("immediate pad"). Expressions ending in an operator have no pad.
 * (The `V`-type operands of a few 0x00-class opcodes are the exception: they
 * never carry the pad; see opcodes.ts.)
 */
export function parseExpr(buf: Buffer, start: number, requireImmPad = true): { expr: RawExpr; end: number } {
  const tokens: ExprToken[] = [];
  let p = start;
  let lastImm = false;
  for (;;) {
    if (p >= buf.length) throw new ExprError("expression runs past end of buffer", start);
    const t = buf[p]!;
    if (t === 0) {
      p += 1;
      let immPad = false;
      if (lastImm && requireImmPad) {
        if (p >= buf.length || buf[p] !== 0) {
          throw new ExprError(
            `expected immediate-pad 0x00 at 0x${p.toString(16)}`,
            start,
          );
        }
        p += 1;
        immPad = true;
      }
      return { expr: { tokens, immPad }, end: p };
    }
    if (t >= 0x80) {
      const width = 1 + [0, 1, 2, 4][(t >> 5) & 3]!;
      if (p + width > buf.length) throw new ExprError("immediate token truncated", start);
      let v = (t & 0xe0) === 0xe0 ? 0 : t & 0x1f;
      for (let i = 1; i < width; i++) v = v * 256 + buf[p + i]!;
      tokens.push({ kind: "imm", value: v, width });
      p += width;
      lastImm = true;
    } else {
      tokens.push({ kind: "op", op: t });
      p += 1;
      lastImm = false;
    }
    if (tokens.length > 128) throw new ExprError("expression implausibly long", start);
  }
}

/**
 * Known/suspected operator bytes appearing inside expressions.
 * Semantics are inferred from usage patterns only (no EXE analysis yet).
 */
export const EXPR_OPS: Record<number, { name: string; note: string }> = {
  0x0a: { name: "var", note: "precedes a variable id in every conditional; W[id] load" },
  0x14: { name: "op14", note: "follows var loads; likely 'evaluate/compare' glue - appears once in assignments, twice in equality tests" },
  0x0c: { name: "op0c", note: "seen in read-modify assignments (00 0a) before the operand value" },
  0x0d: { name: "op0d", note: "variant of 0x0c in assignments" },
  0x01: { name: "op01", note: "trailing op in assignment expressions" },
  0x02: { name: "op02", note: "" },
  0x04: { name: "op04", note: "seen in 10 13 first operand: [imm, 04]" },
  0x28: { name: "lvalue", note: "prefixes var refs used as assignment/choice-result targets" },
  0x2d: { name: "op2d", note: "prefix in computed expressions (10 2e arg2)" },
  0x17: { name: "op17", note: "comparison variant seen in fe 2d conds" },
  0x18: { name: "op18", note: "comparison variant" },
  0x1b: { name: "op1b", note: "comparison variant (system.scr)" },
  0x1e: { name: "op1e", note: "seen in fe 2e conds" },
  0x1f: { name: "op1f", note: "" },
  0x20: { name: "op20", note: "comparison variant seen in system menus" },
  0x26: { name: "op26", note: "" },
  0x2f: { name: "op2f", note: "seen in fe 2e conds (startup)" },
  0x33: { name: "op33", note: "seen in switch (00 08) selector exprs" },
};

/** Render an expression compactly, e.g. "[var 171 op14 op14]" or "[320]". */
export function formatExpr(e: RawExpr): string {
  if (e.tokens.length === 0) return "[]";
  const parts = e.tokens.map((t) =>
    t.kind === "imm" ? String(t.value) : (EXPR_OPS[t.op]?.name ?? `op${t.op.toString(16).padStart(2, "0")}`),
  );
  return `[${parts.join(" ")}]`;
}

/** For the common single-immediate expression, return its value. */
export function exprImm(e: RawExpr): number | undefined {
  if (e.tokens.length === 1 && e.tokens[0]!.kind === "imm") return e.tokens[0]!.value;
  return undefined;
}

/** Matches the ubiquitous `var <id> 14 14` / `var <id> 14 <op>` condition shape. */
export function exprVarTest(e: RawExpr): { varId: number; ops: number[] } | undefined {
  const t = e.tokens;
  if (t.length >= 2 && t[0]!.kind === "op" && t[0]!.op === 0x0a && t[1]!.kind === "imm") {
    const ops = t.slice(2).flatMap((x) => (x.kind === "op" ? [x.op] : []));
    if (ops.length === t.length - 2) return { varId: t[1]!.value, ops };
  }
  return undefined;
}
