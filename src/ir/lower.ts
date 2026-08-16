import type { BasicBlock, Cfg } from "../sc3/cfg.js";
import { exprImm, exprVarTest, formatExpr } from "../sc3/expr.js";
import {
  parseTextChunk,
  type ParsedTextChunk,
  type TextEncoding,
  type TextToken,
} from "../sc3/text.js";
import type { Disassembly, Instruction, Operand, RawExpr, Sc3File } from "../sc3/types.js";
import type { IrBlock, IrCondition, IrOp, IrScene, IrValue } from "./types.js";

const label = (addr: number): string => addr.toString(16).toUpperCase().padStart(8, "0");

function operandImm(op: Operand | undefined): number | null {
  if (op?.kind === "expr") {
    const v = exprImm(op.expr);
    return v === undefined ? null : v;
  }
  if (op?.kind === "u16" || op?.kind === "u8") return op.value;
  return null;
}

function operandU16(op: Operand | undefined): number | null {
  return op?.kind === "u16" ? op.value : null;
}

function exprToValue(e: RawExpr): IrValue {
  const v = exprImm(e);
  return v !== undefined ? { type: "const", value: v } : { type: "expr", raw: formatExpr(e) };
}

function conditionOf(ins: Instruction): IrCondition {
  const lhs = ins.operands[0];
  const rhs = ins.operands[1];
  if (lhs?.kind === "expr" && rhs?.kind === "expr") {
    const vt = exprVarTest(lhs.expr);
    if (vt) {
      return { type: "varTest", varId: vt.varId, ops: vt.ops, rhs: exprToValue(rhs.expr), opcode: ins.opcode.toString("hex") };
    }
    return { type: "unknownExpr", raw: `${formatExpr(lhs.expr)} ?? ${formatExpr(rhs.expr)}` };
  }
  return { type: "unknownExpr", raw: ins.raw.toString("hex") };
}

interface TextSegment {
  voice: string | null;
  speaker: string | null;
  text: string;
}

/** Flatten a parsed text chunk into dialogue segments (split on segmentStart/pageEnd). */
export function chunkSegments(parsed: ParsedTextChunk): TextSegment[] {
  const segments: TextSegment[] = [];
  let voice: string | null = null;
  let lines: string[] = [];
  let current = "";
  const flushLine = () => {
    if (current.length > 0) lines.push(current);
    current = "";
  };
  const flushSegment = () => {
    flushLine();
    if (lines.length === 0 && voice === null) return;
    let speaker: string | null = null;
    let body = lines;
    const first = lines[0];
    // Chinese release wraps the speaker name as 【名字】 on its own line;
    // the JP debug scripts have no such wrapper.
    if (first !== undefined && /^【.+】$/.test(first)) {
      speaker = first.slice(1, -1);
      body = lines.slice(1);
    }
    segments.push({ voice, speaker, text: body.join("\n") });
    voice = null;
    lines = [];
  };
  for (const t of parsed.tokens) {
    switch (t.kind) {
      case "segmentStart":
        flushSegment();
        break;
      case "voice":
        voice = t.id;
        break;
      case "text":
        current += t.text;
        break;
      case "lineBreak":
        flushLine();
        break;
      case "messageEnd":
      case "pageEnd":
      case "segmentParam":
      case "wait":
      case "control":
        break;
      case "choiceHeader":
      case "optionText":
      case "optionCondition":
        // choice chunks are handled by lowerChoice, not as dialogue
        break;
      case "unknown":
        break;
    }
  }
  flushSegment();
  return segments;
}

export interface ChoiceChunkInfo {
  choiceId: number | null;
  options: { text: string; condition?: IrCondition }[];
}

