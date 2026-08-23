import { describe, expect, it } from "vitest";
import { AssetLoader, LoadCancelled, type WaitRecord } from "../src/asset-loader.js";

/**
 * The stall these pin: skip stopped for over twenty seconds with a
 * ten-second per-asset timeout and nothing on screen. Two causes, both here -
 * loads for one event ran one after another, so four cold assets cost four
 * timeouts' worth of patience while no single one was slow; and nothing could
 * interrupt a load, so returning to the title waited the conversion out.
 */

/** A loader whose every request the test settles by hand. */
function deferred() {
  const calls: string[] = [];
  const settlers = new Map<string, { resolve: (v: string) => void; reject: (e: unknown) => void }>();
  const load = (url: string): Promise<string> => {
    calls.push(url);
    return new Promise<string>((resolve, reject) => settlers.set(url, { resolve, reject }));
  };
  return {
    calls,
    load,
    resolve: (url: string, value = `tex:${url}`) => settlers.get(url)!.resolve(value),
    reject: (url: string, err: unknown = new Error("boom")) => settlers.get(url)!.reject(err),
    pendingUrls: () => [...settlers.keys()],
  };
}

/** A controllable clock, so timeouts are exact rather than slept through. */
function fakeTimers() {
  const timers: { fn: () => void; at: number; cancelled: boolean }[] = [];
  let clock = 0;
  return {
    now: () => clock,
    setTimer: (fn: () => void, ms: number) => { timers.push({ fn, at: clock + ms, cancelled: false }); return timers.length - 1; },
    clearTimer: (h: unknown) => { const t = timers[h as number]; if (t) t.cancelled = true; },
    advance: (ms: number) => {
      clock += ms;
      for (const t of timers) if (!t.cancelled && t.at <= clock) { t.cancelled = true; t.fn(); }
    },
  };
}

const make = () => {
  const d = deferred();
  const t = fakeTimers();
  const loader = new AssetLoader<string>({ load: d.load, setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now });
  const activity: { pending: number; progress?: { done: number; total: number } }[] = [];
  const errors: string[] = [];
  const waits: WaitRecord[] = [];
  loader.onActivity = (pending, progress) => activity.push({ pending, progress });
  loader.onError = (file) => errors.push(file);
  loader.onWait = (r) => waits.push(r);
  return { loader, d, t, activity, errors, waits };
};

