import type { RouteGraphJson } from "./model.js";
import { renderGraphViewer } from "./viewer.js";

/**
 * Entry point for the standalone HTML export (`vn graph --format html`).
 * The graph JSON is embedded in the page as window.__GRAPH__; everything else
 * (layout, rendering, interaction) is this bundle.
 */

declare global {
  interface Window {
    __GRAPH__: RouteGraphJson;
  }
}

const json = window.__GRAPH__;
const app = document.getElementById("app")!;
const panel = document.getElementById("panel")!;
const stats = document.getElementById("stats")!;

const observed = json.transitions.filter((t) => t.observedBy.length > 0).length;
stats.textContent =
  `${json.nodes.length} scenes · ${json.transitions.length} transitions ` +
  `(${observed} observed) · ${json.endings.length} endings · start: ${json.start}`;

const viewer = renderGraphViewer(app, json, {
  onSelect: (id) => {
    if (!id) {
      panel.classList.add("hidden");
      return;
    }
    const n = json.nodes.find((x) => x.id === id);
    if (!n) return;
    const endings = json.endings.filter((e) => e.scene === id && !e.note);
    const rows: string[] = [];
    rows.push(`<h2>${id}</h2>`);
    rows.push(`<div class="kv">${n.lines} lines · ${n.blocks} blocks` +
      `${n.terminal ? " · terminal" : ""}${n.canEnd ? " · can end the game" : ""}</div>`);
    if (n.choices.length) {
      rows.push(`<h3>choices</h3>`);
      for (const c of n.choices) {
        rows.push(`<div class="kv">#${c.id ?? "?"} — ${c.options.length} options</div>`);
        for (const o of c.options) rows.push(`<div class="opt">[${o.index}] ${escapeHtml(o.text)}</div>`);
      }
    }
    const out = n.outgoing.map((i) => json.transitions[i]!);
    if (out.length) {
      rows.push(`<h3>transitions out</h3>`);
      for (const t of out) {
        const extra =
          t.type === "choice" && t.choice ? ` (choice ${t.choice.id ?? "?"} → option ${t.choice.option})` :
          t.type === "conditional" && t.condition ? ` (${t.condition.text})` :
          t.type === "ending" ? ` (${t.writes.filter((w) => w.mod === "assign").map((w) => `${w.varId}=${w.value}`).join(", ")})` : "";
        rows.push(`<div class="edge ${t.type}">${t.type} → <b>${t.to}</b>${extra}</div>`);
      }
    }
    if (endings.length) {
      rows.push(`<h3>endings here</h3>`);
      for (const e of endings) {
        rows.push(`<div class="kv"><b>${e.id}</b>${e.movie ? ` · movie ${e.movie}` : ""}` +
          `${e.conditions.length ? ` · ${e.conditions.map((c) => c.text).join(", ")}` : ""} · ${e.evidence}</div>`);
      }
    }
    panel.innerHTML = rows.join("");
    panel.classList.remove("hidden");
  },
});
void viewer;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
