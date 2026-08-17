# e17-assets

CPS/PRT image and WAF audio decoders for the PC version of **Ever17 -the out of
infinity-** (KID engine), plus scene-driven extraction into web-friendly PNG and
WAV.

**No game assets are included or redistributed.** You supply your own
installation.

## What it does

* **CPS images** — deobfuscate (LCG keystream), decompress (KID RLE), parse the
  PRT bitmap, emit top-down straight-alpha RGBA / PNG. Handles 24-bit BGR with
  an alpha plane, bottom-up padded rows, and the v0x66 sprite anchor fields.
* **WAF audio** — parse the header, decode MS-ADPCM to 16-bit PCM, emit WAV.
* **sysvoice.dat** — recognised as headerless raw PCM rather than WAF
  ([why](docs/asset-formats.md#41-sysvoicedat-is-not-waf--high)).
* **Scene extraction** — read a decompiled IR scene, collect every asset it
  references (backgrounds, sprites, SE, BGM, voice), extract only those, and
  write a `manifest.json` the runtime consumes.

Decoders are validated byte-for-byte against an independent port of the
reference implementation; see [docs/asset-formats.md](docs/asset-formats.md).

## CLI

```bash
npm run e17-assets -- archives     <gameDir>
npm run e17-assets -- list         <gameDir> bg.dat
npm run e17-assets -- info         <gameDir> bg01a1
npm run e17-assets -- extract      <gameDir> bg01a1 yu02bdm s1a012 -o out/
npm run e17-assets -- scene        <gameDir> build/ir/s_1a.json -o build/assets/s_1a
```

`scene` is the one that matters: it turns "this scene" into "exactly the assets
this scene needs", which is ~136 MB for `s_1a` instead of the ~1.7 GB the game
ships.

## Library

```ts
import { AssetLibrary, decodeCps, decodeWaf, pcmToWav, encodePng } from "e17-assets";

const lib = new AssetLibrary("/path/to/game");
const bg = lib.resolve("bg01a1", "image")!;
const img = decodeCps(bg.entry.data);          // { width, height, rgba, hasAlpha, baseLeftOffset }

const voice = lib.resolve("s1a012", "audio")!;
const wav = pcmToWav(decodeWaf(voice.entry.data));
```

Bare names are not globally unique (all 168 `sysNNN` entries exist in both
`se.dat` and `sysvoice.dat`), so `resolve()` takes an optional `{ archive }`
hint and `resolveAll()` lists every candidate.

## Tests

```bash
npm test
```

Synthetic codec tests always run; archive-backed tests need the game files
(auto-detected at `../ever17games`, override with `E17_GAME_DIR`).