export function chunkChoice(parsed: ParsedTextChunk): ChoiceChunkInfo | undefined {
  let choiceId: number | null = null;
  const options: { text: string; condition?: IrCondition }[] = [];
  let pendingCond: RawExpr | null = null;
  let sawChoice = false;
  for (const t of parsed.tokens) {
    if (t.kind === "choiceHeader") {
      choiceId = t.choiceId;
      sawChoice = true;
    } else if (t.kind === "optionCondition") {
      pendingCond = t.expr;
      sawChoice = true;
    } else if (t.kind === "optionText") {
      const opt: { text: string; condition?: IrCondition } = { text: t.text };
      if (pendingCond && pendingCond.tokens.length > 0) {
        // Text-side option conditions are self-contained expressions; their
        // comparison semantics are not yet proven, so keep them opaque.
        opt.condition = { type: "unknownExpr", raw: formatExpr(pendingCond) };
      }
      pendingCond = null;
      options.push(opt);
      sawChoice = true;
    }
  }
  return sawChoice ? { choiceId, options } : undefined;
}

function resourceName(file: Sc3File, index: number | null): string | null {
  if (index === null) return null;
  return file.resourceChunks[index]?.name ?? null;
}

export function lowerScene(
  file: Sc3File,
  disasm: Disassembly,
  cfg: Cfg,
  encoding: TextEncoding,
): IrScene {
  const warnings: string[] = [...file.warnings];
  const parsedChunks = new Map<number, ParsedTextChunk>();
  const chunkOf = (index: number): ParsedTextChunk | undefined => {
    if (!parsedChunks.has(index)) {
      const c = file.textChunks[index];
      if (!c) return undefined;
      const parsed = parseTextChunk(c, encoding);
      for (const w of parsed.warnings) warnings.push(`text#${index}: ${w}`);
      parsedChunks.set(index, parsed);
    }
    return parsedChunks.get(index);
  };

  const sceneIds: number[] = [];
  let unknownCount = 0;
  const blocks: Record<string, IrBlock> = {};

  for (const [addr, block] of [...cfg.blocks.entries()].sort((a, b) => a[0] - b[0])) {
    const ops: IrOp[] = [];
    const instrs = block.instructions;
    for (let i = 0; i < instrs.length; i++) {
      const ins = instrs[i]!;
      const lowered = lowerInstruction(ins, i, instrs, block, file, chunkOf, warnings);
      if (lowered === "consumed") continue;
      if (lowered) {
        for (const op of lowered) {
          if (op.op === "sceneMarker") sceneIds.push(op.id);
          if (op.op === "unknown") unknownCount += 1;
          ops.push(op);
        }
      }
    }
    const fall = block.successors.find((s) => s.type === "fallthrough");
    blocks[label(addr)] = {
      next: fall ? label(fall.target) : null,
      ops,
    };
  }

  for (const region of disasm.dataRegions) {
    warnings.push(
      `undecoded region at 0x${region.address.toString(16)} (${region.bytes.length} bytes): ${region.reason}` +
        (region.strings ? ` [string table: ${region.strings.slice(0, 5).join(", ")}...]` : ""),
    );
  }

  const entryAddr =
    cfg.blocks.has(file.header.codeStartOffset) ? file.header.codeStartOffset
    : disasm.instructions[0]?.address ?? file.codeRegionStart;

  return {
    scene: file.name.replace(/\.scr$/i, ""),
    entry: label(entryAddr),
    blocks,
    warnings,
    meta: {
      sceneIds,
      textChunks: file.textChunks.length,
      resources: file.resourceChunks.map((r) => r.name ?? `<raw ${r.data.length}B>`),
      unknownOpcodeCount: unknownCount,
      coverage: disasm.totalBytes === 0 ? 1 : disasm.coveredBytes / disasm.totalBytes,
    },
  };
}

