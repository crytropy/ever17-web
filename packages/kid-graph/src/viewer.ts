import type { RouteGraphJson, Transition } from "./model.js";
import { layoutGraph, NODE_H, NODE_W, type LayoutResult } from "./layout.js";

/**
 * Interactive SVG route-graph viewer: zoom (wheel), pan (drag), node click.
 * Pure DOM - shared by the standalone `vn graph --format html` export and the
 * web client's /routes page. Consumes graph JSON only.
 */

export interface ViewerCompletion {
  scenes: ReadonlySet<string>;
  endings: ReadonlySet<string>;
}

export interface ViewerOptions {
  completion?: ViewerCompletion | null;
  onSelect?: (sceneId: string | null) => void;
}

export interface GraphViewer {
  select(sceneId: string | null): void;
  refresh(completion: ViewerCompletion | null): void;
  readonly layout: LayoutResult;
}

const EDGE_COLORS: Record<Transition["type"], string> = {
  linear: "#64748b",
  choice: "#3b82f6",
  conditional: "#d97706",
  ending: "#dc2626",
};

const SVG = "http://www.w3.org/2000/svg";

export function renderGraphViewer(
  container: HTMLElement,
  json: RouteGraphJson,
  opts: ViewerOptions = {},
): GraphViewer {
  const layout = layoutGraph(json);
  const endingScenes = new Set(json.endings.map((e) => e.scene));

  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.style.display = "block";
  svg.style.cursor = "grab";
  const viewport = document.createElementNS(SVG, "g");
  svg.appendChild(viewport);

  const defs = document.createElementNS(SVG, "defs");
  defs.innerHTML = `<marker id="vg-arrow" viewBox="0 0 8 8" refX="7" refY="4"
      markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L8,4 L0,8 z" fill="context-stroke"/></marker>`;
  svg.appendChild(defs);

  const edgeLayer = document.createElementNS(SVG, "g");
  const nodeLayer = document.createElementNS(SVG, "g");
  viewport.appendChild(edgeLayer);
  viewport.appendChild(nodeLayer);

  const nodeEls = new Map<string, SVGGElement>();
  const edgeEls: { el: SVGPathElement; t: Transition }[] = [];

  const anchor = (id: string): { x: number; y: number } | null => {
    const p = layout.positions[id];
    return p ? { x: p.x, y: p.y } : null;
  };

  for (const t of json.transitions) {
    const a = anchor(t.from);
    const b = anchor(t.to);
    if (!a || !b) continue;
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    const el = document.createElementNS(SVG, "path");
    let d: string;
    if (x2 > x1) {
      const mx = (x1 + x2) / 2;
      d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    } else {
      // back-edge: arc around
      const drop = Math.max(y1, y2) + NODE_H * 1.6;
      d = `M${x1},${y1} C${x1 + 60},${drop} ${x2 - 60},${drop} ${x2},${y2}`;
    }
    el.setAttribute("d", d);
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", EDGE_COLORS[t.type]);
    el.setAttribute("stroke-width", t.observedBy.length > 0 ? "2" : "1.1");
    if (t.observedBy.length === 0) el.setAttribute("stroke-dasharray", "5 4");
    el.setAttribute("marker-end", "url(#vg-arrow)");
    el.setAttribute("opacity", "0.75");
    edgeLayer.appendChild(el);
    edgeEls.push({ el, t });
  }

  for (const n of json.nodes) {
    const p = layout.positions[n.id];
    if (!p) continue;
    const g = document.createElementNS(SVG, "g");
    g.setAttribute("transform", `translate(${p.x},${p.y})`);
    g.style.cursor = "pointer";
    const rect = document.createElementNS(SVG, "rect");
    rect.setAttribute("width", String(NODE_W));
    rect.setAttribute("height", String(NODE_H));
    rect.setAttribute("rx", "7");
    const isStart = n.id === json.start;
    const isEnding = endingScenes.has(n.id) || n.terminal;
    rect.setAttribute("fill", isStart ? "#14532d" : isEnding ? "#450a0a" : "#111a33");
    rect.setAttribute("stroke", isStart ? "#4ade80" : isEnding ? "#f87171" : "#3b4a6b");
    rect.setAttribute("stroke-width", "1.2");
    const label = document.createElementNS(SVG, "text");
    label.textContent = n.id;
    label.setAttribute("x", String(NODE_W / 2));
    label.setAttribute("y", "16");
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("fill", "#dbe4ff");
    label.setAttribute("font-size", "13");
    label.setAttribute("font-family", "monospace");
    const sub = document.createElementNS(SVG, "text");
    sub.textContent = `${n.lines} ln${n.choices.length ? ` · ${n.choices.length} ch` : ""}`;
    sub.setAttribute("x", String(NODE_W / 2));
    sub.setAttribute("y", "29");
    sub.setAttribute("text-anchor", "middle");
    sub.setAttribute("fill", "#8093b8");
    sub.setAttribute("font-size", "9");
    sub.setAttribute("font-family", "monospace");
    g.appendChild(rect);
    g.appendChild(label);
    g.appendChild(sub);
    g.addEventListener("click", (e) => {
      e.stopPropagation();
      select(n.id);
      opts.onSelect?.(n.id);
    });
    nodeLayer.appendChild(g);
    nodeEls.set(n.id, g);
  }

  // ---- pan/zoom; start legible: fit the height, never microscopic
  let scale = Math.max(
    0.35,
    Math.min(1, (container.clientHeight || 700) / layout.height, (container.clientWidth || 1200) / layout.width),
  );
  let tx = 10;
  let ty = 10;
  const applyTransform = (): void => {
    viewport.setAttribute("transform", `translate(${tx},${ty}) scale(${scale})`);
  };
  applyTransform();
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const ns = Math.min(4, Math.max(0.05, scale * factor));
    tx = mx - ((mx - tx) / scale) * ns;
    ty = my - ((my - ty) / scale) * ns;
    scale = ns;
    applyTransform();
  }, { passive: false });
  let dragging: { x: number; y: number } | null = null;
  svg.addEventListener("pointerdown", (e) => {
    dragging = { x: e.clientX - tx, y: e.clientY - ty };
    svg.setPointerCapture(e.pointerId);
    svg.style.cursor = "grabbing";
  });
  svg.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    tx = e.clientX - dragging.x;
    ty = e.clientY - dragging.y;
    applyTransform();
  });
  svg.addEventListener("pointerup", () => {
    dragging = null;
    svg.style.cursor = "grab";
  });
  svg.addEventListener("click", () => {
    select(null);
    opts.onSelect?.(null);
  });

  let selected: string | null = null;
  const select = (id: string | null): void => {
    if (selected) {
      nodeEls.get(selected)?.querySelector("rect")?.setAttribute("stroke-width", "1.2");
    }
    selected = id;
    if (id) nodeEls.get(id)?.querySelector("rect")?.setAttribute("stroke-width", "3");
  };

  const refresh = (completion: ViewerCompletion | null): void => {
    for (const [id, g] of nodeEls) {
      const visited = !completion || completion.scenes.has(id);
      g.setAttribute("opacity", visited ? "1" : "0.28");
    }
    for (const { el, t } of edgeEls) {
      const lit = !completion || (completion.scenes.has(t.from) && completion.scenes.has(t.to));
      el.setAttribute("opacity", lit ? "0.75" : "0.18");
    }
  };
  refresh(opts.completion ?? null);

  container.appendChild(svg);
  return { select, refresh, layout };
}
