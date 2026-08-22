import { describe, expect, it } from "vitest";
import { LoadingIndicator, type IndicatorTimers } from "../src/loading-indicator.js";

/**
 * Fake clock: timers fire only when the test advances time, so the debounce
 * can be exercised exactly rather than raced against a real conversion.
 */
function fakeTimers(): IndicatorTimers & { advance(ms: number): void; pending: number } {
  let now = 0;
  let nextId = 1;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    set(fn, ms) {
      const id = nextId++;
      queue.set(id, { at: now + ms, fn });
      return id;
    },
    clear(handle) {
      queue.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, task] of [...queue]) {
        if (task.at <= now) {
          queue.delete(id);
          task.fn();
        }
      }
    },
    get pending() {
      return queue.size;
    },
  };
}

function setup(delay = 120) {
  const timers = fakeTimers();
  const events: string[] = [];
  const indicator = new LoadingIndicator(
    () => events.push("show"),
    () => events.push("hide"),
    delay,
    timers,
  );
  return { indicator, events, timers };
}

describe("loading indicator", () => {
  it("stays hidden for a load that finishes before the delay", () => {
    const { indicator, events, timers } = setup();
    indicator.update(1);
    timers.advance(100);
    indicator.update(0);
    timers.advance(1000);
    expect(events).toEqual([]);
    expect(indicator.visible).toBe(false);
  });

  it("appears once activity outlasts the delay, and hides when it settles", () => {
    const { indicator, events, timers } = setup();
    indicator.update(1);
    timers.advance(120);
    expect(events).toEqual(["show"]);
    expect(indicator.visible).toBe(true);
    indicator.update(0);
    expect(events).toEqual(["show", "hide"]);
    expect(indicator.visible).toBe(false);
  });

  it("keeps one timer across overlapping loads and hides only at the end", () => {
    const { indicator, events, timers } = setup();
    indicator.update(1);
    indicator.update(2);
    indicator.update(3);
    expect(timers.pending).toBe(1);
    timers.advance(120);
    expect(events).toEqual(["show"]);
    indicator.update(2);
    indicator.update(1);
    expect(events).toEqual(["show"]); // still busy
    indicator.update(0);
    expect(events).toEqual(["show", "hide"]);
  });

  it("does not leave a timer armed after a fast load", () => {
    const { indicator, timers } = setup();
    indicator.update(1);
    expect(timers.pending).toBe(1);
    indicator.update(0);
    expect(timers.pending).toBe(0);
  });

  it("can show again on a later slow load", () => {
    const { indicator, events, timers } = setup();
    indicator.update(1);
    timers.advance(120);
    indicator.update(0);
    indicator.update(1);
    timers.advance(120);
    indicator.update(0);
    expect(events).toEqual(["show", "hide", "show", "hide"]);
  });

  it("is idempotent when told there is nothing to do", () => {
    const { indicator, events } = setup();
    indicator.update(0);
    indicator.update(0);
    expect(events).toEqual([]);
  });
});
