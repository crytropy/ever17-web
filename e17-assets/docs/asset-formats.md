# Ever17 PC — asset formats (CPS/PRT images, WAF audio)

Living specification for the media formats, reverse engineered from the
Chinese PC release. Same confidence labels as
[`../../e17-parser/docs/sc3-format.md`](../../e17-parser/docs/sc3-format.md).

The container is the same `LNK` archive documented there (§1). This file covers
what is *inside* the entries.

Prior art: the algorithms below were re-derived and re-implemented against
[uyjulian/e17p](https://github.com/uyjulian/e17p) (Sebastian Hagen / Svein Ove
Aas, GPL), a Python reimplementation of the Infinity engine. Our TypeScript
decoders are validated byte-for-byte against an independent port of that
reference (see "Validation" below).

---

## 1. Archive → format map — Confirmed

| archive | entries | ext | payload |
|---|---|---|---|
| `bg.dat` | 481 | `.cps` | backgrounds and event CGs |
| `chara.dat` | 864 | `.cps` | character sprites (alpha) |
| `system.dat` | 240 | `.cps` | UI parts |
| `bgm.dat` | 28 | `.waf` | music, `bgm01`..`bgm28` |
| `se.dat` | 308 | `.waf` | sound effects |
| `voice.dat` | 14352 | `.waf` | character voice |
| `sysvoice.dat` | 168 | `.wav` | **headerless raw PCM**, not WAF (§4) |

**Name collisions are real.** All 168 `sysNNN` names in `sysvoice.dat` are
shadowed by same-named entries in `se.dat`. Bare-name resolution therefore
cannot be unique; `AssetLibrary.resolve()` prefers `se.dat` (the archive the
scenario's `PLAY_SE` draws from) and takes an explicit `{ archive }` hint
otherwise. `resolveAll()` returns every candidate.

## 2. CPS container — Confirmed

```
0x00  char magic[4]     "CPS\0"
0x04  u32  fileSize     equals the LNK entry size
0x08  u16  type         0x0066 for every image in this release
0x0A  u8   compression  bit 0 set: RLE body; 0: stored
0x0B  u8   unknown      always 0x01
0x0C  u32  plainSize    size of the PRT payload
0x10  ...  obfuscated body
      u32  keyOffset    last 4 bytes (see §2.1)
```

`plainSize` is exactly `stride*height (+ width*height when alpha) + 36`, which
is how the decoder cross-checks its own geometry.

### 2.1 Obfuscation — Confirmed

The body is scrambled with a linear congruential keystream. The trailing u32
locates the 4-byte seed *inside the body*; that slot is skipped while
unscrambling, and the trailer is dropped afterwards.

```
vOff = u32le(data[len-4]) - 0x07534682          ; 0 means "not obfuscated"
key  = u32le(data[vOff]) + vOff + 0x03786425
for i = 0x10; i < len-4; i += 4:
    if i != vOff: u32le(data[i]) -= key + len
    key = key * 0x41C64E6D + 0x9B06
```

All arithmetic mod 2^32.

### 2.2 RLE codec — Confirmed

Control byte selects one of four operations:

| pattern | operation |
|---|---|
| `0b00xxxxxx` | literal run: `len = (c & 0x1F) + 1`, `+= next << 5` if `c & 0x20`, then `len` literal bytes |
| `0b01xxxxxx` | repeated block: `len = (c & 0x3F) + 2`, `iters = next + 1`; the same `len` source bytes are emitted `iters` times |
| `0b10xxxxxx` | back-reference: `len = ((c >> 2) & 0xF) + 2`, `dist = ((c & 3) << 8) + next + 1` |
| `0b11xxxxxx` | byte run: `len = (c & 0x1F) + 2`, `+= next << 5` if `c & 0x20`, then one byte repeated |

Back-references may overlap the write cursor (copy byte-by-byte). Runs clamp to
the remaining output. The same codec is used for WAF bodies in `voice.dat`.

## 3. PRT bitmap — Confirmed

```
0x00  char magic[4]   "PRT\0"
0x04  u16  version    0x65 (short) or 0x66 (long)
0x06  u16  colorDepth 8 (paletted) or 24 (BGR)
0x08  u16  paletteOffset
0x0A  u16  dataOffset
0x0C  u16  width          nominal
0x0E  u16  height
0x10  u32  hasAlpha       nonzero: 8-bit alpha plane follows the pixel plane
-- version 0x66 only --
0x14  u32  baseLeftOffset x of this bitmap inside the nominal frame
0x18  u32  unknown
0x1C  u32  width2         when nonzero, the real width
0x20  u32  height2        when nonzero, the real height
```

Pixel rows are **bottom-up** (BMP convention), padded to a 4-byte stride; the
alpha plane is **top-down** and unpadded. Backgrounds are 800×600 opaque;
character sprites are trimmed (e.g. 412×535) with `baseLeftOffset` recording
where the trim sits in the 800-wide frame — that is what makes sprite
positioning reproducible (see `vn-runtime`'s placement rule).

## 4. WAF audio — Confirmed

```
0x00  char magic[4]   "WAF\0"
0x04  u16  unknown    0 throughout
0x06  u16  channels   1 (voice) / 2 (SE, BGM)
0x08  u32  sampleRate 22050 throughout
0x0C  u32  byteRate
0x10  u16  blockAlign 512 (mono) / 1024 (stereo)
0x12  u8   extra[34]  MS-ADPCM extra format data, copied verbatim into a WAV fmt chunk
0x34  u32  dataLength
0x38  ...  MS-ADPCM body
```

The body is standard MS-ADPCM: per block a header carries predictor index,
initial delta and two priming samples per channel, then two 4-bit nibbles per
byte (high first, channels alternating in stereo).

### 4.1 sysvoice.dat is *not* WAF — High

Entries are named `.wav` and carry no header at all: they are raw 16-bit
little-endian mono PCM.

Evidence: lag-1 autocorrelation of the byte stream read as `int16` is **0.92**
at even offsets and **0.03** at odd ones — the signature of 16-bit samples
aligned at offset 0 — and the entries play back intelligibly at 22050 Hz mono,
the rate every other voice asset uses. Sample rate is therefore assumed rather
than read (Confidence: Medium for the rate specifically).

## 5. Validation

`e17-assets` is checked against an independent Python port of the reference
algorithm:

* **Images** — decoded RGBA is byte-identical for `bg01a1`, `bg01a3`,
  `ev_yu01a`, `yu02bdm` (alpha) and `smst05`, and every 37th entry of
  `bg.dat`/`chara.dat`/`system.dat` decodes to the geometry its header declares.
* **Audio** — decoded PCM is byte-identical for `s1a000` (mono voice),
  `se01_04` (stereo SE) and `bgm01` (113 s stereo BGM).

One bug was caught this way: an incorrect 4-bit sign extension
(`n - 16 + 8` instead of `n - 16`) that left images perfect but corrupted every
ADPCM sample. Unit tests now pin nibble sign-extension directly.

## 6. Open questions

1. The `unknown` byte at CPS `0x0B` (always `0x01`) and PRT `0x18`.
2. `sysvoice.dat`'s sample rate is inferred, not stored.
3. Paletted (8-bit) PRT images exist in the format but none were found in this
   release's archives, so that path is implemented but unexercised.
4. `movie/` holds the video assets referenced by `PLAY_MOVIE`; not yet examined.
