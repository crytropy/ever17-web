# vn-runtime

A minimal, data-driven visual-novel runtime that plays Ever17 scenes from the
decompiled IR plus extracted assets.

It is deliberately **not a UI**. It is the layer that proves the pipeline:
IR in, story events out, with presentation state resolved against real assets.

## Design

The runtime knows the IR op vocabulary and nothing else — no scene names, no
asset names, no hardcoded choice ids, and nothing about SC3, LNK, CPS or WAF.
Everything comes from `scene.json` + `manifest.json`.

## Stable API (phase 4A)

Two layers, both environment-agnostic:

**`SceneVm`** — one scene, synchronous:

```
SceneVm.next() -> { type: "dialogue", speaker, text, voice, voiceFile, state }
                | { type: "choice", id, resultVar, options[], state }
                | { type: "end", reason, nextScene? }
SceneVm.choose(event, { option })
SceneVm.getSaveState() -> VmSaveState        // at the presented event
```

`state` carries the resolved background, sprites (with screen x), fill and BGM,
so a front end only has to draw what it is handed.

**`GameSession`** — the driver front ends should use: async scene chaining
across `gotoScene` with one shared variable table, a bounded backlog, and
serializable saves.

```
GameSession.start(source, "op00", opts)      -> session       // New Game
GameSession.restore(source, save, opts)      -> session       // resume
session.next()   -> dialogue | choice | { type: "sessionEnd", reason }
session.choose(optionIndex)
session.save()   -> SessionSave   // JSON-safe; format "e17vn-save" v1
session.backlog  -> BacklogEntry[]
session.voiceDuration(ev) -> seconds | null  // for auto-mode pacing
```

`source` is an `AsyncSceneSource` (`load(name)` may return a promise —
fetch in the browser, `fsSceneSource` on Node). Saves are taken at the
currently presented event and **resume identically**: the regression suite
drives the full 12k-event route, saves at several points (including at a
choice), restores from `JSON.parse(JSON.stringify(save))`, and asserts the
continuation event stream equals the uninterrupted control run element by
element. Restored sessions re-present the saved moment without re-counting or
re-logging it.

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

## Presentation layer (phase 4B)

`src/web/stage.ts` is a **Pixi renderer that consumes PresentationState
only**: the `SceneStateSnapshot` each event carries (the truth to settle on)
plus its `PresentationAction[]` delta - the ordered script of what changed
since the previous event (background/fill/sprite changes with fade types,
`transitionTime` durations, waits, effects, shake, viewport rects, CG
overlays). Both are pure JSON recorded by the environment-agnostic VM, are
part of save files, and are covered by the save/resume identity tests.

Primitives: fade, crossfade (background pairs and per-slot sprite pose
dissolves), skippable waits, and sprite movement tweens. Effects are limited
to the ids reached during full-route playback and are labelled
approximations: blink(45), quake(12)/QUA(4,5), filter(44/32), sunbeams(27),
fog(19), snow(41, seeded deterministic particles), flash(46); map ids
(47/48/49) are recorded without a visual. `apply(state, actions, resolveUrl,
{instant})` plays the script and resolves when settled; `instant` jumps to the
final frame (skip mode and the shots harness).

### Visual regression shots

`vn fixtures <irDir> <manifest> -o vn-runtime/test/__shots__/fixtures.json`
captures representative moments from a real headless playthrough, selected by
generic predicates (bg-only, bg+sprite, two sprites, fill, crossfade, active
effect, CG overlay) - fixtures contain asset names and coordinates only, no
game text or pixels, so they are committed. With `vn serve` running, opening
`/shots.html` renders every fixture deterministically and writes PNGs to
`build/shots/current/`; `cp -r build/shots/current/* build/shots/baseline/`
accepts them. The vitest comparator then pixel-diffs current against baseline
(<1% differing pixels passes) and is skipped when shots have not been
generated. Baselines stay **outside git** deliberately: every pixel derives
from the user's copyrighted game assets.

## Browser client

`vn serve <irDir> <assetsDir>` bundles `src/web/` (esbuild) and serves the
playable client on top of `GameSession` and `PixiStage`: authored transitions
(crossfades, fades, waits — all skippable by click), sprite compositing and
movement, route-reachable screen effects, choices, BGM/SE/voice, ending
movies, and scene chaining with persistent variables — plus a **backlog**
overlay (L), **auto mode** (A; paced by manifest voice durations), **skip
mode** (Ctrl or toggle; renders instantly), and a **localStorage save slot**
with identical-resume semantics.
It consumes only `/ir/*.json` + `/assets/manifest.json` and knows no scene
names (the start scene is a URL parameter).

## Status

A complete route plays from New Game to an ending with zero scene-specific
code: op00 → t_1a…t_6b → tt6a → tt7a → y_ed (Tsugumi ending movie + coda) —
22 scenes, 12,308 lines, 43 choices, verified both headlessly
(`vn route build/ir`) and click-through in the browser. Alternative choice
policies reach the You bad end and the Sara good end + epilogue. Effects,
waits and still-unknown opcodes are surfaced through `onOp` rather than
executed.
