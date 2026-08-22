# Ever17 manual playthrough checklist

This is the record sheet for the part of validation that only a person can
do: actually playing the game. Automated tests cover the pipeline, the
runtime, saves and the import; nothing automated can tell you that a
transition feels wrong, that a voice belongs to the wrong line, or that a
scene looks different from the original.

**Nothing here is filled in.** Every row starts empty on purpose — results
belong to the person who played, not to the tool that generated the file.

## How to use it

1. Start the game the normal way:

   ```bash
   npm run ever17 -- serve --game-dir "/absolute/path/to/Ever17"
   ```

2. Play however you like. There is no required order, and you do not have to
   finish a route in one sitting — saves are per-slot and survive restarts.
3. When something looks wrong, stop and fill in one **Issue** block below.
   A half-remembered note a day later is worth much less than thirty seconds
   spent while it is still on screen.
4. Keep the browser console open (F12 → Console) so a red line is visible the
   moment it appears.

Two things make a report actionable more than anything else: **the save slot**
and **the scene name**. The HUD in the top-left corner shows the scene and
line (for example `t_1c · scene 4 · line 812`); with a save in a slot, the
exact moment can be reproduced.

## Route coverage

Tick a route when you have reached its ending and nothing in it is
outstanding. The ending names are the ones the game itself records — the
route explorer (`ROUTES` on the title screen, or `R` in game) shows which you
have collected.

| # | Route / ending | Reached (date) | Save slot | Appears in RECORDS? | Notes |
|---|---|---|---|---|---|
| 1 |  |  |  |  |  |
| 2 |  |  |  |  |  |
| 3 |  |  |  |  |  |
| 4 |  |  |  |  |  |
| 5 |  |  |  |  |  |
| 6 |  |  |  |  |  |
| 7 |  |  |  |  |  |
| 8 |  |  |  |  |  |

## Cross-playthrough progression

This is the part only a full set of playthroughs can confirm. The game is
built to be replayed: finishing a route records it, and finishing enough of
them opens the last one. The mechanism is tested with seeded state, but
whether it *feels* right over real playthroughs is yours to judge.

| Check | Result | Notes |
|---|---|---|
| After an ending, returning to the title keeps the progress |  |  |
| Starting a New Game after an ending behaves differently from the very first run |  |  |
| Route clears accumulate across separate sessions (close the tab, come back) |  |  |
| After the required routes are cleared, the final route becomes available in normal play |  |  |
| The final route is *not* reachable before that |  |  |
| Loading an old save does not undo a route you have already cleared |  |  |
| Save data export, then import into a fresh browser profile, restores everything |  |  |
| Saving inside an ending and quitting before it finishes does **not** clear the route |  |  |
| The route is credited only once the ending actually plays out |  |  |

## Starting over, if you ever want to

You should not need this to validate anything — every check above works on a
profile that already has progress. It is here because the option exists and
you should know what it does before you press it.

**Settings → PLAYER DATA → *start completely fresh***. It asks first and
lists what it removes (saves, quicksave, Continue, cross-playthrough unlocks,
RECORDS, the run in progress) and what it keeps (your installation, the
converted assets, your settings). *Export first* is offered in the same
dialog.

| Check | Result | Notes |
|---|---|---|
| The confirmation describes what will happen before anything is erased |  |  |
| After it, Continue is gone and RECORDS is empty |  |  |
| Settings (volume, Auto speed, transitions) survive |  |  |
| The game does not re-import or re-convert assets afterwards |  |  |
| A New Game after it behaves like a genuine first run |  |  |
| Export beforehand, import afterwards, brings everything back |  |  |

Nothing else resets your data — not an update, not an import, not a test run.

## Naming accuracy

The chapter names come from the game's own developer menus, rendered with the
character names this release uses. Worth a sceptical eye:

| Check | Result | Notes |
|---|---|---|
| HUD chapter name matches where you actually are |  |  |
| Route names match the characters they belong to |  |  |
| Day numbers line up with the story's own days |  |  |
| Epilogues and bad ends are labelled sensibly |  |  |
| Nothing in the ordinary UI shows a script id, line number or variable |  |  |

## Per-session sanity pass

Worth a quick check once per play session rather than once per line.

