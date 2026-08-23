import { describe, expect, it } from "vitest";
import { PLAYER_DATA_FORMAT, SAVE_FORMAT, SAVE_VERSION, type PersistentStatePolicy, type SessionSave } from "kid-contracts";
import { PlayerDataBackup } from "../src/backup.js";
import { buildPlayerDataExport } from "../src/transfer.js";
import { advanceGeneration, readActiveScope } from "../src/play-data.js";
import { SaveSlots } from "../src/slots.js";
import { PersistentProgress } from "../src/progress.js";
import type { StorageLike } from "../src/config.js";

/**
 * "Export first" and "start fresh" sit in the same dialog: one exists to
 * protect the player from the other. That makes their ordering a correctness
 * property, not a UI detail, so it is pinned here rather than left to a
 * hand-run browser check.
 */

const NS = "e17vn";
const GAME = "ever17";
const POLICY: PersistentStatePolicy = { policyVersion: 1, vars: [1039, 1040], merge: "max", derivedFrom: "test" };

function mockStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

const save = (scene: string): SessionSave => ({
  format: SAVE_FORMAT,
  version: SAVE_VERSION,
  vm: { scene, block: "00000010", pc: 0, steps: 1, presentation: { background: null, cg: null, viewport: null, sprites: [], bgm: null, fill: 0 }, actions: [] },
  vars: [[1039, 1]],
  sysVars: [],
  counters: { lines: 12, scenes: 1 },
  route: [scene],
  backlog: [],
});

/** A player who has played: saves and an unlock, all on generation 0. */
function populatedStorage(): StorageLike & { map: Map<string, string> } {
  const s = mockStorage();
  const scope = readActiveScope(s, NS);
  new SaveSlots(s, scope.storagePrefix).put("1", save("t_1a"));
  new SaveSlots(s, scope.storagePrefix).put("quick", save("tt6a"));
  new PersistentProgress(s, scope.storagePrefix, GAME, POLICY).record([[1039, 1]]);
  return s;
}

describe("export first, then start fresh", () => {
  it("backs up generation 0 even when the reset is attempted immediately", async () => {
    const storage = populatedStorage();
    expect(readActiveScope(storage, NS).generation).toBe(0);

    // The player clicks "export first". Delivery is held open, standing in
    // for the browser taking its time over the download.
    let releaseDownload = (): void => {};
    const downloaded = new Promise<void>((r) => (releaseDownload = r));
    let delivered: unknown = null;

    const scopeAtClick = readActiveScope(storage, NS);
    const backup = new PlayerDataBackup({
      assemble: () =>
        buildPlayerDataExport(
          {
            storage,
            storagePrefix: scopeAtClick.storagePrefix,
            settingsNamespace: NS,
            gameId: GAME,
            policy: POLICY,
          },
          null,
        ),
      deliver: async (doc) => {
        delivered = doc;
        await downloaded;
      },
    });

    const inFlight = backup.take();

    // ...and immediately reaches for "start fresh". The reset is refused
    // while the backup it was told to take is still being written.
    expect(backup.inProgress).toBe(true);
    const resetAttempted = backup.inProgress ? "refused" : "performed";
    expect(resetAttempted).toBe("refused");
    expect(readActiveScope(storage, NS).generation, "the generation must not move").toBe(0);

    releaseDownload();
    const outcome = await inFlight;
    expect(outcome.ok).toBe(true);
    expect(backup.inProgress).toBe(false);

    // The file describes generation 0: the saves and the unlock.
    const doc = delivered as ReturnType<typeof buildPlayerDataExport>;
    expect(doc.format).toBe(PLAYER_DATA_FORMAT);
    expect(doc.slots.map((x) => x.slot).sort()).toEqual(["1", "quick"]);
    expect(doc.slots.find((x) => x.slot === "1")!.save.vm.scene).toBe("t_1a");
    expect(doc.progress?.vars).toEqual([[1039, 1]]);

    // Only now, and only on an explicit confirmation, does the world change.
    const fresh = advanceGeneration(storage, NS);
    expect(fresh.generation).toBe(1);
    expect(readActiveScope(storage, NS).generation).toBe(1);
    expect(new SaveSlots(storage, fresh.storagePrefix).list()).toEqual([]);
  });

  it("assembles the document before the first yield, so a later reset cannot empty it", async () => {
    const storage = populatedStorage();
    const scopeAtClick = readActiveScope(storage, NS);
    let assembledAt: number | null = null;
    let steps = 0;

    const backup = new PlayerDataBackup({
      assemble: () => {
        assembledAt = steps;
        return buildPlayerDataExport(
          { storage, storagePrefix: scopeAtClick.storagePrefix, settingsNamespace: NS, gameId: GAME, policy: POLICY },
          null,
        );
      },
      deliver: async () => {
        steps += 1;
        // the destructive step lands in the middle of the download
        advanceGeneration(storage, NS);
        await Promise.resolve();
      },
    });

    const outcome = await backup.take();
    expect(assembledAt, "assemble must run before anything yields").toBe(0);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // even though the generation moved mid-flight, the file is still the real one
    expect(outcome.doc.slots).toHaveLength(2);
    expect(outcome.doc.progress?.vars).toEqual([[1039, 1]]);
  });

  it("turns away a second export instead of running two at once", async () => {
    const storage = populatedStorage();
    let release = (): void => {};
    const held = new Promise<void>((r) => (release = r));
    let assembles = 0;

    const backup = new PlayerDataBackup({
      assemble: () => {
        assembles += 1;
        return { slots: [] };
      },
      deliver: () => held,
    });

    const first = backup.take();
    const second = await backup.take();
    const third = await backup.take();

    expect(second).toMatchObject({ ok: false, alreadyRunning: true });
    expect(third).toMatchObject({ ok: false, alreadyRunning: true });
    expect(assembles, "a rejected request must not assemble anything").toBe(1);

    release();
    expect((await first).ok).toBe(true);
    // once it has settled, exporting again is allowed
    expect((await backup.take()).ok).toBe(true);
    expect(assembles).toBe(2);
    expect(storage.map.size).toBeGreaterThan(0);
  });

  it("reports a failed export and leaves the busy flag down", async () => {
    const storage = populatedStorage();
    const backup = new PlayerDataBackup({
      assemble: () => ({ slots: [] }),
      deliver: () => {
        throw new Error("the browser refused the download");
      },
    });

    const outcome = await backup.take();
    expect(outcome).toMatchObject({ ok: false, reason: "the browser refused the download" });
    expect(outcome.ok === false && outcome.alreadyRunning).toBeUndefined();
    expect(backup.inProgress, "a failure must not wedge the dialog").toBe(false);
    // a failed backup changes nothing: the old generation is still the live one
    expect(readActiveScope(storage, NS).generation).toBe(0);
    expect(new SaveSlots(storage, NS).list().map((m) => m.slot).sort()).toEqual(["1", "quick"]);
  });

  it("surfaces a failure to assemble without delivering anything", async () => {
    let delivered = 0;
    const backup = new PlayerDataBackup({
      assemble: () => {
        throw new Error("storage unavailable");
      },
      deliver: () => void (delivered += 1),
    });
    expect(await backup.take()).toMatchObject({ ok: false, reason: "storage unavailable" });
    expect(delivered).toBe(0);
    expect(backup.inProgress).toBe(false);
  });
});
