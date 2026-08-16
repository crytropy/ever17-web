#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseLnk, findEntry } from "./lnk/parser.js";
import type { LnkArchive, LnkEntry } from "./lnk/types.js";
import { parseSc3 } from "./sc3/chunks.js";
import { disassemble } from "./sc3/disassembler.js";
import { buildCfg } from "./sc3/cfg.js";
import { formatExpr } from "./sc3/expr.js";
import { OPCODES, OPCODES1 } from "./sc3/opcodes.js";
import { parseTextChunk, encodingForScript, type TextEncoding } from "./sc3/text.js";
import { lowerScene, chunkSegments } from "./ir/lower.js";
import type { Instruction, Operand, Sc3File } from "./sc3/types.js";
import { hex, hexdump } from "./util/reader.js";

function usage(): never {
  console.log(`e17 - Ever17 LNK/SC3 scenario toolkit

usage:
  e17 inspect        <script.dat>                 archive + per-file summary table
  e17 list           <script.dat>                 entry list
  e17 inspect-scr    <script.dat> <name.scr>      container regions of one script
  e17 disasm         <script.dat> <name.scr>      disassemble bytecode
  e17 dump-text      <script.dat> <name.scr>      decoded text chunks
  e17 dump-resources <script.dat> <name.scr>      resource chunk names
  e17 cfg            <script.dat> <name.scr>      basic blocks + edges
  e17 decompile      <script.dat> <name.scr>      IR JSON to stdout
  e17 decompile-all  <script.dat> -o <dir>        IR JSON for every script
  e17 coverage       <script.dat>                 disassembler coverage report

options:
  --encoding gbk|shift_jis   override text encoding (default: gbk, debug*=shift_jis)
`);
  process.exit(2);
}

interface Ctx {
  archive: LnkArchive;
  encodingOverride?: TextEncoding;
}

function openArchive(path: string): LnkArchive {
  const archive = parseLnk(readFileSync(path));
  for (const w of archive.warnings) console.error(`warning: ${w}`);
  return archive;
}

function getScr(ctx: Ctx, name: string): { entry: LnkEntry; file: Sc3File } {
  const entry = findEntry(ctx.archive, name);
  if (!entry) {
    console.error(`no entry "${name}" in archive`);
    process.exit(1);
  }
  return { entry, file: parseSc3(entry.name, entry.data) };
}

function encodingFor(ctx: Ctx, name: string): TextEncoding {
  return ctx.encodingOverride ?? encodingForScript(name);
}

// ---------------------------------------------------------------- commands

function cmdInspect(ctx: Ctx): void {
  const { archive } = ctx;
  console.log(`LNK archive: ${archive.count} entries, data at 0x${archive.dataStart.toString(16)}\n`);
  const w = Math.max(...archive.entries.map((e) => e.name.length)) + 2;
  console.log(
    `${"file".padEnd(w)}${"size".padStart(8)}  ${"entries".padStart(7)}  ${"codeStart".padStart(9)}  ${"textOff".padStart(8)}  ${"gfxOff".padStart(8)}  ${"#text".padStart(5)}  ${"#res".padStart(5)}`,
  );
  console.log("-".repeat(w + 60));
  for (const e of archive.entries) {
    try {
      const f = parseSc3(e.name, e.data);
      console.log(
        `${e.name.padEnd(w)}${String(e.size).padStart(8)}  ${String(f.entryPoints.length).padStart(7)}  ` +
          `${("0x" + f.header.codeStartOffset.toString(16)).padStart(9)}  ` +
          `${("0x" + f.header.textTableOffset.toString(16)).padStart(8)}  ` +
          `${("0x" + f.header.graphicsListOffset.toString(16)).padStart(8)}  ` +
          `${String(f.textChunks.length).padStart(5)}  ${String(f.resourceChunks.length).padStart(5)}`,
      );
    } catch (err) {
      console.log(`${e.name.padEnd(w)}${String(e.size).padStart(8)}  !! ${(err as Error).message}`);
    }
  }
}

