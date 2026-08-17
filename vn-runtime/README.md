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

**Conditionals.** Guards are evaluated against runtime variables using the
relations established in
[sc3-format.md §6.1](../e17-parser/docs/sc3-format.md): `0x14` is equality,
`0x17` is inequality, variables default to 0. Guards using a still-unidentified
relation are reported through `onBranch` as unevaluable and take the skip path
rather than guessing. `branchPolicy: "take" | "skip"` forces either side for
experimentation.

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

## Status

`s_1a` plays end to end: 622 lines, both choices, 218 assets, exiting to
`S_1A2`. Both branches of choice 44 play their own reply and reconverge at
block `0x2E0`. Effects, waits and still-unknown opcodes are surfaced through
`onOp` rather than executed.
