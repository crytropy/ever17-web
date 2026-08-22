import { evaluateCondition, MOD_ADD, MOD_ASSIGN } from "./conditions.js";
import type {
  AssetIndex,
  ChoiceEvent,
  ChoiceOptionView,
  IrOp,
  IrScene,
  LayerState,
  PlayerEvent,
  PresentationAction,
  SceneState,
  SceneStateSnapshot,
} from "./types.js";

/**
 * Sprite x operands are expressed in a 640-wide logical space (320 = centre);
 * the shipped artwork is 800x600. A sprite's PRT header carries the x offset of
 * its trimmed bitmap inside that nominal frame, so:
 *
 *   screenX = baseLeftOffset * (SCREEN_W / nominalWidth)
 *           + (spriteX - LOGICAL_CENTRE) * (SCREEN_W / LOGICAL_W)
 *
 * Confidence: Medium. Derived from the PRT anchor fields and the fact that the
 * overwhelmingly common operand 320 reproduces each sprite's authored position
 * exactly; other operands (128/176/464/512) then place sprites symmetrically.
 */
export const SCREEN_W = 800;
export const SCREEN_H = 600;
const LOGICAL_W = 640;
const LOGICAL_CENTRE = 320;

export interface VmOptions {
  /** Called for each op that the VM does not present (effects, waits, unknowns). */
  onOp?: (op: IrOp, block: string) => void;
  /** Safety valve against a malformed/cyclic IR; counted in executed ops. */
  stepLimit?: number;
  /** What to do when a VAR_JUMP condition cannot be evaluated. Default: "fallthrough". */
  unknownJump?: "jump" | "fallthrough";
  /** Reports every VAR_JUMP decision. */
  onVarJump?: (info: VarJumpInfo) => void;
  /** Reports every variable write. */
  onVarSet?: (varId: number, value: number, mod: number, block: string) => void;
  /** Shared variable table (cross-scene persistence); a fresh one when absent. */
  vars?: Map<number, number>;
  /** Shared system-variable table (sysVarTest reads; e.g. "already seen"). */
  sysVars?: Map<number, number>;
  /** Resume from a snapshot taken with getSaveState(). */
  resume?: VmSaveState;
}

export interface VarJumpInfo {
  block: string;
  condition: string;
  /** undefined when the relation or operands are not understood. */
  value: boolean | undefined;
  jumped: boolean;
  target: string;
}

export interface ChoiceDecision {
  /** Option index to take. */
  option: number;
}

/**
 * Serializable snapshot of one SceneVm, taken at an event boundary: restoring
 * it re-presents the same event with the same presentation state, and the
 * continuation is identical to an uninterrupted run (pinned by tests).
 */
export interface VmSaveState {
  scene: string;
  /** Block/op index of the op that produced the currently presented event. */
  block: string;
  pc: number;
  steps: number;
  presentation: {
    background: LayerState | null;
    sprites: [number, LayerState][];
    bgm: string | null;
    fill: number | null;
  };
  /** Presentation deltas of the presented event (re-attached on resume). */
  actions?: PresentationAction[];
}

/**
 * Data-driven interpreter over a decompiled scene.
 *
 * The VM knows the IR op vocabulary and nothing else: no scene names, no asset
 * names, no hardcoded choice ids. It walks blocks, maintains presentation
 * state, and yields dialogue/choice events for a front end to render.
 */
export class SceneVm {
  readonly scene: IrScene;
  private readonly assets: AssetIndex;
  private readonly opts: VmOptions;

  /** Current block label and index of the next op inside it. */
  private block: string;
  private pc = 0;
  private state: SceneState = { background: null, sprites: new Map(), bgm: null, fill: null };
  private steps = 0;
  private finished = false;
  /** Scenario variables (choices, VAR_SET writes), keyed by variable id. */
  readonly vars: Map<number, number>;
  /** System-space variables read by sysVarTest jumps. */
  readonly sysVars: Map<number, number>;
  /** Ordered log of visited blocks, for merge/branch verification. */
  readonly blockTrace: string[] = [];

