/**
 * Browser-safe engine core. Everything exported here is environment-agnostic
 * (no Node, no DOM, no renderer); Node-only helpers live in "kid-runtime/node".
 */
export { SceneVm } from "./vm.js";
export type { VmOptions, ChoiceDecision, VarJumpInfo, VmSaveState } from "./vm.js";
export { evaluateCondition, RELATIONS, MOD_ASSIGN, MOD_ADD } from "./conditions.js";
export type { ConditionResult } from "./conditions.js";
export { runScene } from "./player.js";
export type { ScriptedRun, RunResult } from "./player.js";
export type * from "./types.js";
export { SessionRunner } from "./session.js";
export type { SessionOptions, SessionResult, SceneSource, GapReport } from "./session.js";
export { NULL_ASSETS } from "./null-assets.js";
export { GameSession, SAVE_FORMAT, SAVE_VERSION } from "./game-session.js";
export type {
  AsyncSceneSource,
  BacklogEntry,
  SessionSave,
  GameSessionOptions,
  SessionEvent,
  SessionEndEvent,
} from "./game-session.js";
