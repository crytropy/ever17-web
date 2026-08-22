#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { SessionRunner } from "kid-runtime";
import type { GameProfile } from "kid-contracts/profile";
import { fsSceneSource } from "kid-runtime/node";
import type { IrScene } from "kid-contracts/ir";
import { buildGraphModel } from "./build.js";
import { applyExploration, endingReport } from "./analyze.js";
import {
  buildVarAbstraction,
  detectCrossRunVars,
  explore,
  type ExplorationResult,
  EXPLORATION_FORMAT,
} from "./explore.js";
import { explainEnding, formatExplanation } from "./explain.js";
import { toJson, type RouteGraphModel } from "./model.js";
import { toDot } from "./export.js";

function usage(): never {
  console.log(`vn-graph - route graph and exploration tools

usage:
  vn graph <irDir> [-o out] [--format json|dot|html] [--start s]
  (--start is required unless the calling CLI supplies a game default)
                   [--dot out.dot] [--exploration file] [--no-traversals]
  vn endings <irDir> [--start s] [--exploration file]
  vn explore <irDir> [-o out.json] [--start s] [--max-states n] [--max-sessions n]
                     [--playthroughs n]   (chained New Games carrying cross-run flags; default 3)
  vn explain-ending <irDir> <endingId> [--exploration file] [--start s]

The exploration file defaults to build/exploration.json when present.
`);
  process.exit(2);
}

interface Args {
  cmd: string;
  positional: string[];
  out: string;
  format: string;
  start: string;
  dot: string | null;
  exploration: string | null;
  traversals: boolean;
  maxStates: number | null;
  maxSessions: number | null;
  playthroughs: number;
}

function parseArgs(argv: string[], defaultStart: string | undefined): Args {
  const a: Args = {
    cmd: "",
    positional: [],
    out: "",
    format: "json",
    start: defaultStart ?? "",
    dot: null,
    exploration: null,
    traversals: true,
    maxStates: null,
    maxSessions: null,
    // the deepest chain the data needs: four route clears, then the coda that
    // unlocks the fragment run, then the final route
    playthroughs: 6,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-o") a.out = argv[++i] ?? "";
    else if (arg === "--format") a.format = argv[++i] ?? "json";
    else if (arg === "--start") a.start = argv[++i] ?? "";
    else if (arg === "--dot") a.dot = argv[++i] ?? null;
    else if (arg === "--exploration") a.exploration = argv[++i] ?? null;
    else if (arg === "--no-traversals") a.traversals = false;
    else if (arg === "--max-states") a.maxStates = Number(argv[++i]);
    else if (arg === "--max-sessions") a.maxSessions = Number(argv[++i]);
    else if (arg === "--playthroughs") a.playthroughs = Number(argv[++i] ?? "3");
    else if (arg.startsWith("-")) usage();
    else a.positional.push(arg);
  }
  a.cmd = a.positional.shift() ?? "";
  return a;
}

function loadScenes(irDir: string): Map<string, IrScene> {
  const source = fsSceneSource(irDir);
  const scenes = new Map<string, IrScene>();
  for (const f of readdirSync(irDir).filter((f) => f.endsWith(".json")).sort()) {
    const s = source.load(f.replace(/\.json$/, ""));
    if (s) scenes.set(s.scene.toLowerCase(), s);
  }
  return scenes;
}

function loadExploration(path: string | null): ExplorationResult | null {
  const p = path ?? "build/exploration.json";
  if (!existsSync(p)) {
    if (path) throw new Error(`no exploration data at ${p} - run: vn explore <irDir> -o ${p}`);
    return null;
  }
  const data = JSON.parse(readFileSync(p, "utf8")) as ExplorationResult;
  if (data.format !== EXPLORATION_FORMAT) throw new Error(`${p} is not an exploration file`);
  return data;
}

function buildModel(
  irDir: string,
  start: string,
  exploration: ExplorationResult | null,
  profile?: GameProfile,
): RouteGraphModel {
  const model = buildGraphModel(loadScenes(irDir), start, profile);
  if (exploration) applyExploration(model, exploration);
  return model;
}

/** Game-specific defaults a product CLI can inject (the graph tools
 * themselves hardcode no game's start scene or ending patterns). */