  constructor(scene: IrScene, assets: AssetIndex, opts: VmOptions = {}) {
    this.scene = scene;
    this.assets = assets;
    this.opts = opts;
    this.vars = opts.vars ?? new Map();
    this.sysVars = opts.sysVars ?? new Map();
    const resume = opts.resume;
    if (resume) {
      if (resume.scene !== scene.scene) {
        throw new Error(`save is for scene "${resume.scene}", not "${scene.scene}"`);
      }
      if (!scene.blocks[resume.block]) {
        throw new Error(`save block ${resume.block} not present in ${scene.scene}`);
      }
      this.block = resume.block;
      this.pc = resume.pc;
      this.steps = resume.steps;
      this.state = {
        background: resume.presentation.background ? { ...resume.presentation.background } : null,
        sprites: new Map(resume.presentation.sprites.map(([k, v]) => [k, { ...v }])),
        bgm: resume.presentation.bgm,
        fill: resume.presentation.fill,
      };
      this.resumeActions = (resume.actions ?? []).map((a) => ({ ...a }));
    } else {
      this.block = scene.entry;
      if (!scene.blocks[this.block]) {
        const first = Object.keys(scene.blocks).sort()[0];
        if (!first) throw new Error(`scene ${scene.scene} has no blocks`);
        this.block = first;
      }
    }
    this.blockTrace.push(this.block);
  }

  /** (block, pc) of the op that produced the last yielded dialogue/choice. */
  private eventPoint: { block: string; pc: number } | null = null;
  /** Presentation deltas accumulated since the last yielded event. */
  private actions: PresentationAction[] = [];
  /** Actions to re-deliver with the first event after a resume. */
  private resumeActions: PresentationAction[] | null = null;
  /** Actions delivered with the currently presented event (for saves). */
  private presentedActions: PresentationAction[] = [];

  /**
   * Snapshot for save files. Valid while an event is being presented; before
   * the first event it captures the scene start.
   */
  getSaveState(): VmSaveState {
    const at = this.eventPoint ?? { block: this.block, pc: this.pc };
    return {
      scene: this.scene.scene,
      block: at.block,
      pc: at.pc,
      steps: this.steps,
      presentation: {
        background: this.state.background ? { ...this.state.background } : null,
        sprites: [...this.state.sprites.entries()].map(([k, v]) => [k, { ...v }]),
        bgm: this.state.bgm,
        fill: this.state.fill,
      },
      actions: this.presentedActions.map((a) => ({ ...a })),
    };
  }

  get currentBlock(): string {
    return this.block;
  }

  get done(): boolean {
    return this.finished;
  }

  /** Hand the accumulated deltas to the event being yielded. */
  private takeActions(): PresentationAction[] {
    if (this.resumeActions) {
      const a = this.resumeActions;
      this.resumeActions = null;
      this.actions = [];
      this.presentedActions = a;
      return a.map((x) => ({ ...x }));
    }
    const a = this.actions;
    this.actions = [];
    this.presentedActions = a;
    return a.map((x) => ({ ...x }));
  }

  private snapshot(): SceneStateSnapshot {
    return {
      background: this.state.background ? { ...this.state.background } : null,
      sprites: [...this.state.sprites.values()].map((s) => ({ ...s })),
      bgm: this.state.bgm,
      fill: this.state.fill,
      block: this.block,
    };
  }

  private layerFor(asset: string | null, slot: number | null, x: number | null): LayerState {
    const name = asset ?? "<unresolved>";
    const entry = this.assets.get(name);
    let screenX: number | null = null;
    if (entry?.width != null && x != null) {
      const anchor = entry.baseLeftOffset ?? 0;
      screenX = Math.round(anchor + (x - LOGICAL_CENTRE) * (SCREEN_W / LOGICAL_W));
    }
    return {
      asset: name,
      file: entry?.file ?? null,
      width: entry?.width ?? null,
      height: entry?.height ?? null,
      x: screenX,
      slot,
    };
  }

