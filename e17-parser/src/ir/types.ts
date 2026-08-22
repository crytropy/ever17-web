/**
 * Clean intermediate representation for the future web runtime.
 * The runtime must not need to know anything about SC3 internals; everything
 * not yet understood is preserved as explicit `unknown` ops.
 */

/** Comparison in a VAR_JUMP row. Relations 0x0c (eq) and 0x0d (ne) are the
 * common ones; 0x0f/0x10/0x11 are the rare relational route gates. */
export type IrCondition =
  | {
      type: "varCompare";
      varId: number;
      /** relation byte from the expression (0x0c, 0x0d, 0x0f, 0x10, 0x11) */
      rel: number;
      value: IrValue;
    }
  | {
      /** '2d 0a <var> 14' shape: tests a system-space variable (no value). */
      type: "sysVarTest";
      varId: number;
    }
  | { type: "unknownExpr"; raw: string };

export type IrValue =
  | { type: "const"; value: number }
  /** `28 0a <var> 14`: the value of another variable (y_ed sums the four
   * route-clear flags into var 1215 this way). */
  | { type: "varRef"; varId: number }
  | { type: "expr"; raw: string };

export interface DialogueLine {
  text: string;
}

export type IrOp =
  | { op: "sceneMarker"; id: number }
  | { op: "setBackground"; asset: string | null; resource: number; fade: number | null; arg2: number | null; variant?: string }
  | { op: "showSprite"; asset: string | null; resource: number; slot: number | null; x: number | null; mode: number | null }
  | { op: "showSprites"; sprites: { asset: string | null; resource: number; x: number | null }[]; mode: number | null }
  | { op: "hideSprite"; slot: number | null; mode: number | null }
  | { op: "fillScreen"; color: number | null; fade: number | null; plane: number | null }
  | { op: "playSE"; asset: string; arg1: number | null; volume: number | null }
  | { op: "playBGM"; track: number | null; volume: number | null }
  | { op: "stopBGM" }
  | { op: "playMovie"; asset: string }
  | { op: "setClock"; hour: number | null; minute: number | null }
  | { op: "wait"; amount: number | null; unit: "unknown" }
  | { op: "waitFrames"; frames: number | null }
  | {
      op: "dialogue";
      voice: string | null;
      speaker: string | null;
      text: string;
      /** index of the source text chunk */
      textIndex: number;
      segment: number;
    }
  | {
      op: "choice";
      id: number | null;
      /** Variable receiving the selected option index (1203 everywhere observed). */
      resultVar: number | null;
      options: {
        index: number;
        text: string;
        /** Block label to jump to; null = no dispatch row (execution continues,
         * the target scene reads resultVar). */
        target: string | null;
        condition?: IrCondition;
      }[];
    }
  | { op: "gotoBlock"; target: string }
  | { op: "gotoScene"; scene: string }
  | {
      /** Variable write (fe 28): mod 0x14 = assign, 0x17 = modify (likely +=). */
      op: "varSet";
      varId: number;
      mod: number;
      value: IrValue;
    }
  | {
      /** Conditional jump (00 0a): when the condition holds, control moves to target. */
      op: "varJump";
      condition: IrCondition;
      target: string;
    }
  | { op: "switch"; selector: IrValue; targets: string[] }
  | { op: "savePoint"; id: string }
  | { op: "transitionSync" }
  | { op: "transitionTime"; frames: number | null; mode: number | null }
  | { op: "effectOn"; effect: number | null }
  | { op: "effectOff"; category: number | null }
  | { op: "shake"; mode: number | null; amplitude: number | null }
  | { op: "spriteOrder"; order: (number | null)[] }
  | { op: "viewportRect"; x: number | null; y: number | null; w: number | null; h: number | null; frames: number | null }
  | {
      op: "cgEffect";
      asset: string | null;
      resource: number;
      args: (number | null)[];
    }
  | { op: "unknown"; opcode: string; mnemonic: string; raw: string; operands: string[] };

export interface IrBlock {
  /** Successor block labels for fallthrough (absent for terminal blocks). */
  next: string | null;
  ops: IrOp[];
}

export interface IrScene {
  scene: string;
  /** Label of the first block executed. */
  entry: string;
  /** Blocks keyed by zero-padded hex address label. */
  blocks: Record<string, IrBlock>;
  /** Diagnostics from every layer - never silently dropped. */
  warnings: string[];
  meta: {
    sceneIds: number[];
    textChunks: number;
    resources: string[];
    unknownOpcodeCount: number;
    coverage: number;
  };
}
