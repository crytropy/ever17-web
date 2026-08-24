# ever17-web

A local-first browser version of **Ever17 -the out of infinity-** (KID,
2002). It converts files from a user-owned PC installation on the user's own
machine and serves the game locally with one command.

This repository includes the runtime and toolchain components needed to build
ever17-web. They are internal implementation packages here, not a separately
released engine or a compatibility claim for other KID games.

**This repository contains no Ever17 story text, images, voice, music or
movies, and no other copyrighted game content.** Everything the player shows
is derived, on your machine, from files you supply.

## Playing Ever17 with your own copy

You need the files of a legally obtained Ever17 PC installation. Point the
tool at that directory:

```bash
npm install
npm run ever17 -- serve --game-dir "/absolute/path/to/Ever17"
```

The command:

1. validates the directory and reports exactly which files it found;
2. converts the scenario and indexes every referenced asset into a local
   cache (about a minute on first run);
3. starts a local web server bound to `127.0.0.1` and opens the game at
   New Game (`--no-open` to skip the browser launch, `--port`/`--host` to
   change the binding — keep it local; never host the converted content).

Other commands: `check` validates and lists the files without converting,
`prepare` converts without serving, and `diagnostics` prints the versions and
import summary a bug report needs (no story text, artwork or audio). Inside
this repository a `./ever17games` directory is used automatically when no
`--game-dir` is given.

**Flags worth knowing**

| flag | effect |
|---|---|
| `--rebuild` | regenerate the package even if the cached one is valid |
| `--verify` | re-hash every source file instead of trusting the digest index |
| `--out <dir>` | cache root (default `.local/ever17`) |
| `--port`, `--host` | server binding (default `127.0.0.1:8017`) |
| `--no-open` | do not launch a browser |

**Files the tool expects** (derived from the actual import pipeline):

| file | role | required |
|---|---|---|
| `script.dat` | scenario scripts (SC3 bytecode in a LNK archive) | yes |
| `bg.dat`, `chara.dat`, `system.dat` | CPS/PRT image archives | yes |
| `bgm.dat`, `se.dat`, `voice.dat` | WAF (MS-ADPCM) audio archives | yes |
| `sysvoice.dat` | headerless-PCM audio archive | yes |
| `movie/*.e17` | MPEG-1 movies (byte-flipped container) | no — a text placeholder is shown without them; converting to `.mp4` needs `ffmpeg` on PATH |

**Where generated files live.** Everything derived from your game files goes
under `.local/ever17/`:

```
.local/ever17/
  digest-index.json            cached per-file hashes (paths into your install)
  <source-fingerprint>/
    game.json                  package metadata: versions, profile, branding
    import-report.json         what this import produced, and any problems
    ir/<scene>.json            the decompiled scenario
    assets/manifest.json       every asset the scenario references
    assets/images|audio/       converted on first play, cached here
    assets/movies/*.mp4        converted during import
    narrative.json             chapter names, read from the game's own menus
```

**When a re-import happens.** The fingerprint is a SHA-256 content digest of
every file the importer reads — `script.dat`, all seven archives and every
movie — so replacing any of them, even with a file of the same size, produces
a different fingerprint and a fresh import. Hashing your ~1.4 GB installation
takes about a second and is cached in `digest-index.json`, keyed by path,
size, nanosecond mtime and inode; if a file's stat identity is unchanged the
stored digest is reused. Pass `--verify` to ignore that cache and re-hash
everything.

**Cache validation.** Before a cached package is served it is checked for
real: `game.json` must parse and carry a supported package schema, profile
version and a compatible engine version; the game id and fingerprint must
match; `import-report.json` must show a completed import of the same source;
the manifest must parse at a supported schema and agree with the recorded
asset count; and the IR directory must contain the start scene and every
scene the import recorded. A package that fails any of these is never served
— it is rebuilt automatically, with the reasons printed. If only the product
branding has drifted, the metadata is refreshed in place instead of
reconverting.

**Atomic imports.** An import builds into a temporary sibling directory and is
promoted into place only after every script decompiled and the result passed
the same validation a reuse would apply. A failed import — including a single
script that will not decompile — writes no package and leaves any previously
working one untouched, so `--rebuild` can never leave you worse off than
before you ran it.

**Interrupted imports recover.** Promotion is two renames: the current package
steps aside, then the new one takes its name. If a process dies between them,
the next run puts the retired copy back rather than rebuilding, and a retired
copy is never deleted on age alone — only once a valid package is in place.
Concurrent imports serialize their renames through an advisory lock.

**Clearing the cache.** Delete `.local/ever17/` to reclaim the space, or
delete one `<fingerprint>/` directory to drop a single installation's
package. `npm run ever17 -- diagnostics` lists the cached packages and marks
obsolete ones. Your saves and settings live in the browser, not in the cache,
so clearing it never loses progress.

