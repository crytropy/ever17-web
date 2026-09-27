import type { IrCondition } from "./types.js";

/**
 * VAR_JUMP relation bytes and their evaluation.
 *
 * Established (docs/sc3-format.md §6.1):
 *   0x0c  ==   s_1a2's head dispatches resume points with `1203 == 1/2`, and
 *              fresh entries (1203 == 0) fall through both rows; the rows
 *              before its `GOTO SC1A` skip the call when flag 1050 == 0.
 *   0x0d  !=   complement; used for the same flag family (Medium).
 *
 * Route-gate relation (Confidence: Medium - corrected by playtest + route behavior):
 *   0x10  <    failure gates jump while affection is below threshold:
 *              t_6b uses `1207 < 17` / `1208 < 14`, sy6b uses
 *              `1206 < 7`, and y_ed uses `1209 < 3`.
 *   0x11  >    t_6b's ask-two-of-three menu counts asks in 1211 and exits on
 *              `1211 > 1`; under `<` that gate is dead code and the menu can
 *              never terminate, so strictly-greater is forced. Also fits
 *              t_4a's `1207 > 9` affection bonus gate.
 *   0x0f  <=   rarest; orientation unverified.
 * The 0x10 polarity is pinned by real route behavior: an above-threshold
 * Sora score must fall through the bad-ending gate. RELATIONS is exported
 * for experiments.
 *
 * sysVarTest ('2d 0a <var> 14', no comparison value): reads a system-space
 * variable; treated as "jump when nonzero". Var 7 dominates (y_ed uses it ~20
 * times to skip paragraphs) - consistent with an "already seen" flag, which is
 * 0 on a fresh New Game.
 */
export const RELATIONS: Record<number, { name: string; eval: (lhs: number, rhs: number) => boolean; confidence: "high" | "medium" | "low" }> = {
  0x0c: { name: "==", eval: (a, b) => a === b, confidence: "high" },
  0x0d: { name: "!=", eval: (a, b) => a !== b, confidence: "medium" },
  0x10: { name: "<", eval: (a, b) => a < b, confidence: "medium" },
  0x11: { name: ">", eval: (a, b) => a > b, confidence: "low" },
  0x0f: { name: "<=", eval: (a, b) => a <= b, confidence: "low" },
};

/** VAR_SET modification bytes. */
export const MOD_ASSIGN = 0x14;
export const MOD_ADD = 0x17; // observed only on affection vars 1206-1215; += (Medium)

export interface ConditionResult {
  /** true/false when evaluable, undefined otherwise. */
  value: boolean | undefined;
  /** Human-readable rendering, e.g. "var1203(0) == 1". */
  text: string;
}

/** Work variables default to 0 until written; system vars likewise. */
export function evaluateCondition(
  cond: IrCondition,
  vars: ReadonlyMap<number, number>,
  sysVars: ReadonlyMap<number, number> = new Map(),
): ConditionResult {
  switch (cond.type) {
    case "varCompare": {
      const lhs = vars.get(cond.varId) ?? 0;
      const rhs = cond.value.type === "const" ? cond.value.value : undefined;
      const rel = RELATIONS[cond.rel];
      const relName = rel?.name ?? `rel${cond.rel.toString(16)}`;
      const text = `var${cond.varId}(${lhs}) ${relName} ${rhs ?? "?"}`;
      if (!rel || rhs === undefined) return { value: undefined, text };
      return { value: rel.eval(lhs, rhs), text };
    }
    case "sysVarTest": {
      const v = sysVars.get(cond.varId) ?? 0;
      return { value: v !== 0, text: `sys${cond.varId}(${v}) != 0` };
    }
    case "unknownExpr":
      return { value: undefined, text: cond.raw };
  }
}
