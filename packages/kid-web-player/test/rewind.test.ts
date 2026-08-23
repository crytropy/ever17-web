import { describe, expect, it } from "vitest";
import { GameSession, type AsyncSceneSource } from "kid-runtime";
import { migrateSave, runCountsAsCompletion, SAVE_VERSION, type AssetIndex, type IrBlock, type IrScene, type SessionSave } from "kid-contracts";
import { matchEndings, type EndingInfo } from "kid-graph/model";
import {
  RewindLog,
  backlogOrdinal,
  captureTimeline,
  oldestBacklogOrdinal,
  timelineFor,
  type RewindPoint,
} from "../src/rewind.js";

/**
 * Rewinding is restoring a save the player never took, so the two things that
 * can go wrong are bookkeeping (which line does this snapshot belong to, once
 * the backlog has trimmed?) and completeness (does the restored moment carry
 * everything that decides what happens next?).
 *
 * These run on synthetic scenes so they are deterministic and need no game
 * files.
 */

// ---------------------------------------------------------------- fixtures
const scene = (name: string, blocks: Record<string, IrBlock>, entry = "b0"): IrScene => ({
  formatVersion: 1,
  scene: name,
  entry,
  blocks,
  warnings: [],
  meta: { sceneIds: [], textChunks: 0, resources: [], unknownOpcodeCount: 0, coverage: 1 },
});

const line = (text: string) => ({ op: "dialogue" as const, voice: null, speaker: null, text, textIndex: 0, segment: 0 });

const noAssets: AssetIndex = { get: () => undefined, relative: () => null };

const sourceOf = (scenes: Record<string, IrScene>): AsyncSceneSource => ({
  load: (n) => scenes[n.toLowerCase()] ?? null,
  assets: () => noAssets,
});

/** Six plain lines, then the scene ends. */
const STRAIGHT = sourceOf({
  a: scene("a", {
    b0: { next: null, ops: [line("one"), line("two"), line("three"), line("four"), line("five"), line("six")] },
  }),
});

/** Two lines, a two-way choice, then a distinct line per branch. */
const BRANCHING = sourceOf({
  a: scene("a", {
    b0: {
      next: null,
      ops: [
        line("before one"),
        line("before two"),
        {
          op: "choice",
          id: 7,
          resultVar: 1203,
          options: [
            { index: 0, text: "left", target: "bl" },
            { index: 1, text: "right", target: "br" },
          ],
        },
      ],
    },
    bl: { next: null, ops: [line("went left"), line("still left")] },
    br: { next: null, ops: [line("went right"), line("still right")] },
  }),
});

/** Reads every dialogue line a session produces, in order. */
async function readLines(session: GameSession, max = 50): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    const ev = await session.next();
    if (ev.type === "dialogue") out.push(ev.text);
    else break;
  }
  return out;
}

/** Play forward, snapshotting each line the way the player does. */
async function playAndSnapshot(source: AsyncSceneSource, upTo: number): Promise<{
  session: GameSession;
  log: RewindLog;
  texts: string[];
}> {
  const session = await GameSession.start(source, "a");
  const log = new RewindLog();
  const texts: string[] = [];
  for (let i = 0; i < upTo; i++) {
    const ev = await session.next();
    if (ev.type !== "dialogue") break;
    texts.push(ev.text);
    log.note(session.lines - 1, {
      save: { ...session.save(), backlog: [] },
      moviesPlayed: [],
      moviesSinceChoice: [],
    });
  }
  return { session, log, texts };
}