function cmdList(ctx: Ctx): void {
  for (const e of ctx.archive.entries) {
    console.log(`${e.name.padEnd(20)} offset=0x${e.offset.toString(16).padStart(8, "0")} size=${e.size}`);
  }
}

function cmdInspectScr(ctx: Ctx, name: string): void {
  const { file } = getScr(ctx, name);
  const h = file.header;
  console.log(`${file.name}`);
  console.log(`  header: textTable=0x${h.textTableOffset.toString(16)} graphicsList=0x${h.graphicsListOffset.toString(16)} codeStart=0x${h.codeStartOffset.toString(16)}`);
  console.log(`  entry table: ${file.entryPoints.length} entries [0x10..0x${file.codeRegionStart.toString(16)})`);
  for (const [i, ep] of file.entryPoints.entries()) {
    console.log(`    entry#${i + 1}  -> 0x${ep.toString(16).toUpperCase().padStart(4, "0")}`);
  }
  console.log(`  code: [0x${file.codeRegionStart.toString(16)}..0x${file.codeRegionEnd.toString(16)}) = ${file.codeRegionEnd - file.codeRegionStart} bytes`);
  console.log(`  text chunks: ${file.textChunks.length}, resource chunks: ${file.resourceChunks.length}`);
  for (const w of file.warnings) console.log(`  warning: ${w}`);
}

function formatOperandCli(o: Operand): string {
  switch (o.kind) {
    case "expr": return formatExpr(o.expr);
    case "u8": return `b:${o.value.toString(16).padStart(2, "0")}`;
    case "u16": return String(o.value);
    case "entryRef": return `entry#${o.index}`;
    case "raw": return o.bytes.every((b) => b === 0) ? `z${o.bytes.length}` : `raw:${o.bytes.toString("hex")}`;
    case "string": return JSON.stringify(o.value);
    case "textRef": return `text#${o.index}`;
    case "u16list": return `tbl[${o.values.join(",")}]`;
  }
}

function annotate(file: Sc3File, ins: Instruction): string {
  // helpful cross-references in listings
  const notes: string[] = [];
  for (const o of ins.operands) {
    if (o.kind === "entryRef") {
      const t = file.entryPoints[o.index - 1];
      if (t !== undefined) notes.push(`-> 0x${t.toString(16).toUpperCase()}`);
    }
  }
  if ((ins.mnemonic === "SET_BG" || ins.mnemonic === "SET_BG_B")) {
    const r = ins.operands[1];
    if (r?.kind === "u16") {
      const n = file.resourceChunks[r.value]?.name;
      if (n) notes.push(`"${n}"`);
    }
  }
  if (ins.mnemonic === "SET_SPRITE") {
    const r = ins.operands[2];
    if (r?.kind === "u16") {
      const n = file.resourceChunks[r.value]?.name;
      if (n) notes.push(`"${n}"`);
    }
  }
  return notes.length > 0 ? `  ; ${notes.join(" ")}` : "";
}

function cmdDisasm(ctx: Ctx, name: string): void {
  const { entry, file } = getScr(ctx, name);
  const d = disassemble(file, entry.data);
  const entryAt = new Map<number, number[]>();
  file.entryPoints.forEach((a, i) => {
    const l = entryAt.get(a) ?? [];
    l.push(i + 1);
    entryAt.set(a, l);
  });
  const items: { addr: number; text: string }[] = [];
  for (const ins of d.instructions) {
    if (ins.mnemonic === "PAD") continue;
    const eps = entryAt.get(ins.address);
    if (eps) items.push({ addr: ins.address, text: `\nentry#${eps.join(",#")}:` });
    const opsText = ins.operands.map(formatOperandCli).join(" ");
    items.push({
      addr: ins.address,
      text: `${hex(ins.address)}: ${ins.mnemonic.padEnd(16)} ${opsText}${annotate(file, ins)}`,
    });
  }
  for (const r of d.dataRegions) {
    const head = `${hex(r.address)}: .data ${r.bytes.length} bytes (${r.reason})`;
    items.push({
      addr: r.address,
      text: r.strings
        ? `${head}\n  strings: ${r.strings.join(", ")}`
        : `${head}\n${hexdump(r.bytes.subarray(0, 64), r.address)}${r.bytes.length > 64 ? "\n  ..." : ""}`,
    });
  }
  items.sort((a, b) => a.addr - b.addr);
  for (const it of items) console.log(it.text);
  console.log(
    `\ncoverage: ${d.coveredBytes}/${d.totalBytes} bytes (${((100 * d.coveredBytes) / Math.max(d.totalBytes, 1)).toFixed(1)}%), ${d.dataRegions.length} undecoded region(s)`,
  );
}