function lowerInstruction(
  ins: Instruction,
  idx: number,
  instrs: Instruction[],
  block: BasicBlock,
  file: Sc3File,
  chunkOf: (i: number) => ParsedTextChunk | undefined,
  warnings: string[],
): IrOp[] | "consumed" | undefined {
  const ops = ins.operands;
  switch (ins.mnemonic) {
    case "PAD":
      return undefined;
    case "SCENE_MARKER":
      return [{ op: "sceneMarker", id: operandImm(ops[0]) ?? -1 }];
    case "SET_BG":
    case "SET_BG_B": {
      const resource = operandU16(ops[1]) ?? -1;
      return [
        {
          op: "setBackground",
          asset: resourceName(file, resource),
          resource,
          fade: operandImm(ops[2]),
          arg2: operandImm(ops[3]),
          ...(ins.mnemonic === "SET_BG_B" ? { variant: "B" } : {}),
        },
      ];
    }
    case "SET_SPRITE": {
      const resource = operandU16(ops[2]) ?? -1;
      return [
        {
          op: "showSprite",
          asset: resourceName(file, resource),
          resource,
          slot: operandImm(ops[0]),
          x: operandImm(ops[3]),
          mode: operandImm(ops[4]),
        },
      ];
    }
    case "SET_SPRITE_2": {
      const resA = operandU16(ops[3]) ?? -1;
      const resB = operandU16(ops[5]) ?? -1;
      return [
        {
          op: "showSprites",
          sprites: [
            { asset: resourceName(file, resA), resource: resA, x: operandImm(ops[6]) },
            { asset: resourceName(file, resB), resource: resB, x: operandImm(ops[7]) },
          ],
          mode: operandImm(ops[8]),
        },
      ];
    }
    case "SET_SPRITE_3": {
      const resA = operandU16(ops[1]) ?? -1;
      const resB = operandU16(ops[3]) ?? -1;
      const resC = operandU16(ops[5]) ?? -1;
      return [
        {
          op: "showSprites",
          sprites: [
            { asset: resourceName(file, resA), resource: resA, x: operandImm(ops[6]) },
            { asset: resourceName(file, resB), resource: resB, x: operandImm(ops[7]) },
            { asset: resourceName(file, resC), resource: resC, x: operandImm(ops[8]) },
          ],
          mode: operandImm(ops[9]),
        },
      ];
    }
    case "CLEAR_SPRITE":
      return [{ op: "hideSprite", slot: operandImm(ops[0]), mode: operandImm(ops[1]) }];
    case "FILL_SCREEN":
      return [
        {
          op: "fillScreen",
          color: operandImm(ops[0]),
          fade: operandImm(ops[1]),
          plane: operandImm(ops[2]),
        },
      ];
    case "PLAY_SE": {
      const name = ops[0]?.kind === "string" ? ops[0].value : "?";
      return [{ op: "playSE", asset: name, arg1: operandImm(ops[1]), volume: operandImm(ops[2]) }];
    }
    case "PLAY_BGM":
      return [{ op: "playBGM", track: operandImm(ops[0]), volume: operandImm(ops[1]) }];
    case "STOP_BGM":
      return [{ op: "stopBGM" }];
    case "PLAY_MOVIE":
      return [{ op: "playMovie", asset: ops[0]?.kind === "string" ? ops[0].value : "?" }];
    case "SET_CLOCK":
      return [{ op: "setClock", hour: operandImm(ops[0]), minute: operandImm(ops[1]) }];
    case "WAIT":
      return [{ op: "wait", amount: operandImm(ops[0]), unit: "unknown" }];
    case "WAIT_FRAMES":
      return [{ op: "waitFrames", frames: operandImm(ops[0]) }];
    case "SAVE_POINT":
      return [{ op: "savePoint", id: ops[0]?.kind === "string" ? ops[0].value : "?" }];
    case "SET_VAR":
      return [{ op: "setVar", raw: ins.raw.toString("hex") }];
    case "MESSAGE": {
      const t = ops[0];
      if (t?.kind !== "textRef") return undefined;
      const parsed = chunkOf(t.index);
      if (!parsed) {
        warnings.push(`MESSAGE references missing text chunk #${t.index}`);
        return [{ op: "unknown", opcode: "1019", mnemonic: "MESSAGE", raw: ins.raw.toString("hex"), operands: [`text#${t.index}`] }];
      }
      return chunkSegments(parsed).map((seg, si) => ({
        op: "dialogue" as const,
        voice: seg.voice,
        speaker: seg.speaker,
        text: seg.text,
        textIndex: t.index,
        segment: si,
      }));
    }
    case "SHOW_CHOICE": {
      // SHOW_CHOICE <chunk>; CHOICE_BEGIN <reg> <id>; CHOICE_COND; rows...
      const chunkIndex = operandU16(ops[0]);
      const parsed = chunkIndex !== null ? chunkOf(chunkIndex) : undefined;
      const info = parsed ? chunkChoice(parsed) : undefined;
      let id: number | null = info?.choiceId ?? null;
      for (let j = idx + 1; j < instrs.length && j <= idx + 2; j++) {
        const nx = instrs[j]!;
        if (nx.mnemonic === "CHOICE_BEGIN") {
          id ??= operandImm(nx.operands[1]);
        }
      }
      const rowEdges = block.successors.filter((s) => s.type === "choice");
      const options = (info?.options ?? []).map((o, oi) => {
        const edge = rowEdges.find((e) => e.type === "choice" && e.option === oi);
        return {
          index: oi,
          text: o.text,
          target: edge && edge.type === "choice" ? label(edge.target) : "?",
          ...(o.condition ? { condition: o.condition } : {}),
        };
      });
      if (options.length === 0 && rowEdges.length > 0) {
        for (const e of rowEdges) {
          if (e.type === "choice") options.push({ index: e.option, text: "?", target: label(e.target) });
        }
        warnings.push(`choice at 0x${ins.address.toString(16)}: option texts not found in chunk #${chunkIndex}`);
      }
      return [{ op: "choice", id, options }];
    }
    case "CHOICE_BEGIN":
    case "CHOICE_COND":
    case "CHOICE_OPTION":
    case "CHOICE_END":
      return "consumed";
    case "JUMP": {
      const t = ops[0];
      if (t?.kind === "entryRef") {
        const target = file.entryPoints[t.index - 1];
        if (target !== undefined) return [{ op: "gotoBlock", target: label(target) }];
      }
      return undefined;
    }
    case "GOTO_SCRIPT":
      return [{ op: "gotoScene", scene: ops[0]?.kind === "string" ? ops[0].value : "?" }];
    case "IF_EQ":
    case "IF_2D":
    case "IF_2E": {
      const cond = block.successors.filter((s) => s.type === "condition");
      const taken = cond.find((s) => s.type === "condition" && s.taken);
      const skip = cond.find((s) => s.type === "condition" && !s.taken);
      return [
        {
          op: "branch",
          condition: conditionOf(ins),
          takenTarget: taken && taken.type === "condition" ? label(taken.target) : "?",
          skipTarget: skip && skip.type === "condition" ? label(skip.target) : null,
        },
      ];
    }
    case "SWITCH": {
      const sel = ops[0];
      const list = ops[1];
      return [
        {
          op: "switch",
          selector: sel?.kind === "expr" ? exprToValue(sel.expr) : { type: "expr", raw: "?" },
          targets:
            list?.kind === "u16list"
              ? list.values.map((v) => {
                  const t = file.entryPoints[v - 1];
                  return t !== undefined ? label(t) : "?";
                })
              : [],
        },
      ];
    }
    default: {
      // Everything else is preserved explicitly.
      return [
        {
          op: "unknown",
          opcode: ins.opcode.toString("hex"),
          mnemonic: ins.mnemonic,
          raw: ins.raw.toString("hex"),
          operands: ins.operands.map(formatOperand),
        },
      ];
    }
  }
}

function formatOperand(o: Operand): string {
  switch (o.kind) {
    case "expr":
      return formatExpr(o.expr);
    case "u8":
      return `b:${o.value}`;
    case "u16":
      return String(o.value);
    case "entryRef":
      return `entry#${o.index}`;
    case "raw":
      return `raw:${o.bytes.toString("hex")}`;
    case "string":
      return JSON.stringify(o.value);
    case "textRef":
      return `text#${o.index}`;
    case "u16list":
      return `[${o.values.join(",")}]`;
  }
}
