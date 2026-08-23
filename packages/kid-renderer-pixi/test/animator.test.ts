import { describe, expect, it } from "vitest";
import { Animator, type AnimatorTimers } from "../src/animator.js";

/**
 * The gap these pin: cancelling an apply released its asset loads but not its
 * authored time, so a load or a backlog rewind still sat through the
 * abandoned session's pause, tween or transitionSync barrier.
 *
 * The other half is what a cancelled animation may touch. Skipping paints the
 * final frame, because that is the picture the author intended; cancelling
 * must not, because the picture belongs to a scene that is being thrown away.
 */

/** A clock the test drives by hand, so nothing is slept through. */
function fakeTimers() {
  const timers: { fn: () => void; at: number; cancelled: boolean }[] = [];
  let clock = 0;
  const api: AnimatorTimers & { advance(ms: number): void; now(): number; live(): number } = {
    set: (fn, ms) => {
      timers.push({ fn, at: clock + ms, cancelled: false });
      return timers.length - 1;
    },
    clear: (h) => {
      const t = timers[h as number];
      if (t) t.cancelled = true;
    },
    advance: (ms) => {
      clock += ms;
      for (const t of timers) {
        if (!t.cancelled && t.at <= clock) {
          t.cancelled = true;
          t.fn();
        }
      }
    },
    now: () => clock,
    live: () => timers.filter((t) => !t.cancelled).length,
  };
  return api;
}

