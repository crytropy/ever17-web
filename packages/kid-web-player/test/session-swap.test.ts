import { describe, expect, it } from "vitest";
import { GameSession, type AsyncSceneSource } from "kid-runtime";
import type { AssetIndex, IrBlock, IrScene, SessionSave } from "kid-contracts";
import { SessionSwap } from "../src/session-swap.js";
import { RewindLog, timelineFor, type RewindPoint } from "../src/rewind.js";
import { AutosaveGate } from "../src/autosave.js";
import { AssetLoader } from "kid-renderer-pixi";

/**
 * These drive the same controller WebPlayer.resumeFrom drives, with real
 * GameSessions, because the defect being pinned is entirely about ordering:
 * calling GameSession.restore directly can never show that a failure left the
 * previous session torn down.
 */

const scene = (name: string, blocks: Record<string, IrBlock>, entry = "b0"): IrScene => ({
  formatVersion: 1, scene: name, entry, blocks, warnings: [],
  meta: { sceneIds: [], textChunks: 0, resources: [], unknownOpcodeCount: 0, coverage: 1 },
});
const line = (text: string) => ({ op: "dialogue" as const, voice: null, speaker: null, text, textIndex: 0, segment: 0 });
const noAssets: AssetIndex = { get: () => undefined, relative: () => null };
const sourceOf = (scenes: Record<string, IrScene>): AsyncSceneSource => ({
  load: (n) => scenes[n.toLowerCase()] ?? null,
  assets: () => noAssets,
});

const SOURCE = sourceOf({
  a: scene("a", {
    b0: {
      next: null,
      ops: [
        line("one"), line("two"), line("three"),
        { op: "choice", id: 7, resultVar: 1203, options: [
          { index: 0, text: "left", target: "bl" },
          { index: 1, text: "right", target: "br" },
        ] },
      ],
    },
    bl: { next: null, ops: [line("went left")] },
    br: { next: null, ops: [line("went right")] },
  }),
});

/**
 * The pieces WebPlayer owns per session, assembled the way resumeFrom does.
 * Deliberately thin: the point is to exercise the controller, not to restate
 * the player.
 */
function player() {
  const swap = new SessionSwap<GameSession>();
  const rewind = new RewindLog();
  const state = {
    released: 0,
    committed: 0,
    order: [] as string[],
    movieStopped: 0,
    audioStopped: 0,
    ctxGate: new AutosaveGate(),
    autosaveDecisions: [] as boolean[],
    ops: ["queued-from-old-session"],
    clickWaiter: null as (() => void) | null,
    choiceResolve: null as ((n: number) => void) | null,
    moviesPlayed: new Set<string>(),
    lastError: null as string | null,
  };

  /** Mirrors resumeFrom: build first, release only on success. */
  const resumeFrom = async (save: SessionSave, timeline?: RewindPoint, rewoundTo?: number) => {
    const nextGate = new AutosaveGate();
    nextGate.begin("restore");
    const nextOps: string[] = [];
    const result = await swap.replace(
      () =>
        GameSession.restore(SOURCE, save, {
          onSceneChange: () => void state.autosaveDecisions.push(nextGate.sceneEntered()),
        }),
      {
        release: () => {
          state.order.push("release");
          state.released++;
          state.audioStopped++;
          state.movieStopped++;
          state.ctxGate = nextGate;
          state.ops = nextOps;
          const restored = timelineFor(timeline);
          state.moviesPlayed = restored.moviesPlayed;
          if (rewoundTo === undefined) rewind.clear();
          else rewind.truncateAfter(rewoundTo);
        },
        commit: () => {
          state.order.push("commit");
          state.committed++;
          const wakeClick = state.clickWaiter;
          const wakeChoice = state.choiceResolve;
          state.clickWaiter = null;
          state.choiceResolve = null;
          wakeClick?.();
          wakeChoice?.(-1);
        },
      },
    );
    if (!result.ok && !result.superseded) state.lastError = result.reason;
    return result;
  };

  return { swap, rewind, state, resumeFrom };
}

const CORRUPT = { format: "e17vn-save", version: 1, vm: { scene: "nope" } } as unknown as SessionSave;

async function playTo(session: GameSession, n: number): Promise<SessionSave[]> {
  const saves: SessionSave[] = [];
  for (let i = 0; i < n; i++) {
    const ev = await session.next();
    if (ev.type !== "dialogue") break;
    saves.push({ ...session.save(), backlog: [] });
  }
  return saves;
}

