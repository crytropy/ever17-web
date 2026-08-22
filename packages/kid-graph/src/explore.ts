import {
  GameSession,
  type AsyncSceneSource,
  type IrOp,
  type IrScene,
  type SessionSave,
  type VarJumpInfo,
} from "kid-runtime";
import type { EndingRecord, ExplorationResult, TakenChoice } from "./exploration-types.js";
import { EXPLORATION_FORMAT, EXPLORATION_VERSION } from "./exploration-types.js";

export type { EndingRecord, ExplorationResult, TakenChoice } from "./exploration-types.js";
export { EXPLORATION_FORMAT, EXPLORATION_VERSION } from "./exploration-types.js";

/**
 * Automatic route exploration.
 *
 * Drives the real GameSession - the same engine, save format and condition
 * evaluation as interactive play; there is no second execution engine. At
 * every choice the session is saved; option 0 continues in place and every
 * other enabled option is pushed as a branch to restore later.
 *
 * Termination: branches are pruned when the save fingerprint (position plus
 * abstracted variables, see buildVarAbstraction) has been seen - paths that
 * converge to the same state cannot diverge again, because execution is
 * deterministic in (position, vars). Hard caps guard pathological inputs.
 *
 * Playthrough chaining: some content is gated on flags that are only written
 * in ending scenes and only read in scenes an ending can never reach again -
 * writes that cannot matter within one run, i.e. cross-playthrough state
 * (detectCrossRunVars finds them from the data). When a run reaches an
 * ending, exploration can start a New Game carrying those flags over,
 * up to `playthroughs` generations.
 */

export interface ExploreOptions {
  start: string;
  /** Cap on distinct choice states explored (safety valve). */
  maxStates?: number;
  /** Cap on total sessions (branches) run. */
  maxSessions?: number;
  /**
   * Sound state abstraction for dedup fingerprints - see
   * buildVarAbstraction(). Without it, fingerprints use every variable
   * exactly (always sound, often exponentially slower).
   */
  abstraction?: VarAbstraction;
  /** Maximum chained playthroughs (default 1 = a single fresh run). */
  playthroughs?: number;
  /** Vars carried across chained playthroughs (see detectCrossRunVars). */
  persistentVars?: ReadonlySet<number>;
  onProgress?: (msg: string) => void;
  /** Injected clock for deterministic tests; defaults to Date.now. */
  now?: () => number;
}

/* ------------------------------------------------------------ abstraction */

/**
 * Precomputed, sound variable abstraction for dedup fingerprints.
 *
 * 1. Only the scenario's read set matters: vars compared by some varJump or
 *    option-visibility condition. Writes to never-read vars cannot influence
 *    control flow (story writes are constants - values never flow between
 *    variables), so those vars are dropped.
 * 2. A read var whose value can no longer be *added to* from the current
 *    position (no add-writes reachable in the current scene's remaining
 *    blocks, none in any statically reachable later scene) is observable
 *    only through comparisons against constants. Its exact value is then
 *    projected to the cell it occupies among those constants: two states in
 *    the same cell answer every remaining comparison identically, and any
 *    later assignment overwrites the value for both, so they are bisimilar.
 */
export interface VarAbstraction {
  /** the read set */
  control: ReadonlySet<number>;
  /** vars equality-tested against 3+ distinct values: real dispatch
   * registers (the ending id), as opposed to boolean flags */
  dispatchVars: ReadonlySet<number>;
  /** scene -> var -> distinct values it is equality-tested against IN that
   * scene (identifies each scene's own dispatch register) */
  sceneEqVars: ReadonlyMap<string, ReadonlyMap<number, ReadonlySet<number>>>;
  /** var -> sorted cutpoints derived from every comparison of it */
  cutpoints: ReadonlyMap<number, readonly number[]>;
  /** scene -> vars with add-like writes anywhere in it */
  sceneAdds: ReadonlyMap<string, ReadonlySet<number>>;
  /** scene -> block -> vars with add-like writes reachable from that block */
  addAfterBlock: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>>;
  /** scene -> vars with add-like writes in any statically reachable LATER scene */
  futureAdds: ReadonlyMap<string, ReadonlySet<number>>;
}