describe("cancellation", () => {
  it("releases a load in flight instead of waiting it out", async () => {
    const { loader, d } = make();
    const pending = loader.get("bg01.png", "/assets/bg01.png");
    await Promise.resolve();
    let settled = false;
    void pending.then(() => (settled = true));
    expect(settled).toBe(false);

    loader.cancel();
    await expect(pending).resolves.toBeNull();
    // the underlying load is still outstanding - we simply stopped waiting
    expect(d.pendingUrls()).toEqual(["/assets/bg01.png"]);
  });

  it("does not record a cancelled load as a failure", async () => {
    const { loader, errors, waits } = make();
    const pending = loader.get("bg01.png", "/assets/bg01.png");
    await Promise.resolve();
    loader.cancel();
    await pending;
    expect(loader.failed, "an abandoned asset is not a broken one").toEqual([]);
    expect(errors, "the host must not be told to offer a retry").toEqual([]);
    expect(waits.at(-1)).toMatchObject({ outcome: "cancelled", file: "bg01.png" });
  });

  it("clears pending and loading state", async () => {
    const { loader, activity } = make();
    const a = loader.get("a.png", "/a.png");
    const b = loader.get("b.png", "/b.png");
    await Promise.resolve();
    expect(loader.pending).toBe(2);
    loader.cancel();
    await Promise.all([a, b]);
    expect(loader.pending, "nothing may be left in flight").toBe(0);
    expect(activity.at(-1)!.pending).toBe(0);
    expect(activity.at(-1)!.progress).toBeUndefined();
  });

  it("discards a late result rather than handing it to the new picture", async () => {
    const { loader, d } = make();
    const pending = loader.get("old.png", "/old.png");
    await Promise.resolve();
    loader.cancel();
    await expect(pending).resolves.toBeNull();
    // the abandoned load finally succeeds
    d.resolve("/old.png", "STALE");
    await Promise.resolve();
    await Promise.resolve();
    // and cannot be mistaken for the current picture's asset
    expect(loader.failed).toEqual([]);
    expect(loader.pending).toBe(0);
  });

  it("survives a late rejection without an unhandled rejection", async () => {
    const { loader, d, errors } = make();
    const rejections: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent | unknown): void => void rejections.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const pending = loader.get("old.png", "/old.png");
      await Promise.resolve();
      loader.cancel();
      await pending;
      d.reject("/old.png", new Error("conversion died"));
      await new Promise((r) => setTimeout(r, 10));
      expect(rejections, "an abandoned load's failure must stay handled").toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("is safe to cancel when nothing is loading, and repeatedly", () => {
    const { loader } = make();
    expect(() => { loader.cancel(); loader.cancel(); }).not.toThrow();
    expect(loader.pending).toBe(0);
  });

  it("lets the caller tell an abandoned load from a failed one", async () => {
    const { loader } = make();
    const epoch = loader.epoch;
    const pending = loader.get("a.png", "/a.png");
    await Promise.resolve();
    loader.cancel();
    await pending;
    expect(loader.stale(epoch)).toBe(true);
  });
});

describe("several assets for one event", () => {
  it("loads them together, so they do not multiply the timeout", async () => {
    const { loader, d, t } = make();
    const files = ["a", "b", "c", "d"].map((n) => ({ file: `${n}.png`, base: `/${n}.png` }));
    const warm = loader.warm(files);
    await Promise.resolve();
    // all four are requested at once, not one after another
    expect(d.calls).toEqual(["/a.png", "/b.png", "/c.png", "/d.png"]);
    expect(loader.pending).toBe(4);

    // each takes 4s: serial would be 16s and would have blown past any
    // sane budget; together they cost one asset's wait
    t.advance(4000);
    for (const f of files) d.resolve(f.base);
    await warm;
    expect(t.now()).toBe(4000);
    expect(loader.failed).toEqual([]);
  });

  it("reports progress a host can show as a count", async () => {
    const { loader, d, activity } = make();
    const files = ["a", "b", "c"].map((n) => ({ file: `${n}.png`, base: `/${n}.png` }));
    const warm = loader.warm(files);
    await Promise.resolve();
    expect(activity.some((a) => a.progress?.total === 3)).toBe(true);
    d.resolve("/a.png");
    await new Promise((r) => setTimeout(r, 0));
    const withProgress = activity.filter((a) => a.progress);
    expect(withProgress.at(-1)!.progress).toMatchObject({ total: 3 });
    expect(withProgress.at(-1)!.progress!.done).toBeGreaterThanOrEqual(1);
    d.resolve("/b.png"); d.resolve("/c.png");
    await warm;
    expect(activity.at(-1)!.pending).toBe(0);
  });

  it("does not overlap a single asset - there is nothing to overlap", async () => {
    const { loader, d } = make();
    await loader.warm([{ file: "solo.png", base: "/solo.png" }]);
    expect(d.calls).toEqual([]);
  });

  it("asks for each distinct file once", async () => {
    const { loader, d } = make();
    const warm = loader.warm([
      { file: "a.png", base: "/a.png" },
      { file: "a.png", base: "/a.png" },
      { file: "b.png", base: "/b.png" },
    ]);
    await Promise.resolve();
    expect(d.calls).toEqual(["/a.png", "/b.png"]);
    d.resolve("/a.png"); d.resolve("/b.png");
    await warm;
  });

  it("is cancellable as a batch", async () => {
    const { loader, errors } = make();
    const warm = loader.warm([
      { file: "a.png", base: "/a.png" },
      { file: "b.png", base: "/b.png" },
    ]);
    await Promise.resolve();
    loader.cancel();
    await warm;
    expect(loader.pending).toBe(0);
    expect(loader.failed).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("a genuinely broken asset", () => {
  it("still times out and is reported as retryable", async () => {
    const { loader, t, errors, waits } = make();
    const pending = loader.get("stuck.png", "/stuck.png");
    await Promise.resolve();
    t.advance(10_000);
    await expect(pending).resolves.toBeNull();
    expect(loader.failed, "a real timeout is a failure").toEqual(["stuck.png"]);
    expect(errors).toEqual(["stuck.png"]);
    expect(waits.at(-1)).toMatchObject({ outcome: "timeout", file: "stuck.png" });
  });

  it("reports a conversion error as a failure too", async () => {
    const { loader, d, errors, waits } = make();
    const pending = loader.get("bad.png", "/bad.png");
    await Promise.resolve();
    d.reject("/bad.png", new Error("conversion failed"));
    await expect(pending).resolves.toBeNull();
    expect(loader.failed).toEqual(["bad.png"]);
    expect(errors).toEqual(["bad.png"]);
    expect(waits.at(-1)).toMatchObject({ outcome: "error" });
  });

  it("asks for a fresh URL on retry, since loaders cache by URL", async () => {
    const { loader, d } = make();
    loader.retry(["bad.png"]);
    const pending = loader.get("bad.png", "/bad.png");
    await Promise.resolve();
    expect(d.calls[0]).toBe("/bad.png?retry=1");
    d.resolve("/bad.png?retry=1");
    await pending;
    expect(loader.failed).toEqual([]);
  });

  it("clears a failure once the file loads", async () => {
    const { loader, d, t } = make();
    const first = loader.get("x.png", "/x.png");
    await Promise.resolve();
    t.advance(10_000);
    await first;
    expect(loader.failed).toEqual(["x.png"]);

    loader.retry(["x.png"]);
    const second = loader.get("x.png", "/x.png");
    await Promise.resolve();
    d.resolve("/x.png?retry=1");
    await second;
    expect(loader.failed).toEqual([]);
  });
});

describe("timing records", () => {
  it("names the wait, its outcome and how long it took", async () => {
    const { loader, d, t, waits } = make();
    const pending = loader.get("bg.png", "/bg.png");
    await Promise.resolve();
    t.advance(2500);
    d.resolve("/bg.png");
    await pending;
    expect(waits.at(-1)).toMatchObject({ kind: "texture", file: "bg.png", outcome: "ok", ms: 2500 });
  });

  it("records a batch as one prefetch, at the cost of its slowest member", async () => {
    const { loader, d, t, waits } = make();
    const warm = loader.warm([
      { file: "a.png", base: "/a.png" },
      { file: "b.png", base: "/b.png" },
    ]);
    await Promise.resolve();
    t.advance(1000);
    d.resolve("/a.png");
    await Promise.resolve();
    t.advance(2000);
    d.resolve("/b.png");
    await warm;
    const prefetch = waits.filter((w) => w.kind === "prefetch");
    expect(prefetch).toHaveLength(1);
    expect(prefetch[0]!.ms, "the batch costs the slowest, not the sum").toBe(3000);
  });
});