describe("a failed restore during dialogue", () => {
  it("leaves the original session live, playable and untouched", async () => {
    const p = player();
    const original = await GameSession.start(SOURCE, "a");
    p.swap.set(original);
    await playTo(original, 2);
    p.state.clickWaiter = () => p.state.order.push("woken");

    const result = await p.resumeFrom(CORRUPT);

    expect(result.ok).toBe(false);
    expect(p.state.lastError).toBeTruthy();
    // nothing was released
    expect(p.state.released).toBe(0);
    expect(p.state.committed).toBe(0);
    expect(p.state.audioStopped, "audio must not be stopped by a failed load").toBe(0);
    expect(p.state.movieStopped).toBe(0);
    expect(p.state.ops, "the old session's queued media survives").toEqual(["queued-from-old-session"]);
    expect(p.state.clickWaiter, "the waiter is still usable").not.toBeNull();
    // and the session is the one it always was, still advancing
    expect(p.swap.session).toBe(original);
    expect((await original.next() as { text: string }).text).toBe("three");
    expect(p.swap.inProgress, "the controller cannot stay stuck").toBe(false);
  });
});

describe("a failed restore during a choice", () => {
  it("leaves the original choice answerable", async () => {
    const p = player();
    const original = await GameSession.start(SOURCE, "a");
    p.swap.set(original);
    await playTo(original, 3);
    const choice = await original.next();
    expect(choice.type).toBe("choice");
    p.state.choiceResolve = (n) => p.state.order.push(`choice:${n}`);

    const result = await p.resumeFrom(CORRUPT);
    expect(result.ok).toBe(false);
    expect(p.state.released).toBe(0);
    expect(p.state.choiceResolve, "the choice waiter is still usable").not.toBeNull();

    // the pending choice can still be answered, and routes correctly
    expect(() => original.choose(1)).not.toThrow();
    expect((await original.next() as { text: string }).text).toBe("went right");
  });
});

describe("a successful swap", () => {
  it("releases the old session only after the replacement exists", async () => {
    const p = player();
    const original = await GameSession.start(SOURCE, "a");
    p.swap.set(original);
    const saves = await playTo(original, 3);

    const result = await p.resumeFrom(saves[0]!);
    expect(result.ok).toBe(true);
    expect(p.state.order).toEqual(["release", "commit", "woken"].slice(0, p.state.order.length));
    expect(p.state.order.indexOf("release")).toBeLessThan(p.state.order.indexOf("commit"));
    expect(p.swap.session).not.toBe(original);
    expect(p.state.ops, "the new session starts with its own empty queue").toEqual([]);
  });

  it("loads during dialogue and re-presents the saved line", async () => {
    const p = player();
    const original = await GameSession.start(SOURCE, "a");
    p.swap.set(original);
    const saves = await playTo(original, 3);
    await p.resumeFrom(saves[1]!);
    expect((await p.swap.session!.next() as { text: string }).text).toBe("two");
  });

  it("loads during a choice and replaces the pending decision", async () => {
    const p = player();
    const original = await GameSession.start(SOURCE, "a");
    p.swap.set(original);
    const saves = await playTo(original, 3);
    const choice = await original.next();
    expect(choice.type).toBe("choice");

    let woken: number | null = null;
    p.state.choiceResolve = (n) => (woken = n);
    await p.resumeFrom(saves[0]!);
    expect(woken, "the parked choice waiter is released so the loop can move on").toBe(-1);
    expect((await p.swap.session!.next() as { text: string }).text).toBe("one");
  });
});

describe("concurrency and supersession", () => {
  it("refuses a second swap while one is building", async () => {
    const p = player();
    const original = await GameSession.start(SOURCE, "a");
    p.swap.set(original);
    const saves = await playTo(original, 2);

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const slow = p.swap.replace(async () => {
      await held;
      return GameSession.restore(SOURCE, saves[0]!);
    }, {});
    const second = await p.swap.replace(() => GameSession.restore(SOURCE, saves[1]!), {});
    expect(second).toMatchObject({ ok: false, alreadySwapping: true });
    expect(p.swap.session, "the refused swap changes nothing").toBe(original);

    release();
    expect((await slow).ok).toBe(true);
  });

  it("does not resurrect a session the player has already left", async () => {
    const p = player();
    const original = await GameSession.start(SOURCE, "a");
    p.swap.set(original);
    const saves = await playTo(original, 2);

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const pending = p.swap.replace(async () => {
      await held;
      return GameSession.restore(SOURCE, saves[0]!);
    }, { release: () => p.state.released++, commit: () => p.state.committed++ });

    // return to title while the replacement is still being built
    p.swap.set(null);
    release();
    const result = await pending;

    expect(result).toMatchObject({ ok: false, superseded: true });
    expect(p.swap.session, "still on the title screen").toBeNull();
    expect(p.state.released).toBe(0);
    expect(p.state.committed).toBe(0);
    // and a superseded swap is not reported to the player as a failure
    expect(p.state.lastError).toBeNull();
  });
});

