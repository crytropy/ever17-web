import type { ConditionExpr, EndingInfo, RouteGraphModel } from "./model.js";
import type { ExplorationResult } from "./explore.js";

/**
 * Combine static analysis with runtime observation.
 *
 * Static analysis says what is possible; exploration says what actually
 * happens. Observed endings are matched to static dispatch candidates by
 * (scene, conditions satisfied by the run's final variables), preferring the
 * dispatch variable that actually discriminates between observed endings -
 * so END_TU00 claims the `var1223 == 2` row rather than the coda row that
 * every ending passes through.
 */

function condHolds(c: ConditionExpr, vars: ReadonlyMap<number, number>): boolean {
  const v = vars.get(c.varId) ?? 0;
  switch (c.rel) {
    case "==": return v === c.value;
    case "!=": return v !== c.value;
    case ">=": return v >= c.value;
    case ">": return v > c.value;
    case "<=": return v <= c.value;
    default: return false;
  }
}

/** Merge exploration data into the model: observed transitions and endings. */
export function applyExploration(model: RouteGraphModel, exp: ExplorationResult): RouteGraphModel {
  const observedEdges = new Set(exp.transitionsObserved.map((o) => `${o.from}>${o.to}`));
  for (const t of model.transitions) {
    if (observedEdges.has(`${t.from}>${t.to}`) && !t.observedBy.includes("explore")) {
      t.observedBy.push("explore");
    }
  }

  // how many distinct final values each var takes across observed endings -
  // a condition on a high-diversity var is what separates endings
  const diversity = new Map<number, Set<number>>();
  for (const rec of exp.endings) {
    for (const [v, val] of rec.finalVars) {
      let set = diversity.get(v);
      if (!set) diversity.set(v, (set = new Set()));
      set.add(val);
    }
  }
  const score = (e: EndingInfo): number =>
    Math.max(0, ...e.conditions.map((c) => diversity.get(c.varId)?.size ?? 0));

  const statics = model.endings.filter((e) => e.evidence === "static");
  const claimed = new Map<EndingInfo, number>();
  const extra: EndingInfo[] = [];
  /** static candidates whose condition held for a run but that lost to a
   * more discriminating row (shared-path rows like the coda). */
  const outscored = new Set<EndingInfo>();

  for (const rec of exp.endings) {
    const fv = new Map(rec.finalVars);
    const candidates = statics
      .filter((e) => e.scene === rec.scene && !claimed.has(e) && e.conditions.every((c) => condHolds(c, fv)))
      .sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
    const best = candidates[0];
    for (const lost of candidates.slice(1)) outscored.add(lost);
    if (best) {
      claimed.set(best, rec.paths);
      best.id = rec.id;
      best.movie = rec.movie ?? best.movie;
      best.evidence = "static+observed";
      best.observedPaths = rec.paths;
      outscored.delete(best);
    } else {
      extra.push({
        id: rec.id,
        scene: rec.scene,
        movie: rec.movie,
        conditions: [],
        evidence: "observed",
        observedPaths: rec.paths,
      });
    }
  }
  for (const e of outscored) {
    if (!claimed.has(e)) {
      e.note = "dispatch row on a path shared by other observed endings (not a distinct ending)";
    }
  }
  // rows in a scene whose endings ARE observed but that no run terminated
  // through are variant/skip rows (already-cleared checks), not endings
  const observedScenes = new Set(exp.endings.map((r) => r.scene));
  for (const e of model.endings) {
    if (e.evidence === "static" && !e.note && !claimed.has(e) && observedScenes.has(e.scene)) {
      e.note = "dispatch row never terminated through by any observed run (variant/skip row)";
    }
  }
  model.endings.push(...extra);
  model.endings.sort((a, b) => a.id.localeCompare(b.id));
  // ids stay unique after observed renames; observed entries claim the
  // clean name first, noted variant rows take the suffix
  const used = new Map<string, number>();
  const byPriority = [...model.endings].sort(
    (a, b) => Number(a.note !== undefined) - Number(b.note !== undefined),
  );
  for (const e of byPriority) {
    const n = used.get(e.id) ?? 0;
    used.set(e.id, n + 1);
    if (n > 0) e.id = `${e.id}~${n + 1}`;
  }
  model.totals.endings = model.endings.filter((e) => !e.note).length;
  return model;
}

export interface EndingReport {
  endings: (EndingInfo & { reachable: "observed" | "static-only" })[];
  /** shared-path dispatch rows folded out of the ending list. */
  sharedRows: EndingInfo[];
  /** canEnd scenes never reached by exploration (or with no exploration data). */
  unknownTerminals: string[];
}

/** The `vn endings` view: every ending with its evidence level. */
export function endingReport(model: RouteGraphModel, exp: ExplorationResult | null): EndingReport {
  const observedScenes = new Set(exp?.endings.map((e) => e.scene) ?? []);
  const endings = model.endings
    .filter((e) => !e.note)
    .map((e) => ({
      ...e,
      reachable: (e.evidence !== "static" ? "observed" : "static-only") as "observed" | "static-only",
    }));
  const unknownTerminals = [...model.nodes.values()]
    .filter((n) => (n.canEnd || n.terminal) && !observedScenes.has(n.id))
    .map((n) => n.id)
    .sort();
  return { endings, sharedRows: model.endings.filter((e) => e.note !== undefined), unknownTerminals };
}
