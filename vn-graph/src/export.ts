import type { RouteGraphJson } from "./model.js";

/** Graphviz DOT rendering. Browser-safe (pure string building). */
export function toDot(g: RouteGraphJson): string {
  const esc = (s: string): string => s.replace(/"/g, '\\"');
  const endingScenes = new Set(g.endings.map((e) => e.scene));
  const lines: string[] = [
    "digraph route {",
    "  rankdir=LR;",
    '  node [shape=box, style="rounded,filled", fillcolor="#eef2ff", fontname="monospace"];',
  ];
  for (const n of g.nodes) {
    const attrs: string[] = [];
    const label = `${n.id}\\n${n.lines} lines` + (n.choices.length ? `, ${n.choices.length} ch` : "");
    attrs.push(`label="${esc(label)}"`);
    if (n.terminal || endingScenes.has(n.id)) attrs.push('fillcolor="#ffe4e6"');
    if (n.id === g.start) attrs.push('fillcolor="#dcfce7"');
    lines.push(`  "${esc(n.id)}" [${attrs.join(", ")}];`);
  }
  for (const e of g.transitions) {
    const attrs: string[] = [];
    const bits: string[] = [];
    if (e.choice) bits.push(`c${e.choice.id ?? "?"}[${e.choice.option}]`);
    if (e.condition) bits.push(e.condition.text);
    for (const w of e.writes) {
      if (e.type === "ending" && w.mod === "assign") bits.push(`${w.varId}=${w.value}`);
    }
    if (bits.length) attrs.push(`label="${esc(bits.join(" "))}"`);
    const color =
      e.type === "ending" ? "#dc2626" : e.type === "choice" ? "#2563eb" : e.type === "conditional" ? "#d97706" : "#94a3b8";
    attrs.push(`color="${color}"`);
    if (e.observedBy.length > 0) attrs.push("penwidth=2");
    lines.push(`  "${esc(e.from)}" -> "${esc(e.to)}" [${attrs.join(", ")}];`);
  }
  lines.push("}");
  return lines.join("\n");
}
