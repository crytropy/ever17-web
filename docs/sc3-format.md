# Ever17 PC — LNK / SC3 scenario format

Living specification, reverse engineered from `script.dat` of the Chinese PC
release (dwing patch, 2007-05-26; original engine: KID, 2002). Everything here
was derived **from the scenario files alone** — the Windows EXE has not been
analyzed. Statements carry confidence labels:

* **Confirmed** — mechanically validated across the whole archive (104/104 scripts).
* **High** — consistent across many scripts, semantic reading fits all observed uses.
* **Medium** — plausible reading, limited or indirect evidence.
* **Low** — informed guess, structure known but meaning uncertain.
* **Unknown** — structure (length/operands) known; meaning not assigned.

Sizes/offsets are little-endian unless noted. Expression immediates are the one
big-endian exception.

---

## 1. LNK archive (`script.dat`, and every other `.dat`) — Confirmed

```
0x00  char magic[4]     "LNK\0"
0x04  u32  entryCount   script.dat: 104
0x08  u8   reserved[8]  all zero in every shipped archive
0x10  entry[entryCount]:
        u32  offset     relative to dataStart = 0x10 + 32*entryCount
        u32  sizeField  (size << 1) | compressedFlag
        char name[24]   NUL-padded ASCII
      ... file data, contiguous, in index order
```

Validation results for `script.dat`: 104 entries, zero gaps, zero duplicates,
last entry ends exactly at EOF, every entry begins with `SC3\0`, no entry has
the compressed flag set. The same container is used by `bg.dat` (481 .cps),
`chara.dat` (864 .cps), `bgm.dat` (28 .waf: `bgm01..bgm28`), `se.dat`
(308 .waf, names matching the `10 05` operands), `voice.dat` (14352 .waf,
names matching text-chunk voice tags lowercased), `saver.dat` (17 more .scr),
etc.

Script name references in bytecode (`10 01 "SC1A"`) resolve case-insensitively
without the `.scr` extension.

## 2. SC3 container — Confirmed

```
0x00  char magic[4]        "SC3\0"
0x04  u32  textTableOffset      start of the chunk-offset table (= end of code)
0x08  u32  graphicsListOffset   boundary INSIDE the chunk-offset table
0x0C  u32  codeStartOffset      first instruction after the 10 24 preamble
0x10  u32  entryTable[]         sorted addresses, no explicit count
...   code
textTableOffset:
      u32  textChunkOffsets[(graphicsListOffset - textTableOffset) / 4]
graphicsListOffset:
      u32  resourceChunkOffsets[]   (no explicit count, see below)
...   chunk payloads, contiguous to EOF
```

### 2.1 Entry-address table — Confirmed

A sorted (non-decreasing, duplicates allowed) list of u32 file offsets starting
at 0x10. There is **no length field**: the table ends where the next u32 stops
being a plausible address (in practice the first code bytes `10 24 ...` read as
a huge number). The parser uses: value must be in `[0x10, textTableOffset)` and
non-decreasing.

Jump targets (`00 07`), choice targets (`27`/`00 27`) and switch tables
(`00 08`) reference this table by **1-based index**.
Evidence: debug.scr's menu tree — `00 07 04 00` at the head jumps to
entry#4 = 0x311 which is the menu-display code; `00 07 05 00` at the menu's
fall-through re-enters the menu (selection idle loop); s_1a's option rows
target entry#1/#2 = 0x29D/0x2B1 and both branches end with `00 07 03 00` →
entry#3 = 0x2E0, the merge block.

Quirk (Confirmed observation, unexplained purpose): some entries point *into*
an instruction — specifically at the final "mode" expression operand of
`10 12`/`10 16` sprite commands (e.g. s_1a2 entry → 0x5C0, the `83 00 00` tail
of a `10 12`). No bytecode references those entries via `00 07`/`27`;
hypothesis: engine-side resume/skip positions.

### 2.2 The `10 24` preamble

Story scripts open with `10 24 <sceneId>` *before* `codeStartOffset`;
`codeStartOffset` points just past it. `startup.scr`/`system.scr` have no
preamble (`codeStartOffset` == entry-table end). Scene ids are small integers
matching archive order (sc1a=3 … ycep=263; all debug scripts use 0).
`10 24` also reappears mid-file at section boundaries (save/backlog markers).

### 2.3 Chunk tables — Confirmed

`textTableOffset..graphicsListOffset` is an array of u32 offsets of **text
chunks**; `graphicsListOffset..` holds the **resource chunk** offsets. The
resource table's length is implicit: read u32s until the read position reaches
the smallest payload offset seen so far (story scripts store text payloads
first; startup/system store resource payloads first).

