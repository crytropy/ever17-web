import { describe, expect, it } from "vitest";
import { Animator, type AnimatorTimers } from "../src/animator.js";
import { Picture, type Surface, type SurfaceSprite } from "../src/picture.js";

/**
 * Cancelling an animation without painting its last frame is not the same as
 * abandoning the operation: every helper here awaits a tween and then does the
 * real work - swapping the background layers, destroying a ghost, deleting a
 * sprite, forcing an alpha. Resolved-but-not-guarded, the helper simply
 * resumed and did all of that to a stage belonging to a different scene.
 *
 * So each test drives the real helper, cancels mid-flight, and asserts the
 * finalization did not happen.
 */

function fakeTimers() {
  const timers: { fn: () => void; at: number; cancelled: boolean }[] = [];
  let clock = 0;
  const api: AnimatorTimers & { advance(ms: number): void } = {
    set: (fn, ms) => { timers.push({ fn, at: clock + ms, cancelled: false }); return timers.length - 1; },
    clear: (h) => { const t = timers[h as number]; if (t) t.cancelled = true; },
    advance: (ms) => { clock += ms; for (const t of timers) if (!t.cancelled && t.at <= clock) { t.cancelled = true; t.fn(); } },
  };
  return api;
}

const sprite = (texture: unknown = "tex"): SurfaceSprite & { destroyed: boolean } => ({
  texture, alpha: 1, visible: true, x: 0, y: 0, zIndex: 0,
  destroyed: false,
  destroy() { this.destroyed = true; },
});

