import type { IrOp, IrScene } from "./types.js";
import type { SceneSource } from "./session.js";
import { SessionRunner } from "./session.js";

/**
 * Route-graph generation: a scene-level map of the whole scenario, built by
 * static analysis of the IR plus optional dynamic traversal coverage.
 * Purely data-driven - nodes and edges come from the IR, never from names.
 */

export interface RouteEdge {
  from: string;
  to: string;
  /** Block label of the gotoScene op. */
  block: string;
  /** varSet writes in the same block before the transition (transfer state). */
  writes: { varId: number; value: number }[];
  /** Observed during dynamic traversal (which policies took it). */
  observedBy: string[];
}

export interface RouteNode {
  scene: string;
  lines: number;
  blocks: number;
  choices: { id: number | null; options: number }[];
  /** Scene ids from 10 24 markers. */
  sceneIds: number[];
  /** No outgoing transitions: a terminal (ending) scene. */
  terminal: boolean;
  /** Head dispatch rows: varJump conditions in the entry region (resume points). */
  headDispatch: string[];
}

export interface RouteGraph {
  nodes: Record<string, RouteNode>;
  edges: RouteEdge[];
  /** Scenes referenced by a transition but absent from the IR set. */
  missingScenes: string[];
  /** Scenes with no inbound edge and not the start scene. */
  unreferenced: string[];
  start: string;
  /** Dynamic traversal summaries, keyed by policy label. */
  traversals: Record<string, { route: string[]; end: string }>;
}

function condText(op: Extract<IrOp, { op: "varJump" }>): string {
  const c = op.condition;
  if (c.type === "varCompare") {
    const rel = { 0x0c: "==", 0x0d: "!=", 0x10: ">=", 0x11: ">", 0x0f: "<=" }[c.rel] ?? `rel${c.rel.toString(16)}`;
    return `var${c.varId} ${rel} ${c.value.type === "const" ? c.value.value : "?"}`;
  }
  if (c.type === "sysVarTest") return `sys${c.varId} != 0`;
  return c.raw;
}

export function buildRouteGraph(
  scenes: Map<string, IrScene>,
  start: string,
  traversalPolicies: { label: string; run: () => { route: string[]; end: string } }[] = [],
): RouteGraph {
  const nodes: Record<string, RouteNode> = {};
  const edges: RouteEdge[] = [];
  const missing = new Set<string>();
  const inbound = new Set<string>();

  for (const [name, scene] of scenes) {
    let lines = 0;
    const choices: RouteNode["choices"] = [];
    const sceneIds: number[] = [];
    const headDispatch: string[] = [];
    let sawDialogue = false;
    let terminal = true;

    const blockLabels = Object.keys(scene.blocks).sort();
    for (const label of blockLabels) {
      const block = scene.blocks[label]!;
      const writes: { varId: number; value: number }[] = [];
      for (const op of block.ops) {
        switch (op.op) {
          case "dialogue":
            lines += 1;
            sawDialogue = true;
            break;
          case "choice":
            choices.push({ id: op.id, options: op.options.length });
            break;
          case "sceneMarker":
            sceneIds.push(op.id);
            break;
          case "varSet":
            if (op.value.type === "const") writes.push({ varId: op.varId, value: op.value.value });
            break;
          case "varJump":
            // head dispatch: jumps before any dialogue has played
            if (!sawDialogue) headDispatch.push(`${condText(op)} -> ${op.target}`);
            break;
          case "gotoScene": {
            terminal = false;
            const to = op.scene.toLowerCase();
            edges.push({
              from: name,
              to,
              block: label,
              writes: [...writes],
              observedBy: [],
            });
            if (!scenes.has(to)) missing.add(to);
            inbound.add(to);
            break;
          }
          default:
            break;
        }
      }
    }
    nodes[name] = {
      scene: name,
      lines,
      blocks: blockLabels.length,
      choices,
      sceneIds,
      terminal,
      headDispatch,
    };
  }

  const traversals: RouteGraph["traversals"] = {};
  for (const p of traversalPolicies) {
    const r = p.run();
    traversals[p.label] = r;
    for (let i = 0; i + 1 < r.route.length; i++) {
      const from = r.route[i]!.toLowerCase();
      const to = r.route[i + 1]!.toLowerCase();
      for (const e of edges) {
        if (e.from === from && e.to === to && !e.observedBy.includes(p.label)) {
          e.observedBy.push(p.label);
        }
      }
    }
  }

  const unreferenced = [...scenes.keys()].filter((n) => n !== start && !inbound.has(n)).sort();
  return {
    nodes,
    edges,
    missingScenes: [...missing].sort(),
    unreferenced,
    start,
    traversals,
  };
}

/** Standard dynamic policies over a SceneSource. */
export function standardTraversals(source: SceneSource, start: string) {
  const mk = (label: string, policy: "first" | "last", extra: Record<string, number> = {}) => ({
    label,
    run: () => {
      const r = new SessionRunner(source, { policy, choiceByScene: extra }).run(start);
      return { route: r.route, end: `${r.end}:${r.scenes[r.scenes.length - 1]?.scene ?? "?"}` };
    },
  });
  return [
    mk("first", "first"),
    mk("last", "last"),
    mk("first-kid", "first", { [`${start.toLowerCase()}:7`]: 1 }),
    mk("last-kid", "last", { [`${start.toLowerCase()}:7`]: 1 }),
  ];
}

/** Graphviz DOT rendering of the graph. */
export function toDot(g: RouteGraph): string {
  const esc = (s: string): string => s.replace(/"/g, '\\"');
  const lines: string[] = [
    "digraph route {",
    "  rankdir=LR;",
    '  node [shape=box, style="rounded,filled", fillcolor="#eef2ff", fontname="monospace"];',
  ];
  for (const n of Object.values(g.nodes)) {
    const attrs: string[] = [];
    const label = `${n.scene}\\n${n.lines} lines` + (n.choices.length ? `, ${n.choices.length} ch` : "");
    attrs.push(`label="${esc(label)}"`);
    if (n.terminal) attrs.push('fillcolor="#ffe4e6"');
    if (n.scene === g.start) attrs.push('fillcolor="#dcfce7"');
    lines.push(`  "${esc(n.scene)}" [${attrs.join(", ")}];`);
  }
  for (const e of g.edges) {
    const observed = e.observedBy.length > 0;
    const wr = e.writes
      .filter((w) => w.varId === 1203 || w.varId === 1223)
      .map((w) => `${w.varId}=${w.value}`)
      .join(",");
    const attrs: string[] = [];
    if (wr) attrs.push(`label="${esc(wr)}"`);
    attrs.push(observed ? "color=\"#16a34a\", penwidth=2" : 'color="#94a3b8"');
    lines.push(`  "${esc(e.from)}" -> "${esc(e.to)}" [${attrs.join(", ")}];`);
  }
  lines.push("}");
  return lines.join("\n");
}
