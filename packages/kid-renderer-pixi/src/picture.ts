/**
 * The picture operations, and where each of them is allowed to stop.
 *
 * Every one of these is an async helper that awaits an animation and then
 * finishes the job: a crossfade swaps the two background layers, a pose
 * change destroys the outgoing ghost, a hide destroys the sprite. Resolving
 * the animation without painting its last frame is therefore not enough to
 * abandon the operation - the helper simply resumes and does all of that
 * anyway, to a stage that now belongs to a different scene.
 *
 * So each await is followed by a check, and a cancelled outcome returns
 * immediately: no swap, no forced alpha, no destroy, no continuing into the
 * next tween. The replacement session owns the next visible mutation.
 *
 * Written against a small surface rather than Pixi objects so the finalizers
 * themselves can be tested - a stage needs a WebGL context, and these rules
 * are exactly the part that must not be left to a browser check.
 */
import type { AnimationOutcome, Animator } from "./animator.js";

/** The bits of a sprite these operations touch. */
export interface SurfaceSprite {
  texture: unknown;
  alpha: number;
  visible: boolean;
  x: number;
  y: number;
  zIndex: number;
  destroy(): void;
}

/** The bits of a fill/graphics layer these operations touch. */
export interface SurfaceFill {
  alpha: number;
  paint(color: number): void;
}

/**
 * Everything the picture is drawn on. The stage supplies Pixi objects; a test
 * supplies plain ones.
 */
export interface Surface {
  /** Front and back background layers; a crossfade swaps them. */
  bgA: SurfaceSprite;
  bgB: SurfaceSprite;
  /** Full-screen CG over the background and fill. */
  cg: SurfaceSprite;
  fill: SurfaceFill;
  /** Character sprites by slot. */
  slots: Map<number, SurfaceSprite>;
  /** Swap the two background layers after a crossfade. */
  swapBackgrounds(): void;
  /** Build a sprite for a freshly shown layer. */
  createSprite(texture: unknown): SurfaceSprite;
  /** Put a sprite into the display list. */
  addSprite(sprite: SurfaceSprite): void;
  /**
   * Register a display object that belongs to one operation rather than to
   * the picture: a crossfade ghost lives only for the length of its
   * transition and is in no slot, so nothing that settles the scene can find
   * it. Registering makes it findable, and therefore disposable.
   */
  ownTransient(sprite: SurfaceSprite): void;
  /** Forget a transient after the operation has disposed of it. */
  releaseTransient(sprite: SurfaceSprite): void;
  /** Height of the canvas, for bottom-aligning sprites. */
  height: number;
  /** Width of the canvas, for centring sprites. */
  width: number;
  /** Natural size of a loaded texture. */
  sizeOf(texture: unknown): { width: number; height: number };
  /** The camera transform, as scale and pivot. */
  readonly camera: { scale: number; pivotX: number; pivotY: number };
  /** Put the camera exactly here. */
  setCamera(scale: number, pivotX: number, pivotY: number): void;
}

export interface LayerRef {
  file: string | null;
  x: number | null;
  slot: number | null;
}

export interface PictureDeps {
  surface: Surface;
  anim: Animator;
  /** Load a texture, or null when it failed or was abandoned. */
  texture: (file: string | null) => Promise<unknown | null>;
  /** True once the picture being built has been abandoned. */
  cancelled: () => boolean;
}

/** A cancelled animation, or a cancel that landed while a texture loaded. */
const stopped = (outcome: AnimationOutcome, deps: PictureDeps): boolean =>
  outcome === "cancelled" || deps.cancelled();

export class Picture {
  constructor(private readonly deps: PictureDeps) {}

  /** Crossfade to a new background, then take the screen. */
  async setBackground(layer: LayerRef, durationMs: number, instant: boolean): Promise<void> {
    const { surface, anim } = this.deps;
    const deps = this.deps;
    const tex = await deps.texture(layer.file);
    if (!tex || deps.cancelled()) return;
    surface.cg.visible = false;
    const size = surface.sizeOf(tex);
    surface.bgB.texture = tex;
    surface.bgB.y = Math.max(0, surface.height - size.height);
    surface.bgB.visible = true;
    surface.bgB.alpha = 0;
    const fillWas = surface.fill.alpha;
    const outcome = await anim.tween(
      durationMs,
      (k) => {
        surface.bgB.alpha = k;
        if (fillWas > 0) surface.fill.alpha = fillWas * (1 - k);
      },
      instant,
    );
    // Abandoned mid-crossfade: leaving the swap undone is the whole point -
    // half a transition belonging to a scene nobody is watching must not
    // become the front layer of the one that replaces it.
    if (stopped(outcome, deps)) return;
    surface.bgB.alpha = 1;
    surface.fill.alpha = 0;
    surface.swapBackgrounds();
  }

  /** Fade the screen to a flat colour. */
  async fillScreen(color: number | null, durationMs: number, instant: boolean): Promise<void> {
    const { surface, anim } = this.deps;
    const deps = this.deps;
    surface.fill.paint(color === 1 ? 0xffffff : 0x000000);
    surface.cg.visible = false;
    const outcome = await anim.tween(durationMs, (k) => (surface.fill.alpha = k), instant);
    if (stopped(outcome, deps)) return;
    surface.fill.alpha = 1;
    surface.bgA.visible = false;
    surface.bgB.visible = false;
  }

