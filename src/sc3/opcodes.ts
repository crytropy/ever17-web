import type { Confidence } from "./types.js";

/**
 * Operand signature letters (decoded in disassembler.ts):
 *   E  expression (00-terminated token stream, with immediate-pad rule)
 *   V  value expression WITHOUT the immediate-pad (used by a few 00-class ops)
 *   W  raw u16 LE
 *   J  raw u16 LE, 1-based index into the entry-address table
 *   B  raw byte
 *   4  four raw bytes (observed all-zero ahead of resource ids; meaning unknown)
 *   R  raw u16 LE resource index (into this file's resource chunk list)
 *   S  NUL-terminated ASCII string
 *   T  text-chunk reference: byte 0xFF then u16 LE chunk index
 *   L  u16 LE jump table (self-delimiting heuristic; see disassembler)
 */
export interface OpcodeDef {
  mnemonic: string;
  signature: string;
  confidence: Confidence;
  /** What we believe it does + the evidence. Mirrored in docs/sc3-format.md. */
  note: string;
}

const def = (
  mnemonic: string,
  signature: string,
  confidence: Confidence,
  note: string,
): OpcodeDef => ({ mnemonic, signature, confidence, note });

/** Key: hex of the 1- or 2-byte opcode prefix. */
export const OPCODES: ReadonlyMap<string, OpcodeDef> = new Map(
  Object.entries({
    // ------------------------------------------------------------------ 0x00 class: flow & state
    "0001": def("op_0001", "EEW", "unknown", "startup/system only; args (var-ish, 0, u16)"),
    "0004": def("op_0004", "BEW", "unknown", "startup/system; shape matches 00 0a"),
    "0005": def("WAIT", "E", "medium", "guarded by fe28 var[171] tests after transitions; arg 1..50 looks like a duration. debug menus use it while idling"),
    "0006": def("op_0006", "", "unknown", "rare, no operands observed"),
    "0007": def("JUMP", "J", "confirmed", "unconditional jump to entry-table target (1-based). Proven by debug.scr menu loops and s_1a choice merge (entry #3 = 0x2E0)"),
    "0008": def("SWITCH", "EL", "high", "computed jump: selector expression then u16 entry-index table (startup/system). Table length is implicit"),
    "000a": def("SET_VAR", "BEW", "medium", "story files: byte 01, expr '28 0a <var> 14 <op> <imm> 01', u16. Writes a variable; exact op semantics unproven"),
    "000c": def("op_000c", "EEE", "unknown", "three expr operands"),
    "000d": def("op_000d", "EW", "unknown", "expr + u16 (startup, s_2d)"),
    "000e": def("op_000e", "", "unknown", "system.scr, no operands"),
    "000f": def("op_000f", "WE", "unknown", "startup.scr; u16 + expr"),
    "0010": def("op_0010", "BVW", "low", "startup/system; mode byte 0|1, value expr (no imm-pad!), u16"),
    "0011": def("op_0011", "BV", "low", "startup; byte + unpadded value expr"),
    "0012": def("op_0012", "E", "unknown", "single expr"),
    "0013": def("op_0013", "E", "unknown", "single expr"),
    "0015": def("op_0015", "BEEW", "unknown", "system.scr pattern (01, 64, 0, u16)"),
    "0019": def("op_0019", "EE", "unknown", "pairs like (0..2, 1|3|4); channel+mode? very common in startup"),
    "001a": def("CHOICE_END", "", "medium", "appears after choice dispatch regions; closes a 10 1a choice"),
    "0026": def("CHOICE_COND", "E", "high", "between 10 1a and option rows; expr '28 0a 1203 14' references the selection register as lvalue"),
    "0027": def("CHOICE_OPTION", "EJ", "confirmed", "registers option <expr index> -> entry-table target (1-based). Proven by debug.scr menu tree + s_1a choice (targets 0x29D/0x2B1)"),
    "0028": def("op_0028", "", "unknown", "0-arg; near script heads after route-flag conditionals"),
    // ------------------------------------------------------------------ 0x01 class (system only)
    "0100": def("op_0100", "W", "unknown", "system.scr; u16 then usually a JUMP"),
    "0104": def("op_0104", "E", "unknown", ""),
    "0106": def("op_0106", "EEW", "unknown", ""),
    "0113": def("op_0113", "E", "unknown", ""),
    "0115": def("op_0115", "EE", "unknown", ""),
    "0116": def("op_0116", "EE", "unknown", ""),
    // ------------------------------------------------------------------ 0x10 class: presentation
    "1001": def("GOTO_SCRIPT", "S", "confirmed", "jump to another .scr by name (\"debug\", \"OP00\", \"SC2F\", ...). Names resolve case-insensitively in script.dat"),
    "1003": def("PLAY_BGM", "EE", "medium", "(track 1..19+, 100) at scene starts; bgm.dat has bgm01..28; second arg looks like volume"),
    "1004": def("STOP_BGM", "", "low", "0-arg, appears near PLAY_BGM sites and scene ends"),
    "1005": def("PLAY_SE", "SEE", "confirmed", "SE name from se.dat (\"SE01_04\", loop variants end in L) + (channel?, volume?)"),
    "1006": def("op_1006", "", "unknown", "0-arg"),
    "1007": def("op_1007", "", "unknown", "0-arg"),
    "1008": def("SAVE_POINT", "S", "medium", "chapter/save ids (\"S5A000\"...) in ss5a/ss6a"),
    "1009": def("op_1009", "", "unknown", "0-arg, follows SAVE_POINT"),
    "100c": def("SET_BG", "4REE", "confirmed", "background/CG: 4 zero bytes, resource index, fade-type expr (0=cut, 6=fade), plane expr (1|2). Proven by debug_bg1-8 resource correlation"),
    "100d": def("FILL_SCREEN", "EEE", "high", "(color 0=black/1=white, fade-type 0|6, plane). Proven by debug_ch* 背景黒/背景白 choice"),
    "100f": def("SET_SPRITE", "E4REE", "confirmed", "sprite: slot expr (1/2/4), 4 zero bytes, resource index, x expr (320=center of 640), mode expr. Proven by debug_ch* resource correlation"),
    "1010": def("CLEAR_SPRITE", "EE", "high", "(slot 1|2|4, mode 0|3); precedes sprite replacement"),
    "1012": def("SET_SPRITE_2", "EE4R4REEE", "high", "two sprites at once: (?, ?, resA, resB, xA, xB, mode); resources always consecutive pairs"),
    "1013": def("op_1013", "EE", "unknown", "([imm 3|5|7, op04], 0|3) - sprite-related"),
    "1014": def("SPRITE_ORDER", "EEE", "medium", "permutations of (0,1,2), occasionally 255; z-order of the three sprite slots?"),
    "1015": def("op_1015", "EE", "unknown", "(0|1, 8|15|16|17)"),
    "1016": def("SET_SPRITE_3", "4R4R4REEEE", "high", "three sprites at once: resources consecutive triples, x = 128/512/320, + mode"),
    "1018": def("TRANSITION_SYNC", "", "medium", "0-arg; brackets staged bg/sprite updates before a commit"),
    "1019": def("MESSAGE", "T", "confirmed", "display text chunk (dialogue/narration). ff <u16> operand"),
    "101a": def("CHOICE_BEGIN", "EE", "confirmed", "(result register - always var 1203 except one debug menu, choice id). s_1a's story choice has id 44 as documented"),
    "101d": def("op_101d", "4R", "unknown", "bare resource reference (preload?)"),
    "101e": def("WAIT_FRAMES", "E", "medium", "30/60/90/120/180 - frame counts"),
    "101f": def("SET_CLOCK", "EE", "high", "(hour 0..23, minute) - the on-screen timestamp Ever17 shows at scene transitions"),
    "1020": def("op_1020", "E", "unknown", "very common; small ids 4..48; appears at scene starts (ambient loop? title?)"),
    "1021": def("op_1021", "E", "unknown", "common; ids 0..16"),
    "1024": def("SCENE_MARKER", "E", "high", "scene/section id; first instruction of every story script (id matches archive order) and repeated at section boundaries"),
    "1026": def("op_1026", "E", "unknown", ""),
    "1027": def("SET_BG_B", "4REE", "medium", "SET_BG variant used mid-CG-sequences (overlay/no-clear?)"),
    "102b": def("op_102b", "E", "unknown", "y_ed.scr ending scripts"),
    "102e": def("SET_VAR_COMPUTED", "EE", "low", "(1, computed expr) - writes something from an expression"),
    "1037": def("op_1037", "4R", "unknown", "bare resource reference in y_ed"),
    "1039": def("PLAY_MOVIE", "S", "high", "\"ever17\" (OP), \"MOV01A/MOV02A\", \"sdr640\" (staff roll), \"END_*00\" ending cards"),
    "103a": def("op_103a", "", "unknown", "0-arg"),
    "103b": def("op_103b", "E", "unknown", "always [1]; follows PLAY_MOVIE"),
    "103c": def("op_103c", "", "unknown", "0-arg"),
    "1040": def("CG_EFFECT", "4REEEEEE", "low", "resource + 6 exprs incl. (12,12,775,581)/(0,800,600)-style rects; pan/zoom effect over a CG?"),
    "1041": def("VIEWPORT_RECT", "EEEEE", "low", "(x, y, w, h, frames) rects up to 800x600 with durations"),
    "1043": def("SET_VOLUME", "E", "low", "values 80..100"),
    "1045": def("TRANSITION_TIME", "EE", "medium", "(frames 0/3/6/12/18/24, mode 0|1) before staged transitions"),
    "1046": def("op_1046", "E", "unknown", "(0|1|2) right after SCENE_MARKER at script heads"),
    // ------------------------------------------------------------------ 0xFE class: conditionals
    "fe28": def("IF_EQ", "EE", "high", "compare lhs expr (usually 'var <id> 14 14') with rhs expr; conditionally executes exactly the next instruction. Polarity (eq vs ne) unproven"),
    "fe2d": def("IF_2D", "EE", "medium", "conditional variant; lhs ops often '14 17/18/20' - likely other comparison operators"),
    "fe2e": def("IF_2E", "EE", "low", "conditional variant (startup/system)"),
    // ------------------------------------------------------------------ 0x80 class (system only)
    "8013": def("op_8013", "W", "unknown", "startup/system"),
    "8018": def("op_8018", "BWW", "unknown", "startup/system; (slot byte, u16, u16) - UI widget positioning?"),
  }),
);

/** Single-byte opcodes. 0xFF is the choice-text display; 26/27 are the
 * unprefixed forms of CHOICE_COND / CHOICE_OPTION (first row of a list);
 * 02/03 appear between statements in system scripts. */
export const OPCODES1: ReadonlyMap<number, OpcodeDef> = new Map([
  [0xff, def("SHOW_CHOICE", "W", "confirmed", "display choice text chunk (options list); u16 chunk index. Followed by CHOICE_BEGIN")],
  [0x27, def("CHOICE_OPTION", "EJ", "confirmed", "unprefixed first option row")],
  [0x26, def("CHOICE_COND", "E", "high", "unprefixed form")],
  [0x02, def("op_02", "", "unknown", "single byte (system.scr)")],
  [0x03, def("op_03", "", "unknown", "single byte (system.scr)")],
]);

export function lookupOpcode(b0: number, b1: number): { key: Buffer; def: OpcodeDef } | undefined {
  const two = OPCODES.get(b0.toString(16).padStart(2, "0") + b1.toString(16).padStart(2, "0"));
  if (two) return { key: Buffer.from([b0, b1]), def: two };
  const one = OPCODES1.get(b0);
  if (one) return { key: Buffer.from([b0]), def: one };
  return undefined;
}
