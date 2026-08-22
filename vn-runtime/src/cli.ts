#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { AssetResolver } from "./assets.js";
import { runScene } from "./player.js";
import { SessionRunner } from "./session.js";
import { fsSceneSource } from "./scene-source.js";
import { SceneVm } from "./vm.js";
import { renderFrame } from "./frame.js";
import type { IrScene, PlayerEvent } from "./types.js";

function usage(): never {
  console.log(`vn - minimal data-driven Ever17 runtime

usage:
  vn play  <scene.json> <manifest.json> [options]   play a scene headlessly
  vn trace <scene.json> <manifest.json> [options]   play and print block/asset trace
  vn frame <scene.json> <manifest.json> -n <line> -o <out.png>
                                                    render the composited frame at a line
  vn route <irDir> [manifest.json] [options]        chain scenes from --start to an ending;
                                                    reports route, gaps, unknown semantics
  vn serve <irDir> <assetsDir> [--port n]           bundle + serve the browser client
                                                    (also serves /shots.html, the visual-
                                                    regression harness)
  vn fixtures <irDir> <manifest.json> -o <out.json> capture representative presentation
                                                    fixtures from a headless playthrough
  vn graph <irDir> -o <out> [--format json|dot|html] generate the route graph (static
                                                    edges + classification + coverage;
                                                    html = standalone interactive viewer)
  vn endings <irDir> [--exploration <file>]         list detected endings (static + observed)
  vn explore <irDir> [-o <out.json>]                explore every reachable branch via
                                                    save/restore; find endings + coverage
  vn explain-ending <irDir> <endingId>              why an ending happens, from traces

options:
  --choice <id>=<option>   answer the choice with that id (repeatable)
  --choices <a,b,c>        answer choices in encounter order
  --max <n>                stop after n dialogue lines
  --quiet                  suppress the transcript
  --start <scene>          route: first scene (default op00)
  --policy first|last      route: default answer for unscripted choices
  --scene-choice <scene:id=opt>  route: per-scene answer (repeatable)
`);
  process.exit(2);
}

const argv = process.argv.slice(2);

// Graph-family commands live in the vn-graph package (own flag set); hand the
// raw argv over before this CLI's parser can reject their flags.
if (["graph", "endings", "explore", "explain-ending"].includes(argv[0] ?? "")) {
  const { runGraphCli } = await import("vn-graph/cli");
  process.exit(await runGraphCli(argv));
}

const positional: string[] = [];
const choiceById: Record<number, number> = {};
let choices: number[] | undefined;
let maxLines = 0;
let quiet = false;
let frameLine = 0;
let outPath = "";
let startScene = "op00";
let port = 8017;
let policy: "first" | "last" = "first";
const choiceByScene: Record<string, number> = {};

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--choice") {
    const v = argv[++i];
    const m = v?.match(/^(\d+)=(\d+)$/);
    if (!m) usage();
    choiceById[Number(m[1])] = Number(m[2]);
  } else if (a === "--choices") {
    const v = argv[++i];
    if (!v) usage();
    choices = v.split(",").map((x) => Number(x.trim()));
  } else if (a === "--max") {
    maxLines = Number(argv[++i]);
  } else if (a === "-n") {
    frameLine = Number(argv[++i]);
  } else if (a === "-o") {
    outPath = argv[++i] ?? "";
  } else if (a === "--quiet") {
    quiet = true;
  } else if (a === "--start") {
    startScene = argv[++i] ?? "op00";
  } else if (a === "--policy") {
    const v = argv[++i];
    if (v !== "first" && v !== "last") usage();
    policy = v;
  } else if (a === "--port") {
    port = Number(argv[++i] ?? "8017");
  } else if (a === "--scene-choice") {
    const v = argv[++i];
    const m = v?.match(/^([^:]+):(\d+)=(\d+)$/);
    if (!m) usage();
    choiceByScene[`${m[1]!.toLowerCase()}:${m[2]}`] = Number(m[3]);
  } else if (a.startsWith("-")) usage();
  else positional.push(a);
}

const [cmd, scenePath, manifestPath] = positional;
if (!cmd || !scenePath) usage();
if (cmd !== "route" && cmd !== "fixtures" && !manifestPath) usage();

function describeState(ev: Extract<PlayerEvent, { type: "dialogue" | "choice" }>): string {
  const bg = ev.state.background?.asset ?? (ev.state.fill != null ? `fill:${ev.state.fill}` : "-");
  const sp = ev.state.sprites.map((s) => `${s.asset}@${s.x ?? "?"}`).join(",") || "-";
  return `bg=${bg} sprites=${sp}`;
}

