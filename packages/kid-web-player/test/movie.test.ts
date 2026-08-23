import { describe, expect, it, vi } from "vitest";
import { MoviePlayer, type MovieElement, type MovieOutcome } from "../src/movie.js";

/**
 * The freeze this exists to prevent: a movie's `ended`/`click` handlers are
 * the only thing that resolves the promise the player loop is awaiting, so
 * clearing them without resolving parks the loop forever. Every test here is
 * ultimately "did the await settle?".
 */

function fakeElement() {
  const el = {
    src: "",
    onended: null as (() => void) | null,
    onclick: null as (() => void) | null,
    classList: { tokens: new Set<string>(), add(t: string) { this.tokens.add(t); }, remove(t: string) { this.tokens.delete(t); } },
    playCalls: 0,
    pauseCalls: 0,
    removed: 0,
    playResult: Promise.resolve(),
    play(): Promise<void> { this.playCalls++; return this.playResult; },
    pause(): void { this.pauseCalls++; },
    removeAttribute(): void { this.removed++; },
  };
  return el as unknown as MovieElement & typeof el;
}

/** A HEAD check the test decides the outcome of, whenever it likes. */
function deferredExists() {
  let settle!: (ok: boolean) => void;
  const calls: AbortSignal[] = [];
  const exists = (_url: string, signal: AbortSignal): Promise<boolean> => {
    calls.push(signal);
    return new Promise<boolean>((r) => (settle = r));
  };
  return { exists, calls, resolve: (ok: boolean) => settle(ok) };
}

const timers = () => {
  const fns: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    fns,
    setTimer: (fn: () => void, ms: number) => { fns.push({ fn, ms, cancelled: false }); return fns.length - 1; },
    clearTimer: (h: unknown) => { const e = fns[h as number]; if (e) e.cancelled = true; },
    fire: (i: number) => { const e = fns[i]!; if (!e.cancelled) e.fn(); },
  };
};

describe("cancelling a movie", () => {
  it("resolves the promise the loop is awaiting", async () => {
    const el = fakeElement();
    const player = new MoviePlayer({ el, exists: async () => true });
    const pending = player.play("m.mp4");
    await Promise.resolve();
    await Promise.resolve();

    let settled = false;
    void pending.then(() => (settled = true));
    expect(settled).toBe(false);

    player.stop();
    await expect(pending).resolves.toBe<MovieOutcome>("cancelled");
    expect(player.playing).toBe(false);
  });

  it("tears the element down: handlers, playback and source", async () => {
    const el = fakeElement();
    const player = new MoviePlayer({ el, exists: async () => true });
    const pending = player.play("m.mp4");
    await Promise.resolve();
    await Promise.resolve();
    expect(el.onended).not.toBeNull();

    player.stop();
    await pending;
    expect(el.onended).toBeNull();
    expect(el.onclick).toBeNull();
    expect(el.pauseCalls).toBeGreaterThan(0);
    expect(el.removed).toBeGreaterThan(0);
    expect(el.classList.tokens.has("hidden")).toBe(true);
  });

  it("is harmless when repeated, and when nothing is playing", async () => {
    const el = fakeElement();
    const player = new MoviePlayer({ el, exists: async () => true });
    expect(() => { player.stop(); player.stop(); }).not.toThrow();

    const pending = player.play("m.mp4");
    await Promise.resolve();
    player.stop();
    player.stop();
    player.stop();
    await expect(pending).resolves.toBe("cancelled");
    expect(player.playing).toBe(false);
  });

  it("settles a movie cancelled while its HEAD request is still in flight", async () => {
    const el = fakeElement();
    const head = deferredExists();
    const player = new MoviePlayer({ el, exists: head.exists });
    const pending = player.play("m.mp4");
    await Promise.resolve();

    player.stop();
    await expect(pending).resolves.toBe("cancelled");
    // the HEAD then completes successfully - and must not start anything
    head.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(el.playCalls, "a superseded HEAD must not start a movie").toBe(0);
    expect(el.src).toBe("");
    expect(player.playing).toBe(false);
  });

  it("aborts the HEAD request rather than leaving it running", async () => {
    const el = fakeElement();
    const head = deferredExists();
    const player = new MoviePlayer({ el, exists: head.exists });
    void player.play("m.mp4");
    await Promise.resolve();
    expect(head.calls[0]!.aborted).toBe(false);
    player.stop();
    expect(head.calls[0]!.aborted).toBe(true);
  });
});