function cmdDumpText(ctx: Ctx, name: string): void {
  const { file } = getScr(ctx, name);
  const enc = encodingFor(ctx, file.name);
  for (const chunk of file.textChunks) {
    const parsed = parseTextChunk(chunk, enc);
    console.log(`--- text#${chunk.index} @0x${chunk.offset.toString(16)} (${chunk.data.length} bytes)`);
    const segs = chunkSegments(parsed);
    let printed = false;
    for (const s of segs) {
      const v = s.voice ? `[${s.voice}] ` : "";
      const sp = s.speaker ? `${s.speaker}: ` : "";
      console.log(`  ${v}${sp}${s.text.replace(/\n/g, "\n    ")}`);
      printed = true;
    }
    const opts = parsed.tokens.filter((t) => t.kind === "optionText");
    if (opts.length > 0) {
      const header = parsed.tokens.find((t) => t.kind === "choiceHeader");
      console.log(`  choice${header && header.kind === "choiceHeader" ? ` id=${header.choiceId}` : ""}:`);
      opts.forEach((o, i) => {
        if (o.kind === "optionText") console.log(`    [${i + 1}] ${o.text}`);
      });
      printed = true;
    }
    if (!printed) console.log("  (empty)");
    for (const w of parsed.warnings) console.log(`  warning: ${w}`);
  }
}

function cmdDumpResources(ctx: Ctx, name: string): void {
  const { file } = getScr(ctx, name);
  for (const r of file.resourceChunks) {
    console.log(
      `#${String(r.index).padStart(3)}  ${r.name ?? `<${r.data.length} raw bytes: ${r.data.subarray(0, 16).toString("hex")}>`}`,
    );
  }
}

function cmdCfg(ctx: Ctx, name: string): void {
  const { entry, file } = getScr(ctx, name);
  const d = disassemble(file, entry.data);
  const cfg = buildCfg(file, d);
  for (const [addr, block] of [...cfg.blocks.entries()].sort((a, b) => a[0] - b[0])) {
    const eps = block.entryIndexes.length > 0 ? `  (entry#${block.entryIndexes.join(",#")})` : "";
    console.log(`block 0x${addr.toString(16).toUpperCase().padStart(4, "0")}${eps}  [${block.instructions.length} instr]`);
    for (const s of block.successors) {
      switch (s.type) {
        case "fallthrough": console.log(`  -> fallthrough 0x${s.target.toString(16).toUpperCase()}`); break;
        case "jump": console.log(`  -> jump 0x${s.target.toString(16).toUpperCase()}`); break;
        case "condition": console.log(`  -> cond(${s.taken ? "taken" : "skip"}) 0x${s.target.toString(16).toUpperCase()}`); break;
        case "choice": console.log(`  -> choice[${s.option}] 0x${s.target.toString(16).toUpperCase()}`); break;
        case "switch": console.log(`  -> case[${s.caseIndex}] 0x${s.target.toString(16).toUpperCase()}`); break;
        case "scene": console.log(`  -> scene ${s.targetScene}`); break;
      }
    }
  }
  for (const w of cfg.warnings) console.log(`warning: ${w}`);
}

function decompileOne(ctx: Ctx, entry: LnkEntry): ReturnType<typeof lowerScene> {
  const file = parseSc3(entry.name, entry.data);
  const d = disassemble(file, entry.data);
  const cfg = buildCfg(file, d);
  return lowerScene(file, d, cfg, encodingFor(ctx, file.name));
}

