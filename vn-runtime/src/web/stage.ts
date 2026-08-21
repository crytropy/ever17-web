/**
 * PixiStage - the presentation layer.
 *
 * Renders PresentationState only: a SceneStateSnapshot (the truth to settle
 * on) plus the PresentationAction delta script recorded by the VM between
 * events. It has no knowledge of GameSession, scenes, or scenario semantics.
 *
 * Transition primitives: fade, crossfade, wait, sprite movement. Effects are
 * limited to the ids actually reached during full-route playback; each is an
 * approximation of the original engine's behaviour and is labelled as such.
 */
import { Application, Container, Graphics, Sprite, Texture, Assets } from "pixi.js";

export const STAGE_W = 800;
export const STAGE_H = 600;
const FRAME_MS = 1000 / 60;

/** Structural subset of the runtime types (kept local so the renderer depends
 * on shapes, not on the runtime package). */
export interface StageLayer {
  asset: string;
  file: string | null;
  width: number | null;
  height: number | null;
  x: number | null;
  slot: number | null;
}
export interface StageState {
  background: StageLayer | null;
  sprites: StageLayer[];
  fill: number | null;
}
export type StageAction =
  | { kind: "setBackground"; layer: StageLayer; fade: number | null; variant?: string }
  | { kind: "fillScreen"; color: number | null; fade: number | null }
  | { kind: "showSprite"; layer: StageLayer; mode: number | null }
  | { kind: "hideSprite"; slot: number | null; mode: number | null }
  | { kind: "spriteOrder"; order: (number | null)[] }
  | { kind: "transitionTime"; frames: number | null; mode: number | null }
  | { kind: "transitionSync" }
  | { kind: "wait"; amount: number | null; unit: "vm" | "frames" }
  | { kind: "effectOn"; effect: number | null }
  | { kind: "effectOff"; category: number | null }
  | { kind: "shake"; mode: number | null; amplitude: number | null }
  | { kind: "viewportRect"; x: number | null; y: number | null; w: number | null; h: number | null; frames: number | null }
  | { kind: "cgEffect"; asset: string | null; file: string | null; args: (number | null)[] };

export interface ApplyOptions {
  /** Complete everything immediately (skip mode / deterministic shots). */
  instant?: boolean;
  /** Multiply all durations (1 = authored speed). */
  speed?: number;
}

interface Tween {
  update(dtMs: number): boolean; // false = finished
  finish(): void;
}