describe("rewind points across a swap", () => {
  it("keeps earlier lines after a rewind, so the player can go back again", async () => {
    const p = player();
    const original = await GameSession.start(SOURCE, "a");
    p.swap.set(original);
    const saves = await playTo(original, 3);
    saves.forEach((save, i) => p.rewind.note(i, { save, moviesPlayed: [], moviesSinceChoice: [] }));

    await p.resumeFrom(saves[2]!, { save: saves[2]!, moviesPlayed: [], moviesSinceChoice: [] }, 2);
    expect(p.rewind.ordinals()).toEqual([0, 1, 2]);

    // rewind again, further back: the abandoned future goes, the past stays
    await p.resumeFrom(saves[1]!, { save: saves[1]!, moviesPlayed: [], moviesSinceChoice: [] }, 1);
    expect(p.rewind.ordinals()).toEqual([0, 1]);
    expect(p.rewind.has(2), "the abandoned future is no longer reachable").toBe(false);
    expect(p.rewind.has(0), "an earlier line is still reachable").toBe(true);
  });

  it("clears the whole log when a save is loaded instead", async () => {
    const p = player();
    const original = await GameSession.start(SOURCE, "a");
    p.swap.set(original);
    const saves = await playTo(original, 3);
    saves.forEach((save, i) => p.rewind.note(i, { save, moviesPlayed: [], moviesSinceChoice: [] }));

    await p.resumeFrom(saves[1]!); // no rewoundTo: this is a load
    expect(p.rewind.size).toBe(0);
  });

  it("carries the selected snapshot's movie evidence, not the abandoned future's", async () => {
    const p = player();
    const original = await GameSession.start(SOURCE, "a");
    p.swap.set(original);
    const saves = await playTo(original, 3);
    p.state.moviesPlayed = new Set(["early", "late"]);

    await p.resumeFrom(
      saves[1]!,
      { save: saves[1]!, moviesPlayed: ["early"], moviesSinceChoice: [] },
      1,
    );
    expect([...p.state.moviesPlayed]).toEqual(["early"]);
  });
});

describe("repeated rewind over a long run", () => {
  /** A 300-line run with a 200-entry backlog, snapshotted as the player reads. */
  const longRun = () => {
    const rewind = new RewindLog();
    const LIMIT = 200;
    for (let lines = 1; lines <= 300; lines++) {
      rewind.note(lines - 1, {
        save: { vm: { scene: `s${lines - 1}` } } as unknown as SessionSave,
        moviesPlayed: lines > 150 ? ["late_movie"] : [],
        moviesSinceChoice: [],
      });
      rewind.trim(lines - Math.min(lines, LIMIT));
    }
    return rewind;
  };

  it("goes back to 250, then 220, then 180, each time from what is retained", () => {
    const rewind = longRun();
    expect(rewind.size).toBe(200);
    expect(rewind.ordinals()[0]).toBe(100);

    rewind.truncateAfter(250);
    expect(rewind.has(250)).toBe(true);
    expect(rewind.has(251)).toBe(false);
    expect(rewind.has(220), "an earlier line is still reachable").toBe(true);

    rewind.truncateAfter(220);
    expect(rewind.has(220)).toBe(true);
    expect(rewind.has(221)).toBe(false);
    expect(rewind.has(180)).toBe(true);

    rewind.truncateAfter(180);
    expect(rewind.has(180)).toBe(true);
    expect(rewind.has(181)).toBe(false);
    expect(rewind.ordinals()[0]).toBe(100);
  });

  it("stays bounded at 200 as a new branch is played after rewinding", () => {
    const rewind = longRun();
    rewind.truncateAfter(250);
    // the player takes a different path from line 250 onwards
    for (let lines = 252; lines <= 400; lines++) {
      rewind.note(lines - 1, { save: { vm: { scene: `alt${lines - 1}` } } as unknown as SessionSave, moviesPlayed: [], moviesSinceChoice: [] });
      rewind.trim(lines - Math.min(lines, 200));
      expect(rewind.size).toBeLessThanOrEqual(200);
    }
    expect(rewind.size).toBe(200);
    // the replacement snapshots are the new branch's, not the abandoned one's
    expect(rewind.get(300)!.save.vm.scene).toBe("alt300");
  });

  it("drops the abandoned future's snapshots when rebranching", () => {
    const rewind = longRun();
    expect(rewind.get(260)!.save.vm.scene).toBe("s260");
    rewind.truncateAfter(250);
    expect(rewind.has(260)).toBe(false);
    // replayed differently, ordinal 260 is now the new branch's line
    rewind.note(260, { save: { vm: { scene: "alt260" } } as unknown as SessionSave, moviesPlayed: [], moviesSinceChoice: [] });
    expect(rewind.get(260)!.save.vm.scene).toBe("alt260");
  });

  it("carries the right movie evidence after rewinding twice", () => {
    const rewind = longRun();
    // line 200 was after the movie played; line 100 was before it
    expect(timelineFor(rewind.get(200)).moviesPlayed.has("late_movie")).toBe(true);
    rewind.truncateAfter(200);
    expect(timelineFor(rewind.get(200)).moviesPlayed.has("late_movie")).toBe(true);
    rewind.truncateAfter(120);
    const back = timelineFor(rewind.get(120));
    expect(back.moviesPlayed.has("late_movie"), "evidence from the abandoned future is gone").toBe(false);
  });
});