const settledFlag = (p: Promise<void>) => {
  const box = { done: false };
  void p.then(() => (box.done = true));
  return box;
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("cancel during an authored wait", () => {
  it("releases it at once instead of sitting out the remainder", async () => {
    const t = fakeTimers();
    const anim = new Animator(t);
    const waiting = anim.wait(2000);
    const flag = settledFlag(waiting);
    await flush();
    expect(flag.done, "still waiting").toBe(false);
    expect(anim.waiting).toBe(1);

    anim.cancel();
    await expect(waiting).resolves.toBeUndefined();
    expect(anim.waiting).toBe(0);
    // and the clock never had to reach the end of the pause
    expect(t.now()).toBe(0);
  });

  it("cancels the underlying timer rather than leaving it to fire", async () => {
    const t = fakeTimers();
    const anim = new Animator(t);
    const waiting = anim.wait(2000);
    anim.cancel();
    await waiting;
    expect(t.live(), "no timer left pending").toBe(0);
    // firing the clock past the original deadline changes nothing
    t.advance(5000);
    expect(anim.waiting).toBe(0);
  });

  it("still lets an uncancelled wait finish normally", async () => {
    const t = fakeTimers();
    const anim = new Animator(t);
    const waiting = anim.wait(500);
    const flag = settledFlag(waiting);
    t.advance(499);
    await flush();
    expect(flag.done).toBe(false);
    t.advance(1);
    await expect(waiting).resolves.toBeUndefined();
  });
});

describe("cancel during a tween", () => {
  it("settles the tween without painting its final frame", async () => {
    const t = fakeTimers();
    const anim = new Animator(t);
    const frames: number[] = [];
    const running = anim.tween(1000, (k) => frames.push(k), false);
    anim.tick(250);
    expect(frames).toEqual([0.25]);

    anim.cancel();
    await expect(running).resolves.toBeUndefined();
    expect(frames, "an abandoned animation must not land on its last frame").toEqual([0.25]);
    expect(anim.active).toBe(0);
  });

  it("is the opposite of skip, which does paint the final frame", async () => {
    const anim = new Animator(fakeTimers());
    const frames: number[] = [];
    const running = anim.tween(1000, (k) => frames.push(k), false);
    anim.tick(250);
    anim.skip();
    await expect(running).resolves.toBeUndefined();
    expect(frames, "the authored picture is still the right one").toEqual([0.25, 1]);
  });

  it("stops a late ticker update from mutating the replacement picture", async () => {
    const anim = new Animator(fakeTimers());
    const frames: number[] = [];
    const running = anim.tween(1000, (k) => frames.push(k), false);
    anim.tick(100);
    anim.cancel();
    await running;

    // the ticker keeps running for the new scene
    anim.tick(500);
    anim.tick(500);
    expect(frames, "the abandoned tween is no longer driven").toEqual([0.1]);
    expect(anim.active).toBe(0);
  });

  it("cancels several running tweens together", async () => {
    const anim = new Animator(fakeTimers());
    const a: number[] = [];
    const b: number[] = [];
    const ta = anim.tween(1000, (k) => a.push(k), false);
    const tb = anim.tween(1000, (k) => b.push(k), false);
    anim.tick(100);
    expect(anim.active).toBe(2);
    anim.cancel();
    await Promise.all([ta, tb]);
    expect(anim.active).toBe(0);
    expect(a).toEqual([0.1]);
    expect(b).toEqual([0.1]);
  });

  it("leaves an instant tween alone - it has already painted", async () => {
    const anim = new Animator(fakeTimers());
    const frames: number[] = [];
    await anim.tween(1000, (k) => frames.push(k), true);
    expect(frames).toEqual([1]);
    anim.cancel();
    expect(anim.active).toBe(0);
  });
});

describe("cancel while transitionSync is settling", () => {
  it("releases the barrier rather than polling for a tween that will never end", async () => {
    const t = fakeTimers();
    const anim = new Animator(t);
    void anim.tween(10_000, () => undefined, false);
    anim.tick(1);

    const barrier = anim.settle();
    const flag = settledFlag(barrier);
    t.advance(16);
    await flush();
    expect(flag.done, "still blocked on the running tween").toBe(false);

    anim.cancel();
    await expect(barrier).resolves.toBeUndefined();
    expect(anim.active).toBe(0);
    expect(anim.waiting).toBe(0);
  });

  it("resolves immediately when nothing is animating", async () => {
    const anim = new Animator(fakeTimers());
    await expect(anim.settle()).resolves.toBeUndefined();
  });

  it("resolves normally once the tween it was waiting for finishes", async () => {
    const t = fakeTimers();
    const anim = new Animator(t);
    const running = anim.tween(100, () => undefined, false);
    anim.tick(1);
    const barrier = anim.settle();
    const flag = settledFlag(barrier);
    t.advance(16);
    await flush();
    expect(flag.done).toBe(false);

    anim.tick(200); // the tween completes
    await running;
    t.advance(16);
    await expect(barrier).resolves.toBeUndefined();
  });
});

describe("a replacement scene", () => {
  it("proceeds without waiting for any of the abandoned session's time", async () => {
    const t = fakeTimers();
    const anim = new Animator(t);
    // the outgoing picture: a long pause, a long tween, and a barrier on both
    const pause = anim.wait(2000);
    const painted: number[] = [];
    const fade = anim.tween(5000, (k) => painted.push(k), false);
    anim.tick(1);
    const barrier = anim.settle();
    const flags = [settledFlag(pause), settledFlag(fade), settledFlag(barrier)];
    await flush();
    expect(flags.every((f) => f.done)).toBe(false);

    // a load or a rewind lands
    anim.cancel();
    await Promise.all([pause, fade, barrier]);
    expect(flags.every((f) => f.done), "everything parked is released").toBe(true);
    expect(t.now(), "no authored time was sat through").toBe(0);

    // the replacement's own transition runs normally on the same animator
    const fresh: number[] = [];
    const next = anim.tween(100, (k) => fresh.push(k), false);
    anim.tick(100);
    await expect(next).resolves.toBeUndefined();
    expect(fresh.at(-1)).toBe(1);
    expect(painted, "the abandoned fade never reached its end").not.toContain(1);
  });
});

describe("repeated and redundant cancellation", () => {
  it("is harmless when called twice, and when nothing is running", async () => {
    const anim = new Animator(fakeTimers());
    expect(() => {
      anim.cancel();
      anim.cancel();
    }).not.toThrow();

    const running = anim.tween(1000, () => undefined, false);
    anim.tick(10);
    anim.cancel();
    anim.cancel();
    anim.cancel();
    await expect(running).resolves.toBeUndefined();
    expect(anim.active).toBe(0);
    expect(anim.waiting).toBe(0);
  });

  it("makes a following skip a no-op, which is how reset() calls both", async () => {
    const anim = new Animator(fakeTimers());
    const frames: number[] = [];
    const running = anim.tween(1000, (k) => frames.push(k), false);
    anim.tick(100);
    // reset(): cancelApply() then skip()
    anim.cancel();
    anim.skip();
    await expect(running).resolves.toBeUndefined();
    expect(frames, "the redundant skip paints nothing").toEqual([0.1]);
    expect(anim.active).toBe(0);
  });

  it("keeps skip idempotent too", async () => {
    const anim = new Animator(fakeTimers());
    const frames: number[] = [];
    const running = anim.tween(1000, (k) => frames.push(k), false);
    anim.tick(100);
    anim.skip();
    anim.skip();
    await running;
    expect(frames, "the final frame is painted once").toEqual([0.1, 1]);
  });
});

describe("what a cancelled tween leaves behind", () => {
  /**
   * Cancelling settles without painting, which is right for a fade the
   * replacement scene is about to redraw - and wrong for anything the stage
   * does not redraw. The flash overlay is driven by a fire-and-forget tween
   * from full white down to nothing; abandoned mid-fade it stayed on screen
   * and whited out whatever loaded next. The stage neutralises it explicitly
   * on cancel, and this pins the property that makes that necessary.
   */
  it("leaves the driven value wherever the animation had reached", async () => {
    const anim = new Animator(fakeTimers());
    let alpha = 1;
    const fading = anim.tween(220, (k) => (alpha = 1 - k), false);
    anim.tick(22); // a tenth of the way through
    expect(alpha).toBeCloseTo(0.9, 5);

    anim.cancel();
    await fading;
    expect(alpha, "the value is left mid-fade, not completed").toBeCloseTo(0.9, 5);
  });

  it("whereas skipping runs it to the end", async () => {
    const anim = new Animator(fakeTimers());
    let alpha = 1;
    const fading = anim.tween(220, (k) => (alpha = 1 - k), false);
    anim.tick(22);
    anim.skip();
    await fading;
    expect(alpha, "a skipped fade completes").toBe(0);
  });
});