// ---------------------------------------------------------------- bookkeeping
describe("rewind bookkeeping", () => {
  const point = (scene = "a"): RewindPoint => ({
    save: { vm: { scene } } as unknown as SessionSave,
    moviesPlayed: [],
    moviesSinceChoice: [],
  });

  it("maps a backlog index to the line ordinal it actually is", () => {
    // 10 lines read, backlog holds the last 4: entry 0 is line 6
    expect(backlogOrdinal(10, 4, 0)).toBe(6);
    expect(backlogOrdinal(10, 4, 3)).toBe(9);
    // before any trimming, index and ordinal agree
    expect(backlogOrdinal(4, 4, 0)).toBe(0);
    expect(oldestBacklogOrdinal(10, 4)).toBe(6);
  });

  it("keeps a snapshot addressable by the same line after the backlog trims", () => {
    const log = new RewindLog();
    for (let i = 0; i < 6; i++) log.note(i, point(`s${i}`));
    // the backlog now holds only the last 3 lines (ordinals 3,4,5)
    log.trim(oldestBacklogOrdinal(6, 3));
    expect(log.ordinals()).toEqual([3, 4, 5]);
    // backlog entry 0 is ordinal 3, and still the scene it always was
    expect(log.get(backlogOrdinal(6, 3, 0))!.save.vm.scene).toBe("s3");
  });

  it("stays bounded by the backlog rather than growing with the run", () => {
    const log = new RewindLog();
    const LIMIT = 5;
    for (let lines = 1; lines <= 200; lines++) {
      log.note(lines - 1, point());
      log.trim(oldestBacklogOrdinal(lines, Math.min(lines, LIMIT)));
      expect(log.size).toBeLessThanOrEqual(LIMIT);
    }
    expect(log.size).toBe(LIMIT);
    expect(log.ordinals()).toEqual([195, 196, 197, 198, 199]);
  });

  it("treats re-noting the same line as a no-op, as a re-presentation is", () => {
    const log = new RewindLog();
    log.note(3, point("first"));
    log.note(3, point("second"));
    expect(log.size).toBe(1);
    expect(log.get(3)!.save.vm.scene).toBe("second");
  });

  it("forgets everything when a session is replaced", () => {
    const log = new RewindLog();
    log.note(0, point());
    log.note(1, point());
    log.clear();
    expect(log.size).toBe(0);
    expect(log.has(0)).toBe(false);
  });
});

// ---------------------------------------------------------------- timeline
describe("the timeline a rewind restores", () => {
  it("keeps evidence earned before the line and drops what came after", () => {
    const captured = captureTimeline({
      moviesPlayed: new Set(["op_a", "op_b"]),
      moviesSinceChoice: ["op_b"],
    });
    // the run continues and plays more before the player rewinds
    const restored = timelineFor({ save: {} as SessionSave, ...captured });
    expect([...restored.moviesPlayed].sort()).toEqual(["op_a", "op_b"]);
    expect(restored.moviesSinceChoice).toEqual(["op_b"]);
    expect(restored.moviesPlayed.has("op_future")).toBe(false);
  });

  it("detaches from the live collections, so later play cannot edit the past", () => {
    const live = { moviesPlayed: new Set(["op_a"]), moviesSinceChoice: ["op_a"] };
    const captured = captureTimeline(live);
    live.moviesPlayed.add("op_later");
    live.moviesSinceChoice.push("op_later");
    const restored = timelineFor({ save: {} as SessionSave, ...captured });
    expect([...restored.moviesPlayed]).toEqual(["op_a"]);
    expect(restored.moviesSinceChoice).toEqual(["op_a"]);
  });

  it("gives a loaded save file an empty record rather than invented evidence", () => {
    const restored = timelineFor(undefined);
    expect(restored.moviesPlayed.size).toBe(0);
    expect(restored.moviesSinceChoice).toEqual([]);
  });

  it("hands back collections the caller may keep mutating", () => {
    const a = timelineFor(undefined);
    const b = timelineFor(undefined);
    a.moviesPlayed.add("x");
    a.moviesSinceChoice.push("x");
    expect(b.moviesPlayed.size).toBe(0);
    expect(b.moviesSinceChoice).toEqual([]);
  });
});

