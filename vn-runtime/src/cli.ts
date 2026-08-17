#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { AssetResolver } from "./assets.js";
import { runScene } from "./player.js";
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

options:
  --choice <id>=<option>   answer the choice with that id (repeatable)
  --choices <a,b,c>        answer choices in encounter order
  --max <n>                stop after n dialogue lines
  --quiet                  suppress the transcript
`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const positional: string[] = [];
const choiceById: Record<number, number> = {};
let choices: number[] | undefined;
let maxLines = 0;
let quiet = false;
let frameLine = 0;
let outPath = "";

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
  } else if (a.startsWith("-")) usage();
  else positional.push(a);
}

const [cmd, scenePath, manifestPath] = positional;
if (!cmd || !scenePath || !manifestPath) usage();

const scene = JSON.parse(readFileSync(scenePath, "utf8")) as IrScene;
const assets = new AssetResolver(manifestPath);

function describeState(ev: Extract<PlayerEvent, { type: "dialogue" | "choice" }>): string {
  const bg = ev.state.background?.asset ?? (ev.state.fill != null ? `fill:${ev.state.fill}` : "-");
  const sp = ev.state.sprites.map((s) => `${s.asset}@${s.x ?? "?"}`).join(",") || "-";
  return `bg=${bg} sprites=${sp}`;
}

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
