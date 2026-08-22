import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { IrBlock, IrOp, IrScene } from "kid-contracts/ir";
import type { AsyncSceneSource } from "kid-runtime";
import { NULL_ASSETS } from "kid-runtime";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const IR_DIR = process.env["E17_IR_DIR"] ?? join(root, "build", "ir");
export const HAVE_IR = existsSync(join(IR_DIR, "op00.json"));

/* ---------------------------------------------------- synthetic IR builders */

export function scene(name: string, blocks: Record<string, { next?: string | null; ops: IrOp[] }>): IrScene {
  const entry = Object.keys(blocks).sort()[0]!;
  const full: Record<string, IrBlock> = {};
  for (const [label, b] of Object.entries(blocks)) {
    full[label] = { next: b.next ?? null, ops: b.ops };
  }
  return {
    scene: name,
    entry,
    blocks: full,
    warnings: [],
    meta: { sceneIds: [], textChunks: 0, resources: [], unknownOpcodeCount: 0, coverage: 1 },
  };
}

export const line = (text: string): IrOp => ({
  op: "dialogue",
  voice: null,
  speaker: null,
  text,
  textIndex: 0,
  segment: 0,
});

export const choice = (
  id: number,
  options: { text: string; target?: string | null }[],
  resultVar: number | null = 1203,
): IrOp => ({
  op: "choice",
  id,
  resultVar,
  options: options.map((o, index) => ({ index, text: o.text, target: o.target ?? null })),
});

export const set = (varId: number, value: number, mod: 0x14 | 0x17 = 0x14): IrOp => ({
  op: "varSet",
  varId,
  mod,
  value: { type: "const", value },
});

export const jump = (varId: number, rel: number, value: number, target: string): IrOp => ({
  op: "varJump",
  condition: { type: "varCompare", varId, rel, value: { type: "const", value } },
  target,
});

export const gotoScene = (name: string): IrOp => ({ op: "gotoScene", scene: name });
export const gotoBlock = (target: string): IrOp => ({ op: "gotoBlock", target });
export const movie = (asset: string): IrOp => ({ op: "playMovie", asset });

/** In-memory scene source over synthetic scenes. */
export function memorySource(scenes: IrScene[]): AsyncSceneSource & { map: Map<string, IrScene> } {
  const map = new Map(scenes.map((s) => [s.scene.toLowerCase(), s]));
  return {
    map,
    load: (name: string) => map.get(name.toLowerCase()) ?? null,
    assets: () => NULL_ASSETS,
  };
}