**Distribution boundary.** `.local/`, `build/` and the game directory are
gitignored. Generated IR, converted assets, screenshots of game content and
the cache are derived from copyrighted material: do not commit them, do not
redistribute them, and do not serve them beyond your own machine. The server
binds `127.0.0.1` by default and there is no deployment path for generated
content. The tools in this repository read your copy locally and nothing else.

**Playing it.** The title screen offers New Game, Continue (naming the
chapter you left off in), Load, Settings and Records. In game, the arrow keys
are the obvious pair: **↑** opens the backlog and **↑** again puts it away, so
one key takes you back through what was said and returns you to the story.
**↓** goes on to the next line, as does a click, Enter or space, and it also
closes the backlog. Then `A` auto, `Ctrl`/`S`kip, `L` backlog, `Q` quicksave,
`S`/`D` save and load menus, `O` settings, `R` records, `T` back to the title,
`Esc` closes whatever is open. Auto paces itself by how much there is to read
and never cuts a voiced line short; its speed is a Fast / Normal / Slow
setting.

While any panel is open - Settings, save/load, a confirmation, RECORDS or the
title screen - the story keys do nothing, so nothing advances behind your
back; and a focused slider or dropdown keeps its own arrow keys.

**Going back to a line.** In the backlog, a line you have read this session
can be clicked to return to exactly that sentence — the story resumes from
there with the variables it had at the time. Lines carried in from a loaded
save are shown but not clickable: the save records where you were, not the
route you took to get there, so there is no earlier moment to return to.

**Saving.** Ninety-nine numbered slots, plus a quicksave (`Q`) and an
autosave written at each scene change. A full save is about 24 KB, so even a
complete set stays well inside what a browser gives one site.

**Your progress is yours.** Saves, settings, cross-run progress and the
records screen live in the browser. Settings → PLAYER DATA exports all of it
to a JSON file and imports it back - useful before clearing site data, or to
move to another browser. Importing merges: it never removes a save or revokes
something already unlocked, and a file that fails validation is refused whole
before a single key is written.

> **An export is not free of game content — keep it private.** Every save
> carries its dialogue backlog, so the file contains the story text you had
> recently read, and a slot's thumbnail is a picture of the screen at that
> moment. The file stays on your machine unless you share it, and that is how
> it should stay: do not commit it to a repository and do not post it
> publicly. The same copyright rules as the rest of the converted content
> apply to it.

**Playing more than once.** Ever17 is built to be replayed - finishing routes
is what opens the last one - so route-clear state is carried across New Game
sessions. Which variables persist is derived from the scenario during import,
not hardcoded, and stored in the game package. New Game therefore starts a
fresh story but keeps what you have unlocked; a route counts as cleared only
when you actually reach its ending, so saving inside an ending and quitting
before it finishes changes nothing.

**Starting completely fresh.** Settings → PLAYER DATA → *start completely
fresh* is the only way to erase progress, and it always asks first, listing
exactly what goes (saves, quicksave, Continue, cross-playthrough unlocks,
records) and what stays (your installation, the converted assets, your
settings). Nothing else in the tooling ever resets a player's data.

Under the hood each reset moves a *generation* pointer, and saves are stored
beneath it (`e17vn:play:<n>:…`). The pointer moves in one write, so a reset
interrupted halfway still leaves you on empty data rather than half-erased
data, and a tab left open on the old generation notices, stops, and cannot
write into the new one. Data written before generations existed is generation
0 and is read in place - nothing is copied or deleted to migrate it.

**Records, not a graph.** `/records` is the player-facing screen: chapters you
have visited, days you have played, endings you have collected. Nothing you
have not reached is listed - not even as a blank - because a row of locked
placeholders is a count, and how many endings a story has is part of the
story. It says only whether anything remains. The full technical route graph is still available for
development at `/debug/routes` - it shows the whole game and will spoil it.

**Reporting playthrough bugs.** Full validation of all eight endings is
user-led by design — the agent that built this does not play the game for
you. [`docs/manual-playthrough-checklist.md`](docs/manual-playthrough-checklist.md)
is the record sheet: route coverage, a per-session sanity pass, issue blocks
that ask for the scene, the save slot and the console output, and a note on
which known issues are already accounted for.

## Repository layout