export interface GraphCliDefaults {
  start?: string;
  profile?: GameProfile;
}

/** Shared command implementation; used directly and via the vn CLI. */
export async function runGraphCli(argv: string[], defaults: GraphCliDefaults = {}): Promise<number> {
  const a = parseArgs(argv, defaults.start);
  const irDir = a.positional[0];
  if (a.cmd && a.cmd !== "help" && !a.start) {
    console.error("no start scene: pass --start <scene> (no game default is built in)");
    return 2;
  }

  if (a.cmd === "graph") {
    if (!irDir) usage();
    const exploration = loadExploration(a.exploration);
    const model = buildModel(irDir, a.start, exploration, defaults.profile);
    let traversals: Record<string, { route: string[]; end: string }> | undefined;
    if (a.traversals) {
      const source = fsSceneSource(irDir);
      traversals = {};
      for (const label of ["first", "last"] as const) {
        const r = new SessionRunner(source, {
          policy: label,
          ...(defaults.profile ? { endingScenes: defaults.profile.endingScenePatterns, vm: { profile: defaults.profile } } : {}),
        }).run(a.start);
        traversals[label] = { route: r.route, end: `${r.end}:${r.scenes[r.scenes.length - 1]?.scene ?? "?"}` };
      }
      for (const t of model.transitions) {
        for (const [label, tr] of Object.entries(traversals)) {
          for (let i = 0; i + 1 < tr.route.length; i++) {
            if (
              tr.route[i]!.toLowerCase() === t.from &&
              tr.route[i + 1]!.toLowerCase() === t.to &&
              !t.observedBy.includes(label)
            ) {
              t.observedBy.push(label);
            }
          }
        }
      }
    }
    const json = toJson(model, traversals);
    const observed = json.transitions.filter((t) => t.observedBy.length > 0).length;
    const byType = new Map<string, number>();
    for (const t of json.transitions) byType.set(t.type, (byType.get(t.type) ?? 0) + 1);
    console.log(
      `graph: ${json.nodes.length} scenes, ${json.transitions.length} transitions ` +
        `(${observed} observed; ${[...byType.entries()].map(([k, v]) => `${v} ${k}`).join(", ")}), ` +
        `${json.endings.length} endings`,
    );
    if (json.missingScenes.length) console.log(`missing scenes: ${json.missingScenes.join(", ")}`);
    if (json.unreferenced.length) console.log(`unreferenced: ${json.unreferenced.join(", ")}`);

    if (a.format === "json") {
      if (!a.out) usage();
      writeFileSync(a.out, JSON.stringify(json, null, 1));
      console.log(`-> ${a.out}`);
    } else if (a.format === "dot") {
      if (!a.out) usage();
      writeFileSync(a.out, toDot(json));
      console.log(`-> ${a.out}`);
    } else if (a.format === "html") {
      if (!a.out) usage();
      const { toHtml } = await import("./export-html.js");
      writeFileSync(a.out, toHtml(json));
      console.log(`-> ${a.out}`);
    } else usage();
    if (a.dot) {
      writeFileSync(a.dot, toDot(json));
      console.log(`-> ${a.dot}`);
    }
    return 0;
  }

  if (a.cmd === "endings") {
    if (!irDir) usage();
    const exploration = loadExploration(a.exploration);
    const model = buildModel(irDir, a.start, exploration, defaults.profile);
    const report = endingReport(model, exploration);
    console.log(`Detected endings (${report.endings.length}):\n`);
    for (const e of report.endings) {
      console.log(`${e.id}`);
      console.log(`  scene: ${e.scene}${e.movie ? `   movie: ${e.movie}` : ""}`);
      console.log(`  evidence: ${e.evidence}${e.observedPaths ? ` (${e.observedPaths} explored paths)` : ""}`);
      for (const c of e.conditions) console.log(`  condition: ${c.text}`);
      console.log("");
    }
    if (report.sharedRows.length) {
      console.log(`Shared terminal rows (not distinct endings):`);
      for (const e of report.sharedRows) {
        console.log(`  ${e.scene}: ${e.conditions.map((c) => c.text).join(", ") || "?"} — ${e.note}`);
      }
      console.log("");
    }
    if (report.unknownTerminals.length) {
      console.log(`Terminal-capable scenes with no observed ending:`);
      for (const s of report.unknownTerminals) console.log(`  ${s}`);
    }
    if (!exploration) {
      console.log(`\n(no exploration data - static only; run: vn explore ${irDir} -o build/exploration.json)`);
    }
    return 0;
  }

  if (a.cmd === "explore") {
    if (!irDir) usage();
    const source = fsSceneSource(irDir);
    const scenes = loadScenes(irDir);
    const abstraction = buildVarAbstraction(scenes.values());
    const persistentVars = detectCrossRunVars(scenes.values(), a.start);
    console.log(`control vars (scenario read set): ${abstraction.control.size}`);
    console.log(`cross-run flags (persist across chained playthroughs): ${[...persistentVars].sort((x, y) => x - y).join(", ") || "none"}`);
    const result = await explore(source, {
      start: a.start,
      abstraction,
      persistentVars,
      playthroughs: a.playthroughs,
      ...(a.maxStates != null && Number.isFinite(a.maxStates) ? { maxStates: a.maxStates } : {}),
      ...(a.maxSessions != null && Number.isFinite(a.maxSessions) ? { maxSessions: a.maxSessions } : {}),
      onProgress: (m) => console.log(`  ${m}`),
    });
    const out = a.out || "build/exploration.json";
    writeFileSync(out, JSON.stringify(result, null, 1));
    console.log(`\nExploration complete (${(result.stats.elapsedMs / 1000).toFixed(1)}s, ` +
      `${result.stats.sessions} sessions, ${result.stats.statesSeen} states, ` +
      `${result.stats.events} events, ${result.playthroughsExplored} playthrough generation(s)` +
      `${result.stats.capped ? ", CAPPED" : ""}).\n`);
    console.log(`Reachable endings (${result.endings.length}):`);
    for (const e of result.endings) {
      const pt = e.playthrough > 1 ? `  [playthrough ${e.playthrough}]` : "";
      console.log(`  ${e.id.padEnd(12)} scene ${e.scene}${e.movie ? ` movie ${e.movie}` : ""}  (${e.paths} paths)${pt}`);
    }
    console.log(`\nCoverage:`);
    console.log(`  scenes visited: ${result.scenesVisited.length}`);
    console.log(`  choices seen: ${Object.keys(result.choicesSeen).length} sites, ` +
      `${Object.values(result.choicesSeen).reduce((s, c) => s + c.options.length, 0)} options`);
    console.log(`  transitions observed: ${result.transitionsObserved.length}`);
    const unknownTotal = Object.values(result.unknownOps).reduce((a2, b) => a2 + b, 0);
    console.log(`\nUnknown reachable operations: ${unknownTotal}`);
    for (const [k, n] of Object.entries(result.unknownOps)) console.log(`  ${n}x ${k}`);
    if (Object.keys(result.unevaluableJumps).length) {
      console.log(`Unevaluable jumps:`);
      for (const [k, n] of Object.entries(result.unevaluableJumps)) console.log(`  ${n}x ${k}`);
    }
    if (result.anomalies.length) {
      console.log(`Anomalies (${result.anomalies.length}):`);
      for (const an of result.anomalies.slice(0, 10)) console.log(`  ${an.reason} @ ${an.scene}`);
    }
    console.log(`\n-> ${out}`);
    return 0;
  }

  if (a.cmd === "explain-ending") {
    const endingId = a.positional[1];
    if (!irDir || !endingId) usage();
    const exploration = loadExploration(a.exploration);
    if (!exploration) {
      console.error(`explain-ending needs exploration data - run: vn explore ${irDir} -o build/exploration.json`);
      return 1;
    }
    const model = buildModel(irDir, a.start, exploration, defaults.profile);
    const x = explainEnding(toJson(model), exploration, endingId);
    if (!x) {
      console.error(`no explored ending "${endingId}". Known: ${exploration.endings.map((e) => e.id).join(", ")}`);
      return 1;
    }
    console.log(formatExplanation(x));
    return 0;
  }

  usage();
}

// Direct invocation (npm run vn-graph -- ...)
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await runGraphCli(process.argv.slice(2)));
}
