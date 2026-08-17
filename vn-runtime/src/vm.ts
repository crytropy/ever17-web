import type { AssetResolver } from "./assets.js";
import { evaluateCondition, type BranchPolicy } from "./conditions.js";
import type {
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
  /**
   * How to resolve a guard: "evaluate" (default) tests the condition against
   * runtime variables; "take"/"skip" force one side for experimentation.
   */
  branchPolicy?: BranchPolicy;
  /** What to do when a condition cannot be evaluated. Default: "skip". */
  unknownBranch?: "take" | "skip";
  onBranch?: (info: BranchInfo) => void;
}

export interface BranchInfo {
  block: string;
  condition: string;
  /** undefined when the guard's relation or operands are not understood. */
  value: boolean | undefined;
  taken: boolean;
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
  private readonly assets: AssetResolver;
  private readonly opts: VmOptions;

  /** Current block label and index of the next op inside it. */
  private block: string;
  private pc = 0;
  private state: SceneState = { background: null, sprites: new Map(), bgm: null, fill: null };
  private steps = 0;
  private finished = false;
  /** Scenario variables written by choices, keyed by variable id. */
  readonly vars = new Map<number, number>();
  /** Ordered log of visited blocks, for merge/branch verification. */
  readonly blockTrace: string[] = [];

  constructor(scene: IrScene, assets: AssetResolver, opts: VmOptions = {}) {
    this.scene = scene;
    this.assets = assets;
    this.opts = opts;
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
          const options: ChoiceOptionView[] = op.options.map((o) => ({
            index: o.index,
            text: o.text,
            target: o.target,
            // Option visibility conditions are not yet proven (see
            // docs/sc3-format.md §5); every option is offered and the
            // condition is surfaced untouched for the front end.
            enabled: true,
          }));
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

        case "branch": {
          // A guard controls exactly one following instruction: the "taken"
          // continuation runs it, the "skip" continuation jumps past it.
          this.opts.onOp?.(op, this.block);
          const policy = this.opts.branchPolicy ?? "evaluate";
          const evaluated = evaluateCondition(op.condition, this.vars);
          let taken: boolean;
          if (policy === "take") taken = true;
          else if (policy === "skip") taken = false;
          else if (evaluated.value !== undefined) taken = evaluated.value;
          else taken = (this.opts.unknownBranch ?? "skip") === "take";
          this.opts.onBranch?.({
            block: this.block,
            condition: evaluated.text,
            value: evaluated.value,
            taken,
          });
          const target = taken ? op.takenTarget : op.skipTarget;
          if (target && target !== "?" && this.goto(target)) continue;
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
