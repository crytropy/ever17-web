import type { Disassembly, Instruction, Sc3File } from "./types.js";

export type Edge =
  | { type: "fallthrough"; target: number }
  | { type: "jump"; target: number }
  | {
      type: "condition";
      target: number;
      /** The VAR_JUMP (00 0a) instruction whose comparison takes this edge. */
      lhs: Instruction;
      /** True for the edge taken when the comparison holds (jump); false = fallthrough. */
      taken: boolean;
    }
  | { type: "choice"; option: number; target: number }
  | { type: "switch"; caseIndex: number; target: number }
  | { type: "scene"; targetScene: string };

export interface BasicBlock {
  address: number;
  instructions: Instruction[];
  successors: Edge[];
  /** 1-based entry-table indexes that point at this block, if any. */
  entryIndexes: number[];
}

export interface Cfg {
  blocks: Map<number, BasicBlock>;
  /** Address of the first executed instruction (after the 10 24 preamble). */
  start: number;
  warnings: string[];
}

const COND_OPS = new Set(["VAR_JUMP"]);

function entryTarget(file: Sc3File, index1: number): number | undefined {
  return file.entryPoints[index1 - 1];
}

/**
 * Build a CFG over the linear disassembly.
 *
 * Control-flow model (evidence in docs/sc3-format.md):
 *  - JUMP (00 07): unconditional jump to entryPoints[n-1].
 *  - VAR_JUMP (00 0a): conditional jump to an entry-table target when its
 *    variable comparison holds; otherwise falls through. (fe 28 is a variable
 *    WRITE, not a conditional - it never branches.)
 *  - CHOICE_OPTION rows attach choice edges to the block containing the
 *    dispatch; fallthrough continues (the engine idles until selection).
 *  - SWITCH (00 08): edges to each table target.
 *  - GOTO_SCRIPT (10 01): terminal cross-scene edge.
 */
export function buildCfg(file: Sc3File, disasm: Disassembly): Cfg {
  const warnings: string[] = [];
  const instrs = disasm.instructions.filter((i) => i.mnemonic !== "PAD");
  const byAddr = new Map<number, number>();
  instrs.forEach((ins, idx) => byAddr.set(ins.address, idx));

  // --- collect leaders
  const leaders = new Set<number>();
  if (instrs.length > 0) leaders.add(instrs[0]!.address);
  leaders.add(file.header.codeStartOffset);
  for (const ep of file.entryPoints) {
    if (byAddr.has(ep)) leaders.add(ep);
    // entries pointing mid-instruction exist (they mark the trailing
    // transition-mode operand of sprite commands); they do not start blocks.
  }
  const jumpTargetOf = (ins: Instruction): number | undefined => {
    const op = ins.operands[0];
    if (op?.kind !== "entryRef") return undefined;
    return entryTarget(file, op.index);
  };

  for (let i = 0; i < instrs.length; i++) {
    const ins = instrs[i]!;
    if (ins.mnemonic === "JUMP") {
      const t = jumpTargetOf(ins);
      if (t !== undefined) leaders.add(t);
      const next = instrs[i + 1];
      if (next) leaders.add(next.address);
    } else if (ins.mnemonic === "GOTO_SCRIPT") {
      const next = instrs[i + 1];
      if (next) leaders.add(next.address);
    } else if (ins.mnemonic === "CHOICE_OPTION") {
      const t = ins.operands[1]?.kind === "entryRef" ? entryTarget(file, ins.operands[1].index) : undefined;
      if (t !== undefined) leaders.add(t);
    } else if (ins.mnemonic === "SWITCH") {
      const list = ins.operands[1];
      if (list?.kind === "u16list") {
        for (const idx of list.values) {
          const t = entryTarget(file, idx);
          if (t !== undefined) leaders.add(t);
        }
      }
      const next = instrs[i + 1];
      if (next) leaders.add(next.address);
    } else if (COND_OPS.has(ins.mnemonic)) {
      // conditional jump: the target and the fallthrough both become leaders
      const tgt = ins.operands[2];
      if (tgt?.kind === "entryRef") {
        const t = entryTarget(file, tgt.index);
        if (t !== undefined) leaders.add(t);
      }
      const next = instrs[i + 1];
      if (next) leaders.add(next.address);
    }
  }

  // --- slice into blocks
  const blocks = new Map<number, BasicBlock>();
  const sortedLeaders = [...leaders].filter((a) => byAddr.has(a)).sort((a, b) => a - b);
  for (let li = 0; li < sortedLeaders.length; li++) {
    const startAddr = sortedLeaders[li]!;
    const endAddr = sortedLeaders[li + 1];
    const startIdx = byAddr.get(startAddr)!;
    const blockInstrs: Instruction[] = [];
    for (let i = startIdx; i < instrs.length; i++) {
      const ins = instrs[i]!;
      if (endAddr !== undefined && ins.address >= endAddr) break;
      blockInstrs.push(ins);
    }
    blocks.set(startAddr, {
      address: startAddr,
      instructions: blockInstrs,
      successors: [],
      entryIndexes: file.entryPoints
        .map((a, i) => (a === startAddr ? i + 1 : -1))
        .filter((x) => x > 0),
    });
  }

  // --- successors
  for (const block of blocks.values()) {
    const last = block.instructions[block.instructions.length - 1];
    if (!last) continue;
    const lastIdx = byAddr.get(last.address)!;
    const nextIns = instrs[lastIdx + 1];

    // choice edges from any option rows inside the block
    for (const ins of block.instructions) {
      if (ins.mnemonic === "CHOICE_OPTION") {
        const optExpr = ins.operands[0];
        const tgt = ins.operands[1];
        if (tgt?.kind === "entryRef") {
          const t = entryTarget(file, tgt.index);
          if (t !== undefined) {
            let option = -1;
            if (optExpr?.kind === "expr" && optExpr.expr.tokens[0]?.kind === "imm") {
              option = optExpr.expr.tokens[0].value;
            }
            block.successors.push({ type: "choice", option, target: t });
          }
        }
      }
    }

    if (last.mnemonic === "JUMP") {
      const t = jumpTargetOf(last);
      if (t !== undefined) block.successors.push({ type: "jump", target: t });
      else warnings.push(`JUMP at 0x${last.address.toString(16)} with unresolvable target`);
      continue;
    }
    if (last.mnemonic === "GOTO_SCRIPT") {
      const op = last.operands[0];
      if (op?.kind === "string") block.successors.push({ type: "scene", targetScene: op.value });
      continue;
    }
    if (last.mnemonic === "SWITCH") {
      const list = last.operands[1];
      if (list?.kind === "u16list") {
        list.values.forEach((idx, caseIndex) => {
          const t = entryTarget(file, idx);
          if (t !== undefined) block.successors.push({ type: "switch", caseIndex, target: t });
        });
      }
      if (nextIns) block.successors.push({ type: "fallthrough", target: nextIns.address });
      continue;
    }
    if (COND_OPS.has(last.mnemonic)) {
      const tgt = last.operands[2];
      if (tgt?.kind === "entryRef") {
        const t = entryTarget(file, tgt.index);
        if (t !== undefined) {
          block.successors.push({ type: "condition", target: t, lhs: last, taken: true });
        }
      }
      if (nextIns) {
        block.successors.push({ type: "condition", target: nextIns.address, lhs: last, taken: false });
      }
      continue;
    }
    if (nextIns && blocks.has(nextIns.address)) {
      block.successors.push({ type: "fallthrough", target: nextIns.address });
    }
  }

  return { blocks, start: file.header.codeStartOffset, warnings };
}