// ---------------------------------------------------------------- sessions
describe("rewinding a session", () => {
  it("returns to the chosen line and continues identically", async () => {
    const { session, log, texts } = await playAndSnapshot(STRAIGHT, 5);
    expect(texts).toEqual(["one", "two", "three", "four", "five"]);

    // rewind to "three" (ordinal 2)
    const point = log.get(2)!;
    const back = await GameSession.restore(STRAIGHT, { ...point.save, backlog: [] });
    // restore re-presents the saved line, then carries on
    expect(await readLines(back)).toEqual(["three", "four", "five", "six"]);
    expect(session.lines).toBe(5);
  });

  it("can be done repeatedly while the snapshots still exist", async () => {
    const { log } = await playAndSnapshot(STRAIGHT, 5);
    let session = await GameSession.restore(STRAIGHT, { ...log.get(3)!.save, backlog: [] });
    expect((await session.next() as { text: string }).text).toBe("four");
    // and again, further back, from the point taken during the first pass
    session = await GameSession.restore(STRAIGHT, { ...log.get(1)!.save, backlog: [] });
    expect((await session.next() as { text: string }).text).toBe("two");
    session = await GameSession.restore(STRAIGHT, { ...log.get(4)!.save, backlog: [] });
    expect((await session.next() as { text: string }).text).toBe("five");
  });

  it("rewinds past a choice and lets the other branch be taken", async () => {
    const session = await GameSession.start(BRANCHING, "a");
    const log = new RewindLog();
    // two lines, then the choice
    for (let i = 0; i < 2; i++) {
      await session.next();
      log.note(session.lines - 1, { save: { ...session.save(), backlog: [] }, moviesPlayed: [], moviesSinceChoice: [] });
    }
    const choice = await session.next();
    expect(choice.type).toBe("choice");
    session.choose(0);
    expect(await readLines(session)).toEqual(["went left", "still left"]);

    // the player rewinds to before the choice and answers differently
    const back = await GameSession.restore(BRANCHING, { ...log.get(1)!.save, backlog: [] });
    expect((await back.next() as { text: string }).text).toBe("before two");
    const again = await back.next();
    expect(again.type).toBe("choice");
    back.choose(1);
    expect(await readLines(back)).toEqual(["went right", "still right"]);
  });

  it("restores the variable a choice wrote, so the branch is genuinely re-decided", async () => {
    const session = await GameSession.start(BRANCHING, "a");
    await session.next();
    const beforeChoice = { ...session.save(), backlog: [] };
    await session.next();
    const choice = await session.next();
    expect(choice.type).toBe("choice");
    session.choose(1);
    expect(session.vars.get(1203)).toBe(1);

    const back = await GameSession.restore(BRANCHING, beforeChoice);
    // the answer has not been made yet in the restored timeline
    expect(back.vars.get(1203) ?? null).toBeNull();
  });

  it("leaves the current session usable when a restore fails", async () => {
    const { session } = await playAndSnapshot(STRAIGHT, 3);
    const broken = { vm: { scene: "nope" } } as unknown as SessionSave;
    await expect(GameSession.restore(STRAIGHT, broken)).rejects.toBeTruthy();
    // the session the player is actually in is untouched and still advances
    expect((await session.next() as { text: string }).text).toBe("four");
  });

  it("offers no rewind for lines carried in from a loaded save", async () => {
    const { session, log } = await playAndSnapshot(STRAIGHT, 4);
    const save = session.save();
    expect(save.backlog.length).toBe(4);

    // a fresh session restored from that save inherits the backlog but none
    // of the VM states behind it
    const loaded = await GameSession.restore(STRAIGHT, save);
    const fresh = new RewindLog();
    expect(loaded.backlog.length).toBe(4);
    for (let i = 0; i < loaded.backlog.length; i++) {
      expect(fresh.has(backlogOrdinal(loaded.lines, loaded.backlog.length, i))).toBe(false);
    }
    // whereas the session that actually played them can reach them
    expect(log.has(backlogOrdinal(session.lines, session.backlog.length, 0))).toBe(true);
  });
});

