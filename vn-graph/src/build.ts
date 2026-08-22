import type { IrOp, IrScene } from "e17-parser/ir";
import { collectSceneAssets } from "e17-assets/scene-assets";
import { RELATIONS } from "vn-runtime";
import type {
  ChoiceSite,
  ConditionExpr,
  RouteGraphModel,
  SceneNode,
  Transition,
  VarWrite,
} from "./model.js";

/**
 * Static graph construction from the IR.
 *
 * Scene-level transitions come from gotoScene ops. To classify each one
 * (linear / choice / conditional) the builder runs a small intra-scene
 * analysis: blocks are split into segments at choice ops, a label closure
 * tracks which choice options can reach each segment, and a guard pass finds
 * segments whose only entries are a single varJump condition.
 *
 * The classification is display-oriented and conservative - runtime traces
 * (the explorer) remain the source of truth for what actually happens.
 */

/** A choice-option dispatch row inside a scene (used for ending inference). */
export interface DispatchRow {
  condition: ConditionExpr;
  target: string;
  /** First movie on the unique forward chain from the target, when any. */
  movie: string | null;
  /** The chain reaches an in-scene termination without further branching. */
  terminates: boolean;
}

export interface SceneAnalysis {
  node: SceneNode;
  /** gotoScene sites with classification inputs resolved. */
  transitions: Transition[];
  /** Reachable == dispatch rows with their movie/termination binding. */
  dispatch: DispatchRow[];
  /** Every scene referenced by a gotoScene, including unreachable sites
   * (dead references still matter for the missing-scene diagnostic). */
  referencedScenes: string[];
}

interface Segment {
  block: string;
  seg: number;
  ops: IrOp[];
  /** Writes accumulated from the block start up to each op index. */
  labels: Set<string>;
  guard: ConditionExpr | null;
  /** Inbound edges, for guard propagation. */
  inbound: { from: SegKey; kind: "plain" | "cond" | "choice"; cond?: ConditionExpr }[];
  reachable: boolean;
}

type SegKey = string; // `${block}#${seg}`

function relText(rel: number): string {
  return RELATIONS[rel]?.name ?? `rel${rel.toString(16)}`;
}

function condExpr(op: Extract<IrOp, { op: "varJump" }>): ConditionExpr | null {
  const c = op.condition;
  if (c.type !== "varCompare" || c.value.type !== "const") return null;
  const rel = relText(c.rel);
  return { varId: c.varId, rel, value: c.value.value, text: `var${c.varId} ${rel} ${c.value.value}` };
}

function sameCond(a: ConditionExpr, b: ConditionExpr): boolean {
  return a.varId === b.varId && a.rel === b.rel && a.value === b.value;
}

