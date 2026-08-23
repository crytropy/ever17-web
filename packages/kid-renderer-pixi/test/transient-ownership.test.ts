import { describe, expect, it } from "vitest";
import { Animator, type AnimatorTimers } from "../src/animator.js";
import { Picture, type Surface, type SurfaceSprite } from "../src/picture.js";

/** STAGE 0 REGRESSION 2: a cancelled pose crossfade leaks its ghost. */
function fakeTimers(): AnimatorTimers {
  return { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
}
const sprite = (texture: unknown = "tex"): SurfaceSprite & { destroyed: boolean } => ({
  texture, alpha: 1, visible: true, x: 0, y: 0, zIndex: 0, destroyed: false,
  destroy() { this.destroyed = true; },
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("a cancelled pose crossfade", () => {
  it("leaves no untracked child in the display list", async () => {
    const anim = new Animator(fakeTimers());
    const children: SurfaceSprite[] = [];
    const transients = new Set<SurfaceSprite>();
    const slots = new Map<number, SurfaceSprite>();
    const existing = sprite("old-tex");
    slots.set(1, existing);
    children.push(existing);

    const surface: Surface = {
      get bgA() { return sprite(); }, get bgB() { return sprite(); }, get cg() { return sprite(); },
      fill: { alpha: 0, paint: () => undefined },
      slots,
      swapBackgrounds: () => undefined,
      createSprite: (t) => sprite(t),
      addSprite: (s) => void children.push(s),
      ownTransient: (s) => void transients.add(s),
      releaseTransient: (s) => void transients.delete(s),
      height: 600, width: 800,
      sizeOf: () => ({ width: 400, height: 500 }),
      get camera() { return { scale: 1, pivotX: 0, pivotY: 0 }; },
      setCamera: () => undefined,
    get camera() { return { ...state.camera }; },
    setCamera: (scale, pivotX, pivotY) => { state.camera = { scale, pivotX, pivotY }; },
    };
    const picture = new Picture({ surface, anim, texture: async () => "new-tex", cancelled: () => cancelled });
    let cancelled = false;

    const before = children.length;
    const op = picture.showSprite({ file: "ch.png", x: 0, slot: 1 }, 1000, false, 200);
    await flush();
    anim.tick(200);
    expect(children.length, "the ghost was added").toBe(before + 1);

    cancelled = true;
    anim.cancel();
    await op;

    // The ghost belongs to the abandoned transition alone: it is in no slot,
    // so settleToState/reset/clearSprites can never find it.
    const ghost = children.find((c) => c.texture === "old-tex" && c !== existing) as ReturnType<typeof sprite>;
    expect(ghost, "a ghost was created").toBeTruthy();
    expect(ghost.destroyed, "it must not survive the operation that owns it").toBe(true);
    expect(children.filter((c) => !slots.has(1) || c !== existing).length, "no untracked child remains")
      .toBeLessThanOrEqual(before);
  });
});

/**
 * STAGE 5 AUDIT — every temporary the renderer creates, and who cleans it.
 *
 * | object              | owner                | completion | skip     | cancel/reset            |
 * |---------------------|----------------------|------------|----------|-------------------------|
 * | pose ghost          | the showSprite op    | destroyed  | destroyed| destroyed via transients|
 * | background back-buf | the stage (bgB)      | swapped    | swapped  | left; settle re-settles |
 * | fresh sprite        | slots (registered)   | alpha 1    | alpha 1  | left; settle re-settles |
 * | CG overlay          | the stage (cg)       | alpha 1    | alpha 1  | left; settle re-settles |
 * | fill overlay        | the stage (fillRect) | alpha 1    | alpha 1  | left; settle re-settles |
 * | flash overlay       | the stage            | tween to 0 | tween    | zeroed by cancelApply   |
 * | snow particles      | the stage (snow)     | n/a        | n/a      | cleared by reset        |
 * | camera transform    | the stage (world)    | final      | final    | identity on cancelApply |
 *
 * Only the pose ghost is invisible to settleToState, because it is in no
 * slot - which is why it is the one that needed explicit ownership.
 */
describe("the transient audit", () => {
  it("registers exactly the objects nothing else can find", async () => {
    const anim = new Animator(fakeTimers());
    const transients = new Set<SurfaceSprite>();
    const slots = new Map<number, SurfaceSprite>();
    const added: SurfaceSprite[] = [];
    let cancelled = false;
    const surface: Surface = {
      get bgA() { return sprite(); }, get bgB() { return sprite(); }, get cg() { return sprite(); },
      fill: { alpha: 0, paint: () => undefined },
      slots,
      swapBackgrounds: () => undefined,
      createSprite: (t) => sprite(t),
      addSprite: (s) => void added.push(s),
      ownTransient: (s) => void transients.add(s),
      releaseTransient: (s) => void transients.delete(s),
      height: 600, width: 800,
      sizeOf: () => ({ width: 400, height: 500 }),
      get camera() { return { scale: 1, pivotX: 0, pivotY: 0 }; },
      setCamera: () => undefined,
    };
    // each file resolves to its own texture, so a pose change really changes
    const picture = new Picture({ surface, anim, texture: async (f) => `tex:${f}`, cancelled: () => cancelled });

    // a fresh sprite is registered in a slot, so nothing transient is needed
    await picture.showSprite({ file: "a.png", x: 0, slot: 1 }, 0, true, 0);
    expect(transients.size, "a slot sprite is findable by settleToState").toBe(0);
    expect(slots.has(1)).toBe(true);

    // a pose change creates the one object no slot holds
    const op = picture.showSprite({ file: "b.png", x: 0, slot: 1 }, 1000, false, 200);
    await flush();
    anim.tick(100);
    expect(transients.size, "the ghost is owned while it exists").toBe(1);
    cancelled = true;
    anim.cancel();
    await op;
    expect(transients.size, "and released once disposed of").toBe(0);
  });
});