if (cmd === "serve") {
  const irDir = scenePath;
  const assetsDir = manifestPath;
  if (!assetsDir) usage();
  const { serve } = await import("./serve.js");
  serve({ irDir, assetsDir, port });
} else if (cmd === "fixtures") {
  const irDir = scenePath;
  const manifest = manifestPath;
  if (!manifest || !outPath) usage();
  const { captureFixtures } = await import("./fixtures.js");
  const fixtures = await captureFixtures(irDir, manifest, startScene);
  writeFileSync(outPath, JSON.stringify(fixtures, null, 1));
  console.log(`${fixtures.length} fixtures -> ${outPath}`);
  for (const f of fixtures) {
    console.log(
      `  ${f.name.padEnd(14)} bg=${f.state.background?.asset ?? "-"} sprites=${f.state.sprites.length} actions=${f.actions.length}`,
    );
  }
} else if (cmd === "route") {
  const source = fsSceneSource(scenePath, manifestPath);
  const runner = new SessionRunner(source, {
    choiceByScene,
    ...(Object.keys(choiceById).length ? { choiceById } : {}),
    policy,
  });
  const r = runner.run(startScene);
  console.log(`route: ${r.route.join(" -> ")}`);
  console.log(`end: ${r.end} (${r.endDetail})`);
  for (const s of r.scenes) {
    const ch = s.choices.map((c) => `#${c.id}=[${c.option}]${c.text}`).join(" ");
    console.log(
      `  ${s.scene.padEnd(8)} ${String(s.lines).padStart(4)} lines  ${String(s.blocks).padStart(3)} blocks  ${s.exit}${ch ? "  " + ch : ""}`,
    );
  }
  console.log(`total lines: ${r.totalLines}`);
  const g = r.gaps;
  if (g.unknownOps.size) {
    console.log("reachable unknown ops:");
    for (const [k, n] of [...g.unknownOps].sort((a, b) => b[1] - a[1])) console.log(`  ${n
      .toString()
      .padStart(5)}x ${k}`);
  }
  if (g.unevaluableJumps.size) {
    console.log("unevaluable jumps:");
    for (const [k, n] of g.unevaluableJumps) console.log(`  ${n}x ${k}`);
  }
  if (g.conditionedOptions.size) {
    console.log(`choice options with conditions: ${[...g.conditionedOptions.keys()].join(", ")}`);
  }
  if (g.unresolvedAssets.size) console.log(`unresolved assets: ${g.unresolvedAssets.size}`);
  const mods = [...g.unknownMods].filter(([m]) => m !== 0x14 && m !== 0x17);
  if (mods.length) console.log(`unknown varSet mods: ${mods.map(([m, n]) => `0x${m.toString(16)}x${n}`).join(" ")}`);
  process.exit(r.end === "ending" ? 0 : 1);
}

if (cmd === "serve" || cmd === "fixtures" || cmd === "route") {
  // handled above; the single-scene commands below do not apply
} else {
const scene = JSON.parse(readFileSync(scenePath, "utf8")) as IrScene;
const assets = new AssetResolver(manifestPath!);

switch (cmd) {
  case "play":
  case "trace": {
    const script = {
      ...(choices ? { choices } : {}),
      ...(Object.keys(choiceById).length ? { choiceById } : {}),
      ...(maxLines ? { maxLines } : {}),
    };
    const result = runScene(scene, assets, script);

    if (!quiet) {
      for (const ev of result.events) {
        if (ev.type === "dialogue") {
          const v = ev.voice ? `[${ev.voice}] ` : "";
          const who = ev.speaker ? `${ev.speaker}: ` : "";
          const body = ev.text.replace(/\n/g, " / ");
          console.log(
            cmd === "trace"
              ? `${ev.state.block}  ${v}${who}${body}   {${describeState(ev)}}`
              : `${v}${who}${body}`,
          );
        } else if (ev.type === "choice") {
          console.log(`\n--- CHOICE id=${ev.id} (var ${ev.resultVar}) at block ${ev.state.block}`);
          for (const o of ev.options) {
            console.log(`  [${o.index}] ${o.text}  -> ${o.target ?? "(fallthrough)"}`);
          }
          const taken = result.choicesMade.find((c) => c.id === ev.id);
          if (taken) console.log(`  => chose [${taken.option}] ${taken.text}\n`);
        } else {
          console.log(
            `\n--- END (${ev.reason}${ev.nextScene ? `: ${ev.nextScene}` : ""})`,
          );
        }
      }
    }

    console.log(
      `\nscene=${scene.scene} lines=${result.lines} choices=${result.choicesMade.length} ` +
        `blocks visited=${result.blockTrace.length} assets used=${result.usedAssets.length} ` +
        `unresolved=${result.unresolved.length}`,
    );
    if (result.unresolved.length > 0) {
      console.log(`unresolved assets: ${result.unresolved.join(", ")}`);
    }
    if (cmd === "trace") {
      console.log(`block trace: ${result.blockTrace.join(" -> ")}`);
    }
    break;
  }

  case "frame": {
    if (!outPath) usage();
    const vm = new SceneVm(scene, assets);
    let seen = 0;
    let target: PlayerEvent | null = null;
    for (;;) {
      const ev = vm.next();
      if (ev.type === "end") break;
      if (ev.type === "choice") {
        vm.choose(ev, { option: ev.options[0]?.index ?? 0 });
        continue;
      }
      seen += 1;
      if (seen >= frameLine) {
        target = ev;
        break;
      }
    }
    if (!target || target.type !== "dialogue") {
      console.error(`could not reach dialogue line ${frameLine}`);
      process.exit(1);
    }
    const png = renderFrame(target.state, assets, {
      speaker: target.speaker,
      text: target.text,
    });
    writeFileSync(outPath, png);
    console.log(
      `line ${frameLine} @ block ${target.state.block}: ${describeState(target)}\n` +
        `${target.speaker ? target.speaker + ": " : ""}${target.text.replace(/\n/g, " / ")}\n` +
        `-> ${outPath}`,
    );
    break;
  }

  default:
    usage();
}
}