```
packages/            game-independent runtime components (internal)
  kid-contracts/     versioned JSON contracts: scene IR, manifests, events,
                     presentation state, saves, GameProfile, game packages
  kid-runtime/       scene VM, multi-scene sessions, deterministic saves
                     (browser-safe core; Node helpers under kid-runtime/node)
  kid-renderer-pixi/ Pixi presentation renderer over PresentationState
  kid-web-player/    browser player (dialogue, choices, audio, save/load UI,
                     backlog, auto/skip, settings, PWA) + local dev server
  kid-graph/         route graph, automatic explorer, ending analysis (optional)

adapters/
  ever17-pc/         the Ever17 adapter: installation discovery/validation,
                     LNK/SC3 -> IR conversion, CPS/WAF/movie conversion,
                     source fingerprinting, and the Ever17 GameProfile
                     (canvas 800x600, sprite space 640, bgmNN naming, ending
                     scenes, effect table, storage namespace)

apps/
  ever17-web/        the product: one-command CLI, Ever17 branding, and the
                     developer vn/vn-graph compatibility CLIs

e17-parser/          Ever17 LNK/SC3 parser, disassembler, CFG, IR decompiler
e17-assets/          Ever17 CPS/PRT image and WAF/PCM audio decoders
```

Dependency direction (enforced by tests in
`packages/kid-contracts/test/boundaries.test.ts`):

```
ever17-web ─▶ ever17-pc ─▶ e17-parser, e17-assets, kid-contracts
    │
    └──────▶ kid-web-player ─▶ kid-graph ─▶ kid-runtime ─▶ kid-contracts
                    └─────────▶ kid-renderer-pixi ────────▶ kid-contracts
```

The internal runtime packages never import the Ever17 parser, asset, or
adapter packages. Game-specific behavior enters through the `GameProfile` and
game-package metadata supplied by the adapter. This boundary keeps the product
maintainable without presenting the internal packages as a second project.

## Development

```bash
direnv allow    # or: nix develop
npm install
npm test        # full suite (game-file tests skip when absent)
npm run typecheck
```

Developer pipeline commands (compatibility aliases; the product workflow
above does all of this in one step):

```bash
GAME=ever17games

# scenario -> IR, assets for one scene, headless play
npm run e17 -- decompile-all $GAME/script.dat -o build/ir
npm run e17-assets -- scene $GAME build/ir/s_1a.json -o build/assets/s_1a
npm run vn -- play build/ir/s_1a.json build/assets/s_1a/manifest.json --choice 44=0
npm run vn -- route build/ir --start op00 --policy first

# route graph, exploration, endings
npm run vn -- graph build/ir -o build/route-graph.json --format json
npm run vn -- explore build/ir -o build/exploration.json
npm run vn -- endings build/ir
npm run vn -- explain-ending build/ir END_TU00

# dev server over a hand-built IR/assets pair (the ever17 CLI supersedes this)
npm run vn -- serve build/ir build/assets/s_1a
```

Tests that need the game files are skipped when absent; point at an
installation with `E17_SCRIPT_DAT` / `E17_GAME_DIR`, and at pipeline output
with `E17_IR_DIR` / `E17_ASSETS_DIR`.

### Browser testing must never touch a real player's data

Anything that drives the game in a browser — an automated agent, a smoke
test, a scripted QA pass — **must** run under a QA profile:

```bash
npm run ever17 -- serve --qa-profile my-run --port 8057 --no-open
```

`--qa-profile <id>` gives that server its own storage namespace
(`e17vn-qa-<id>`) and its own IndexedDB, so its saves, endings and unlock
flags are invisible to the ordinary `serve`, which always uses the production
namespace `e17vn`. Unit tests need nothing extra: they inject in-memory
stores. `apps/ever17-web/test/qa-profile.test.ts` asserts the two namespaces
can never coincide.

The rule this enforces: **a browser test result is invalid if it wrote a save,
an ending or a persistent flag into the real player's profile.** Progress the
player did not earn is indistinguishable from progress they did, and the only
cure — resetting — is theirs alone to choose. Never invoke *start completely
fresh* on someone's production profile, and never reset as a step in
migration, setup or testing.

## License and legal notice

Except where otherwise noted, the original source code in this repository is
Copyright (C) 2026 Empathy117 and is licensed under the **GNU General Public
License, version 2 or (at your option) any later version**
(`GPL-2.0-or-later`). See [`LICENSE`](LICENSE).

The Ever17 asset decoders were re-derived and reimplemented with reference to
the GPL-licensed [e17p project](https://github.com/uyjulian/e17p) by Sebastian
Hagen and Svein Ove Aas. Its attribution is preserved in [`NOTICE`](NOTICE).

This license applies to this repository's source code. It does **not** grant
rights to Ever17, its story, artwork, audio, movies, trademarks, or any data
supplied or generated from a user's installation. Those remain the property
of their respective rights holders. This is an unofficial preservation and
compatibility project and is not affiliated with or endorsed by KID or the
rights holders of Ever17.
