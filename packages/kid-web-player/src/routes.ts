/**
 * /routes - the route explorer page.
 *
 * Consumes graph JSON (+ optional exploration JSON) from the server and the
 * player's completion state from IndexedDB. No SC3 knowledge, no scene names:
 * everything on screen comes from the data.
 */
import type { RouteGraphJson } from "kid-graph/model";
import { renderGraphViewer } from "kid-graph/viewer";
import { explainEnding, formatExplanation } from "kid-graph/explain";
import type { ExplorationResult } from "kid-graph/exploration-types";
import { CompletionTracker, IdbCompletionStore } from "./completion.js";

const $ = (id: string): HTMLElement => document.getElementById(id)!;

function pct(n: number, d: number): string {
  return d > 0 ? `<span class="pct">${Math.round((100 * n) / d)}%</span>` : "";
}

async function main(): Promise<void> {
  const graph = (await (await fetch("graph.json")).json()) as RouteGraphJson;
  const exploration = await fetch("exploration.json")
    .then((r) => (r.ok ? (r.json() as Promise<ExplorationResult>) : null))
    .catch(() => null);
  const tracker = await CompletionTracker.open(new IdbCompletionStore()).catch(() => null);

  const completion = tracker
    ? { scenes: tracker.scenes, endings: tracker.endings }
    : null;

  // ---- header stats: player progress against graph totals
  const reachable = new Set<string>();
  {
    const queue = [graph.start];
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    while (queue.length) {
      const id = queue.pop()!;
      if (reachable.has(id)) continue;
      const n = byId.get(id);
      if (!n) continue;
      reachable.add(id);
      for (const i of n.outgoing) queue.push(graph.transitions[i]!.to);
    }
  }
  // player-facing endings: observed by the analyzer, in reachable scenes
  const endingIds = graph.endings
    .filter((e) => !e.note && e.evidence !== "static" && reachable.has(e.scene))
    .map((e) => e.id);
  const choicesTotal = graph.nodes
    .filter((n) => reachable.has(n.id))
    .reduce((s, n) => s + n.choices.reduce((x, c) => x + c.options.length, 0), 0);
  const assetsTotal = new Set(
    graph.nodes.filter((n) => reachable.has(n.id)).flatMap((n) => n.assets ?? []),
  ).size;

  const seenScenes = [...(tracker?.scenes ?? [])].filter((s) => reachable.has(s)).length;
  const seenChoices = tracker?.choices.size ?? 0;
  const seenEndings = endingIds.filter((e) => tracker?.endings.has(e)).length;
  const seenAssets = tracker?.assets.size ?? 0;

  $("st-scenes").innerHTML = `scenes <b>${seenScenes} / ${reachable.size}</b> ${pct(seenScenes, reachable.size)}`;
  $("st-choices").innerHTML = `choices <b>${seenChoices} / ${choicesTotal}</b> ${pct(seenChoices, choicesTotal)}`;
  $("st-endings").innerHTML = `endings <b>${seenEndings} / ${endingIds.length}</b> ${pct(seenEndings, endingIds.length)}`;
  $("st-assets").innerHTML = `assets <b>${Math.min(seenAssets, assetsTotal)} / ${assetsTotal}</b> ${pct(Math.min(seenAssets, assetsTotal), assetsTotal)}`;

  // ---- endings checklist
  const list = $("endings-list");
  list.innerHTML = `<div style="color:#8093b8;margin-bottom:4px">ENDINGS</div>`;
  for (const id of endingIds) {
    const got = tracker?.endings.has(id) ?? false;
    const div = document.createElement("div");
    div.className = `e${got ? " got" : ""}`;
    div.textContent = `${got ? "✓" : "·"} ${got || !tracker ? id : "?????"}`;
    list.appendChild(div);
  }

  // ---- graph
  const panel = $("panel");
  renderGraphViewer($("app"), graph, {
    completion,
    onSelect: (id) => {
      if (!id) {
        panel.classList.add("hidden");
        return;
      }
      const n = graph.nodes.find((x) => x.id === id);
      if (!n) return;
      const visited = !tracker || tracker.scenes.has(id);
      const rows: string[] = [];
      rows.push(`<h2>${id}</h2>`);
      rows.push(
        `<div class="kv">${n.lines} lines · ${n.blocks} blocks` +
          `${n.canEnd ? " · can end the game" : ""}${visited ? "" : ` <span class="muted">· not yet visited</span>`}</div>`,
      );
      if (n.choices.length) {
        rows.push(`<h3>choices</h3>`);
        for (const c of n.choices) {
          rows.push(`<div class="kv">#${c.id ?? "?"} — ${c.options.length} options</div>`);
          for (const o of c.options) {
            const key = `${id}:${c.id ?? `b${c.block}`}:${o.index}`;
            const done = tracker?.choices.has(key) ?? false;
            const text = visited ? escapeHtml(o.text) : "·····";
            rows.push(`<div class="opt${done ? " done" : ""}">[${o.index}] ${done ? "✓ " : ""}${text}</div>`);
          }
        }
      }
      const out = n.outgoing.map((i) => graph.transitions[i]!);
      if (out.length) {
        rows.push(`<h3>transitions out</h3>`);
        for (const t of out) {
          const known = !tracker || (tracker.scenes.has(t.from) && tracker.scenes.has(t.to));
          const extra =
            t.type === "choice" && t.choice ? ` (choice ${t.choice.id ?? "?"} → option ${t.choice.option})` :
            t.type === "conditional" && t.condition ? ` (${t.condition.text})` :
            t.type === "ending" ? ` (${t.writes.filter((w) => w.mod === "assign").map((w) => `${w.varId}=${w.value}`).join(", ")})` : "";
          rows.push(`<div class="edge ${t.type}">${t.type} → <b>${known ? t.to : "???"}</b>${known ? extra : ""}</div>`);
        }
      }
      const here = graph.endings.filter((e) => e.scene === id && !e.note && e.evidence !== "static");
      if (here.length) {
        rows.push(`<h3>endings here</h3>`);
        for (const e of here) {
          const got = tracker?.endings.has(e.id) ?? false;
          rows.push(`<div class="kv">${got ? "✓" : "·"} <b>${got || !tracker ? e.id : "?????"}</b>` +
            `${e.conditions.length ? ` · ${e.conditions.map((c) => c.text).join(", ")}` : ""}</div>`);
          if (got && exploration) {
            const x = explainEnding(graph, exploration, e.id);
            if (x) rows.push(`<pre>${escapeHtml(formatExplanation(x))}</pre>`);
          }
        }
        if (!exploration) rows.push(`<div class="muted">run "vn explore" for ending explanations</div>`);
      }
      panel.innerHTML = rows.join("");
      panel.classList.remove("hidden");
    },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

void main();
