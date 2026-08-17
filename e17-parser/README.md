# e17-parser

Reverse-engineering toolkit for the PC version of **Ever17 -the out of
infinity-** (KID engine): parses the `script.dat` LNK archive, disassembles the
SC3 scenario bytecode, reconstructs control flow, and lowers everything into a
clean JSON intermediate representation for a future browser runtime.

**No game assets are included or redistributed.** You must supply your own
`script.dat` from an original installation.

## Status (Phase 1)

* LNK archive parser — validated against every `.dat` of the release.
* SC3 container split (entry table / code / text chunks / resource chunks).
* Bytecode disassembler — **100% byte coverage on all 84 story & 19 debug
  scripts**, 97% overall (the remainder is inline data + a few unresolved
  opcodes in `system.scr`/`startup.scr`, all reported explicitly).
* Expression decoder (immediates confirmed; operator semantics partial).
* Text decoder (GBK story text / Shift-JIS debug text, voice tags, choices
  with ids and per-option visibility conditions).
* Control-flow graphs (jumps, conditionals, choices, switches, cross-script).
* IR emitter (`e17 decompile-all`) — 104/104 scripts.

The format specification with confidence labels and evidence lives in
[docs/sc3-format.md](docs/sc3-format.md).

Part of the [Ever17 preservation toolkit](../README.md) workspace; see the root
README for setup (`direnv allow && npm install` at the workspace root).

## CLI

```bash
npm run e17 -- inspect        /path/to/script.dat
npm run e17 -- list           /path/to/script.dat
npm run e17 -- inspect-scr    /path/to/script.dat s_1a.scr
npm run e17 -- disasm         /path/to/script.dat debug_bg8.scr
npm run e17 -- dump-text      /path/to/script.dat s_1a.scr
npm run e17 -- dump-resources /path/to/script.dat sc1a.scr
npm run e17 -- cfg            /path/to/script.dat s_1a.scr
npm run e17 -- decompile      /path/to/script.dat s_1a.scr
npm run e17 -- decompile-all  /path/to/script.dat -o dumps/ir
npm run e17 -- coverage       /path/to/script.dat
```

`--encoding gbk|shift_jis` overrides text decoding (default: GBK, `debug*`
scripts Shift-JIS).

## Tests

```bash
npm test
```

Synthetic tests always run; archive-backed tests need the real `script.dat`
(auto-detected at `../ever17games/script.dat`, override with
`E17_SCRIPT_DAT=/path/to/script.dat`).

Phase 2 note: the conditional-polarity question this document listed as open was
resolved while building the runtime — see
[docs/sc3-format.md §6.1](docs/sc3-format.md).

## Layout

```
src/lnk/        LNK archive container
src/sc3/        SC3: header, chunks, expressions, opcodes, disassembler, text, cfg
src/ir/         IR types + lowering
src/cli.ts      command-line tool
docs/           living format specification
dumps/          scratch output (gitignored)
```
