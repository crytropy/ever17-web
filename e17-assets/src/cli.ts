#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { IrScene } from "e17-parser";
import { AssetLibrary, ARCHIVES, RAW_PCM_CHANNELS, RAW_PCM_SAMPLE_RATE } from "./library.js";
import { decodeCps, parseCpsPrt, parseCpsHeader } from "./cps/index.js";
import { decodeWaf, decodeRawPcm, parseWaf, pcmToWav } from "./waf/index.js";
import { encodePng } from "./png.js";
import { collectSceneAssets } from "./scene-assets.js";
import { extractAssets, writeManifest } from "./extract.js";

function usage(): never {
  console.log(`e17-assets - Ever17 CPS image / WAF audio decoder

usage:
  e17-assets archives     <gameDir>                      list archives found and their entry counts
  e17-assets list         <gameDir> <archive.dat>        list entries of one archive
  e17-assets info         <gameDir> <name>               header details for one asset
  e17-assets extract      <gameDir> <name...> -o <dir>   decode assets to png/wav
  e17-assets scene        <gameDir> <scene.json> -o <dir>
                                                         extract every asset an IR scene references
                                                         and write a manifest.json
`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "-o") {
    const v = argv[++i];
    if (v === undefined) usage();
    flags.set(a, v);
  } else if (a.startsWith("-")) usage();
  else positional.push(a);
}

const [cmd, gameDir, ...rest] = positional;
if (!cmd || !gameDir) usage();
const lib = new AssetLibrary(gameDir);

switch (cmd) {
  case "archives": {
    for (const spec of lib.available()) {
      const a = lib.archive(spec.file);
      console.log(
        `${spec.file.padEnd(14)} ${String(a.count).padStart(6)} entries  ${spec.kind}  (${spec.ext})`,
      );
    }
    break;
  }

  case "list": {
    const file = rest[0];
    if (!file) usage();
    const a = lib.archive(file);
    for (const e of a.entries) {
      console.log(`${e.name.padEnd(24)} ${String(e.size).padStart(9)} bytes  @0x${e.offset.toString(16)}`);
    }
    console.log(`\n${a.count} entries`);
    break;
  }

  case "info": {
    const name = rest[0];
    if (!name) usage();
    for (const kind of ["image", "audio"] as const) {
      const r = lib.resolve(name, kind);
      if (!r) continue;
      console.log(`${r.name}  (${r.archive}, ${r.entry.size} bytes)`);
      if (kind === "image") {
        const h = parseCpsHeader(r.entry.data);
        const prt = parseCpsPrt(r.entry.data);
        console.log(`  CPS: compression=0x${h.compression.toString(16)} plainSize=${h.plainSize}`);
        console.log(
          `  PRT: v0x${prt.version.toString(16)} ${prt.width}x${prt.height} ${prt.colorDepth}bpp` +
            ` stride=${prt.stride} alpha=${prt.hasAlpha} palette=${prt.palette ? "yes" : "no"}` +
            ` baseLeftOffset=${prt.baseLeftOffset} nominalWidth=${prt.nominalWidth}`,
        );
      } else if (r.format === "pcm") {
        const a = decodeRawPcm(r.entry.data, RAW_PCM_CHANNELS, RAW_PCM_SAMPLE_RATE);
        console.log(
          `  raw PCM (headerless): ${a.channels}ch ${a.sampleRate}Hz ` +
            `${a.pcm.length}B (${a.duration.toFixed(3)}s)`,
        );
      } else {
        const w = parseWaf(r.entry.data);
        const a = decodeWaf(r.entry.data);
        console.log(
          `  WAF: ${w.channels}ch ${w.sampleRate}Hz blockAlign=${w.blockAlign} ` +
            `adpcm=${w.data.length}B -> pcm=${a.pcm.length}B (${a.duration.toFixed(3)}s)`,
        );
      }
    }
    break;
  }

  case "extract": {
    const outDir = flags.get("-o");
    if (!outDir || rest.length === 0) usage();
    mkdirSync(outDir, { recursive: true });
    for (const name of rest) {
      let done = false;
      for (const kind of ["image", "audio"] as const) {
        const r = lib.resolve(name, kind);
        if (!r) continue;
        const base = name.toLowerCase().replace(/\.[^.]+$/, "");
        if (kind === "image") {
          const img = decodeCps(r.entry.data);
          const out = join(outDir, `${base}.png`);
          writeFileSync(out, encodePng(img));
          console.log(`${name} -> ${out} (${img.width}x${img.height}${img.hasAlpha ? ", alpha" : ""})`);
        } else {
          const audio =
            r.format === "pcm"
              ? decodeRawPcm(r.entry.data, RAW_PCM_CHANNELS, RAW_PCM_SAMPLE_RATE)
              : decodeWaf(r.entry.data);
          const out = join(outDir, `${base}.wav`);
          writeFileSync(out, pcmToWav(audio));
          console.log(`${name} -> ${out} (${audio.channels}ch ${audio.duration.toFixed(2)}s)`);
        }
        done = true;
        break;
      }
      if (!done) console.error(`not found: ${name}`);
    }
    break;
  }

  case "scene": {
    const scenePath = rest[0];
    const outDir = flags.get("-o");
    if (!scenePath || !outDir) usage();
    const scene = JSON.parse(readFileSync(scenePath, "utf8")) as IrScene;
    const refs = collectSceneAssets(scene);
    const images = refs.filter((r) => r.kind === "image").length;
    console.log(
      `${scene.scene}: ${refs.length} referenced assets (${images} images, ${refs.length - images} audio)`,
    );
    let ok = 0;
    const manifest = extractAssets(
      lib,
      refs,
      {
        outDir,
        onProgress: (name, entry, err) => {
          if (entry) ok += 1;
          else console.error(`  MISSING ${name}: ${err?.message}`);
        },
      },
      [basename(scenePath)],
    );
    writeManifest(outDir, manifest);
    console.log(`extracted ${ok}/${refs.length} -> ${join(outDir, "manifest.json")}`);
    if (manifest.missing.length > 0) console.log(`${manifest.missing.length} missing`);
    break;
  }

  default:
    usage();
}

export { ARCHIVES };