Resource chunks are NUL-terminated ASCII asset names (`bg01a1`, `YU02BDM`,
`my01adl`, `EV_YU01A`, …) resolved against `bg.dat`/`chara.dat`. Text chunks
are token streams (§5). Chunks are *not* all NUL-terminated strings; each
chunk's size is the distance to the next payload offset (or EOF).

## 3. Expression encoding — encoding Confirmed, semantics partial

Numeric operands are token streams terminated by `0x00`:

* byte ≥ 0x80 — immediate. `(byte & 0xE0)` selects total width, value is
  big-endian with the low 5 bits of the first byte as the top bits:
  * `0x80..0x9F` — 1 byte, value = `b & 0x1F` (0..31)
  * `0xA0..0xBF` — 2 bytes, value = `(b & 0x1F) << 8 | b1` (`a1 40` = 320)
  * `0xC0..0xDF` — 3 bytes (`c0 12 27` = 0x1227)
  * `0xE0..0xFF` — 5 bytes: full big-endian u32 in the next four bytes (head
    bits unused). Confirmed at three sites: quake parameter writes
    (`e0 00 00 28 00` = 0x2800 followed by operator 0x06) and system.scr's
    `01 01 <E> <E>` pairs.
* byte < 0x80 — operator (one byte).
* `0x00` — terminator.

**Immediate-pad rule (Confirmed empirically, purpose unknown):** when the last
token before the terminator is an immediate, exactly one extra `0x00` follows
the terminator. Expressions ending in an operator have no pad. Zero exceptions
across 104 scripts *except* the `V`-type operands of `00 10`/`00 11`
(startup/system), which never carry the pad — suggesting the VM has two
scalar-reading routines.

Values are used raw (no fixed-point scaling): sprite x=320 = screen center of
the 640-wide screen, BGM volume 100, frame counts 30/60/120.

### 3.1 Operator bytes (semantics: Low/Unknown)

Recurring shapes rather than proven meanings:

| shape | where | reading (tentative) |
|---|---|---|
| `0a <var> 14 14` | lhs of `fe 28` | load variable, compare with rhs operand |
| `0a <var> 14 17/18/20/1b` | lhs of `fe 2d` | other comparison relations |
| `28 0a <var> 14` | `00 26` (choice), `00 0a` (assign) | variable reference as *lvalue* |
| `28 0a <var> 14 0c/0d 01 <imm> 01` | `00 0a` | read-modify-write of a variable |
| `2d 0a <var> 14` | `10 2e` arg2 | computed value from a variable |

Variable ids observed: 171 (`0xAB`, guards every `00 05` wait — likely a global
"wait/skip enabled" setting), 1203 (`0x4B3`, the choice-selection register used
by `10 1a`/`00 26` everywhere), 1200–1202/1274 (route/progress flags tested at
scene heads), 1050/1210/1245… (story flags written by `00 0a`).

## 4. Instruction encoding

Opcodes are one byte (`26`, `27`, `02`, `03`, `ff`) or two bytes
(`00 xx`, `01 xx`, `10 xx`, `80 xx`, `fe xx`). A lone `0x00` immediately
before a decodable instruction is a pad byte (seen between choice option rows
and ahead of `10 20`); the disassembler records these explicitly.

Operand signature letters used below: `E` expression; `V` expression without
imm-pad; `W` u16; `J` u16 1-based entry index; `B` byte; `4` four raw bytes
(observed all-zero, before every resource index — meaning unknown; **not
assumed padding**, preserved and checked); `R` u16 resource index; `S`
NUL-terminated ASCII; `T` `0xFF` + u16 text-chunk index; `L` implicit-length
u16 table.

### 4.1 Opcode table

Confidence and evidence for the interesting ones; the full machine-readable
table lives in `src/sc3/opcodes.ts`.