function harness(opts: { texture?: () => Promise<unknown | null> } = {}) {
  const anim = new Animator(fakeTimers());
  const bgA = sprite("bgA-tex");
  const bgB = sprite("bgB-tex");
  const cg = sprite("cg-tex");
  const added: SurfaceSprite[] = [];
  const transients = new Set<SurfaceSprite>();
  const state = { swaps: 0, fillAlpha: 0, painted: [] as number[], camera: { scale: 1, pivotX: 0, pivotY: 0 } };
  const slots = new Map<number, SurfaceSprite>();
  let cancelled = false;

  const surface: Surface = {
    get bgA() { return bgA; },
    get bgB() { return bgB; },
    get cg() { return cg; },
    fill: {
      get alpha() { return state.fillAlpha; },
      set alpha(v: number) { state.fillAlpha = v; },
      paint: (c) => void state.painted.push(c),
    },
    slots,
    swapBackgrounds: () => void state.swaps++,
    createSprite: (t) => { const s = sprite(t); added.push(s); return s; },
    addSprite: (s) => void added.push(s),
    ownTransient: (s) => void transients.add(s),
    releaseTransient: (s) => void transients.delete(s),
    height: 600,
    width: 800,
    sizeOf: () => ({ width: 400, height: 500 }),
    get camera() { return { ...state.camera }; },
    setCamera: (scale, pivotX, pivotY) => { state.camera = { scale, pivotX, pivotY }; },
  };

  const picture = new Picture({
    surface,
    anim,
    texture: opts.texture ?? (async () => "new-tex"),
    cancelled: () => cancelled,
  });
  return {
    picture, anim, surface, slots, bgA, bgB, cg, state, added, transients,
    cancel: () => { cancelled = true; anim.cancel(); },
    uncancel: () => { cancelled = false; },
    skip: () => anim.skip(),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("cancel during a background crossfade", () => {
  it("does not swap the layers or clear the fill", async () => {
    const h = harness();
    h.state.fillAlpha = 1;
    const op = h.picture.setBackground({ file: "bg.png", x: null, slot: null }, 1000, false);
    await flush();
    h.anim.tick(200);
    expect(h.bgB.alpha).toBeCloseTo(0.2, 5);

    h.cancel();
    await op;
    expect(h.state.swaps, "the half-faded layer must not become the front one").toBe(0);
    expect(h.bgB.alpha, "not forced opaque").toBeCloseTo(0.2, 5);
    expect(h.state.fillAlpha, "the fill is not cleared by an abandoned fade").toBeGreaterThan(0);
  });

  it("still swaps and settles when it completes normally", async () => {
    const h = harness();
    h.state.fillAlpha = 1;
    const op = h.picture.setBackground({ file: "bg.png", x: null, slot: null }, 100, false);
    await flush();
    h.anim.tick(100);
    await op;
    expect(h.state.swaps).toBe(1);
    expect(h.bgB.alpha).toBe(1);
    expect(h.state.fillAlpha).toBe(0);
  });

  it("still swaps when the player skips it", async () => {
    const h = harness();
    const op = h.picture.setBackground({ file: "bg.png", x: null, slot: null }, 1000, false);
    await flush();
    h.anim.tick(100);
    h.skip();
    await op;
    expect(h.state.swaps, "a skipped transition lands on the authored picture").toBe(1);
    expect(h.bgB.alpha).toBe(1);
  });

  it("stops before touching anything when the load is abandoned", async () => {
    const h = harness({ texture: async () => null });
    await h.picture.setBackground({ file: "bg.png", x: null, slot: null }, 100, false);
    expect(h.state.swaps).toBe(0);
    expect(h.bgB.visible, "an unloaded background is never shown").toBe(true); // untouched default
  });
});

describe("cancel during a screen fill", () => {
  it("does not force the fill opaque or hide the backgrounds", async () => {
    const h = harness();
    h.bgA.visible = true;
    const op = h.picture.fillScreen(1, 1000, false);
    await flush();
    h.anim.tick(300);
    h.cancel();
    await op;
    expect(h.state.fillAlpha, "not forced to 1").toBeCloseTo(0.3, 5);
    expect(h.bgA.visible, "the abandoned fill does not hide the background").toBe(true);
  });

  it("completes normally when it is not cancelled", async () => {
    const h = harness();
    h.bgA.visible = true;
    const op = h.picture.fillScreen(1, 100, false);
    await flush();
    h.anim.tick(100);
    await op;
    expect(h.state.fillAlpha).toBe(1);
    expect(h.bgA.visible).toBe(false);
    expect(h.state.painted).toEqual([0xffffff]);
  });
});

describe("cancel while a new sprite is fading in", () => {
  it("leaves it transparent rather than forcing it opaque", async () => {
    const h = harness();
    const op = h.picture.showSprite({ file: "ch.png", x: 100, slot: 1 }, 1000, false, 200);
    await flush();
    h.anim.tick(250);
    const sp = h.slots.get(1)!;
    expect(sp.alpha).toBeCloseTo(0.25, 5);

    h.cancel();
    await op;
    expect(sp.alpha, "an abandoned entrance is not completed").toBeCloseTo(0.25, 5);
  });

  it("completes normally otherwise", async () => {
    const h = harness();
    const op = h.picture.showSprite({ file: "ch.png", x: 100, slot: 1 }, 100, false, 200);
    await flush();
    h.anim.tick(100);
    await op;
    expect(h.slots.get(1)!.alpha).toBe(1);
  });
});

describe("cancel during a sprite pose crossfade", () => {
  it("disposes of its own ghost but leaves the slot sprite alone", async () => {
    const h = harness();
    const existing = sprite("old-tex");
    h.slots.set(1, existing);
    const op = h.picture.showSprite({ file: "ch.png", x: 0, slot: 1 }, 1000, false, 200);
    await flush();
    h.anim.tick(200);
    const ghost = h.added.find((s) => s.texture === "old-tex") as ReturnType<typeof sprite>;
    expect(ghost).toBeTruthy();
    expect(h.transients.has(ghost), "the ghost is owned by this operation").toBe(true);

    h.cancel();
    await op;
    // Cleaning up a private temporary is not painting the abandoned
    // animation's last frame: the ghost is in no slot, so nothing that
    // settles the scene could ever find it again.
    expect(ghost.destroyed, "the operation disposes of what only it can see").toBe(true);
    expect(h.transients.has(ghost), "and stops owning it").toBe(false);
    // The slot sprite belongs to the picture; the replacement settles it.
    expect(existing.destroyed, "a registered sprite is left for the replacement").toBe(false);
    expect(h.slots.get(1), "still registered").toBe(existing);
    expect(existing.alpha, "not forced opaque").toBeCloseTo(0.2, 5);
  });

  it("leaves no transient behind however many times it is cancelled", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      const existing = sprite(`pose-${i}`);
      h.slots.set(1, existing);
      const op = h.picture.showSprite({ file: "ch.png", x: 0, slot: 1 }, 1000, false, 200);
      await flush();
      h.anim.tick(100);
      h.cancel();
      await op;
      h.uncancel();
    }
    expect(h.transients.size, "cancellations do not accumulate display objects").toBe(0);
    expect(h.added.filter((s) => !(s as ReturnType<typeof sprite>).destroyed && !h.slots.has(1)).length).toBe(0);
  });

  it("destroys the ghost when it completes", async () => {
    const h = harness();
    h.slots.set(1, sprite("old-tex"));
    const op = h.picture.showSprite({ file: "ch.png", x: 0, slot: 1 }, 100, false, 200);
    await flush();
    h.anim.tick(100);
    await op;
    const ghost = h.added.find((s) => s.texture === "old-tex") as ReturnType<typeof sprite>;
    expect(ghost.destroyed).toBe(true);
  });
});