export function analyzeScene(scene: IrScene): SceneAnalysis {
  const name = scene.scene.toLowerCase();
  const blockLabels = Object.keys(scene.blocks).sort();

  // ---- split blocks into segments at choice ops
  const segments = new Map<SegKey, Segment>();
  const segKey = (block: string, seg: number): SegKey => `${block}#${seg}`;
  for (const label of blockLabels) {
    const ops = scene.blocks[label]!.ops;
    let seg = 0;
    let start = 0;
    const cut = (end: number): void => {
      segments.set(segKey(label, seg), {
        block: label,
        seg,
        ops: ops.slice(start, end),
        labels: new Set(),
        guard: null,
        inbound: [],
        reachable: false,
      });
    };
    for (let i = 0; i < ops.length; i++) {
      if (ops[i]!.op === "choice") {
        cut(i + 1); // segment includes its trailing choice op
        seg += 1;
        start = i + 1;
      }
    }
    cut(ops.length);
  }

  // ---- CFG edges between segments
  interface SegEdge {
    from: SegKey;
    to: SegKey;
    kind: "plain" | "cond" | "choice";
    cond?: ConditionExpr;
    /** For choice edges: which options flow here. */
    options?: { key: string; index: number }[];
  }
  const edges: SegEdge[] = [];
  const choiceSites: ChoiceSite[] = [];
  interface GotoSite {
    at: SegKey;
    block: string;
    to: string;
    writes: VarWrite[];
  }
  const gotoSites: GotoSite[] = [];
  /** Segments whose flow can run off the end of a next-less block. */
  const terminationSites: SegKey[] = [];
  const movies = new Set<string>();
  let lines = 0;
  const sceneIds: number[] = [];
  const headDispatch: string[] = [];
  let sawDialogue = false;

  for (const label of blockLabels) {
    const block = scene.blocks[label]!;
    let seg = 0;
    let flowAlive = true;
    const writes: VarWrite[] = [];
    for (const op of block.ops) {
      switch (op.op) {
        case "dialogue":
          lines += 1;
          sawDialogue = true;
          break;
        case "sceneMarker":
          sceneIds.push(op.id);
          break;
        case "playMovie":
          movies.add(op.asset.toLowerCase());
          break;
        case "varSet":
          if (op.value.type === "const") {
            writes.push({
              varId: op.varId,
              value: op.value.value,
              mod: op.mod === 0x17 ? "add" : "assign",
            });
          }
          break;
        case "varJump": {
          if (!flowAlive) break;
          if (!sawDialogue) {
            const c = condExpr(op);
            headDispatch.push(`${c?.text ?? "?"} -> ${op.target}`);
          }
          const c = condExpr(op);
          edges.push({
            from: segKey(label, seg),
            to: segKey(op.target, 0),
            kind: c ? "cond" : "plain",
            ...(c ? { cond: c } : {}),
          });
          break;
        }
        case "gotoBlock":
          if (!flowAlive) break;
          edges.push({ from: segKey(label, seg), to: segKey(op.target, 0), kind: "plain" });
          flowAlive = false;
          break;
        case "gotoScene":
          if (!flowAlive) break;
          gotoSites.push({
            at: segKey(label, seg),
            block: label,
            to: op.scene.toLowerCase(),
            writes: [...writes],
          });
          flowAlive = false;
          break;
        case "choice": {
          if (!flowAlive) break;
          const key = `${name}:${op.id ?? `b${label}`}`;
          choiceSites.push({
            key,
            scene: name,
            id: op.id,
            block: label,
            options: op.options.map((o) => ({
              index: o.index,
              text: o.text,
              conditioned: o.condition !== undefined,
            })),
          });
          const fallthroughOptions: { key: string; index: number }[] = [];
          for (const o of op.options) {
            if (o.target && o.target !== "?") {
              edges.push({
                from: segKey(label, seg),
                to: segKey(o.target, 0),
                kind: "choice",
                options: [{ key, index: o.index }],
              });
            } else {
              fallthroughOptions.push({ key, index: o.index });
            }
          }
          // flow continues inline only for options without a dispatch row
          const next = segKey(label, seg + 1);
          if (fallthroughOptions.length > 0) {
            edges.push({ from: segKey(label, seg), to: next, kind: "choice", options: fallthroughOptions });
          }
          seg += 1;
          flowAlive = fallthroughOptions.length > 0;
          break;
        }
        default:
          break;
      }
    }
    if (flowAlive) {
      const next = scene.blocks[label]!.next;
      if (next && scene.blocks[next]) {
        edges.push({ from: segKey(label, seg), to: segKey(next, 0), kind: "plain" });
      } else {
        terminationSites.push(segKey(label, seg));
      }
    }
  }

  // ---- reachability + label closure (labels only ever grow -> fixpoint)
  const entryKey = segKey(scene.blocks[scene.entry] ? scene.entry : blockLabels[0]!, 0);
  const entrySeg = segments.get(entryKey);
  if (entrySeg) {
    entrySeg.reachable = true;
    entrySeg.labels.add("entry");
  }
  const bySource = new Map<SegKey, SegEdge[]>();
  for (const e of edges) {
    const list = bySource.get(e.from) ?? [];
    list.push(e);
    bySource.set(e.from, list);
    segments.get(e.to)?.inbound.push({
      from: e.from,
      kind: e.kind,
      ...(e.cond ? { cond: e.cond } : {}),
    });
  }
  for (let changed = true, guard = 0; changed && guard < 200; guard++) {
    changed = false;
    for (const e of edges) {
      const from = segments.get(e.from);
      const to = segments.get(e.to);
      if (!from?.reachable || !to) continue;
      if (!to.reachable) {
        to.reachable = true;
        changed = true;
      }
      const add = (l: string): void => {
        if (!to.labels.has(l)) {
          to.labels.add(l);
          changed = true;
        }
      };
      if (e.kind === "choice") for (const o of e.options ?? []) add(`${o.key}#${o.index}`);
      else for (const l of from.labels) add(l);
    }
  }

  // ---- guard propagation: a segment guarded by one condition, through
  // single-inbound plain chains
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const s of segments.values()) {
      if (s.guard || !s.reachable) continue;
      const inbound = s.inbound.filter((i) => segments.get(i.from)?.reachable);
      if (inbound.length === 0) continue;
      const conds = inbound.map((i) =>
        i.kind === "cond" ? (i.cond ?? null) : i.kind === "plain" ? (segments.get(i.from)?.guard ?? null) : null,
      );
      const first = conds[0];
      if (first && conds.every((c) => c && sameCond(c, first))) {
        s.guard = first;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // ---- classify gotoScene sites
  const transitions: Transition[] = [];
  for (const site of gotoSites) {
    const s = segments.get(site.at);
    if (!s || !s.reachable) continue; // unreachable code
    let type: Transition["type"] = "linear";
    let choice: Transition["choice"] | undefined;
    let condition: ConditionExpr | undefined;
    const labels = [...s.labels];
    const optionLabels = labels.filter((l) => l !== "entry");
    if (labels.length > 0 && !s.labels.has("entry")) {
      const parsed = optionLabels.map((l) => {
        const at = l.lastIndexOf("#");
        return { key: l.slice(0, at), index: Number(l.slice(at + 1)) };
      });
      const keys = new Set(parsed.map((p) => p.key));
      const indices = new Set(parsed.map((p) => p.index));
      if (keys.size === 1 && indices.size === 1) {
        const p = parsed[0]!;
        const siteInfo = choiceSites.find((c) => c.key === p.key);
        const text = siteInfo?.options.find((o) => o.index === p.index)?.text;
        choice = { id: siteInfo?.id ?? null, option: p.index, ...(text !== undefined ? { text } : {}) };
        type = "choice";
      }
    }
    if (type === "linear" && s.guard) {
      condition = s.guard;
      type = "conditional";
    }
    transitions.push({
      from: name,
      to: site.to,
      type,
      block: site.block,
      writes: site.writes,
      ...(condition ? { condition } : {}),
      ...(choice ? { choice } : {}),
      observedBy: [],
    });
  }

  // ---- dispatch rows: reachable == comparisons, with movie/termination
  // binding via the unique forward chain from the row's target
  const dispatch: DispatchRow[] = [];
  for (const e of edges) {
    if (e.kind !== "cond" || !e.cond || e.cond.rel !== "==") continue;
    if (!segments.get(e.from)?.reachable) continue;
    let movie: string | null = null;
    let terminates = false;
    let cursor: SegKey | null = e.to;
    const visited = new Set<SegKey>();
    for (let depth = 0; cursor && depth < 64; depth++) {
      if (visited.has(cursor)) break;
      visited.add(cursor);
      const s = segments.get(cursor);
      if (!s) break;
      if (!movie) {
        const m = s.ops.find((o) => o.op === "playMovie");
        if (m && m.op === "playMovie") movie = m.asset.toLowerCase();
      }
      if (terminationSites.includes(cursor)) {
        terminates = true;
        break;
      }
      const here: SegEdge[] = bySource.get(cursor) ?? [];
      const out = here.filter((x) => x.kind === "plain");
      const branching = here.some((x) => x.kind !== "plain");
      const exits = gotoSites.some((g) => g.at === cursor);
      cursor = !branching && !exits && out.length === 1 ? out[0]!.to : null;
    }
    dispatch.push({ condition: e.cond, target: e.to.split("#")[0]!, movie, terminates });
  }

  const reachableTermination = terminationSites.some((k) => segments.get(k)?.reachable);
  const assets = [...new Set(collectSceneAssets(scene).map((a) => a.name.toLowerCase()))].sort();

  const node: SceneNode = {
    id: name,
    outgoing: [],
    incoming: [],
    lines,
    blocks: blockLabels.length,
    choices: choiceSites,
    sceneIds,
    terminal: transitions.length === 0,
    canEnd: reachableTermination,
    movies: [...movies].sort(),
    headDispatch,
    assets,
  };
  return { node, transitions, dispatch, referencedScenes: gotoSites.map((g) => g.to) };
}

/** Build the full static model over an IR scene set. */
export function buildGraphModel(scenes: Map<string, IrScene>, start: string): RouteGraphModel {
  const nodes = new Map<string, SceneNode>();
  const transitions: Transition[] = [];
  const dispatchByScene = new Map<string, DispatchRow[]>();
  const missing = new Set<string>();
  const inbound = new Set<string>();

  const names = [...scenes.keys()].sort();
  for (const key of names) {
    const scene = scenes.get(key)!;
    const a = analyzeScene(scene);
    nodes.set(a.node.id, a.node);
    dispatchByScene.set(a.node.id, a.dispatch);
    for (const r of a.referencedScenes) if (!scenes.has(r)) missing.add(r);
    for (const t of a.transitions) {
      transitions.push(t);
      a.node.outgoing.push(t);
      inbound.add(t.to);
    }
  }
  for (const t of transitions) nodes.get(t.to)?.incoming.push(t);

  // ---- ending inference (static): a transition is route-committing when its
  // writes assign a var that the target scene's dispatch rows compare
  for (const t of transitions) {
    const rows = dispatchByScene.get(t.to) ?? [];
    const commits = t.writes.some(
      (w) => w.mod === "assign" && rows.some((r) => r.condition.varId === w.varId && r.condition.value === w.value),
    );
    const target = nodes.get(t.to);
    if (commits && target?.canEnd) t.type = "ending";
  }

  const startLc = start.toLowerCase();
  const reachable = new Set<string>();
  const queue = [startLc];
  while (queue.length) {
    const n = queue.pop()!;
    if (reachable.has(n) || !nodes.has(n)) continue;
    reachable.add(n);
    for (const t of nodes.get(n)!.outgoing) queue.push(t.to);
  }

  // constant assignments per var across the corpus, keyed "var=value" -
  // a dispatch row is an ending candidate when something actually assigns
  // the value it tests (the ending register written by the route scenes)
  const assignedValues = new Set<string>();
  for (const scene of scenes.values()) {
    for (const block of Object.values(scene.blocks)) {
      for (const op of block.ops) {
        if (op.op === "varSet" && op.mod === 0x14 && op.value.type === "const") {
          assignedValues.add(`${op.varId}=${op.value.value}`);
        }
      }
    }
  }

  const endings = inferStaticEndings(nodes, dispatchByScene, assignedValues);

  const allAssets = new Set<string>();
  for (const n of nodes.values()) for (const a of n.assets ?? []) allAssets.add(a);
  const totals = {
    scenes: nodes.size,
    reachableScenes: reachable.size,
    choiceSites: [...nodes.values()].reduce((s, n) => s + n.choices.length, 0),
    choiceOptions: [...nodes.values()].reduce(
      (s, n) => s + n.choices.reduce((x, c) => x + c.options.length, 0),
      0,
    ),
    assets: allAssets.size,
    endings: endings.length,
  };

  return {
    start: startLc,
    nodes,
    transitions,
    missingScenes: [...missing].sort(),
    unreferenced: names.filter((n) => n !== startLc && !inbound.has(n)).sort(),
    endings,
    totals,
  };
}

/**
 * Static ending candidates. A scene "can end" when a reachable path runs off
 * a next-less block. Distinct endings inside such a scene are separated by
 * its dispatch rows: each == row testing a (var, value) pair that something
 * in the corpus actually assigns is one candidate, with the movie found on
 * its chain as the distinctive id. A canEnd scene without such rows is one
 * candidate.
 */
function inferStaticEndings(
  nodes: Map<string, SceneNode>,
  dispatchByScene: Map<string, DispatchRow[]>,
  assignedValues: ReadonlySet<string>,
): import("./model.js").EndingInfo[] {
  const endings: import("./model.js").EndingInfo[] = [];
  const usedIds = new Map<string, number>();
  const mkId = (base: string): string => {
    const n = usedIds.get(base) ?? 0;
    usedIds.set(base, n + 1);
    return n === 0 ? base : `${base}#${n + 1}`;
  };

  for (const [id, node] of nodes) {
    if (!node.canEnd) continue;
    const rows = (dispatchByScene.get(id) ?? []).filter((r) =>
      assignedValues.has(`${r.condition.varId}=${r.condition.value}`),
    );
    if (rows.length > 0) {
      for (const r of rows) {
        endings.push({
          id: mkId((r.movie ?? id).toUpperCase()),
          scene: id,
          movie: r.movie,
          conditions: [r.condition],
          evidence: "static",
        });
      }
    } else {
      endings.push({ id: mkId(id.toUpperCase()), scene: id, movie: null, conditions: [], evidence: "static" });
    }
  }
  return endings.sort((a, b) => a.id.localeCompare(b.id));
}