export function buildVarAbstraction(sceneList: Iterable<IrScene>): VarAbstraction {
  const scenes = [...sceneList];
  const control = new Set<number>();
  const cutpointSets = new Map<number, Set<number>>();
  const eqValues = new Map<number, Set<number>>();
  const cut = (varId: number, ...points: number[]): void => {
    let s = cutpointSets.get(varId);
    if (!s) cutpointSets.set(varId, (s = new Set()));
    for (const p of points) s.add(p);
  };
  const sceneEqVars = new Map<string, Map<number, Set<number>>>();
  let currentScene = "";
  const addCondition = (c: { type: string; varId?: number; rel?: number; value?: unknown }): void => {
    if (c.type === "varCompare" && typeof c.varId === "number") {
      control.add(c.varId);
      const v = c.value as { type: string; value?: number };
      if (v.type === "const" && typeof v.value === "number") {
        const k = v.value;
        switch (c.rel) {
          case 0x0c: case 0x0d: {
            cut(c.varId, k, k + 1); // == / !=
            let s = eqValues.get(c.varId);
            if (!s) eqValues.set(c.varId, (s = new Set()));
            s.add(k);
            let perScene = sceneEqVars.get(currentScene);
            if (!perScene) sceneEqVars.set(currentScene, (perScene = new Map()));
            let vals = perScene.get(c.varId);
            if (!vals) perScene.set(c.varId, (vals = new Set()));
            vals.add(k);
            break;
          }
          case 0x10: cut(c.varId, k); break; // >=
          case 0x11: cut(c.varId, k + 1); break; // >
          case 0x0f: cut(c.varId, k + 1); break; // <=
          default: cut(c.varId, k, k + 1); break;
        }
      } else {
        // unevaluable comparison: keep the var fully exact
        cut(c.varId, Number.NaN);
      }
    } else if (c.type === "sysVarTest" && typeof c.varId === "number") {
      control.add(c.varId);
      cut(c.varId, 0, 1);
    }
  };

  const sceneAdds = new Map<string, Set<number>>();
  const addAfterBlock = new Map<string, Map<string, Set<number>>>();
  const successors = new Map<string, Set<string>>(); // scene-level

  for (const scene of scenes) {
    const name = scene.scene.toLowerCase();
    currentScene = name;
    const adds = new Set<number>();
    const blockAdds = new Map<string, Set<number>>();
    const blockSucc = new Map<string, Set<string>>();
    const succScenes = new Set<string>();
    for (const [label, block] of Object.entries(scene.blocks)) {
      const a = new Set<number>();
      const succ = new Set<string>();
      if (block.next) succ.add(block.next);
      for (const op of block.ops) {
        switch (op.op) {
          case "varSet":
            // adds and anything not understood as a plain assignment count
            // as add-like (conservative)
            if (op.mod !== 0x14 || op.value.type !== "const") a.add(op.varId);
            // a varRef value reads its source var: values flow, so the source
            // must stay in the fingerprint, exactly (no cutpoints of its own)
            if (op.value.type === "varRef") {
              control.add(op.value.varId);
              cut(op.value.varId, Number.NaN);
            }
            break;
          case "varJump":
            addCondition(op.condition);
            succ.add(op.target);
            break;
          case "gotoBlock":
            succ.add(op.target);
            break;
          case "choice":
            for (const o of op.options) {
              if (o.condition) addCondition(o.condition);
              if (o.target && o.target !== "?") succ.add(o.target);
            }
            break;
          case "switch":
            for (const t of op.targets) if (t !== "?") succ.add(t);
            break;
          case "gotoScene":
            succScenes.add(op.scene.toLowerCase());
            break;
          default:
            break;
        }
      }
      blockAdds.set(label, a);
      blockSucc.set(label, succ);
      for (const v of a) adds.add(v);
    }
    // reachable-adds closure over the intra-scene CFG (sets grow-only)
    const after = new Map<string, Set<number>>();
    for (const label of Object.keys(scene.blocks)) after.set(label, new Set(blockAdds.get(label)));
    for (let changed = true, guard = 0; changed && guard < 200; guard++) {
      changed = false;
      for (const [label, succ] of blockSucc) {
        const mine = after.get(label)!;
        for (const s of succ) {
          for (const v of after.get(s) ?? []) {
            if (!mine.has(v)) {
              mine.add(v);
              changed = true;
            }
          }
        }
      }
    }
    sceneAdds.set(name, adds);
    addAfterBlock.set(name, after);
    successors.set(name, succScenes);
  }

  // scene-closure of future adds (excluding the scene itself, which is
  // covered block-precisely by addAfterBlock)
  const futureAdds = new Map<string, Set<number>>();
  for (const scene of scenes) {
    const name = scene.scene.toLowerCase();
    const seen = new Set<string>();
    const acc = new Set<number>();
    const queue = [...(successors.get(name) ?? [])];
    while (queue.length) {
      const s = queue.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);
      for (const v of sceneAdds.get(s) ?? []) acc.add(v);
      for (const n of successors.get(s) ?? []) queue.push(n);
    }
    futureAdds.set(name, acc);
  }

  const cutpoints = new Map<number, number[]>();
  for (const [v, s] of cutpointSets) {
    cutpoints.set(v, [...s].sort((a, b) => a - b));
  }
  const dispatchVars = new Set<number>();
  for (const [v, s] of eqValues) if (s.size >= 3) dispatchVars.add(v);
  return { control, dispatchVars, sceneEqVars, cutpoints, sceneAdds, addAfterBlock, futureAdds };
}

/* -------------------------------------------------------- cross-run flags */

/**
 * Vars whose writes can only matter across playthroughs.
 *
 * Evidence for "cross-run flag": a scene W (reachable from the start)
 * *assigns* v a nonzero constant, and some other scene R reads v, never
 * assigns it itself, and is unreachable from W within a single run. Such a
 * write is dead code inside one run - it exists to be read by a LATER run.
 *
 * The filters matter:
 *  - add-writes are work-state accumulation (affection counters), never
 *    flag-setting; zero-assigns are cleanup/re-initialization;
 *  - a read scene that assigns v itself re-initializes it locally (menu
 *    visibility vars), so its read says nothing about carried state;
 *  - same-scene write/read pairs are ambiguous without op ordering and are
 *    ignored as evidence in both directions.
 *
 * (Found this way in the data: the ending scene assigns a flag that the
 * early chapters test to unlock second-playthrough fragment scenes.)
 */
