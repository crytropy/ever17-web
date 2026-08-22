/**
 * The formal route-graph model: scenes as nodes, inter-scene transitions as
 * typed edges, endings as first-class entities.
 *
 * Everything here is derived from data - the IR (static analysis) and runtime
 * traces (dynamic observation). No scene names, choice ids, variable ids or
 * ending names are hardcoded anywhere in this package.
 *
 * Browser-safe: types and (de)serialization only, no Node imports.
 */

export type TransitionType = "linear" | "choice" | "conditional" | "ending";

/** A variable comparison that gates a path (from a VAR_JUMP or dispatch row). */
export interface ConditionExpr {
  varId: number;
  /** Relation as text: "==", "!=", ">=", ">", "<=" (see vn-runtime RELATIONS). */
  rel: string;
  value: number;
  /** Human-readable rendering, e.g. "var1223 == 2". */
  text: string;
}

/** A constant variable write on the path into a transition. */
export interface VarWrite {
  varId: number;
  value: number;
  mod: "assign" | "add";
}

export interface Transition {
  from: string;
  to: string;
  type: TransitionType;
  /** Block label of the gotoScene op inside `from`. */
  block: string;
  /** Constant writes in the same block before the transition (transfer state). */
  writes: VarWrite[];
  /** For type "conditional": the guard that selects this path. */
  condition?: ConditionExpr;
  /** For type "choice": the option whose branch leads (only) here. */
  choice?: { id: number | null; option: number; text?: string };
  /** Dynamic-traversal policies that walked this edge. */
  observedBy: string[];
}

export interface ChoiceSite {
  /** Stable key: "<scene>:<choiceId>" (or "<scene>:b<block>" when id is null). */
  key: string;
  scene: string;
  id: number | null;
  block: string;
  options: { index: number; text: string; conditioned: boolean }[];
}

export interface SceneNode {
  id: string;
  outgoing: Transition[];
  incoming: Transition[];
  lines: number;
  blocks: number;
  choices: ChoiceSite[];
  /** Scene ids from `10 24` markers. */
  sceneIds: number[];
  /** No outgoing transitions at all. */
  terminal: boolean;
  /** Has a reachable in-scene termination path (the scene can end the game). */
  canEnd: boolean;
  /** playMovie assets referenced anywhere in the scene. */
  movies: string[];
  /** varJump conditions in the entry region (resume/dispatch points). */
  headDispatch: string[];
  /** Distinct asset names the scene references (images and audio). */
  assets?: string[];
}

/** How an ending was established. */
export type EndingEvidence = "static" | "observed" | "static+observed";

export interface EndingInfo {
  /** Derived id: the distinctive movie asset uppercased, else the scene id
   * uppercased, suffixed on collision. Never hand-written. */
  id: string;
  scene: string;
  /** Distinctive movie on the terminal path, when one exists. */
  movie: string | null;
  /** Static dispatch conditions guarding the terminal path (e.g. var1223 == 2). */
  conditions: ConditionExpr[];
  evidence: EndingEvidence;
  /** From exploration: number of distinct paths that reached it. */
  observedPaths?: number;
  /** Analysis annotation (e.g. a dispatch row shared by every ending). */
  note?: string;
}

export interface GraphTotals {
  scenes: number;
  /** Scenes reachable from start following transitions. */
  reachableScenes: number;
  choiceSites: number;
  choiceOptions: number;
  assets: number;
  endings: number;
}

export interface RouteGraphModel {
  start: string;
  nodes: Map<string, SceneNode>;
  transitions: Transition[];
  /** Scenes referenced by a transition but absent from the IR set. */
  missingScenes: string[];
  /** Scenes with no inbound edge and not the start scene. */
  unreferenced: string[];
  endings: EndingInfo[];
  totals: GraphTotals;
}

/* ------------------------------------------------------------------ JSON */

export const GRAPH_FORMAT = "e17vn-graph";
export const GRAPH_VERSION = 1;

/** Node as serialized: transitions referenced by index into `transitions`. */
export type SceneNodeJson = Omit<SceneNode, "outgoing" | "incoming"> & {
  outgoing: number[];
  incoming: number[];
};

export interface RouteGraphJson {
  format: typeof GRAPH_FORMAT;
  version: typeof GRAPH_VERSION;
  start: string;
  nodes: SceneNodeJson[];
  transitions: Transition[];
  missingScenes: string[];
  unreferenced: string[];
  endings: EndingInfo[];
  totals: GraphTotals;
  /** Optional dynamic traversal summaries, keyed by policy label. */
  traversals?: Record<string, { route: string[]; end: string }>;
}

export function toJson(
  model: RouteGraphModel,
  traversals?: Record<string, { route: string[]; end: string }>,
): RouteGraphJson {
  const index = new Map<Transition, number>();
  model.transitions.forEach((t, i) => index.set(t, i));
  const nodes: SceneNodeJson[] = [...model.nodes.values()].map((n) => ({
    ...n,
    outgoing: n.outgoing.map((t) => index.get(t)!),
    incoming: n.incoming.map((t) => index.get(t)!),
  }));
  return {
    format: GRAPH_FORMAT,
    version: GRAPH_VERSION,
    start: model.start,
    nodes,
    transitions: model.transitions,
    missingScenes: model.missingScenes,
    unreferenced: model.unreferenced,
    endings: model.endings,
    totals: model.totals,
    ...(traversals ? { traversals } : {}),
  };
}

/**
 * Which endings does a finished session satisfy? Evaluated client-side from
 * the graph's own definitions: the terminal scene must match, every dispatch
 * condition must hold on the final variables, and when the ending has a
 * distinctive movie it must actually have been played. Endings with neither
 * conditions nor a movie are not awardable this way (nothing to verify).
 */
export function matchEndings(
  endings: readonly EndingInfo[],
  terminalScene: string,
  finalVars: ReadonlyMap<number, number>,
  moviesPlayed: ReadonlySet<string>,
): EndingInfo[] {
  const scene = terminalScene.toLowerCase();
  const holds = (c: ConditionExpr): boolean => {
    const v = finalVars.get(c.varId) ?? 0;
    switch (c.rel) {
      case "==": return v === c.value;
      case "!=": return v !== c.value;
      case ">=": return v >= c.value;
      case ">": return v > c.value;
      case "<=": return v <= c.value;
      default: return false;
    }
  };
  return endings.filter((e) => {
    if (e.note) return false;
    if (e.scene !== scene) return false;
    if (e.conditions.length === 0 && !e.movie) return false;
    if (!e.conditions.every(holds)) return false;
    if (e.movie && !moviesPlayed.has(e.movie.toLowerCase())) return false;
    return true;
  });
}

export function fromJson(json: RouteGraphJson): RouteGraphModel {
  if (json.format !== GRAPH_FORMAT) throw new Error(`not a route graph (format ${String(json.format)})`);
  if (json.version !== GRAPH_VERSION) throw new Error(`unsupported graph version ${String(json.version)}`);
  const transitions = json.transitions;
  const nodes = new Map<string, SceneNode>();
  for (const n of json.nodes) {
    nodes.set(n.id, {
      ...n,
      outgoing: n.outgoing.map((i) => transitions[i]!),
      incoming: n.incoming.map((i) => transitions[i]!),
    });
  }
  return {
    start: json.start,
    nodes,
    transitions,
    missingScenes: json.missingScenes,
    unreferenced: json.unreferenced,
    endings: json.endings,
    totals: json.totals,
  };
}