describe("a movie that is not in the package", () => {
  it("reports missing rather than hanging", async () => {
    const el = fakeElement();
    const player = new MoviePlayer({ el, exists: async () => false });
    await expect(player.play("gone.mp4")).resolves.toBe<MovieOutcome>("missing");
    expect(el.playCalls).toBe(0);
    expect(player.playing).toBe(false);
  });
});

describe("skip timers", () => {
  it("ends the movie it belongs to", async () => {
    const el = fakeElement();
    const t = timers();
    const player = new MoviePlayer({ el, exists: async () => true, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const pending = player.play("m.mp4", { skipAfterMs: 400 });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    t.fire(0);
    await expect(pending).resolves.toBe("played");
  });

  it("cannot finish or mutate a newer movie", async () => {
    const el = fakeElement();
    const t = timers();
    const player = new MoviePlayer({ el, exists: async () => true, setTimer: t.setTimer, clearTimer: t.clearTimer });

    const first = player.play("old.mp4", { skipAfterMs: 400 });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(t.fns).toHaveLength(1);

    // a session swap replaces it with another movie
    const second = player.play("new.mp4", { skipAfterMs: null });
    await expect(first).resolves.toBe("cancelled");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // the old timer fires late
    t.fire(0);
    let secondSettled = false;
    void second.then(() => (secondSettled = true));
    await Promise.resolve();
    expect(secondSettled, "a stale timer must not end the current movie").toBe(false);
    expect(el.src).toBe("new.mp4");

    player.stop();
    await expect(second).resolves.toBe("cancelled");
  });

  it("cancels its timer when the movie ends normally", async () => {
    const el = fakeElement();
    const t = timers();
    const player = new MoviePlayer({ el, exists: async () => true, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const pending = player.play("m.mp4", { skipAfterMs: 400 });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    el.onended!();
    await expect(pending).resolves.toBe("played");
    expect(t.fns[0]!.cancelled).toBe(true);
  });
});

describe("starting another movie", () => {
  it("cancels the one already running", async () => {
    const el = fakeElement();
    const player = new MoviePlayer({ el, exists: async () => true });
    const first = player.play("a.mp4");
    await Promise.resolve(); await Promise.resolve();
    const second = player.play("b.mp4");
    await expect(first).resolves.toBe("cancelled");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(el.src).toBe("b.mp4");
    player.stop();
    await expect(second).resolves.toBe("cancelled");
  });

  it("survives an autoplay rejection without hanging", async () => {
    const el = fakeElement();
    el.playResult = Promise.reject(new Error("NotAllowedError"));
    const player = new MoviePlayer({ el, exists: async () => true });
    const pending = player.play("m.mp4");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    // a click still ends it
    el.onclick!();
    await expect(pending).resolves.toBe("played");
  });
});

describe("returning to the title during a movie", () => {
  it("releases the loop and lets a New Game play a movie afterwards", async () => {
    const el = fakeElement();
    const player = new MoviePlayer({ el, exists: async () => true });

    // a movie is playing when the player quits to the title
    const interrupted = player.play("ending.mp4");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(player.playing).toBe(true);

    player.stop();                                   // what endSession does
    await expect(interrupted, "the loop must not stay parked").resolves.toBe("cancelled");
    expect(player.playing).toBe(false);
    expect(el.onended).toBeNull();

    // New Game, and a movie plays normally
    const fresh = player.play("opening.mp4");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(el.src).toBe("opening.mp4");
    expect(el.classList.tokens.has("hidden")).toBe(false);
    el.onended!();
    await expect(fresh).resolves.toBe("played");
  });

  it("survives being stopped twice around a title round trip", async () => {
    const el = fakeElement();
    const player = new MoviePlayer({ el, exists: async () => true });
    const a = player.play("m.mp4");
    await Promise.resolve(); await Promise.resolve();
    player.stop();          // return to title
    player.stop();          // showTitle, again
    await expect(a).resolves.toBe("cancelled");
    const b = player.play("m2.mp4");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    el.onended!();
    await expect(b).resolves.toBe("played");
  });
});