export function detectCrossRunVars(sceneList: Iterable<IrScene>, start: string): Set<number> {
  const scenes = [...sceneList];
  const byName = new Map(scenes.map((s) => [s.scene.toLowerCase(), s]));
  const succ = new Map<string, Set<string>>();
  for (const s of scenes) {
    const out = new Set<string>();
    for (const b of Object.values(s.blocks)) {
      for (const op of b.ops) if (op.op === "gotoScene") out.add(op.scene.toLowerCase());
    }
    succ.set(s.scene.toLowerCase(), out);
  }
  const closure = (from: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [from];
    while (queue.length) {
      const n = queue.pop()!;
      if (seen.has(n) || !byName.has(n)) continue;
      seen.add(n);
      for (const m of succ.get(n) ?? []) queue.push(m);
    }
    return seen;
  };
  const reachable = closure(start.toLowerCase());
  const closures = new Map<string, Set<string>>();
  for (const s of reachable) closures.set(s, closure(s));

  /** nonzero-assign write scenes per var */
  const flagWrites = new Map<number, Set<string>>();
  /** any-assign scenes per var (locally re-initializing readers) */
  const assigns = new Map<number, Set<string>>();
  const reads = new Map<number, Set<string>>();
  const record = (m: Map<number, Set<string>>, v: number, scene: string): void => {
    let set = m.get(v);
    if (!set) m.set(v, (set = new Set()));
    set.add(scene);
  };
  /** varRef sources read together in one block, feeding one target (the
   * route-clear flags summed into a counter read as a family). */
  const refGroups: Set<number>[] = [];
  for (const s of scenes) {
    const name = s.scene.toLowerCase();
    if (!reachable.has(name)) continue;
    for (const b of Object.values(s.blocks)) {
      const groups = new Map<number, Set<number>>(); // target var -> sources
      for (const op of b.ops) {
        if (op.op === "varSet") {
          if (op.mod === 0x14 && op.value.type === "const") {
            record(assigns, op.varId, name);
            if (op.value.value !== 0) record(flagWrites, op.varId, name);
          }
          // a varRef value reads its source var
          if (op.value.type === "varRef") {
            record(reads, op.value.varId, name);
            let g = groups.get(op.varId);
            if (!g) groups.set(op.varId, (g = new Set()));
            g.add(op.value.varId);
          }
        } else if (op.op === "varJump" && op.condition.type === "varCompare") {
          record(reads, op.condition.varId, name);
        } else if (op.op === "choice") {
          // choosing assigns the selected index into resultVar
          if (op.resultVar != null) record(assigns, op.resultVar, name);
          for (const o of op.options) {
            if (o.condition?.type === "varCompare") record(reads, o.condition.varId, name);
          }
        }
      }
      for (const g of groups.values()) if (g.size > 1) refGroups.push(g);
    }
  }
  const persistent = new Set<number>();
  for (const [v, ws] of flagWrites) {
    const rs = reads.get(v);
    if (!rs) continue;
    const selfInit = assigns.get(v) ?? new Set();
    for (const w of ws) {
      const reach = closures.get(w)!;
      const evidence = [...rs].some((r) => r !== w && !selfInit.has(r) && !reach.has(r));
      if (evidence) {
        persistent.add(v);
        break;
      }
    }
  }
  // sibling closure: flags read as one family (summed into one counter in
  // one block) persist together - a member proven cross-run pulls in the rest
  for (let changed = true; changed; ) {
    changed = false;
    for (const g of refGroups) {
      if ([...g].some((v) => persistent.has(v)) && ![...g].every((v) => persistent.has(v))) {
        for (const v of g) persistent.add(v);
        changed = true;
      }
    }
  }
  return persistent;
}

/* -------------------------------------------------------------- explorer */

/**
 * Path context with structural sharing: hundreds of thousands of pending
 * branches each hold one of these, so per-branch state must be O(small).
 * Choices and movies are immutable parent-linked chains (branches share the
 * prefix); condition outcomes are a byte per interned condition (1 = seen
 * true, 2 = seen false, 3 = both).
 */
interface ChainNode<T> {
  v: T;
  prev: ChainNode<T> | null;
}

function chainToArray<T>(head: ChainNode<T> | null): T[] {
  const out: T[] = [];
  for (let n = head; n; n = n.prev) out.push(n.v);
  return out.reverse();
}

interface PathCtx {
  choices: ChainNode<TakenChoice> | null;
  /** interned condition id -> outcome bits (see CondInterner) */
  condState: Uint8Array;
  moviesSinceChoice: string[];
  /** every movie played on this path (parent-linked chain) */
  moviesAll: ChainNode<string> | null;
  /** chained-playthrough generation (1 = fresh New Game). */
  generation: number;
  /** remaining scripted answers (carry-bootstrap replays); [] = free run. */
  script: TakenChoice[];
  /** session originated from a replay: its branches explore a known deep
   * trajectory's neighbourhood and are scheduled hot. */
  fromReplay: boolean;
}

interface Branch {
  save: SessionSave;
  option: number;
  ctx: PathCtx;
  /** choice-site key, for balanced scheduling */
  site: string;
}

interface NewGame {
  carry: [number, number][];
  generation: number;
  /** replay a known ending's choices under this carry (flag-lattice bootstrap). */
  script?: TakenChoice[];
}

