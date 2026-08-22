import type { RouteGraphJson } from "./model.js";

/**
 * Automatic layered graph layout (a light Sugiyama): rank by longest path
 * from the start scene (back-edges ignored), order layers by neighbour
 * barycenter, then assign fixed-grid coordinates. Deterministic - no
 * randomness, stable sorts only. Browser-safe.
 */

export const NODE_W = 118;
export const NODE_H = 36;
const COL_GAP = 84;
const ROW_GAP = 18;

export interface LayoutResult {
  positions: Record<string, { x: number; y: number }>;
  width: number;
  height: number;
  layers: string[][];
}

export function layoutGraph(json: RouteGraphJson): LayoutResult {
  const ids = json.nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  for (const id of ids) {
    out.set(id, []);
    inn.set(id, []);
  }
  for (const t of json.transitions) {
    if (!idSet.has(t.from) || !idSet.has(t.to)) continue;
    if (!out.get(t.from)!.includes(t.to)) out.get(t.from)!.push(t.to);
    if (!inn.get(t.to)!.includes(t.from)) inn.get(t.to)!.push(t.from);
  }

  // ---- DFS from start: spot back-edges so layering sees a DAG
  const backEdges = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>(); // unvisited / on stack / done
  const dfs = (n: string): void => {
    state.set(n, 1);
    for (const m of out.get(n) ?? []) {
      const s = state.get(m) ?? 0;
      if (s === 1) backEdges.add(`${n}>${m}`);
      else if (s === 0) dfs(m);
    }
    state.set(n, 2);
  };
  if (idSet.has(json.start)) dfs(json.start);
  for (const id of ids) if ((state.get(id) ?? 0) === 0) dfs(id);

  // ---- longest-path layering over the DAG edges
  const layerOf = new Map<string, number>();
  const indeg = new Map<string, number>();
  for (const id of ids) indeg.set(id, 0);
  for (const t of json.transitions) {
    if (!idSet.has(t.from) || !idSet.has(t.to)) continue;
    if (backEdges.has(`${t.from}>${t.to}`)) continue;
    indeg.set(t.to, (indeg.get(t.to) ?? 0) + 1);
  }
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0).sort();
  for (const id of queue) layerOf.set(id, 0);
  // Kahn order, taking the longest inbound path
  const dagOut = (n: string): string[] =>
    (out.get(n) ?? []).filter((m) => !backEdges.has(`${n}>${m}`));
  while (queue.length) {
    const n = queue.shift()!;
    for (const m of dagOut(n)) {
      layerOf.set(m, Math.max(layerOf.get(m) ?? 0, (layerOf.get(n) ?? 0) + 1));
      indeg.set(m, (indeg.get(m) ?? 1) - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
  }
  for (const id of ids) if (!layerOf.has(id)) layerOf.set(id, 0);

  const maxLayer = Math.max(0, ...layerOf.values());
  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const id of [...ids].sort()) layers[layerOf.get(id)!]!.push(id);

  // ---- barycenter ordering sweeps
  const pos = new Map<string, number>();
  const reindex = (): void => {
    for (const layer of layers) layer.forEach((id, i) => pos.set(id, i));
  };
  reindex();
  const sweep = (direction: 1 | -1): void => {
    const order = direction === 1 ? layers : [...layers].reverse();
    for (const layer of order) {
      const scored = layer.map((id) => {
        const neigh = direction === 1 ? (inn.get(id) ?? []) : (out.get(id) ?? []);
        const xs = neigh.map((m) => pos.get(m) ?? 0);
        const bary = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : (pos.get(id) ?? 0);
        return { id, bary };
      });
      scored.sort((a, b) => a.bary - b.bary || a.id.localeCompare(b.id));
      layer.splice(0, layer.length, ...scored.map((s) => s.id));
      reindex();
    }
  };
  for (let i = 0; i < 4; i++) {
    sweep(1);
    sweep(-1);
  }

  // ---- coordinates
  const tallest = Math.max(1, ...layers.map((l) => l.length));
  const height = tallest * (NODE_H + ROW_GAP) + ROW_GAP;
  const positions: Record<string, { x: number; y: number }> = {};
  layers.forEach((layer, li) => {
    const x = 40 + li * (NODE_W + COL_GAP);
    const total = layer.length * (NODE_H + ROW_GAP);
    const y0 = (height - total) / 2 + ROW_GAP / 2;
    layer.forEach((id, i) => {
      positions[id] = { x, y: y0 + i * (NODE_H + ROW_GAP) };
    });
  });
  const width = 80 + (maxLayer + 1) * (NODE_W + COL_GAP);
  return { positions, width, height, layers };
}