// ------------------------------------------------------- ending recognition
describe("ending recognition after a rewind", () => {
  /**
   * Endings are matched on the terminal scene, the final variables and which
   * movies played. The movies are host state, so a rewind that mishandled
   * them would credit the run with a different ending than the same play
   * uninterrupted - the failure this whole snapshot exists to prevent.
   */
  const ENDINGS: EndingInfo[] = [
    { id: "END_TU00", scene: "y_ed", movie: "end_tu00", conditions: [], evidence: {} as never },
    { id: "END_SA00", scene: "y_ed", movie: "end_sa00", conditions: [], evidence: {} as never },
  ];
  const vars = new Map<number, number>();

  it("matches what uninterrupted play would have matched", () => {
    // played a movie, then rewound to a line after it and played on
    const atLine = captureTimeline({ moviesPlayed: new Set(["end_tu00"]), moviesSinceChoice: ["end_tu00"] });
    const restored = timelineFor({ save: {} as SessionSave, ...atLine });
    const uninterrupted = new Set(["end_tu00"]);

    expect(matchEndings(ENDINGS, "y_ed", vars, restored.moviesPlayed).map((e) => e.id))
      .toEqual(matchEndings(ENDINGS, "y_ed", vars, uninterrupted).map((e) => e.id));
    expect(matchEndings(ENDINGS, "y_ed", vars, restored.moviesPlayed).map((e) => e.id)).toEqual(["END_TU00"]);
  });

  it("forgets a movie from the future the player rewound away from", () => {
    // the snapshot was taken before any movie played
    const before = captureTimeline({ moviesPlayed: new Set(), moviesSinceChoice: [] });
    const live = { moviesPlayed: new Set(["end_sa00"]), moviesSinceChoice: ["end_sa00"] };
    void live; // the run went on to play end_sa00, then the player rewound

    const restored = timelineFor({ save: {} as SessionSave, ...before });
    expect(matchEndings(ENDINGS, "y_ed", vars, restored.moviesPlayed)).toEqual([]);
    expect(restored.moviesPlayed.has("end_sa00")).toBe(false);
  });

  it("keeps evidence earned before the line, so the earlier ending still matches", () => {
    const before = captureTimeline({ moviesPlayed: new Set(["end_tu00"]), moviesSinceChoice: [] });
    const restored = timelineFor({ save: {} as SessionSave, ...before });
    expect(matchEndings(ENDINGS, "y_ed", vars, restored.moviesPlayed).map((e) => e.id)).toEqual(["END_TU00"]);
  });

  it("credits a route only for a run that actually ended", () => {
    // A rewind is not an ending, and neither is a save or a quit. Only a
    // sessionEnd whose reason is "ending" counts.
    expect(runCountsAsCompletion("ending")).toBe(true);
    for (const reason of ["missing-scene", "stepLimit", "quit", "rewind", "save"]) {
      expect(runCountsAsCompletion(reason), reason).toBe(false);
    }
  });
});

describe("rewind points made by this build", () => {
  /**
   * A rewind point is a save the player never took, so it goes through the
   * same contract - including the CG. If it did not, jumping back would land
   * on the same bare fill that a legacy save does.
   */
  it("always carry explicit CG state", async () => {
    const { session, log } = await playAndSnapshot(STRAIGHT, 4);
    expect(log.size).toBe(4);
    for (const ordinal of log.ordinals()) {
      const point = log.get(ordinal)!;
      expect(point.save.version, "written at the current version").toBe(SAVE_VERSION);
      expect("cg" in point.save.vm.presentation, `ordinal ${ordinal} says whether a CG is showing`).toBe(true);
    }
    expect(session.lines).toBe(4);
  });

  it("migrate as no-ops, because they are already current", async () => {
    const { log } = await playAndSnapshot(STRAIGHT, 2);
    for (const ordinal of log.ordinals()) {
      const result = migrateSave(log.get(ordinal)!.save);
      expect(result).toMatchObject({ ok: true, migrated: false });
    }
  });
});
