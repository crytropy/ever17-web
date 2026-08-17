import type { IrCondition } from "./types.js";

/**
 * Comparison relations used by the SC3 conditional opcodes.
 *
 * A guard's left-hand expression has the shape `load <var> 0x14 <rel>`: the
 * first 0x14 belongs to the variable load, the trailing operator selects the
 * relation.
 *
 * Evidence for 0x14 = equality (Confidence: High):
 *   sc1a.scr dispatches with `var1203 == 1` at 0x9A and `var1203 == 2` at
 *   0x90F, both guarding `GOTO_SCRIPT "S_1A2"`. Two different constants
 *   selecting the same destination is a value dispatch, which is only coherent
 *   if the guarded instruction runs when the values are *equal*. Every scene
 *   exit in the corpus has this shape (`s_1a` -> S_1A2, `s_1a2` -> S_1B,
 *   `t_1a` -> T_1B, ...), keyed on the choice register written by the
 *   preceding choice.
 *
 * Evidence for 0x17 = inequality (Confidence: Medium):
 *   s_1a 0x29D guards the 「谢谢……」 reply - the response to picking option 0
 *   of choice 44 - with `var1206 <0x17> 1`. The line must play on that branch,
 *   so the relation has to hold while var1206 is at its initial value, which
 *   equality cannot do and inequality does.
 *
 * 0x18, 0x1B and 0x20 appear on `fe 2d`/`fe 2e` guards and are not yet
 * identified; conditions using them evaluate to `undefined` (unknown).
 */
export const REL_EQ = 0x14;
export const REL_NE = 0x17;

export type BranchPolicy = "evaluate" | "take" | "skip";

export interface ConditionResult {
  /** true/false when the guard could be evaluated, undefined when not. */
  value: boolean | undefined;
  /** Human-readable rendering, e.g. "var1203 == 0". */
  text: string;
}

/** Variables default to 0 until a choice or assignment writes them. */
export function evaluateCondition(
  cond: IrCondition,
  vars: ReadonlyMap<number, number>,
): ConditionResult {
  if (cond.type !== "varTest") {
    return { value: undefined, text: cond.raw };
  }
  const lhs = vars.get(cond.varId) ?? 0;
  const rel = cond.ops[cond.ops.length - 1];
  const rhs = cond.rhs.type === "const" ? cond.rhs.value : undefined;
  const relName = rel === REL_EQ ? "==" : rel === REL_NE ? "!=" : `rel${(rel ?? 0).toString(16)}`;
  const rhsText = rhs !== undefined ? String(rhs) : cond.rhs.type === "expr" ? cond.rhs.raw : "?";
  const text = `var${cond.varId}(${lhs}) ${relName} ${rhsText}`;

  if (rhs === undefined || cond.ops.length !== 2 || cond.ops[0] !== 0x14) {
    return { value: undefined, text };
  }
  if (rel === REL_EQ) return { value: lhs === rhs, text };
  if (rel === REL_NE) return { value: lhs !== rhs, text };
  return { value: undefined, text };
}