- [ ] Title screen: New Game, Continue, Load, Settings and Routes all respond
- [ ] Continue resumes the save you actually made last
- [ ] Text renders fully, no clipped or overlapping characters
- [ ] Speaker names match who is speaking
- [ ] Voice matches the line, and stops when you advance
- [ ] BGM changes at scene changes and loops without a gap
- [ ] Sound effects fire where they should
- [ ] Backgrounds and sprites appear, positioned sensibly
- [ ] Choices show every option you expect
- [ ] Auto advances at a comfortable pace, and longer lines wait longer
- [ ] Auto waits for a voiced line to finish before advancing
- [ ] Auto switches itself off when a choice appears
- [ ] Auto pauses while the backlog, save/load or settings are open
- [ ] Auto speed (Fast / Normal / Slow) makes an audible difference
- [ ] Skip mode is fast and stops when you turn it off
- [ ] Backlog (`L`) shows recent lines in order
- [ ] Save, then Load, returns to exactly the same line
- [ ] Returning to the title and back does not lose a save
- [ ] CONTINUE names the chapter you actually left off in
- [ ] RECORDS shows only chapters and endings you have reached
- [ ] RECORDS never names a route you have not entered yet
- [ ] No red errors in the browser console

## Issue blocks

Copy one block per problem. Delete the guidance lines if you like.

---

### Issue 1

- **Scene / line (from the HUD):**
- **Save slot holding the moment:**
- **What happened:**
- **What you expected instead:**
- **Category** (delete what does not apply):
  dialogue text · choice options · missing background · missing sprite ·
  missing voice · missing BGM · missing sound effect · transition or effect
  looks wrong · movie did not play · save/load · auto mode · skip mode ·
  performance · console error · other
- **Browser console output** (paste any red lines):
- **Reproduction:** does it happen every time you load that save?
- **Screenshot:** (see the note on screenshots below)

---

### Issue 2

- **Scene / line (from the HUD):**
- **Save slot holding the moment:**
- **What happened:**
- **What you expected instead:**
- **Category:**
- **Browser console output:**
- **Reproduction:**
- **Screenshot:**

---

## Collecting diagnostics

This prints the environment facts a bug report needs — versions, the import
report summary, and the package layout — without touching game content:

```bash
npm run ever17 -- diagnostics
```

It prints to the terminal; redirect it to a file if you want to attach it
(`npm run ever17 -- diagnostics > /tmp/ever17-diagnostics.txt 2>&1`).

What it does and does not include:

- **Includes:** file names and sizes, the source fingerprint, schema and
  engine versions, and counts of scripts, assets and movies.
- **Excludes:** story text, images, audio, movies and the IR. None of that is
  read or printed.

The one thing it does contain is the **path to your installation**, which may
include your user name — trim that line before sharing if you would rather
not.

### Screenshots

A screenshot of a rendering problem contains game artwork, so it is
copyrighted material: keep it local, attach it to a private report, and do
not commit it. `.gitignore` already excludes the generated cache; put
screenshots somewhere outside the repository, or under `.local/`, so they
cannot be committed by accident.

## What is already known

So it does not get re-reported:

- **11 missing audio assets** (`v_hotaru1`, `v_tubame1`, …). They are
  referenced only by `system.scr`, the system/UI script, and are not shipped
  in this release. They are not reachable during play; the import reports
  them as `system` severity.
- **Effect fidelity is approximate.** Weather, filters, quakes and the
  eyecatch effects are interpretations of the original engine's numeric
  effect ids, mapped in the Ever17 game profile. If one looks clearly wrong
  (rather than merely different), that is worth reporting — include the scene
  so the effect id can be traced.
- **`net::ERR_ABORTED` on `bgm*.wav` in the console.** Switching background
  music cancels the previous track's download, and the browser logs the
  cancellation. It is expected — most visible while skipping, when tracks
  change quickly — and nothing is actually failing. Worth reporting only if
  the music itself stops or the wrong track plays.
- **Movies need `ffmpeg`** at import time. Without it the game shows a
  `[MOVIE: name]` placeholder instead.
- **Cross-game reuse is unproven.** This build is validated on Ever17 only.
- **The developer route graph still exists** at `/debug/routes`. It shows the
  entire game including routes and endings you have not reached, so opening it
  will spoil the story. It is deliberately not linked from anywhere in the
  game.
- **Chapter names come from the game's developer menus**, which are in
  Japanese while the story text is Chinese. Route and viewpoint names are
  rendered with the names this release uses for those characters. If one reads
  wrongly to you, that is worth reporting - it is a judgement call, not
  recovered text.