describe("cancel during sprite movement", () => {
  it("stops where it was, and does not continue the move", async () => {
    const h = harness();
    const existing = sprite("new-tex"); // same texture: goes straight to the move
    existing.x = 0;
    h.slots.set(1, existing);
    const op = h.picture.showSprite({ file: "ch.png", x: 400, slot: 1 }, 0, false, 1000);
    await flush();
    h.anim.tick(250);
    expect(existing.x).toBeCloseTo(100, 5);

    h.cancel();
    await op;
    expect(existing.x, "an abandoned move does not jump to its destination").toBeCloseTo(100, 5);
    // and later ticks cannot resume it
    h.anim.tick(1000);
    expect(existing.x).toBeCloseTo(100, 5);
  });
});

describe("cancel during a sprite hide", () => {
  it("does not destroy or unregister the sprite", async () => {
    const h = harness();
    const existing = sprite();
    h.slots.set(1, existing);
    const op = h.picture.hideSprite(1, 1000, false);
    await flush();
    h.anim.tick(200);

    h.cancel();
    await op;
    expect(existing.destroyed, "the sprite belongs to the stage now, not to this operation").toBe(false);
    expect(h.slots.has(1), "the slot map is not mutated by an abandoned hide").toBe(true);
  });

  it("destroys and unregisters when it completes", async () => {
    const h = harness();
    const existing = sprite();
    h.slots.set(1, existing);
    const op = h.picture.hideSprite(1, 100, false);
    await flush();
    h.anim.tick(100);
    await op;
    expect(existing.destroyed).toBe(true);
    expect(h.slots.has(1)).toBe(false);
  });

  it("handles hiding every sprite at once", async () => {
    const h = harness();
    h.slots.set(1, sprite());
    h.slots.set(2, sprite());
    const op = h.picture.hideSprite(null, 1000, false);
    await flush();
    h.anim.tick(100);
    h.cancel();
    await op;
    expect(h.slots.size, "none of them are removed").toBe(2);
  });
});

describe("cancel during a CG fade", () => {
  it("does not force the CG opaque", async () => {
    const h = harness();
    const op = h.picture.showCg("cg.png", 1000, false);
    await flush();
    h.anim.tick(400);
    expect(h.cg.alpha).toBeCloseTo(0.4, 5);
    h.cancel();
    await op;
    expect(h.cg.alpha).toBeCloseTo(0.4, 5);
  });

  it("completes normally otherwise", async () => {
    const h = harness();
    const op = h.picture.showCg("cg.png", 100, false);
    await flush();
    h.anim.tick(100);
    await op;
    expect(h.cg.alpha).toBe(1);
    expect(h.cg.visible).toBe(true);
  });
});

