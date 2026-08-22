/**
 * Exploration result types - browser-safe (no runtime imports), shared by the
 * Node-side explorer and the web route-explorer page.
 */

export const EXPLORATION_FORMAT = "e17vn-exploration";
export const EXPLORATION_VERSION = 1;

export interface TakenChoice {
  scene: string;
  key: string;
  id: number | null;
  option: number;
  text: string;
}

/** One aggregated ending, over every path that reached it. */
export interface EndingRecord {
  id: string;
  scene: string;
  movie: string | null;
  reason: string;
  paths: number;
  /** Lowest chained-playthrough number that reached it (1 = fresh New Game). */
  playthrough: number;
  /** Scenes present on every path (in first-path order). */
  criticalScenes: string[];
  /** Scenes on at least one path. */
  anyScenes: string[];
  /** Choices answered identically on every path. */
  requiredChoices: TakenChoice[];
  /** Choices met on every path but answered differently (any option works). */
  freeChoices: { key: string; scene: string; id: number | null; options: number[] }[];
  /** Condition outcomes consistent across every path: text -> outcome. */
  conditions: Record<string, boolean>;
  /** Final variable values identical across every path. */
  finalVars: [number, number][];
  samplePath: { route: string[]; choices: TakenChoice[] };
}

export interface ExplorationResult {
  format: typeof EXPLORATION_FORMAT;
  version: typeof EXPLORATION_VERSION;
  start: string;
  scenesVisited: string[];
  transitionsObserved: { from: string; to: string; count: number }[];
  /** Every choice presented, with the options seen enabled. */
  choicesSeen: Record<
    string,
    { scene: string; id: number | null; options: number[]; texts: Record<number, string> }
  >;
  endings: EndingRecord[];
  /** Runs that ended for a non-ending reason (anomalies worth reading). */
  anomalies: { reason: string; scene: string; route: string[] }[];
  /** Unknown IR ops actually executed: "mnemonic(opcode)" -> count. */
  unknownOps: Record<string, number>;
  /** varJump conditions that could not be evaluated: text -> count. */
  unevaluableJumps: Record<string, number>;
  /** Cross-run flag vars carried over between chained playthroughs. */
  persistentVars: number[];
  /** Highest playthrough generation explored (1 = single fresh run). */
  playthroughsExplored: number;
  stats: {
    sessions: number;
    statesSeen: number;
    dedupPrunes: number;
    events: number;
    capped: boolean;
    elapsedMs: number;
  };
}