/** Deterministic PRNG so particle effects are reproducible in shots. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export class PixiStage {
  readonly app: Application;
  private shaker = new Container();
  private world = new Container();
  private bgA = new Sprite();
  private bgB = new Sprite();
  private cg = new Sprite();
  private spriteLayer = new Container();
  private fillRect = new Graphics();
  private fx = new Container();
  private flashRect = new Graphics();
  private tintRect = new Graphics();
  private fogRect = new Graphics();
  private beamRect = new Graphics();
  private snow = new Container();

  private slots = new Map<number, Sprite>();
  private tweens = new Set<Tween>();
  private pendingFrames: number | null = null;
  private waitCancel: (() => void) | null = null;
  private activeEffects = new Set<number>();
  private shakeTime = 0;
  private shakeAmp = 0;
  private rand = lcg(0x1d117);

  private constructor(app: Application) {
    this.app = app;
    this.world.addChild(this.bgA, this.bgB, this.spriteLayer);
    this.fx.addChild(this.tintRect, this.beamRect, this.fogRect, this.snow, this.flashRect);
    // cg overlays sit above the fill: op00 letterboxes its CGs over white
    this.shaker.addChild(this.world, this.fillRect, this.cg, this.fx);
    app.stage.addChild(this.shaker);
    this.spriteLayer.sortableChildren = true;
    this.cg.visible = false;
    this.fillRect.rect(0, 0, STAGE_W, STAGE_H).fill(0x000000);
    this.fillRect.alpha = 0;
    this.flashRect.rect(0, 0, STAGE_W, STAGE_H).fill(0xffffff);
    this.flashRect.alpha = 0;
    this.tintRect.rect(0, 0, STAGE_W, STAGE_H).fill(0x203050);
    this.tintRect.alpha = 0;
    this.fogRect.rect(0, 0, STAGE_W, STAGE_H).fill(0xb8c0cc);
    this.fogRect.alpha = 0;
    this.beamRect.rect(0, 0, STAGE_W, STAGE_H).fill(0xfff2c0);
    this.beamRect.alpha = 0;
    app.ticker.add(() => this.tick(app.ticker.deltaMS));
  }

  static async create(parent: HTMLElement): Promise<PixiStage> {
    const app = new Application();
    await app.init({
      width: STAGE_W,
      height: STAGE_H,
      background: 0x000000,
      antialias: true,
      preference: "webgl",
      // keeps the framebuffer readable for snapshots and mid-frame sampling
      preserveDrawingBuffer: true,
    });
    parent.appendChild(app.canvas);
    return new PixiStage(app);
  }

  // ---------------------------------------------------------------- ticking
  private tick(dtMs: number): void {
    for (const t of [...this.tweens]) {
      if (!t.update(dtMs)) this.tweens.delete(t);
    }
    // quake decay (approximation of effect 12 / 4 / 5 and the SHAKE op)
    if (this.shakeAmp > 0.2) {
      this.shakeTime += dtMs;
      const a = this.shakeAmp;
      this.shaker.x = Math.sin(this.shakeTime / 23) * a;
      this.shaker.y = Math.cos(this.shakeTime / 17) * a * 0.7;
      this.shakeAmp *= Math.pow(0.998, dtMs);
    } else if (this.shaker.x !== 0 || this.shaker.y !== 0) {
      this.shaker.x = 0;
      this.shaker.y = 0;
      this.shakeAmp = 0;
    }
    // blink pulsing (effect 45): tint oscillates while active
    if (this.activeEffects.has(45)) {
      this.tintRect.alpha = 0.25 + 0.2 * Math.sin(this.shakeTime / 140);
      this.shakeTime += dtMs * (this.shakeAmp > 0 ? 0 : 1);
    }
    // snow drift (effect 41)
    if (this.snow.children.length > 0) {
      for (const flake of this.snow.children as Sprite[]) {
        flake.y += dtMs * 0.03 * (0.5 + flake.alpha);
        flake.x += Math.sin((flake.y + flake.x) / 60) * 0.3;
        if (flake.y > STAGE_H) flake.y = -4;
      }
    }
  }

  /** Clear everything - fresh stage (used between shot fixtures). */
  reset(): void {
    this.skip();
    this.clearSprites(true);
    this.bgA.visible = this.bgB.visible = false;
    this.cg.visible = false;
    this.fillRect.alpha = 0;
    this.flashRect.alpha = 0;
    this.tintRect.alpha = 0;
    this.fogRect.alpha = 0;
    this.beamRect.alpha = 0;
    this.snow.removeChildren();
    this.activeEffects.clear();
    this.shakeAmp = 0;
    this.shaker.x = this.shaker.y = 0;
    this.world.scale.set(1);
    this.world.pivot.set(0, 0);
    this.pendingFrames = null;
    this.rand = lcg(0x1d117);
  }

  /** Finish all in-flight transitions and waits immediately. */
  skip(): void {
    for (const t of [...this.tweens]) t.finish();
    this.tweens.clear();
    this.waitCancel?.();
  }

  private tween(
    durationMs: number,
    step: (k: number) => void,
    instant: boolean,
  ): Promise<void> {
    if (instant || durationMs <= 0) {
      step(1);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let elapsed = 0;
      const t: Tween = {
        update: (dt) => {
          elapsed += dt;
          const k = Math.min(1, elapsed / durationMs);
          step(k);
          if (k >= 1) {
            resolve();
            return false;
          }
          return true;
        },
        finish: () => {
          step(1);
          resolve();
        },
      };
      this.tweens.add(t);
    });
  }

  private takeDurationMs(defaultFrames: number, speed: number): number {
    const frames = this.pendingFrames ?? defaultFrames;
    this.pendingFrames = null;
    return (frames * FRAME_MS) / speed;
  }

  private async texture(file: string | null, resolveUrl: (f: string) => string): Promise<Texture | null> {
    if (!file) return null;
    try {
      return (await Assets.load(resolveUrl(file))) as Texture;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- apply
  /**
   * Play the action delta, then settle on the target state. Resolves when all
   * transitions (and authored waits) have completed.
   */
  async apply(
    state: StageState,
    actions: StageAction[],
    resolveUrl: (file: string) => string,
    opts: ApplyOptions = {},
  ): Promise<void> {
    const instant = opts.instant ?? false;
    const speed = opts.speed ?? 1;

    for (const a of actions) {
      switch (a.kind) {
        case "transitionTime":
          this.pendingFrames = a.frames;
          break;
        case "transitionSync":
          // barrier: wait for whatever is currently animating
          if (!instant) await this.settle();
          break;
        case "wait": {
          // vm-unit waits look like tenths of a second (docs: Medium).
          // Skippable: a click (stage.skip()) cancels the remainder.
          const ms = a.unit === "frames" ? (a.amount ?? 0) * FRAME_MS : (a.amount ?? 0) * 100;
          if (!instant && ms > 0) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                this.waitCancel = null;
                resolve();
              }, Math.min(ms, 2000) / speed);
              this.waitCancel = () => {
                clearTimeout(timer);
                this.waitCancel = null;
                resolve();
              };
            });
          }
          break;
        }
        case "setBackground":
          await this.setBackground(a.layer, a.fade, resolveUrl, instant, speed);
          break;
        case "fillScreen": {
          const target = a.color === 1 ? 0xffffff : 0x000000;
          this.fillRect.clear().rect(0, 0, STAGE_W, STAGE_H).fill(target);
          this.clearSprites(instant);
          this.cg.visible = false;
          const dur = a.fade ? this.takeDurationMs(18, speed) : 0;
          await this.tween(dur, (k) => (this.fillRect.alpha = k), instant || !a.fade);
          this.fillRect.alpha = 1;
          this.bgA.visible = this.bgB.visible = false;
          break;
        }
        case "showSprite":
          await this.showSprite(a.layer, a.mode, resolveUrl, instant, speed);
          break;
        case "hideSprite": {
          const targets =
            a.slot == null ? [...this.slots.keys()] : this.slots.has(a.slot) ? [a.slot] : [];
          await Promise.all(
            targets.map(async (slot) => {
              const sp = this.slots.get(slot);
              if (!sp) return;
              const dur = a.mode ? this.takeDurationMs(12, speed) : 0;
              const from = sp.alpha;
              await this.tween(dur, (k) => (sp.alpha = from * (1 - k)), instant || !a.mode);
              sp.destroy();
              this.slots.delete(slot);
            }),
          );
          break;
        }
        case "spriteOrder": {
          // z-order of the three sprite slots; index = depth (approximation)
          a.order.forEach((slotVal, depth) => {
            if (slotVal === null) return;
            const sp = this.slots.get(slotVal + 1) ?? this.slots.get(slotVal);
            if (sp) sp.zIndex = 10 - depth;
          });
          break;
        }
        case "effectOn":
          this.effectOn(a.effect, instant);
          break;
        case "effectOff":
          this.effectOff(a.category);
          break;
        case "shake":
          this.shakeAmp = Math.max(4, Math.min(20, (a.amplitude ?? 200) / 25));
          if (instant) this.shakeAmp = 0;
          break;
        case "viewportRect": {
          const w = a.w ?? STAGE_W;
          const h = a.h ?? STAGE_H;
          const full = w >= STAGE_W && h >= STAGE_H;
          const scale = full ? 1 : Math.min(STAGE_W / w, STAGE_H / h);
          const cx = (a.x ?? 0) + w / 2;
          const cy = (a.y ?? 0) + h / 2;
          const dur = ((a.frames ?? 30) * FRAME_MS) / speed;
          const s0 = this.world.scale.x;
          const p0x = this.world.pivot.x;
          const p0y = this.world.pivot.y;
          const px = full ? 0 : cx - STAGE_W / 2 / scale;
          const py = full ? 0 : cy - STAGE_H / 2 / scale;
          await this.tween(
            dur,
            (k) => {
              const s = s0 + (scale - s0) * k;
              this.world.scale.set(s);
              this.world.pivot.set(p0x + (px - p0x) * k, p0y + (py - p0y) * k);
            },
            instant,
          );
          break;
        }
        case "cgEffect": {
          // approximation: display the referenced CG as a full overlay until
          // the next background change
          const tex = await this.texture(a.file, resolveUrl);
          if (tex) {
            this.cg.texture = tex;
            this.cg.visible = true;
            this.cg.alpha = 0;
            const dur = this.takeDurationMs(18, speed);
            await this.tween(dur, (k) => (this.cg.alpha = k), instant);
          }
          break;
        }
      }
    }

    // settle on the target state (covers anything the delta missed, e.g.
    // resuming from a save where actions describe only the final moment)
    await this.settleToState(state, resolveUrl);
  }

  private async setBackground(
    layer: StageLayer,
    fade: number | null,
    resolveUrl: (f: string) => string,
    instant: boolean,
    speed: number,
  ): Promise<void> {
    const tex = await this.texture(layer.file, resolveUrl);
    if (!tex) return;
    this.cg.visible = false;
    const dur = fade ? this.takeDurationMs(20, speed) : 0;
    // crossfade: new texture on bgB over bgA, then swap roles
    this.bgB.texture = tex;
    this.bgB.y = Math.max(0, STAGE_H - tex.height);
    this.bgB.visible = true;
    this.bgB.alpha = 0;
    const fillWas = this.fillRect.alpha;
    await this.tween(
      dur,
      (k) => {
        this.bgB.alpha = k;
        if (fillWas > 0) this.fillRect.alpha = fillWas * (1 - k);
      },
      instant || !fade,
    );
    this.bgB.alpha = 1;
    this.fillRect.alpha = 0;
    const old = this.bgA;
    this.bgA = this.bgB;
    this.bgB = old;
    this.bgB.visible = false;
    this.world.setChildIndex(this.bgA, 0);
  }

  private async showSprite(
    layer: StageLayer,
    mode: number | null,
    resolveUrl: (f: string) => string,
    instant: boolean,
    speed: number,
  ): Promise<void> {
    const slot = layer.slot ?? 1;
    const tex = await this.texture(layer.file, resolveUrl);
    if (!tex) return;
    let sp = this.slots.get(slot);
    const targetX = layer.x ?? Math.round((STAGE_W - tex.width) / 2);
    const targetY = STAGE_H - tex.height;
    const dur = mode ? this.takeDurationMs(12, speed) : 0;
    if (!sp) {
      sp = new Sprite(tex);
      sp.x = targetX;
      sp.y = targetY;
      sp.alpha = 0;
      sp.zIndex = slot;
      this.spriteLayer.addChild(sp);
      this.slots.set(slot, sp);
      await this.tween(dur, (k) => (sp!.alpha = k), instant || !mode);
      sp.alpha = 1;
      return;
    }
    if (sp.texture !== tex) {
      // pose change in place: quick cross-dissolve via overlay sprite
      const ghost = new Sprite(sp.texture);
      ghost.x = sp.x;
      ghost.y = sp.y;
      ghost.zIndex = sp.zIndex;
      this.spriteLayer.addChild(ghost);
      sp.texture = tex;
      sp.y = STAGE_H - tex.height;
      sp.alpha = 0;
      await this.tween(
        dur,
        (k) => {
          sp!.alpha = k;
          ghost.alpha = 1 - k;
        },
        instant || !mode,
      );
      ghost.destroy();
      sp.alpha = 1;
    }
    if (sp.x !== targetX) {
      // sprite movement primitive
      const from = sp.x;
      await this.tween(dur || 200 / speed, (k) => (sp!.x = from + (targetX - from) * k), instant);
    }
  }

  private clearSprites(instant: boolean): void {
    void instant;
    for (const sp of this.slots.values()) sp.destroy();
    this.slots.clear();
  }

  // ---------------------------------------------------------------- effects
  /** Route-reachable effect ids only; all approximations (see sc3-format.md). */
  private effectOn(effect: number | null, instant: boolean): void {
    if (effect === null) return;
    this.activeEffects.add(effect);
    switch (effect) {
      case 46: // flash
        if (!instant) {
          this.flashRect.alpha = 1;
          void this.tween(220, (k) => (this.flashRect.alpha = 1 - k), false);
        }
        break;
      case 45: // blink (pulsing dark tint; handled in tick)
        this.tintRect.alpha = 0.3;
        break;
      case 44: // filter
      case 32:
        this.tintRect.alpha = 0.35;
        break;
      case 12: // quake (params in vars 571-576; amplitude approximated)
      case 4: // QUA1
      case 5: // QUA2
        this.shakeAmp = instant ? 0 : effect === 12 ? 14 : 8;
        this.shakeTime = 0;
        break;
      case 27: // sunbeams
        this.beamRect.alpha = 0.18;
        break;
      case 19: // fog
        this.fogRect.alpha = 0.3;
        break;
      case 41: {
        // snow: deterministic particle field
        this.snow.removeChildren();
        for (let i = 0; i < 80; i++) {
          const flake = new Sprite(Texture.WHITE);
          flake.width = flake.height = 2 + this.rand() * 3;
          flake.x = this.rand() * STAGE_W;
          flake.y = this.rand() * STAGE_H;
          flake.alpha = 0.4 + this.rand() * 0.6;
          this.snow.addChild(flake);
        }
        break;
      }
      default:
        // 47/48/49 map eyecatch/pins/route and unknown ids: recorded, no visual
        break;
    }
  }

  private effectOff(category: number | null): void {
    // category -> effect mapping is incomplete (docs); clear conservatively
    const clearTint = category === 13 || category === 11 || category === 15 || category === 16 || category === null;
    if (clearTint) {
      this.tintRect.alpha = 0;
      this.activeEffects.delete(44);
      this.activeEffects.delete(32);
      this.activeEffects.delete(45);
    }
    if (category === 7 || category === null) this.beamRect.alpha = 0;
    if (category === 6 || category === null) this.fogRect.alpha = 0; // rain category; fog shares
    if (category === 14 || category === null) this.snow.removeChildren();
    if (category === 0 || category === null) {
      this.shakeAmp = 0;
      this.activeEffects.clear();
    }
  }

  // ---------------------------------------------------------------- settle
  private settle(): Promise<void> {
    if (this.tweens.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.tweens.size === 0) resolve();
        else setTimeout(check, 16);
      };
      check();
    });
  }

  /** Force the display to match the target state exactly (skip/restore). */
  async settleToState(state: StageState, resolveUrl: (f: string) => string): Promise<void> {
    // background
    if (state.background?.file) {
      const tex = await this.texture(state.background.file, resolveUrl);
      if (tex && this.bgA.texture !== tex) {
        this.bgA.texture = tex;
        this.bgA.y = Math.max(0, STAGE_H - tex.height);
      }
      this.bgA.visible = true;
      this.bgA.alpha = 1;
      this.bgB.visible = false;
      this.fillRect.alpha = 0;
    } else {
      this.bgA.visible = this.bgB.visible = false;
      this.fillRect
        .clear()
        .rect(0, 0, STAGE_W, STAGE_H)
        .fill(state.fill === 1 ? 0xffffff : 0x000000);
      this.fillRect.alpha = 1;
    }
    // sprites: remove extras, ensure presence
    const want = new Map(state.sprites.filter((s) => s.file).map((s) => [s.slot ?? 1, s]));
    for (const [slot, sp] of [...this.slots]) {
      if (!want.has(slot)) {
        sp.destroy();
        this.slots.delete(slot);
      }
    }
    for (const [slot, layer] of want) {
      const tex = await this.texture(layer.file, resolveUrl);
      if (!tex) continue;
      let sp = this.slots.get(slot);
      if (!sp) {
        sp = new Sprite(tex);
        sp.zIndex = slot;
        this.spriteLayer.addChild(sp);
        this.slots.set(slot, sp);
      } else if (sp.texture !== tex) {
        sp.texture = tex;
      }
      sp.alpha = 1;
      sp.x = layer.x ?? Math.round((STAGE_W - tex.width) / 2);
      sp.y = STAGE_H - tex.height;
    }
  }

  /** Render one frame and return it as a PNG data URL (shots harness). */
  async snapshotPng(): Promise<string> {
    this.app.renderer.render(this.app.stage);
    const canvas = this.app.renderer.extract.canvas(this.app.stage) as HTMLCanvasElement;
    return canvas.toDataURL("image/png");
  }
}