  /** Show or update a character sprite. */
  async showSprite(layer: LayerRef, durationMs: number, instant: boolean, moveMs: number): Promise<void> {
    const { surface, anim } = this.deps;
    const deps = this.deps;
    const slot = layer.slot ?? 1;
    const tex = await deps.texture(layer.file);
    if (!tex || deps.cancelled()) return;
    const size = surface.sizeOf(tex);
    const targetX = layer.x ?? Math.round((surface.width - size.width) / 2);
    const targetY = surface.height - size.height;

    let sp = surface.slots.get(slot);
    if (!sp) {
      const fresh = surface.createSprite(tex);
      fresh.x = targetX;
      fresh.y = targetY;
      fresh.alpha = 0;
      fresh.zIndex = slot;
      surface.addSprite(fresh);
      surface.slots.set(slot, fresh);
      const outcome = await anim.tween(durationMs, (k) => (fresh.alpha = k), instant);
      // Abandoned while fading in: do not force it opaque. The replacement
      // settles the whole picture, including whether this sprite is in it.
      if (stopped(outcome, deps)) return;
      fresh.alpha = 1;
      return;
    }

    const current = sp;
    if (current.texture !== tex) {
      const ghost = surface.createSprite(current.texture);
      ghost.x = current.x;
      ghost.y = current.y;
      ghost.zIndex = current.zIndex;
      surface.addSprite(ghost);
      // The ghost belongs to this transition and to nothing else. Registering
      // it means an abandoned transition can still be cleaned up: it is in no
      // slot, so settleToState and reset would never see it otherwise.
      surface.ownTransient(ghost);
      current.texture = tex;
      current.y = surface.height - size.height;
      current.alpha = 0;
      const outcome = await anim.tween(
        durationMs,
        (k) => {
          current.alpha = k;
          ghost.alpha = 1 - k;
        },
        instant,
      );
      // Abandoned mid-dissolve: the sprite in the slot is left exactly as it
      // is, because the replacement settles the picture for itself - but the
      // ghost is this operation's own, and disposing of it is cleanup rather
      // than painting the abandoned animation's final frame.
      surface.releaseTransient(ghost);
      ghost.destroy();
      if (stopped(outcome, deps)) return;
      current.alpha = 1;
    }

    if (current.x !== targetX) {
      const from = current.x;
      const outcome = await anim.tween(moveMs, (k) => (current.x = from + (targetX - from) * k), instant);
      if (stopped(outcome, deps)) return;
    }
  }

  /** Fade sprites out and remove them. */
  async hideSprite(slot: number | null, durationMs: number, instant: boolean): Promise<void> {
    const { surface, anim } = this.deps;
    const deps = this.deps;
    const targets = slot == null ? [...surface.slots.keys()] : surface.slots.has(slot) ? [slot] : [];
    await Promise.all(
      targets.map(async (target) => {
        const sp = surface.slots.get(target);
        if (!sp) return;
        const from = sp.alpha;
        const outcome = await anim.tween(durationMs, (k) => (sp.alpha = from * (1 - k)), instant);
        // Abandoned mid-fade: the sprite is not destroyed and not removed
        // from the slot map. Deleting it would be a mutation of a stage the
        // replacement is about to settle for itself.
        if (stopped(outcome, deps)) return;
        sp.destroy();
        surface.slots.delete(target);
      }),
    );
  }

  /**
   * Move the camera to a new framing.
   *
   * Abandoned partway, the camera is left for the replacement to settle -
   * which it does, because the viewport is recorded state. Forcing the
   * abandoned target here would frame the next scene with the last one's
   * camera.
   */
  async moveCamera(
    target: { scale: number; pivotX: number; pivotY: number },
    durationMs: number,
    instant: boolean,
  ): Promise<void> {
    const { surface, anim } = this.deps;
    const deps = this.deps;
    const from = { ...surface.camera };
    const outcome = await anim.tween(
      durationMs,
      (k) => {
        surface.setCamera(
          from.scale + (target.scale - from.scale) * k,
          from.pivotX + (target.pivotX - from.pivotX) * k,
          from.pivotY + (target.pivotY - from.pivotY) * k,
        );
      },
      instant,
    );
    if (stopped(outcome, deps)) return;
    surface.setCamera(target.scale, target.pivotX, target.pivotY);
  }

  /** Fade a full-screen CG in over whatever is there. */
  async showCg(file: string | null, durationMs: number, instant: boolean): Promise<void> {
    const { surface, anim } = this.deps;
    const deps = this.deps;
    const tex = await deps.texture(file);
    if (!tex || deps.cancelled()) return;
    surface.cg.texture = tex;
    surface.cg.visible = true;
    surface.cg.alpha = 0;
    const outcome = await anim.tween(durationMs, (k) => (surface.cg.alpha = k), instant);
    if (stopped(outcome, deps)) return;
    surface.cg.alpha = 1;
  }
}