/** Strip the interpolated current value: "var1207(18) >= 17" -> "var1207 >= 17". */
function normalizeCond(text: string): string {
  return text.replace(/\(-?\d+\)/, "");
}

class CondInterner {
  readonly ids = new Map<string, number>();
  readonly keys: string[] = [];
  intern(key: string): number {
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.keys.length;
      this.ids.set(key, id);
      this.keys.push(key);
    }
    return id;
  }
}

function markCond(ctx: PathCtx, id: number, outcome: boolean): PathCtx {
  if (id >= ctx.condState.length) {
    const grown = new Uint8Array(Math.max(64, id + 1, ctx.condState.length * 2));
    grown.set(ctx.condState);
    ctx.condState = grown;
  }
  ctx.condState[id] = ctx.condState[id]! | (outcome ? 1 : 2);
  return ctx;
}

function cloneCtx(ctx: PathCtx): PathCtx {
  return {
    choices: ctx.choices, // shared immutable chain
    condState: ctx.condState.slice(),
    moviesSinceChoice: [...ctx.moviesSinceChoice],
    moviesAll: ctx.moviesAll, // shared immutable chain
    generation: ctx.generation,
    script: [], // a branch deviates from any replay script
    fromReplay: false,
  };
}

/** Cell index of x among sorted cutpoints (count of cutpoints <= x). */
function cellOf(cuts: readonly number[], x: number): number {
  let lo = 0;
  let hi = cuts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cuts[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function fingerprint(save: SessionSave, abs: VarAbstraction | null): string {
  const scene = save.vm.scene.toLowerCase();
  const project = (entries: [number, number][]): [number, number | string][] => {
    if (!abs) return [...entries].sort((a, b) => a[0] - b[0]);
    const addHere = abs.addAfterBlock.get(scene)?.get(save.vm.block);
    const addLater = abs.futureAdds.get(scene);
    const out: [number, number | string][] = [];
    for (const [v, val] of entries) {
      if (!abs.control.has(v)) continue;
      if (val === 0) continue; // unwritten vars default to 0: same meaning
      const cuts = abs.cutpoints.get(v);
      const exact =
        !cuts ||
        cuts.some(Number.isNaN) ||
        addHere?.has(v) === true ||
        addLater?.has(v) === true;
      out.push([v, exact ? val : `c${cellOf(cuts!, val)}`]);
    }
    return out.sort((a, b) => a[0] - b[0]);
  };
  return JSON.stringify([scene, save.vm.block, save.vm.pc, project(save.vars), project(save.sysVars)]);
}

interface EndingAgg {
  /** aggregation key: base identity + dispatch signature */
  key: string;
  scene: string;
  /** first movie after the last choice (the old, under-discriminating id) */
  movieAfterChoice: string | null;
  /** "var=value" rows of the dispatch table this run matched */
  sig: string[];
  /** movies played on every path, in first-path order */
  moviesCommon: string[];
  reason: string;
  paths: number;
  playthrough: number;
  routeFirst: string[];
  routeIntersect: Set<string>;
  routeUnion: Set<string>;
  /** choice key -> options taken across paths + occurrence count. */
  choiceAgg: Map<string, { options: Set<number>; seenOnPaths: number; sample: TakenChoice }>;
  condAgg: Map<string, { true: number; false: number; onPaths: number }>;
  finalVars: Map<number, number | null>; // null = conflicting
  sample: { route: string[]; choices: TakenChoice[] };
}

/**
 * Ending identity, from the run itself:
 * - the dispatch signature: `==` comparisons that held while the same var
 *   failed other values on this run - i.e. the dispatch-table row that fired
 *   (var 1223 == 2 separates endings that share a movie);
 * - the distinctive movie: played on every path of this ending and on no
 *   other ending's every-path set (staff rolls and shared cutscenes drop
 *   out), which gives endings their natural names.
 */
function dispatchSignature(
  condState: Uint8Array,
  interner: CondInterner,
  dispatchVars: ReadonlySet<number>,
): string[] {
  const trueTests = new Map<number, number>();
  for (let id = 0; id < condState.length && id < interner.keys.length; id++) {
    if (condState[id] !== 1) continue; // true-only on this path
    const m = interner.keys[id]!.match(/^var(\d+) == (-?\d+)$/);
    if (!m) continue;
    const v = Number(m[1]);
    if (!dispatchVars.has(v)) continue;
    trueTests.set(v, Number(m[2]));
  }
  return [...trueTests.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([v, val]) => `${v}=${val}`);
}

export async function explore(
  source: AsyncSceneSource,
  opts: ExploreOptions,
): Promise<ExplorationResult> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const maxStates = opts.maxStates ?? 250_000;
  const maxSessions = opts.maxSessions ?? 250_000;
  const abstraction = opts.abstraction ?? null;
  const maxPlaythroughs = Math.max(1, opts.playthroughs ?? 1);
  const persistentVars = opts.persistentVars ?? new Set<number>();

  const seen = new Set<string>();
  const scenesVisited = new Set<string>();
  const transitions = new Map<string, number>();
  const choicesSeen: ExplorationResult["choicesSeen"] = {};
  const unknownOps = new Map<string, number>();
  const unevaluable = new Map<string, number>();
  const endings = new Map<string, EndingAgg>();
  const anomalies: ExplorationResult["anomalies"] = [];
  let sessions = 0;
  let events = 0;
  let dedupPrunes = 0;
  let capped = false;
  let playthroughsExplored = 1;

  // Site-balanced work queue: pending branches grouped by choice site; the
  // next branch comes from the least-expanded site. This spreads the budget
  // across the whole scenario instead of exhausting one region's variable
  // permutations first, so coverage and endings arrive early even when the
  // full sound state space exceeds the caps. New-game tasks (carried flags
  // from a completed run) unlock whole new regions and always go first.
  const pending = new Map<string, Branch[]>();
  /** branches spawned by replay sessions: neighbourhoods of known deep
   * trajectories, explored before the balanced pool */
  const hot: Branch[] = [];
  const siteExpansions = new Map<string, number>();
  const newGames: NewGame[] = [{ carry: [], generation: 1 }];
  const carriesSeen = new Set<string>([JSON.stringify([])]);
  /** carry-bootstrap bookkeeping: known carries x known ending scripts */
  const knownCarries: { key: string; carry: [number, number][]; generation: number }[] = [
    { key: JSON.stringify([]), carry: [], generation: 1 },
  ];
  const endingScripts = new Map<string, TakenChoice[]>();
  const bootstrapTried = new Set<string>();
  // Replay each known ending's choice script under each known carry - and,
  // Go-Explore style, prefixes of it (drop the last 1/2/4/8 answers): the run
  // rides a known trajectory deep into the game, then branches freely near
  // the tip, exactly where sibling endings usually differ.
  const TRIMS = [0, 1, 2, 4, 8, 12, 16, 24, 32];
  const scheduleBootstraps = (): void => {
    for (const c of knownCarries) {
      if (c.generation > maxPlaythroughs) continue;
      for (const [id, script] of endingScripts) {
        for (const trim of TRIMS) {
          const k = `${c.key}|${id}|${trim}`;
          if (bootstrapTried.has(k)) continue;
          bootstrapTried.add(k);
          // the untrimmed empty-carry replay is the run that discovered it
          if (c.carry.length === 0 && trim === 0) continue;
          if (trim > 0 && trim >= script.length) continue;
          newGames.push({
            carry: c.carry,
            generation: c.generation,
            script: script.slice(0, script.length - trim),
          });
        }
      }
    }
  };
  const pendingCount = (): number => {
    let n = hot.length;
    for (const list of pending.values()) n += list.length;
    return n;
  };
  /** global LIFO view of the same branches (depth-first lineage completion);
   * entries are shared with `pending` and marked taken when popped */
  const lifo: (Branch & { taken?: boolean })[] = [];
  let popCounter = 0;
  const takeNext = (): Branch | NewGame | undefined => {
    const ng = newGames.shift();
    if (ng) return ng;
    const h = hot.pop();
    if (h) return h;
    popCounter += 1;
    // Mostly depth-first: LIFO completes lineages fast (endings hide at the
    // ends of long chains). Every 4th pop takes the least-expanded choice
    // site instead, so no region is starved.
    if (popCounter % 4 !== 0) {
      for (;;) {
        const b = lifo.pop();
        if (!b) break;
        if (b.taken) continue;
        b.taken = true;
        const list = pending.get(b.site);
        if (list) {
          const i = list.indexOf(b);
          if (i >= 0) list.splice(i, 1);
          if (list.length === 0) pending.delete(b.site);
        }
        siteExpansions.set(b.site, (siteExpansions.get(b.site) ?? 0) + 1);
        return b;
      }
    }
    let bestSite: string | null = null;
    let bestCount = Infinity;
    for (const [site, list] of pending) {
      if (list.length === 0) continue;
      const c = siteExpansions.get(site) ?? 0;
      if (c < bestCount || (c === bestCount && bestSite !== null && site < bestSite)) {
        bestCount = c;
        bestSite = site;
      }
    }
    if (bestSite === null) {
      // pending empty; drain any untaken LIFO leftovers
      for (;;) {
        const b = lifo.pop();
        if (!b) return undefined;
        if (!b.taken) {
          b.taken = true;
          return b;
        }
      }
    }
    const list = pending.get(bestSite)!;
    const b = list.pop()! as Branch & { taken?: boolean };
    b.taken = true;
    siteExpansions.set(bestSite, (siteExpansions.get(bestSite) ?? 0) + 1);
    if (list.length === 0) pending.delete(bestSite);
    return b;
  };

  // per-session mutable context, bound through the VM callbacks
  const interner = new CondInterner();
  const freshCtx = (generation: number, script: TakenChoice[]): PathCtx => ({
    choices: null,
    condState: new Uint8Array(64),
    moviesSinceChoice: [],
    moviesAll: null,
    generation,
    script,
    fromReplay: script.length > 0,
  });
  let ctx: PathCtx = freshCtx(1, []);

  const sessionOpts = {
    backlogLimit: 1, // keep branch saves tiny; the backlog is irrelevant here
    vm: {
      onOp: (op: IrOp) => {
        if (op.op === "unknown") {
          const k = `${op.mnemonic}(${op.opcode})`;
          unknownOps.set(k, (unknownOps.get(k) ?? 0) + 1);
        } else if (op.op === "playMovie") {
          const name = op.asset.toLowerCase();
          ctx.moviesSinceChoice.push(name);
          ctx.moviesAll = { v: name, prev: ctx.moviesAll };
        }
      },
      onVarJump: (info: VarJumpInfo) => {
        const k = normalizeCond(info.condition);
        if (info.value === undefined) {
          unevaluable.set(k, (unevaluable.get(k) ?? 0) + 1);
          return;
        }
        markCond(ctx, interner.intern(k), info.value);
      },
    },
  };

  const recordChoicePresented = (
    scene: string,
    ev: { id: number | null; options: { index: number; text: string; enabled: boolean }[] },
    block: string,
  ): { key: string; enabled: { index: number; text: string }[] } => {
    const key = `${scene}:${ev.id ?? `b${block}`}`;
    const entry = (choicesSeen[key] ??= { scene, id: ev.id, options: [], texts: {} });
    const enabled = ev.options.filter((o) => o.enabled);
    for (const o of enabled) {
      if (!entry.options.includes(o.index)) entry.options.push(o.index);
      entry.texts[o.index] = o.text;
    }
    return { key, enabled: enabled.map((o) => ({ index: o.index, text: o.text })) };
  };

  const recordEnd = (session: GameSession, reason: string): void => {
    const route = session.route.map((s) => s.toLowerCase());
    for (const s of route) scenesVisited.add(s);
    for (let i = 0; i + 1 < route.length; i++) {
      const k = `${route[i]}>${route[i + 1]}`;
      transitions.set(k, (transitions.get(k) ?? 0) + 1);
    }
    if (reason !== "ending") {
      anomalies.push({ reason, scene: session.scene.toLowerCase(), route });
      return;
    }
    const endScene = session.scene.toLowerCase();
    const movieAfterChoice = ctx.moviesSinceChoice[0] ?? null;
    const sig = dispatchSignature(ctx.condState, interner, abstraction?.dispatchVars ?? new Set());
    const key = `${movieAfterChoice ?? endScene}|${sig.join(",")}`;
    const pathChoices = chainToArray(ctx.choices);
    const pathMovies = chainToArray(ctx.moviesAll);
    let agg = endings.get(key);
    if (!agg) {
      agg = {
        key,
        scene: endScene,
        movieAfterChoice,
        sig,
        moviesCommon: [...new Set(pathMovies)],
        reason,
        paths: 0,
        playthrough: ctx.generation,
        routeFirst: route,
        routeIntersect: new Set(route),
        routeUnion: new Set(),
        choiceAgg: new Map(),
        condAgg: new Map(),
        finalVars: new Map(),
        sample: { route, choices: pathChoices },
      };
      endings.set(key, agg);
      for (const [k, v] of session.vars) agg.finalVars.set(k, v);
    } else {
      agg.playthrough = Math.min(agg.playthrough, ctx.generation);
      const routeSet = new Set(route);
      for (const s of [...agg.routeIntersect]) if (!routeSet.has(s)) agg.routeIntersect.delete(s);
      const played = new Set(pathMovies);
      agg.moviesCommon = agg.moviesCommon.filter((m) => played.has(m));
      for (const [k, v] of agg.finalVars) {
        if (v !== null && session.vars.get(k) !== v) agg.finalVars.set(k, null);
      }
      for (const [k] of session.vars) {
        if (!agg.finalVars.has(k)) agg.finalVars.set(k, null);
      }
    }
    agg.paths += 1;
    for (const s of route) agg.routeUnion.add(s);
    const choiceKeys = new Set<string>();
    for (const c of pathChoices) {
      const e = agg.choiceAgg.get(c.key) ?? { options: new Set<number>(), seenOnPaths: 0, sample: c };
      e.options.add(c.option);
      if (!choiceKeys.has(c.key)) {
        e.seenOnPaths += 1;
        choiceKeys.add(c.key);
      }
      agg.choiceAgg.set(c.key, e);
    }
    for (let id = 0; id < ctx.condState.length && id < interner.keys.length; id++) {
      const bits = ctx.condState[id]!;
      if (bits === 0) continue;
      const k = interner.keys[id]!;
      const e = agg.condAgg.get(k) ?? { true: 0, false: 0, onPaths: 0 };
      // an outcome counts for a path only when it was consistent within it
      if (bits === 1) e.true += 1;
      else if (bits === 2) e.false += 1;
      e.onPaths += 1;
      agg.condAgg.set(k, e);
    }

    // remember this ending's choice script for carry-bootstrap replays
    if (!endingScripts.has(key)) {
      endingScripts.set(key, pathChoices.map((c) => ({ ...c })));
    }

    // chained playthrough: carry the persistent flags into a fresh New Game
    if (persistentVars.size > 0 && ctx.generation < maxPlaythroughs) {
      const carry: [number, number][] = [...session.vars]
        .filter(([k, v]) => persistentVars.has(k) && v !== 0)
        .sort((a, b) => a[0] - b[0]);
      const carryKey = JSON.stringify(carry);
      if (!carriesSeen.has(carryKey)) {
        carriesSeen.add(carryKey);
        const generation = ctx.generation + 1;
        newGames.push({ carry, generation });
        knownCarries.push({ key: carryKey, carry, generation });
        opts.onProgress?.(`new carry (gen ${generation}) after ${key}: ${carryKey}`);
      }
    }
    scheduleBootstraps();
  };

  for (;;) {
    if (sessions >= maxSessions) {
      capped = true;
      break;
    }
    const task = takeNext();
    if (task === undefined) break;
    sessions += 1;
    let session: GameSession;
    if ("carry" in task) {
      ctx = freshCtx(task.generation, task.script ? [...task.script] : []);
      playthroughsExplored = Math.max(playthroughsExplored, task.generation);
      session = await GameSession.start(source, opts.start, sessionOpts);
      for (const [k, v] of task.carry) session.vars.set(k, v);
    } else {
      ctx = task.ctx;
      session = await GameSession.restore(source, structuredClone(task.save), sessionOpts);
      const ev = await session.next(); // re-presents the saved choice
      events += 1;
      if (ev.type !== "choice") {
        anomalies.push({
          reason: `restore did not re-present a choice (${ev.type})`,
          scene: session.scene.toLowerCase(),
          route: session.route.map((s) => s.toLowerCase()),
        });
        continue;
      }
      const { key, enabled } = recordChoicePresented(session.scene.toLowerCase(), ev, ev.state.block);
      const text = enabled.find((o) => o.index === task.option)?.text ?? "?";
      ctx.choices = {
        v: { scene: session.scene.toLowerCase(), key, id: ev.id, option: task.option, text },
        prev: ctx.choices,
      };
      ctx.moviesSinceChoice = [];
      session.choose(task.option);
    }

    // run to the next choice or the end
    run: for (;;) {
      const ev = await session.next();
      events += 1;
      if (ev.type === "dialogue") continue;
      if (ev.type === "choice") {
        const save = session.save();
        const fp = fingerprint(save, abstraction);
        const scripted = ctx.script.length > 0;
        if (seen.has(fp)) {
          // a replay must run through to its ending to produce the carry;
          // for free runs a seen state means the continuation is covered
          if (!scripted) {
            dedupPrunes += 1;
            break run;
          }
        } else {
          seen.add(fp);
          if (seen.size >= maxStates) {
            capped = true;
            break run;
          }
        }
        const scene = session.scene.toLowerCase();
        const { key, enabled } = recordChoicePresented(scene, ev, ev.state.block);
        if (enabled.length === 0) {
          anomalies.push({ reason: "choice with no enabled options", scene, route: [] });
          break run;
        }
        // session.save() returns freshly-built objects, so the branches can
        // share it; restore() clones defensively before use.
        const site = `${scene}:${save.vm.block}:${save.vm.pc}`;
        // scripted replays follow their recorded answer where it still
        // applies (carried flags may surface new choices - take option 0
        // there and keep the rest of the script)
        let take = enabled[0]!;
        if (scripted) {
          const next = ctx.script[0]!;
          if (next.key === key) {
            ctx.script.shift();
            take = enabled.find((o) => o.index === next.option) ?? enabled[0]!;
          }
        }
        for (const o of enabled) {
          if (o.index === take.index) continue;
          const branch = { save, option: o.index, ctx: cloneCtx(ctx), site };
          if (ctx.fromReplay) {
            hot.push(branch);
          } else {
            let list = pending.get(site);
            if (!list) pending.set(site, (list = []));
            list.push(branch);
            lifo.push(branch);
          }
        }
        ctx.choices = {
          v: { scene, key, id: ev.id, option: take.index, text: take.text },
          prev: ctx.choices,
        };
        ctx.moviesSinceChoice = [];
        session.choose(take.index);
        continue;
      }
      // sessionEnd
      recordEnd(session, ev.reason);
      break;
    }
    if (sessions % 500 === 0) {
      opts.onProgress?.(
        `${sessions} sessions, ${seen.size} states, ${pendingCount()} pending, ` +
          `${endings.size} endings, ${scenesVisited.size} scenes, gen ${playthroughsExplored}`,
      );
    }
  }

  // ---- regroup: signatures split by residues of other dispatch registers
  // (the transfer register's last value, the fragment counter). Real ending
  // identity is (terminal scene, movie evidence, the value of the scene's
  // PRIMARY dispatch register - the sig var with the most distinct values
  // among this scene's aggregates). Merge everything else.
  const rawAggs = [...endings.values()];
  // A terminal scene's PRIMARY dispatch register: the var it equality-tests
  // against the most distinct values within its own bytecode (y_ed -> the
  // ending id). Scenes with no >=2-value register (plain epilogues) have
  // none - their signature entries are path residue and merge away.
  const primaryVarByScene = new Map<string, number | null>();
  for (const a of rawAggs) {
    if (primaryVarByScene.has(a.scene)) continue;
    const eq = abstraction?.sceneEqVars.get(a.scene);
    let best: number | null = null;
    let bestCount = 1; // a register needs >= 2 tested values to dispatch
    for (const [v, set] of eq ?? []) {
      if (set.size > bestCount || (set.size === bestCount && best !== null && v > best)) {
        best = v;
        bestCount = set.size;
      }
    }
    primaryVarByScene.set(a.scene, best);
  }
  const mergeKey = (a: EndingAgg): string => {
    const primary = primaryVarByScene.get(a.scene);
    const row = primary != null ? a.sig.find((s) => s.startsWith(`${primary}=`)) : undefined;
    return `${a.scene}|${a.movieAfterChoice ?? ""}|${row ?? ""}`;
  };
  const merged = new Map<string, EndingAgg>();
  for (const a of rawAggs.sort((x, y) => y.paths - x.paths)) {
    const k = mergeKey(a);
    const into = merged.get(k);
    if (!into) {
      merged.set(k, a);
      continue;
    }
    // fold a into the larger aggregate
    into.paths += a.paths;
    into.playthrough = Math.min(into.playthrough, a.playthrough);
    for (const s of [...into.routeIntersect]) if (!a.routeIntersect.has(s)) into.routeIntersect.delete(s);
    for (const s of a.routeUnion) into.routeUnion.add(s);
    const theirs = new Set(a.moviesCommon);
    into.moviesCommon = into.moviesCommon.filter((m) => theirs.has(m));
    into.sig = into.sig.filter((s) => a.sig.includes(s));
    for (const [key2, e] of a.choiceAgg) {
      const mine = into.choiceAgg.get(key2);
      if (!mine) into.choiceAgg.set(key2, e);
      else {
        for (const o of e.options) mine.options.add(o);
        mine.seenOnPaths += e.seenOnPaths;
      }
    }
    for (const [key2, e] of a.condAgg) {
      const mine = into.condAgg.get(key2);
      if (!mine) into.condAgg.set(key2, e);
      else {
        mine.true += e.true;
        mine.false += e.false;
        mine.onPaths += e.onPaths;
      }
    }
    for (const [v, val] of a.finalVars) {
      if (!into.finalVars.has(v)) into.finalVars.set(v, null);
      else if (into.finalVars.get(v) !== val) into.finalVars.set(v, null);
    }
    for (const [v] of into.finalVars) {
      if (!a.finalVars.has(v)) into.finalVars.set(v, null);
    }
  }

  // ---- display names: a movie played on every path of this ending and on
  // no other ending's every-path set names it (staff rolls and shared
  // cutscenes drop out); otherwise the terminal scene, disambiguated by the
  // non-shared dispatch-signature rows.
  const aggs = [...merged.values()];
  const displayId = new Map<EndingAgg, string>();
  const movieOwners = new Map<string, number>();
  for (const a of aggs) for (const m of a.moviesCommon) movieOwners.set(m, (movieOwners.get(m) ?? 0) + 1);
  const byBase = new Map<string, EndingAgg[]>();
  for (const a of aggs) {
    const distinctive = a.moviesCommon.filter((m) => movieOwners.get(m) === 1);
    const base = (distinctive[distinctive.length - 1] ?? a.movieAfterChoice ?? a.scene).toUpperCase();
    displayId.set(a, base);
    const list = byBase.get(base) ?? [];
    list.push(a);
    byBase.set(base, list);
  }
  for (const [base, group] of byBase) {
    if (group.length === 1) continue;
    const shared = new Set(group[0]!.sig.filter((s) => group.every((g) => g.sig.includes(s))));
    for (const g of group) {
      const distinct = g.sig.filter((s) => !shared.has(s));
      displayId.set(g, distinct.length ? `${base}@${distinct.join(",")}` : `${base}@${group.indexOf(g)}`);
    }
  }

  const endingRecords: EndingRecord[] = aggs
    .map((a) => {
      const required: TakenChoice[] = [];
      const free: EndingRecord["freeChoices"] = [];
      for (const [key, e] of a.choiceAgg) {
        if (e.seenOnPaths !== a.paths) continue; // not on every path
        if (e.options.size === 1) {
          required.push({ ...e.sample, key, option: [...e.options][0]! });
        } else {
          free.push({
            key,
            scene: e.sample.scene,
            id: e.sample.id,
            options: [...e.options].sort((x, y) => x - y),
          });
        }
      }
      const conditions: Record<string, boolean> = {};
      for (const [k, e] of a.condAgg) {
        if (e.onPaths !== a.paths) continue;
        if (e.true === a.paths) conditions[k] = true;
        else if (e.false === a.paths) conditions[k] = false;
      }
      const finalVars = [...a.finalVars.entries()]
        .filter((e): e is [number, number] => e[1] !== null)
        .sort((x, y) => x[0] - y[0]);
      const distinctive = a.moviesCommon.filter((m) => movieOwners.get(m) === 1);
      return {
        id: displayId.get(a)!,
        scene: a.scene,
        movie: distinctive[distinctive.length - 1] ?? a.movieAfterChoice,
        reason: a.reason,
        paths: a.paths,
        playthrough: a.playthrough,
        criticalScenes: a.routeFirst.filter((s) => a.routeIntersect.has(s)),
        anyScenes: [...a.routeUnion].sort(),
        requiredChoices: required,
        freeChoices: free,
        conditions,
        finalVars,
        samplePath: a.sample,
      };
    })
    .sort((x, y) => x.id.localeCompare(y.id));

  return {
    format: EXPLORATION_FORMAT,
    version: EXPLORATION_VERSION,
    start: opts.start.toLowerCase(),
    scenesVisited: [...scenesVisited].sort(),
    transitionsObserved: [...transitions.entries()]
      .map(([k, count]) => {
        const [from, to] = k.split(">");
        return { from: from!, to: to!, count };
      })
      .sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to)),
    choicesSeen,
    endings: endingRecords,
    anomalies,
    unknownOps: Object.fromEntries([...unknownOps.entries()].sort()),
    unevaluableJumps: Object.fromEntries([...unevaluable.entries()].sort()),
    persistentVars: [...persistentVars].sort((a, b) => a - b),
    playthroughsExplored,
    stats: {
      sessions,
      statesSeen: seen.size,
      dedupPrunes,
      events,
      capped,
      elapsedMs: now() - t0,
    },
  };
}
