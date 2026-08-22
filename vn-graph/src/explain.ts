import type { RouteGraphJson, RouteGraphModel, ConditionExpr } from "./model.js";
import type { EndingRecord, ExplorationResult, TakenChoice } from "./exploration-types.js";

export type { ExplorationResult } from "./exploration-types.js";

/**
 * Ending explanation, generated entirely from traces plus the static graph -
 * never hand-written.
 *
 * "Required" choices are those answered identically on every explored path
 * to the ending. "Discriminating" conditions are gates whose outcome on this
 * ending's paths differs from their outcome on some other ending's paths -
 * the branches that actually separate this ending from the rest.
 *
 * Browser-safe: pure data transformation.
 */

export interface EndingExplanation {
  id: string;
  scene: string;
  movie: string | null;
  paths: number;
  /** 1 = reachable on a fresh New Game; >1 = needs completed prior runs. */
  playthrough: number;
  requiredChoices: TakenChoice[];
  freeChoices: EndingRecord["freeChoices"];
  /** var writes on the route-committing transition(s) into the ending scene. */
  routeWrites: { varId: number; value: number }[];
  /** dispatch conditions from static analysis (e.g. "var1223 == 2"). */
  dispatchConditions: ConditionExpr[];
  /** condition -> outcome on all paths, filtered to gates that discriminate
   * this ending from at least one other. */
  discriminating: { text: string; outcome: boolean }[];
  /** other consistently-held conditions (context, not necessarily causal). */
  background: { text: string; outcome: boolean }[];
  criticalScenes: string[];
  samplePath: { route: string[]; choices: TakenChoice[] };
}

type GraphLike = RouteGraphModel | RouteGraphJson;

function nodesOf(graph: GraphLike): { id: string }[] {
  return graph.nodes instanceof Map ? [...graph.nodes.values()] : graph.nodes;
}

export function explainEnding(
  graph: GraphLike | null,
  exp: ExplorationResult,
  endingId: string,
): EndingExplanation | null {
  const rec = exp.endings.find((e) => e.id.toUpperCase() === endingId.toUpperCase());
  if (!rec) return null;

  // route-committing writes: on the sample path, the transition into the
  // first entry of the ending scene; keep writes that hold on every path
  // (consistent with finalVars) AND whose variable some ending's dispatch
  // actually tests - the rest is transfer/scratch state.
  const finalVars = new Map(rec.finalVars);
  const routeWrites: { varId: number; value: number }[] = [];
  const dispatchConditions: ConditionExpr[] = [];
  if (graph) {
    const endings = "endings" in graph ? graph.endings : [];
    const dispatchTested = new Set(endings.flatMap((e) => e.conditions.map((c) => c.varId)));
    const transitions =
      graph.transitions instanceof Array ? graph.transitions : [];
    const idx = rec.samplePath.route.indexOf(rec.scene);
    if (idx > 0) {
      const from = rec.samplePath.route[idx - 1]!;
      const seenWrites = new Set<string>();
      for (const t of transitions) {
        if (t.from !== from || t.to !== rec.scene) continue;
        for (const w of t.writes) {
          const key = `${w.varId}=${w.value}`;
          if (
            w.mod === "assign" &&
            dispatchTested.has(w.varId) &&
            finalVars.get(w.varId) === w.value &&
            !seenWrites.has(key)
          ) {
            seenWrites.add(key);
            routeWrites.push({ varId: w.varId, value: w.value });
          }
        }
      }
    }
    const candidates = endings.filter((e) => e.id.toUpperCase() === endingId.toUpperCase());
    const info =
      candidates.find((e) => !e.note && e.evidence !== "static") ?? candidates.find((e) => !e.note) ?? candidates[0];
    if (info) dispatchConditions.push(...info.conditions);
  }

  // discriminating conditions: outcome consistent here, and the opposite
  // outcome is consistent on at least one other ending
  const discriminating: { text: string; outcome: boolean }[] = [];
  const background: { text: string; outcome: boolean }[] = [];
  for (const [text, outcome] of Object.entries(rec.conditions)) {
    const contested = exp.endings.some(
      (other) => other.id !== rec.id && other.conditions[text] === !outcome,
    );
    (contested ? discriminating : background).push({ text, outcome });
  }
  discriminating.sort((a, b) => a.text.localeCompare(b.text));
  background.sort((a, b) => a.text.localeCompare(b.text));

  return {
    id: rec.id,
    scene: rec.scene,
    movie: rec.movie,
    paths: rec.paths,
    playthrough: rec.playthrough,
    requiredChoices: rec.requiredChoices,
    freeChoices: rec.freeChoices,
    routeWrites,
    dispatchConditions,
    discriminating,
    background,
    criticalScenes: rec.criticalScenes,
    samplePath: rec.samplePath,
  };
}

/** Plain-text rendering shared by the CLI and any log surface. */
export function formatExplanation(x: EndingExplanation): string {
  const lines: string[] = [];
  lines.push(`Ending ${x.id}  (scene ${x.scene}${x.movie ? `, movie ${x.movie}` : ""})`);
  lines.push(`observed on ${x.paths} explored path${x.paths === 1 ? "" : "s"}`);
  if (x.playthrough > 1) {
    lines.push(`requires carried-over flags from ${x.playthrough - 1} completed prior playthrough${x.playthrough > 2 ? "s" : ""}`);
  }
  lines.push("");
  lines.push("Choice history (identical on every path):");
  if (x.requiredChoices.length === 0) lines.push("  (none - every choice varies)");
  for (const c of x.requiredChoices) {
    lines.push(`  ${c.scene} choice ${c.id ?? "?"}: option ${c.option}  ${c.text}`);
  }
  if (x.freeChoices.length > 0) {
    lines.push("");
    lines.push("Free choices (any explored option reaches this ending):");
    for (const c of x.freeChoices) {
      lines.push(`  ${c.scene} choice ${c.id ?? "?"}: options ${c.options.join("/")}`);
    }
  }
  lines.push("");
  lines.push("Variables:");
  for (const w of x.routeWrites) lines.push(`  ${w.varId} = ${w.value}   (route-committing write)`);
  for (const c of x.dispatchConditions) lines.push(`  ${c.text}   (ending dispatch)`);
  for (const d of x.discriminating) {
    lines.push(`  ${d.text}  is ${d.outcome}   (discriminates vs other endings)`);
  }
  if (x.routeWrites.length + x.dispatchConditions.length + x.discriminating.length === 0) {
    lines.push("  (no distinguishing variables recorded)");
  }
  lines.push("");
  lines.push("Critical scenes (on every path):");
  lines.push(`  ${x.criticalScenes.join(" -> ")}`);
  return lines.join("\n");
}
