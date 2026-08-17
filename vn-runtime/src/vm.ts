import { evaluateCondition, MOD_ADD, MOD_ASSIGN } from "./conditions.js";
import type {
  AssetIndex,
  ChoiceEvent,
  ChoiceOptionView,
  IrOp,
  IrScene,
  LayerState,
  PlayerEvent,
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
    this.block = scene.entry;
    if (!scene.blocks[this.block]) {
      const first = Object.keys(scene.blocks).sort()[0];
      if (!first) throw new Error(`scene ${scene.scene} has no blocks`);
      this.block = first;
    }
    this.blockTrace.push(this.block);
  }

  get currentBlock(): string {
    return this.block;
  }

  get done(): boolean {
    return this.finished;
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
          return {
            type: "dialogue",
            speaker: op.speaker,
            text: op.text,
            voice: op.voice,
            voiceFile: this.assets.relative(op.voice),
            state: this.snapshot(),
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
          return {
            type: "choice",
            id: op.id,
            resultVar: op.resultVar,
            options,
            state: this.snapshot(),
          };
        }

        case "setBackground": {
          this.state.background = this.layerFor(op.asset, null, null);
          this.state.fill = null;
          break;
        }

        case "fillScreen": {
          this.state.fill = op.color;
          this.state.background = null;
          this.state.sprites.clear();
          break;
        }

        case "showSprite": {
          const slot = op.slot ?? 1;
          this.state.sprites.set(slot, this.layerFor(op.asset, slot, op.x));
          break;
        }

        case "showSprites": {
          op.sprites.forEach((s, i) => {
            const slot = i + 1;
            this.state.sprites.set(slot, this.layerFor(s.asset, slot, s.x));
          });
          break;
        }

        case "hideSprite": {
          if (op.slot == null) this.state.sprites.clear();
          else this.state.sprites.delete(op.slot);
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
          const value = op.value.type === "const" ? op.value.value : null;
          if (value === null) {
            // non-constant writes have not been observed in story scripts
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
