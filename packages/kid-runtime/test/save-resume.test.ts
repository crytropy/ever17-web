import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { GameSession, type SessionEvent, type SessionSave } from "../src/game-session.js";
import { SceneVm } from "../src/vm.js";
import { fsSceneSource } from "../src/scene-source.js";
import { IR_DIR } from "./helpers.js";

const HAVE_IR = existsSync(`${IR_DIR}/op00.json`) && existsSync(`${IR_DIR}/y_ed.json`);

/** Structural fingerprint of an event, for identity comparison. */
function fp(ev: SessionEvent): unknown {
  switch (ev.type) {
    case "dialogue":
      return {
        t: "d",
        speaker: ev.speaker,
        text: ev.text,
        voice: ev.voice,
        block: ev.state.block,
        bg: ev.state.background?.asset ?? null,
        sprites: ev.state.sprites.map((s) => [s.asset, s.slot, s.x]),
        bgm: ev.state.bgm,
        fill: ev.state.fill,
        // presentation deltas are part of the identity contract
        actions: ev.actions,
      };
    case "choice":
      return {
        t: "c",
        id: ev.id,
        options: ev.options.map((o) => [o.index, o.text, o.target, o.enabled]),
        actions: ev.actions,
      };
    case "sessionEnd":
      return { t: "e", reason: ev.reason, scene: ev.scene };
    default:
      return { t: "?" };
  }
}

/** Deterministic choice policy shared by all runs. */
function pick(ev: Extract<SessionEvent, { type: "choice" }>): number {
  const enabled = ev.options.filter((o) => o.enabled);
  return (enabled[0] ?? ev.options[0])?.index ?? 0;
}

/** Drive a session, returning event fingerprints; optionally stop after n events. */
async function drive(
  session: GameSession,
  maxEvents = Infinity,
): Promise<{ events: unknown[]; session: GameSession }> {
  const events: unknown[] = [];
  while (events.length < maxEvents) {
    const ev = await session.next();
    events.push(fp(ev));
    if (ev.type === "sessionEnd") break;
    if (ev.type === "choice") session.choose(pick(ev));
  }
  return { events, session };
}

describe.skipIf(!HAVE_IR)("save/resume identity (full real route)", () => {
  const source = () => fsSceneSource(IR_DIR);

  // One uninterrupted control run, shared by the cases below.
  let control: unknown[] | null = null;
  async function controlRun(): Promise<unknown[]> {
    if (!control) {
      const s = await GameSession.start(source(), "op00");
      control = (await drive(s)).events;
    }
    return control;
  }

  it("the control route completes with >12k events", async () => {
    const events = await controlRun();
    expect(events.length).toBeGreaterThan(12_000);
    expect(events[events.length - 1]).toMatchObject({ t: "e", reason: "ending" });
  });

  // Save points chosen to cover: early scene, investigation-menu vars hot
  // (t_1c), late route (tt7a region), and a point that is exactly a choice.
  for (const at of [50, 2500, 11_900]) {
    it(`resuming after event ${at} continues identically`, async () => {
      const full = await controlRun();

      const s1 = await GameSession.start(source(), "op00");
      await drive(s1, at);
      // serialize through JSON to prove the save is genuinely persistable
      const saved = JSON.parse(JSON.stringify(s1.save())) as SessionSave;

      const s2 = await GameSession.restore(source(), saved);
      const resumed = (await drive(s2)).events;

      // The resumed stream re-presents the saved event, so it must equal the
      // control stream from index at-1 to the end.
      expect(resumed.length).toBe(full.length - (at - 1));
      expect(resumed[0]).toEqual(full[at - 1]);
      expect(resumed).toEqual(full.slice(at - 1));
      expect(s2.done).toBe(true);
    }, 60_000);
  }

  it("saving while a choice is displayed re-presents the choice", async () => {
    // find the event index of the first choice in the control stream
    const full = await controlRun();
    const choiceIdx = full.findIndex((e) => (e as { t: string }).t === "c");
    expect(choiceIdx).toBeGreaterThan(0);

    const s1 = await GameSession.start(source(), "op00");
    let ev: SessionEvent | null = null;
    for (let i = 0; i <= choiceIdx; i++) {
      ev = await s1.next();
      if (ev.type === "choice" && i < choiceIdx) s1.choose(pick(ev));
    }
    expect(ev?.type).toBe("choice");
    const saved = JSON.parse(JSON.stringify(s1.save())) as SessionSave;

    const s2 = await GameSession.restore(source(), saved);
    const again = await s2.next();
    expect(fp(again)).toEqual(full[choiceIdx]);
    // and answering it continues identically to the end
    if (again.type === "choice") s2.choose(pick(again));
    const rest = (await drive(s2)).events;
    expect(rest).toEqual(full.slice(choiceIdx + 1));
  }, 60_000);

  it("saves carry backlog, counters and route", async () => {
    const s1 = await GameSession.start(source(), "op00", { backlogLimit: 40 });
    await drive(s1, 120);
    const saved = s1.save();
    expect(saved.backlog.length).toBe(40); // capped
    expect(saved.backlog[saved.backlog.length - 1]!.text.length).toBeGreaterThan(0);
    expect(saved.counters.lines).toBeGreaterThan(100);
    expect(saved.route[0]).toBe("op00");

    const s2 = await GameSession.restore(source(), JSON.parse(JSON.stringify(saved)), {
      backlogLimit: 40,
    });
    expect(s2.backlog).toEqual(saved.backlog);
    expect(s2.lines).toBe(saved.counters.lines);
    const ev = await s2.next();
    expect(ev.type).toBe("dialogue");
    // the re-presented line is neither re-counted nor re-logged...
    expect(s2.lines).toBe(saved.counters.lines);
    expect(s2.backlog).toEqual(saved.backlog);
    // ...but the following line is
    const ev2 = await s2.next();
    if (ev2.type === "choice") s2.choose(0);
    else expect(s2.lines).toBe(saved.counters.lines + 1);
  });

  it("rejects saves with a wrong format or version", async () => {
    const s1 = await GameSession.start(source(), "op00");
    await drive(s1, 5);
    const saved = s1.save();
    await expect(
      GameSession.restore(source(), { ...saved, format: "nope" } as never),
    ).rejects.toThrow(/not a save file/);
    await expect(
      GameSession.restore(source(), { ...saved, version: 99 } as never),
    ).rejects.toThrow(/unsupported save version/);
  });

  it("GameSession completes the full route (parity with SessionRunner)", async () => {
    const s = await GameSession.start(source(), "op00");
    const { events } = await drive(s);
    expect(events[events.length - 1]).toMatchObject({ t: "e", reason: "ending", scene: "y_ed" });
    expect(s.route[0]).toBe("op00");
    expect(s.route[s.route.length - 1]).toBe("y_ed");
    expect(s.route).toContain("tt7a");
    expect(s.lines).toBeGreaterThan(12_000);
  }, 60_000);
});

