# vn-runtime

A minimal, data-driven visual-novel runtime that plays Ever17 scenes from the
decompiled IR plus extracted assets.

It is deliberately **not a UI**. It is the layer that proves the pipeline:
IR in, story events out, with presentation state resolved against real assets.

## Design

The runtime knows the IR op vocabulary and nothing else — no scene names, no
asset names, no hardcoded choice ids, and nothing about SC3, LNK, CPS or WAF.
Everything comes from `scene.json` + `manifest.json`.

```
SceneVm.next() -> { type: "dialogue", speaker, text, voice, voiceFile, state }
                | { type: "choice", id, resultVar, options[], state }
                | { type: "end", reason, nextScene? }
SceneVm.choose(event, { option })
```

`state` carries the resolved background, sprites (with screen x), fill and BGM,
so a front end only has to draw what it is handed.

**Variables and conditionals.** `varSet` ops execute (`:=` and the affection
`+=`); `varJump` compares against the shared variable table using the relations
in [sc3-format.md §6.1](../e17-parser/docs/sc3-format.md) (==, !=, >=, >).
Unevaluable conditions are reported through `onVarJump` and fall through rather
than guessing. A `SessionRunner` chains scenes across `gotoScene` with one
variable table — exactly how the engine's cross-scene state works — and reports
every reachable gap (unknown ops, unevaluable jumps, unresolved assets).

**Sprite placement.** Sprite x operands live in a 640-wide logical space
(320 = centre) while the artwork is 800×600, and each sprite's PRT header
records where its trimmed bitmap sits in the frame:

```
screenX = baseLeftOffset + (spriteX - 320) * (800 / 640)
```

## CLI

```bash
# play a scene, answering choice 44 with option 0
npm run vn -- play  build/ir/s_1a.json build/assets/s_1a/manifest.json --choice 44=0

# same, with block labels and presentation state per line
npm run vn -- trace build/ir/s_1a.json build/assets/s_1a/manifest.json --choice 44=1

# composite the frame shown at dialogue line 58
npm run vn -- frame build/ir/s_1a.json build/assets/s_1a/manifest.json -n 58 -o frame.png
```

Options: `--choice <id>=<option>` (repeatable), `--choices a,b,c` (in encounter
order), `--max <n>`, `--quiet`.

## Browser client

`vn serve <irDir> <assetsDir>` bundles `src/web/` (esbuild) and serves a
minimal playable client: click-to-advance text with speaker names, sprite/CG
compositing, choices, BGM/SE/voice, ending movies, and scene chaining with
persistent variables. It consumes only `/ir/*.json` + `/assets/manifest.json`
and knows no scene names (the start scene is a URL parameter).

## Status

A complete route plays from New Game to an ending with zero scene-specific
code: op00 → t_1a…t_6b → tt6a → tt7a → y_ed (Tsugumi ending movie + coda) —
22 scenes, 12,308 lines, 43 choices, verified both headlessly
(`vn route build/ir`) and click-through in the browser. Alternative choice
policies reach the You bad end and the Sara good end + epilogue. Effects,
waits and still-unknown opcodes are surfaced through `onOp` rather than
executed.