| opcode | sig | name | conf. | evidence / notes |
|---|---|---|---|---|
| `00 07` | J | JUMP | Confirmed | debug menu loops; s_1a merge (entry#3=0x2E0) |
| `27` / `00 27` | E J | CHOICE_OPTION | Confirmed | debug.scr 10-option menus target entries #7/#0x14/#0x37… = submenu display code; s_1a options → 0x29D/0x2B1 |
| `ff` | W | SHOW_CHOICE | Confirmed | operand = chunk with `0b`-structured options (§5); always followed by `10 1a` |
| `10 1a` | E E | CHOICE_BEGIN | Confirmed | (result var — always 1203, choice id). s_1a story choice id = 44; debug menus use dummy id 1000 |
| `00 26` | E | CHOICE_COND | High | expr `28 0a 1203 14` (selection register as lvalue) between CHOICE_BEGIN and rows |
| `00 1a` | — | CHOICE_END | Medium | closes choice regions |
| `fe 28` | E E | IF_EQ | High | guards exactly the next instruction (debug menu3: `fe 28 <flag test> <10 01 OP00>`); rhs is a comparison value — the same value `0x1227` recurs across 8+ files, tiny values 0/1/5 common. Polarity unproven |
| `fe 2d`, `fe 2e` | E E | IF_* | Medium | comparison variants (different relation ops in lhs) |
| `00 08` | E L | SWITCH | High | selector expr + u16 entry-index table; table length implicit (startup/system only) |
| `10 01` | S | GOTO_SCRIPT | Confirmed | `"debug"`, `"OP00"`, `"SC2F"`… case-insensitive |
| `10 19` | T | MESSAGE | Confirmed | 5 bytes; sequential chunk refs throughout every script |
| `10 0c` | 4REE | SET_BG | Confirmed | debug_bg1–8: resource index sweeps the CG list in lockstep with texts naming each CG. args: (fade 0=cut/6=fade, plane 1|2) |
| `10 27` | 4REE | SET_BG_B | Medium | SET_BG variant interleaved in CG sequences |
| `10 0f` | E4REE | SET_SPRITE | Confirmed | debug_ch1–11: slot 1/2/4, x=320/128/512/176/464, mode 0|3 |
| `10 12` | EE4R4REEE | SET_SPRITE_2 | High | two consecutive resources + x1/x2 (128/512) + mode |
| `10 16` | 4R4R4REEEE | SET_SPRITE_3 | High | three consecutive resources + x=128/512/320 + mode |
| `10 10` | EE | CLEAR_SPRITE | High | (slot 1|2|4, mode 0|3); precedes replacements |
| `10 14` | EEE | SPRITE_ORDER | Medium | permutations of (0,1,2), occasionally 255 |
| `10 0d` | EEE | FILL_SCREEN | High | debug_ch* 背景黒/背景白 choice → (color 0/1, fade 0|6, plane) |
| `10 05` | SEE | PLAY_SE | Confirmed | 1136 uses; names match se.dat (`L` suffix = loop) |
| `10 03` | EE | PLAY_BGM | Medium | (track ≤28 matching bgm01–28.waf, 100=volume) at scene starts |
| `10 04` | — | STOP_BGM | Low | near PLAY_BGM sites |
| `10 39` | S | PLAY_MOVIE | High | `"ever17"` (OP), `"MOV01A/02A"`, `"sdr640"` (staff roll), `"END_*00"` ending cards |
| `10 1f` | EE | SET_CLOCK | High | (hour 0..23, minute) — the timestamp overlay |
| `10 1e` | E | WAIT_FRAMES | Medium | 30/60/90/120/180 |
| `00 05` | E | WAIT | Medium | always guarded by `fe 28 [0a 171 14 14] …` after staged transitions |
| `10 18` | — | TRANSITION_SYNC | Medium | brackets staged bg/sprite updates |
| `10 45` | EE | TRANSITION_TIME | Medium | (frames 0/3/6/12/18/24, mode 0|1) |
| `10 24` | E | SCENE_MARKER | High | §2.2 |
| `10 08` | S | SAVE_POINT | Medium | `"S5A000"`… chapter ids |
| `00 0a` | BEW | SET_VAR | Medium | expr writes a flag; u16 arg unknown |
| `10 41` | EEEEE | VIEWPORT_RECT | Low | (x,y,w,h,frames), rects up to 800×600 |
| `10 40` | 4REEEEEE | CG_EFFECT | Low | resource + 6 exprs incl. rect-like values |
| `10 20` | E | EFFECT_ON | High | debug.scr effect test labels each id: 4=QUA1, 5=QUA2, 12=quake (params vars 571-576, values incl. 0x2800/0xA0000 - fixed-point?), 18=sakura petals, 26=rain (intensity var 569), 27=sunbeams (variant var 568), 32=filter2, 41=snow, 44=filter, 45=blink, 46=flash, 47/48/49=map eyecatch/position/route |
| `10 21` | E | EFFECT_OFF | Medium | stops by category: filter+filter2 → 13, sunbeams → 7, rain → 6, snow → 14; mapping incomplete |
| `00 0d` | E W | SHAKE | Medium | paired with QUA1_CH / CHR_QUA labels; (mode, amplitude/duration 194..346) |
| `10 41` | E×5 | VIEWPORT_RECT | Medium | zooms to (x,y,w,h) over N frames (effect test: (332,185,200,150) in 90) |
| `10 46`, `10 26`, `10 2e`, `10 13`, `10 15`, `10 1d`, `10 37`, `10 06/07/09`, `10 3a/3b/3c`, `10 2b`, `10 43`, `00 28`, `00 0c/0e/0f`, `00 10/11/12/13/15/19`, `01 xx`, `80 13/18`, `02`, `03` | various | — | Unknown/Low | structure pinned, semantics open; see opcodes.ts notes |

### 4.2 Known open decoding issues

* `system.scr` has ~20% undecoded bytes and `startup.scr` ~10% (debug.scr
  and every story script decode fully). Causes: inline data (u32 jump tables,
  the `"T_1A\0T_2A\0…"` scene-name string table in startup.scr — detected and
  reported as string-table data regions) and a handful of `00/01/80`-class
  opcodes whose operand layouts are still unproven. All gaps are surfaced as
  `.data` regions, never skipped silently.

## 5. Text chunk format — Confirmed structure

Token stream, `0x00`-terminated. Bytes ≥ 0x20 are text (bytes ≥ 0x80 start a
2-byte character — GBK in this release's story scripts, Shift-JIS in the
`debug*` scripts). Control codes:

| code | args | meaning | conf. |
|---|---|---|---|
| `0x0E` | — | segment start (new message) | Confirmed |
| `0x0D` | cstring | voice id (`"S1A012"` → voice.dat `s1a012.waf`) | Confirmed |
| `0x05` | expr | segment parameter — observed value 0 in all 45639 uses | Confirmed shape |
| `0x01` | — | line break; separates 【speaker】 from body; terminates option text | Confirmed |
| `0x02` | — | message end (wait for input) | High |
| `0x03` | — | page end / clear | High |
| `0x0B 0x00` | u16 | choice header: **choice id** (44 = s_1a's 谢谢/不需要) | Confirmed |
| `0x0B 0x01` | text…`0x01` | choice option text | Confirmed |
| `0x0A` | expr | option visibility condition (empty = always) | High |
| `0x04` | expr | inline wait (30/60) | Medium |
| `0x10/0x11/0x14` | u8 | unknown 2-byte controls | Unknown |
| `0x0C` | — | unknown 1-byte control | Unknown |

Speaker names are wrapped 【…】 as the first line in the Chinese release; the
parser exposes raw lines and the IR layer splits speaker/body on that pattern.

## 6. Control flow model

* Sequential execution; `00 07` jump; `10 01` cross-script transfer.
* `fe 28/2d/2e <lhs> <rhs>`: conditionally executes **exactly the next
  instruction** (typically `00 07`, `10 01`, or `00 05`). Chains of guards
  appear at scene heads testing route flags.
* Choices: `ff <chunk>` displays options; `10 1a <reg> <id>` blocks until the
  player picks and stores the selected option index in the register (always
  var 1203); `00 26` supplies the register lvalue; optional `27`/`00 27` rows
  then dispatch option index → entry target, branches typically rejoining via
  `00 07` at a shared merge entry. Rowless choices exist (debug.scr:
  `SHOW_CHOICE; CHOICE_BEGIN; GOTO_SCRIPT "YC3A"`): the target scene reads
  var 1203 itself (yc3a.scr / tc2b.scr test it at their heads) - so 1203 is a
  cross-script selection register.
* `00 08` computed jump over an entry-index table.

## 7. Confirmed worked examples

* **debug_bg8**: 240 × (`SET_BG bg…`, `SET_SPRITE YU02BDM`, `MESSAGE`) then
  `GOTO_SCRIPT "debug"`; text chunks name each CG being shown. 100% decode.
* **s_1a choice 44** (`SHOW_CHOICE 20`): options 谢谢→0x29D / 不需要→0x2B1,
  both `JUMP entry#3`→0x2E0 merge; 0x29D contains an `IF_EQ`-guarded extra
  line (voice S1A0xx 「谢谢……」).
* **debug.scr**: 3-level test menu tree (10 options per page) fully mapped via
  `27`-row targets; menu idle loops via `00 07` self/redisplay jumps.

## 8. Open questions

1. Meaning of the always-zero 4-byte block before resource indexes.
2. `fe 28` polarity (execute-on-true vs execute-on-false) and the exact
   relation encoded by `14 14` vs `14 17` etc.
3. The immediate-pad rule's real grammar (probably an artifact of the VM's
   expression evaluator; harmless for parsing).
4. Semantics of `10 20`/`10 21`/`10 46` (very frequent, ids ≤ 48 — ambient
   loops? window modes?), `00 28`, and most `01 xx`/`80 xx` system ops.
5. Entry points into instruction tails (§2.1 quirk).
6. The `10 21` category-id mapping; `10 1a` timeout behaviour (arg 1000 in
   every debug menu vs real ids in story choices).
7. Voice-tag ↔ per-character mapping (`voice.dat` also holds `c1s*`-style
   names not seen in tags yet).

Next avenues, in order: differential play-testing against the real engine;
only then the EXE.