function cmdDecompile(ctx: Ctx, name: string): void {
  const entry = findEntry(ctx.archive, name);
  if (!entry) {
    console.error(`no entry "${name}"`);
    process.exit(1);
  }
  console.log(JSON.stringify(decompileOne(ctx, entry), null, 2));
}

function cmdDecompileAll(ctx: Ctx, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  let ok = 0;
  const summary: string[] = [];
  for (const entry of ctx.archive.entries) {
    try {
      const ir = decompileOne(ctx, entry);
      const out = join(outDir, entry.name.replace(/\.scr$/i, "") + ".json");
      writeFileSync(out, JSON.stringify(ir, null, 2));
      ok += 1;
      summary.push(
        `${entry.name.padEnd(18)} coverage=${(ir.meta.coverage * 100).toFixed(1)}% unknownOps=${ir.meta.unknownOpcodeCount} warnings=${ir.warnings.length}`,
      );
    } catch (err) {
      summary.push(`${entry.name.padEnd(18)} FAILED: ${(err as Error).message}`);
    }
  }
  for (const line of summary) console.log(line);
  console.log(`\n${ok}/${ctx.archive.entries.length} scripts decompiled to ${outDir}/`);
}

function cmdCoverage(ctx: Ctx): void {
  let total = 0;
  let covered = 0;
  const rows: { name: string; c: number; t: number; regions: number }[] = [];
  for (const entry of ctx.archive.entries) {
    try {
      const file = parseSc3(entry.name, entry.data);
      const d = disassemble(file, entry.data);
      rows.push({ name: entry.name, c: d.coveredBytes, t: d.totalBytes, regions: d.dataRegions.length });
      total += d.totalBytes;
      covered += d.coveredBytes;
    } catch (err) {
      console.log(`${entry.name.padEnd(18)} not SC3: ${(err as Error).message}`);
    }
  }
  if (total === 0) {
    console.log("no SC3 scripts in this archive");
    return;
  }
  rows.sort((a, b) => a.c / Math.max(a.t, 1) - b.c / Math.max(b.t, 1));
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(18)} ${((100 * r.c) / Math.max(r.t, 1)).toFixed(1).padStart(6)}%  (${r.c}/${r.t}, ${r.regions} undecoded region(s))`,
    );
  }
  console.log(`\nTOTAL: ${covered}/${total} = ${((100 * covered) / total).toFixed(2)}%`);
  console.log(`opcode table: ${OPCODES.size} two-byte + ${OPCODES1.size} one-byte opcodes`);
}

// ---------------------------------------------------------------- main

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "-o" || a === "--encoding") {
    const v = argv[++i];
    if (v === undefined) usage();
    flags.set(a, v);
  } else if (a.startsWith("-")) usage();
  else positional.push(a);
}
const [cmd, datPath, scrName] = positional;
if (!cmd || !datPath) usage();

const ctx: Ctx = { archive: openArchive(datPath) };
const enc = flags.get("--encoding");
if (enc === "gbk" || enc === "shift_jis") ctx.encodingOverride = enc;

switch (cmd) {
  case "inspect": cmdInspect(ctx); break;
  case "list": cmdList(ctx); break;
  case "inspect-scr": scrName ? cmdInspectScr(ctx, scrName) : usage(); break;
  case "disasm": scrName ? cmdDisasm(ctx, scrName) : usage(); break;
  case "dump-text": scrName ? cmdDumpText(ctx, scrName) : usage(); break;
  case "dump-resources": scrName ? cmdDumpResources(ctx, scrName) : usage(); break;
  case "cfg": scrName ? cmdCfg(ctx, scrName) : usage(); break;
  case "decompile": scrName ? cmdDecompile(ctx, scrName) : usage(); break;
  case "decompile-all": cmdDecompileAll(ctx, flags.get("-o") ?? "output"); break;
  case "coverage": cmdCoverage(ctx); break;
  default: usage();
}