describe("the autosave across a rewind", () => {
  it("is byte-identical: a rewind writes nothing to the slot", async () => {
    const { SaveSlots } = await import("../src/slots.js");
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
    const slots = new SaveSlots(storage, "ns");

    const p = player();
    const original = await GameSession.start(SOURCE, "a");
    p.swap.set(original);
    const saves = await playTo(original, 3);
    slots.put("auto", { ...saves[2]!, backlog: [] });
    const before = JSON.stringify([...map.entries()]);

    // the rewind itself, and the gate the restored session arms
    await p.resumeFrom(saves[0]!, { save: saves[0]!, moviesPlayed: [], moviesSinceChoice: [] }, 0);
    expect(JSON.stringify([...map.entries()]), "a rewind must not touch the autosave").toBe(before);

    // the restored session's own scene entry, delivered from inside
    // restore(), asked for no autosave
    expect(p.state.autosaveDecisions, "the rewind's own scene entry").toEqual([false]);
    // and a genuine later transition still does
    expect(p.state.ctxGate.sceneEntered(), "a genuine later transition").toBe(true);
    expect(JSON.stringify([...map.entries()])).toBe(before);
  });
});

describe("a session abandoned while an asset is still cold", () => {
  /**
   * The stall in the round: skip stopped for over twenty seconds and manual
   * advance did nothing, because the loop was parked on a texture load that
   * neither skip() nor a session change could interrupt. The replacement
   * session must not inherit that wait.
   */
  const coldLoader = () => {
    const settlers = new Map<string, (v: string) => void>();
    const loader = new AssetLoader<string>({
      load: (url) => new Promise<string>((resolve) => settlers.set(url, resolve)),
    });
    return { loader, settle: (url: string) => settlers.get(url)?.("tex"), outstanding: () => settlers.size };
  };

  it("lets a New Game run immediately, without waiting for the abandoned load", async () => {
    const { loader, settle, outstanding } = coldLoader();
    const p = player();
    const original = await GameSession.start(SOURCE, "a");
    p.swap.set(original);

    // the original session is parked on a conversion that has not answered
    const cold = loader.get("bg01.png", "/assets/bg01.png");
    await Promise.resolve();
    expect(loader.pending).toBe(1);

    // returning to the title abandons it
    loader.cancel();
    p.swap.set(null);
    await expect(cold, "the parked wait is released").resolves.toBeNull();
    expect(loader.pending).toBe(0);

    // New Game, and its own assets load on their own epoch
    const fresh = await GameSession.start(SOURCE, "a");
    p.swap.set(fresh);
    const next = loader.get("bg02.png", "/assets/bg02.png");
    await Promise.resolve();
    settle("/assets/bg02.png");
    await expect(next).resolves.toBe("tex");
    expect((await fresh.next() as { text: string }).text, "the new session plays at once").toBe("one");
    // the abandoned conversion is still outstanding and harmless
    expect(outstanding()).toBe(2);
    expect(loader.failed, "abandoning is not failing").toEqual([]);
  });

  it("does not let the abandoned load paint into the replacement", async () => {
    const { loader, settle } = coldLoader();
    const staleEpoch = loader.epoch;
    const cold = loader.get("old.png", "/old.png");
    await Promise.resolve();

    loader.cancel(); // session swap
    await cold;
    expect(loader.stale(staleEpoch), "the old picture's epoch has passed").toBe(true);

    // the abandoned conversion finally answers
    settle("/old.png");
    await new Promise((r) => setTimeout(r, 0));
    // and contributes nothing to the current picture
    expect(loader.pending).toBe(0);
    expect(loader.failed).toEqual([]);
  });
});