describe("a CG is part of the picture, not a passing effect", () => {
  /**
   * Regression: a CG shown over a white fill stayed on screen, but the VM
   * recorded only the fill. Saving there and coming back - exit to title then
   * Continue, or a backlog rewind - restored the bare fill, so the screen
   * went white where the artwork belonged.
   */
  const cgScene = {
    formatVersion: 1,
    scene: "cg",
    entry: "b0",
    blocks: {
      b0: {
        next: null,
        ops: [
          { op: "fillScreen" as const, color: 1, fade: null, plane: null },
          { op: "cgEffect" as const, asset: "cg01", resource: 0, args: [] },
          { op: "dialogue" as const, voice: null, speaker: null, text: "under the CG", textIndex: 0, segment: 0 },
          { op: "setBackground" as const, asset: "bg01", resource: 0, fade: null, arg2: null },
          { op: "dialogue" as const, voice: null, speaker: null, text: "after the background", textIndex: 0, segment: 0 },
        ],
      },
    },
    warnings: [],
    meta: { sceneIds: [], textChunks: 0, resources: [], unknownOpcodeCount: 0, coverage: 1 },
  };

  const assets = {
    get: (n?: string | null) => (n ? { file: `images/${n}.png`, width: 800, height: 600 } : undefined),
    relative: (n?: string | null) => (n ? `images/${n}.png` : null),
  };

  it("records the CG in the state it can be restored from", () => {
    const vm = new SceneVm(cgScene as never, assets as never, {});
    const ev = vm.next();
    expect(ev.type).toBe("dialogue");
    // the picture is a CG over a white fill
    expect(ev.type === "dialogue" && ev.state.fill).toBe(1);
    expect(ev.type === "dialogue" && ev.state.cg?.file).toBe("images/cg01.png");

    const save = vm.getSaveState();
    expect(save.presentation.cg?.file, "the save carries the CG").toBe("images/cg01.png");
  });

  it("restores it, so the moment looks the way it did", () => {
    const vm = new SceneVm(cgScene as never, assets as never, {});
    vm.next();
    const save = vm.getSaveState();

    const resumed = new SceneVm(cgScene as never, assets as never, { resume: save });
    const ev = resumed.next();
    expect(ev.type === "dialogue" && ev.state.cg?.file, "not a bare fill").toBe("images/cg01.png");
    expect(ev.type === "dialogue" && ev.state.fill).toBe(1);
  });

  it("clears it once a background replaces it on screen", () => {
    const vm = new SceneVm(cgScene as never, assets as never, {});
    vm.next();
    const after = vm.next();
    expect(after.type === "dialogue" && (after.state.cg ?? null), "the background replaced the CG").toBeFalsy();
    expect(vm.getSaveState().presentation.cg ?? null).toBeFalsy();
  });

  it("treats a save written before CGs existed as having none", () => {
    const vm = new SceneVm(cgScene as never, assets as never, {});
    vm.next();
    const save = vm.getSaveState();
    delete (save.presentation as { cg?: unknown }).cg; // an older save
    const resumed = new SceneVm(cgScene as never, assets as never, { resume: save });
    const ev = resumed.next();
    expect(ev.type === "dialogue" && (ev.state.cg ?? null)).toBeNull();
  });
});
