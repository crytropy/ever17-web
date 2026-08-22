/**
 * The scene IR contract lives in kid-contracts (shared with the engine);
 * this module re-exports it so parser-internal code and existing consumers
 * of "e17-parser/ir" keep working unchanged.
 */
export { IR_SCHEMA_VERSION } from "kid-contracts/ir";
export type {
  IrScene,
  IrBlock,
  IrOp,
  IrCondition,
  IrValue,
  DialogueLine,
} from "kid-contracts/ir";
