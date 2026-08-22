export { buildGraphModel, analyzeScene } from "./build.js";
export type { DispatchRow, SceneAnalysis } from "./build.js";
export { applyExploration, endingReport } from "./analyze.js";
export type { EndingReport } from "./analyze.js";
export {
  explore,
  buildVarAbstraction,
  detectCrossRunVars,
  EXPLORATION_FORMAT,
  EXPLORATION_VERSION,
} from "./explore.js";
export type { ExploreOptions, VarAbstraction } from "./explore.js";
export type {
  ExplorationResult,
  EndingRecord,
  TakenChoice,
} from "./exploration-types.js";
export { explainEnding, formatExplanation } from "./explain.js";
export type { EndingExplanation } from "./explain.js";
export { toJson, fromJson, GRAPH_FORMAT, GRAPH_VERSION } from "./model.js";
export type {
  RouteGraphModel,
  RouteGraphJson,
  SceneNode,
  SceneNodeJson,
  Transition,
  TransitionType,
  ConditionExpr,
  VarWrite,
  ChoiceSite,
  EndingInfo,
  GraphTotals,
} from "./model.js";
export { toDot } from "./export.js";
export { layoutGraph, NODE_W, NODE_H } from "./layout.js";
export type { LayoutResult } from "./layout.js";
export { runGraphCli } from "./cli.js";