describe("cancellation and the replacement that follows", () => {
  it("leaves the stage exactly as the replacement settles it", async () => {
    const h = harness();
    // an outgoing crossfade, abandoned halfway
    const abandoned = h.picture.setBackground({ file: "old.png", x: null, slot: null }, 1000, false);
    await flush();
    h.anim.tick(300);
    h.cancel();
    await abandoned;

    // the replacement settles the picture for itself
    h.bgA.texture = "replacement";
    h.bgA.alpha = 1;
    h.bgA.visible = true;
    h.state.fillAlpha = 0;
    const swapsAfterReplacement = h.state.swaps;

    // late ticks belonging to the abandoned operation change nothing
    h.anim.tick(5000);
    await flush();
    expect(h.bgA.texture).toBe("replacement");
    expect(h.bgA.alpha).toBe(1);
    expect(h.state.fillAlpha).toBe(0);
    expect(h.state.swaps).toBe(swapsAfterReplacement);
  });

  it("a texture that lands after cancellation cannot start an operation", async () => {
    let release!: (v: unknown) => void;
    const pending = new Promise((r) => (release = r));
    const h = harness({ texture: () => pending as Promise<unknown> });
    const op = h.picture.setBackground({ file: "slow.png", x: null, slot: null }, 100, false);
    await flush();
    h.cancel();
    release("late-tex");
    await op;
    expect(h.bgB.texture, "the late texture is not installed").toBe("bgB-tex");
    expect(h.state.swaps).toBe(0);
  });

  it("is harmless when cancelled repeatedly", async () => {
    const h = harness();
    const op = h.picture.showCg("cg.png", 1000, false);
    await flush();
    h.anim.tick(100);
    h.cancel();
    h.cancel();
    h.cancel();
    await expect(op).resolves.toBeUndefined();
    expect(h.anim.active).toBe(0);
    expect(h.anim.waiting).toBe(0);
  });
});

describe("the camera", () => {
  /**
   * A zoom outlives the event that set it, so it is recorded state - and an
   * abandoned zoom must not frame the scene that replaces it. The replacement
   * settles its own camera from its own state; cancelling simply stops.
   */
  const target = { scale: 2, pivotX: 100, pivotY: 50 };

  it("reaches its authored framing when it completes", async () => {
    const h = harness();
    const op = h.picture.moveCamera(target, 100, false);
    await flush();
    h.anim.tick(100);
    await op;
    expect(h.state.camera).toEqual(target);
  });

  it("reaches it immediately when the player skips", async () => {
    const h = harness();
    const op = h.picture.moveCamera(target, 1000, false);
    await flush();
    h.anim.tick(100);
    h.skip();
    await op;
    expect(h.state.camera).toEqual(target);
  });

  for (const pct of [25, 50, 90]) {
    it(`stops where it was when cancelled at ${pct}%`, async () => {
      const h = harness();
      const op = h.picture.moveCamera(target, 1000, false);
      await flush();
      h.anim.tick(pct * 10);
      const mid = { ...h.state.camera };
      expect(mid.scale, "partway").toBeGreaterThan(1);
      expect(mid.scale).toBeLessThan(2);

      h.cancel();
      await op;
      expect(h.state.camera, "not forced to the abandoned target").toEqual(mid);
      expect(h.state.camera).not.toEqual(target);
    });
  }

  it("cannot be moved by a late tick after cancellation", async () => {
    const h = harness();
    const op = h.picture.moveCamera(target, 1000, false);
    await flush();
    h.anim.tick(200);
    h.cancel();
    await op;
    const afterCancel = { ...h.state.camera };
    h.anim.tick(5000);
    expect(h.state.camera, "the abandoned tween is no longer driven").toEqual(afterCancel);
  });

  it("hands the frame to whatever settles next", async () => {
    const h = harness();
    const op = h.picture.moveCamera(target, 1000, false);
    await flush();
    h.anim.tick(300);
    h.cancel();
    await op;
    // the replacement settles its own camera from its own state
    h.surface.setCamera(1, 0, 0);
    h.anim.tick(5000);
    expect(h.state.camera, "no intermediate zoom survives").toEqual({ scale: 1, pivotX: 0, pivotY: 0 });
  });

  it("is harmless to cancel repeatedly", async () => {
    const h = harness();
    const op = h.picture.moveCamera(target, 1000, false);
    await flush();
    h.anim.tick(100);
    h.cancel(); h.cancel(); h.cancel();
    await expect(op).resolves.toBeUndefined();
    expect(h.anim.active).toBe(0);
  });
});