  /** Jump to a block label; returns false when the label is unknown. */
  private goto(label: string | null): boolean {
    if (!label || !this.scene.blocks[label]) return false;
    this.block = label;
    this.pc = 0;
    this.blockTrace.push(label);
    return true;
  }

  /** Advance past the end of a block via its recorded fallthrough. */
  private fallthrough(): boolean {
    const next = this.scene.blocks[this.block]?.next ?? null;
    return this.goto(next);
  }

  /**
   * Run until the next event the presentation layer must handle.
   * Returns a dialogue line, a choice to make, or the end of the scene.
   */
  next(): PlayerEvent {
    if (this.finished) return { type: "end", reason: "terminated" };
    const limit = this.opts.stepLimit ?? 500_000;

    for (;;) {
      if (this.steps++ > limit) {
        this.finished = true;
        return { type: "end", reason: "stepLimit" };
      }
      const block = this.scene.blocks[this.block];
      if (!block) {
        this.finished = true;
        return { type: "end", reason: "terminated" };
      }
      if (this.pc >= block.ops.length) {
        if (!this.fallthrough()) {
          this.finished = true;
          return { type: "end", reason: "terminated" };
        }
        continue;
      }

      const op = block.ops[this.pc++]!;
      switch (op.op) {
        case "dialogue": {
          if (op.text.length === 0 && !op.voice) break; // stage direction with no line
          this.eventPoint = { block: this.block, pc: this.pc - 1 };
          return {
            type: "dialogue",
            speaker: op.speaker,
            text: op.text,
            voice: op.voice,
            voiceFile: this.assets.relative(op.voice),
            state: this.snapshot(),
            actions: this.takeActions(),
          };
        }

        case "choice": {
          const options: ChoiceOptionView[] = op.options.map((o) => {
            // Visibility: 0x0b 0x02 options are hidden once their variable is
            // zeroed (t_1c investigation menus). Unevaluable conditions leave
            // the option enabled rather than guessing it away.
            const cond = o.condition
              ? evaluateCondition(o.condition, this.vars, this.sysVars)
              : undefined;
            return {
              index: o.index,
              text: o.text,
              target: o.target,
              enabled: cond?.value !== false,
            };
          });
          if (options.length > 0 && options.every((o) => !o.enabled)) {
            // No visible options: the scripts gate menus so this state is not
            // reached in normal play (t_1c entry#1); continue linearly.
            break;
          }
          this.eventPoint = { block: this.block, pc: this.pc - 1 };
          return {
            type: "choice",
            id: op.id,
            resultVar: op.resultVar,
            options,
            state: this.snapshot(),
            actions: this.takeActions(),
          };
        }

        case "setBackground": {
          this.state.background = this.layerFor(op.asset, null, null);
          this.state.fill = null;
          this.actions.push({
            kind: "setBackground",
            layer: { ...this.state.background },
            fade: op.fade,
            ...(op.variant !== undefined ? { variant: op.variant } : {}),
          });
          break;
        }

        case "fillScreen": {
          this.state.fill = op.color;
          this.state.background = null;
          this.state.sprites.clear();
          this.actions.push({ kind: "fillScreen", color: op.color, fade: op.fade });
          break;
        }

        case "showSprite": {
          const slot = op.slot ?? 1;
          const layer = this.layerFor(op.asset, slot, op.x);
          this.state.sprites.set(slot, layer);
          this.actions.push({ kind: "showSprite", layer: { ...layer }, mode: op.mode });
          break;
        }

        case "showSprites": {
          op.sprites.forEach((s, i) => {
            const slot = i + 1;
            const layer = this.layerFor(s.asset, slot, s.x);
            this.state.sprites.set(slot, layer);
            this.actions.push({ kind: "showSprite", layer: { ...layer }, mode: op.mode });
          });
          break;
        }

        case "hideSprite": {
          if (op.slot == null) this.state.sprites.clear();
          else this.state.sprites.delete(op.slot);
          this.actions.push({ kind: "hideSprite", slot: op.slot, mode: op.mode });
          break;
        }

        case "playBGM": {
          this.state.bgm = op.track != null ? `bgm${String(op.track).padStart(2, "0")}` : null;
          this.opts.onOp?.(op, this.block);
          break;
        }

        case "stopBGM": {
          this.state.bgm = null;
          this.opts.onOp?.(op, this.block);
          break;
        }

        case "transitionSync":
          this.actions.push({ kind: "transitionSync" });
          break;
        case "transitionTime":
          this.actions.push({ kind: "transitionTime", frames: op.frames, mode: op.mode });
          break;
        case "effectOn":
          this.actions.push({ kind: "effectOn", effect: op.effect });
          break;
        case "effectOff":
          this.actions.push({ kind: "effectOff", category: op.category });
          break;
        case "shake":
          this.actions.push({ kind: "shake", mode: op.mode, amplitude: op.amplitude });
          break;
        case "spriteOrder":
          this.actions.push({ kind: "spriteOrder", order: [...op.order] });
          break;
        case "viewportRect":
          this.actions.push({ kind: "viewportRect", x: op.x, y: op.y, w: op.w, h: op.h, frames: op.frames });
          break;
        case "cgEffect":
          this.actions.push({
            kind: "cgEffect",
            asset: op.asset,
            file: this.assets.relative(op.asset),
            args: [...op.args],
          });
          break;
        case "wait":
          this.actions.push({ kind: "wait", amount: op.amount, unit: "vm" });
          this.opts.onOp?.(op, this.block);
          break;
        case "waitFrames":
          this.actions.push({ kind: "wait", amount: op.frames, unit: "frames" });
          this.opts.onOp?.(op, this.block);
          break;

        case "gotoBlock": {
          if (!this.goto(op.target)) {
            this.finished = true;
            return { type: "end", reason: "terminated" };
          }
          continue;
        }

        case "gotoScene": {
          this.finished = true;
          return { type: "end", reason: "gotoScene", nextScene: op.scene };
        }

        case "varSet": {
          const value =
            op.value.type === "const" ? op.value.value
            : op.value.type === "varRef" ? (this.vars.get(op.value.varId) ?? 0)
            : null;
          if (value === null) {
            // unrecognized value expressions are surfaced, not guessed
            this.opts.onOp?.(op, this.block);
            break;
          }
          const prev = this.vars.get(op.varId) ?? 0;
          const next =
            op.mod === MOD_ASSIGN ? value
            : op.mod === MOD_ADD ? prev + value
            : value; // unknown mod: best effort, reported below
          this.vars.set(op.varId, next);
          this.opts.onVarSet?.(op.varId, next, op.mod, this.block);
          if (op.mod !== MOD_ASSIGN && op.mod !== MOD_ADD) this.opts.onOp?.(op, this.block);
          break;
        }

        case "varJump": {
          const evaluated = evaluateCondition(op.condition, this.vars, this.sysVars);
          const jumped =
            evaluated.value !== undefined
              ? evaluated.value
              : (this.opts.unknownJump ?? "fallthrough") === "jump";
          this.opts.onVarJump?.({
            block: this.block,
            condition: evaluated.text,
            value: evaluated.value,
            jumped,
            target: op.target,
          });
          if (jumped && this.goto(op.target)) continue;
          break;
        }

        case "switch": {
          this.opts.onOp?.(op, this.block);
          const first = op.targets.find((t) => t !== "?");
          if (first && this.goto(first)) continue;
          break;
        }

        default:
          this.opts.onOp?.(op, this.block);
          break;
      }
    }
  }

  /** Apply the player's decision to a choice event and resume. */
  choose(event: ChoiceEvent, decision: ChoiceDecision): void {
    const option = event.options.find((o) => o.index === decision.option);
    if (!option) throw new Error(`no option ${decision.option} in choice ${event.id}`);
    if (event.resultVar != null) this.vars.set(event.resultVar, option.index);
    if (option.target && option.target !== "?") {
      if (!this.goto(option.target)) {
        throw new Error(`choice target ${option.target} is not a block in ${this.scene.scene}`);
      }
    }
    // A choice without a dispatch row falls through; the selected index lives
    // in resultVar and is read later (often by the next scene).
  }
}
