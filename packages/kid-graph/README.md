# kid-graph

(Renamed from `vn-graph` in phase 6A; depends only on `kid-contracts` and
`kid-runtime` - the former runtime/graph cycle is gone.)

Route-graph model, automatic explorer and completion analysis over the
Ever17 IR and the vn-runtime engine. This package turns the recovered VM
execution model into a first-class, inspectable representation of the game's
narrative structure: static analysis says what is *possible*, runtime tracing
says what *actually happens*, and every output combines both.

Nothing here hardcodes scene names, choice ids, variable ids or ending names
— every fact is derived from the IR or from execution traces.

## Model (`src/model.ts`, `src/build.ts`)

`buildGraphModel(scenes, start)` walks every scene's IR and produces:

- **SceneNode** — lines/blocks/choice sites, `terminal` (no outgoing
  transitions), `canEnd` (a reachable path runs off a next-less block),
  referenced movies and assets, head-dispatch rows; `outgoing`/`incoming`
  link to shared Transition objects.
- **Transition** — one `gotoScene` site, classified by a small intra-scene
  analysis (blocks split into segments at choices; a label closure tracks
  which options reach each segment; a guard pass finds single-condition
  entries):
  - `choice` — reached only from one option of one choice (carries
    `{id, option, text}`),
  - `conditional` — guarded by one varJump condition,
  - `ending` — its writes assign the value a dispatch row in the target
    scene tests (the route-committing edges: `1223 := k` before `GOTO Y_ED`),
  - `linear` — everything else.
  Every transition also carries its constant `writes` (transfer state).
- **EndingInfo** — static candidates: one per dispatch row in a `canEnd`
  scene whose tested value is actually assigned somewhere, plus one per
  bare terminal scene. Exploration upgrades these to `static+observed`.

JSON round-trips via `toJson`/`fromJson` (`format: "e17vn-graph"`).

## Explorer (`src/explore.ts`)

`explore(source, opts)` drives the real **GameSession** — the same engine,
save format and condition evaluation as interactive play; there is no second
execution engine. At every choice the session is saved; option 0 continues
in place, every other enabled option becomes a branch restored later from
that save.

What makes it terminate and scale:

- **Sound state dedup** — a branch is pruned when its save fingerprint has
  been seen. `buildVarAbstraction` keeps fingerprints small *soundly*: only
  the scenario's read set matters (writes to never-read vars can't influence
  control flow — story writes are constants), and a var with no reachable
  add-writes left is projected to its cell among the comparison constants
  (two states in the same cell answer every remaining comparison
  identically).
- **Depth-first scheduling with novelty seasoning** — endings live at the
  ends of long chains, so lineage completion (LIFO) dominates; every 4th
  pop takes the least-expanded choice site instead so no region starves.
- **Chained playthroughs** — `detectCrossRunVars` finds flags whose writes
  cannot reach their readers within one run (the ending scene writes what
  the early chapters read): cross-playthrough state. Reaching an ending
  enqueues a New Game carrying those flags, up to `--playthroughs`
  generations — this is how the all-routes-cleared unlock and the
  second-run fragment scenes are exercised.
- **Trajectory replays (Go-Explore)** — each known ending's choice script is
  replayed under each new carry, whole and with the last 1/2/4/8/… answers
  dropped: the run rides a known trajectory deep into the game and branches
  near the tip, where sibling endings differ. Replay branches are scheduled
  hot.

Ending identity is also data-derived: runs aggregate by (terminal movie or
scene) plus the **dispatch signature** — the `== value` rows that held while
the same register was dispatched over — and the display name prefers the
**distinctive movie** (played on every path of this ending and on no other
ending's every-path set), which drops shared staff rolls and cutscenes.

Output (`format: "e17vn-exploration"`): endings with required/free choices,
consistent condition outcomes, final variables and sample paths; scene,
choice and transition coverage; unknown-op counts; anomalies; stats.

## CLI (via `vn`)

```bash
vn graph <irDir> -o build/route-graph.json          # + --format dot|html
vn graph <irDir> -o build/route-graph.html --format html
vn explore <irDir> -o build/exploration.json        # --playthroughs 6 default
vn endings <irDir>                                  # static + observed merge
vn explain-ending <irDir> <endingId>                # why an ending happens
```

`--format html` writes a standalone interactive viewer (zoom/pan, automatic
layered layout, per-scene panel) — a single self-contained file.

## Explanation (`src/explain.ts`)

`explainEnding(graph, exploration, id)` answers "why did I get this ending?"
from generated data only: choices answered identically on every explored
path to it, the route-committing writes and dispatch conditions, gates whose
outcome discriminates it from other endings, critical scenes, and whether it
needs carried-over flags from prior playthroughs.

## Browser pieces

`layout.ts` (deterministic layered layout) and `viewer.ts` (SVG pan/zoom
renderer) are browser-safe and shared by the standalone HTML export and the
web client's `/routes` page. The web page consumes graph JSON only.
