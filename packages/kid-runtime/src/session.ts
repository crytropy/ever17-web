import { SceneVm, type VmOptions } from "./vm.js";
import type { AssetIndex, ChoiceEvent, IrScene, PlayerEvent } from "./types.js";

/**
 * Multi-scene session: chains scenes across gotoScene transitions with a
 * single shared variable table, exactly as the engine does (var 1203 written
 * by one scene is read by the next scene's head dispatch).
 *
 * "New Game" is a session started at the opening scene with empty tables.
 * The opening scene's name comes from the game data, not from code: the debug
 * menu labels OP00 as オープニング and the title screen (startup.scr) is
 * system UI outside the story graph.
 */

export interface SceneSource {
  /** Load a scene's IR by (case-insensitive) name; null when absent. */
  load(name: string): IrScene | null;
  /** Asset index for a scene; may be shared across scenes. */
  assets(name: string): AssetIndex;
}

export interface SessionOptions {
  /** Answers keyed by "<scene>:<choiceId>"; falls back to choiceById, then policy. */
  choiceByScene?: Record<string, number>;
  choiceById?: Record<number, number>;
  /** Default option when nothing matches: "first" (0) or "last". */
  policy?: "first" | "last";
  maxScenes?: number;
  maxLinesPerScene?: number;
  onEvent?: (scene: string, ev: PlayerEvent) => void;
  /**
   * Case-insensitive regex sources naming the game's terminal story scenes
   * (GameProfile.endingScenePatterns). A scene matching one of these that
   * terminates without a transition is classified "ending"; any other
   * transitionless termination is reported as a softlock. Empty = every
   * termination is a softlock.
   */
  endingScenes?: string[];
  vm?: VmOptions;
}

export interface SceneRunSummary {
  scene: string;
  lines: number;
  choices: { id: number | null; option: number; text: string }[];
  blocks: number;
  exit: "gotoScene" | "terminated" | "stepLimit" | "lineLimit";
  next: string | null;
}

export interface GapReport {
  /** Unknown IR ops actually executed, keyed by "mnemonic(opcode)" -> count. */
  unknownOps: Map<string, number>;
  /** VAR_JUMP decisions that could not be evaluated, keyed by condition text. */
  unevaluableJumps: Map<string, number>;
  /** varSet mods outside the understood set, keyed by mod byte. */
  unknownMods: Map<number, number>;
  /** Assets referenced during play but missing from the index. */
  unresolvedAssets: Set<string>;
  /** Choice options carrying visibility conditions (not yet interpreted). */
  conditionedOptions: Map<string, number>;
}

export interface SessionResult {
  scenes: SceneRunSummary[];
  /** Scene names in play order, e.g. op00 -> s_1a -> ... */
  route: string[];
  end: "ending" | "missing-scene" | "softlock" | "limit";
  endDetail: string;
  vars: Map<number, number>;
  gaps: GapReport;
  totalLines: number;
}

export class SessionRunner {
  private readonly source: SceneSource;
  private readonly opts: SessionOptions;
  private readonly endingScenes: RegExp[];
  readonly vars = new Map<number, number>();
  readonly sysVars = new Map<number, number>();

  constructor(source: SceneSource, opts: SessionOptions = {}) {
    this.source = source;
    this.opts = opts;
    this.endingScenes = (opts.endingScenes ?? []).map((src) => new RegExp(src, "i"));
  }

  private pickOption(scene: string, ev: ChoiceEvent): number {
    const bySceneKey = `${scene.toLowerCase()}:${ev.id ?? "?"}`;
    const byScene = this.opts.choiceByScene?.[bySceneKey];
    if (byScene !== undefined) return byScene;
    if (ev.id != null && this.opts.choiceById && ev.id in this.opts.choiceById) {
      return this.opts.choiceById[ev.id]!;
    }
    const opts = ev.options.filter((o) => o.enabled);
    if (opts.length === 0) return ev.options[0]?.index ?? 0;
    return this.opts.policy === "last" ? opts[opts.length - 1]!.index : opts[0]!.index;
  }

  run(startScene: string): SessionResult {
    const gaps: GapReport = {
      unknownOps: new Map(),
      unevaluableJumps: new Map(),
      unknownMods: new Map(),
      unresolvedAssets: new Set(),
      conditionedOptions: new Map(),
    };
    const scenes: SceneRunSummary[] = [];
    const route: string[] = [];
    let totalLines = 0;
    let current: string | null = startScene;
    const maxScenes = this.opts.maxScenes ?? 100;

    const bump = (m: Map<string, number>, k: string): void => {
      m.set(k, (m.get(k) ?? 0) + 1);
    };

    while (current !== null) {
      if (scenes.length >= maxScenes) {
        return { scenes, route, end: "limit", endDetail: `scene limit ${maxScenes}`, vars: this.vars, gaps, totalLines };
      }
      const scene = this.source.load(current);
      if (!scene) {
        return { scenes, route, end: "missing-scene", endDetail: `no IR for "${current}"`, vars: this.vars, gaps, totalLines };
      }
      route.push(scene.scene);
      const assets = this.source.assets(current);
      const vm = new SceneVm(scene, assets, {
        ...this.opts.vm,
        vars: this.vars,
        sysVars: this.sysVars,
        onOp: (op, block) => {
          if (op.op === "unknown") bump(gaps.unknownOps, `${op.mnemonic}(${op.opcode})`);
          if (op.op === "varSet") gaps.unknownMods.set(op.mod, (gaps.unknownMods.get(op.mod) ?? 0) + 1);
          this.opts.vm?.onOp?.(op, block);
        },
        onVarJump: (info) => {
          if (info.value === undefined) bump(gaps.unevaluableJumps, info.condition);
          this.opts.vm?.onVarJump?.(info);
        },
      });

      const summary: SceneRunSummary = {
        scene: scene.scene,
        lines: 0,
        choices: [],
        blocks: 0,
        exit: "terminated",
        next: null,
      };

      let nextScene: string | null = null;
      for (;;) {
        const ev = vm.next();
        this.opts.onEvent?.(scene.scene, ev);
        if (ev.type === "dialogue") {
          summary.lines += 1;
          totalLines += 1;
          if (ev.voice && !ev.voiceFile) gaps.unresolvedAssets.add(ev.voice);
          if (ev.state.background && !ev.state.background.file && ev.state.background.asset !== "<unresolved>") {
            gaps.unresolvedAssets.add(ev.state.background.asset);
          }
          for (const s of ev.state.sprites) {
            if (!s.file && s.asset !== "<unresolved>") gaps.unresolvedAssets.add(s.asset);
          }
          if (this.opts.maxLinesPerScene && summary.lines >= this.opts.maxLinesPerScene) {
            summary.exit = "lineLimit";
            break;
          }
          continue;
        }
        if (ev.type === "choice") {
          const irBlock = scene.blocks[ev.state.block];
          for (const op of irBlock?.ops ?? []) {
            if (op.op === "choice") {
              for (const o of op.options) {
                if (o.condition) bump(gaps.conditionedOptions, `${scene.scene}:${op.id}:${o.index}`);
              }
            }
          }
          const option = this.pickOption(scene.scene, ev);
          const chosen = ev.options.find((o) => o.index === option) ?? ev.options[0];
          summary.choices.push({ id: ev.id, option: chosen?.index ?? 0, text: chosen?.text ?? "?" });
          vm.choose(ev, { option: chosen?.index ?? 0 });
          continue;
        }
        // end
        summary.exit = ev.reason === "gotoScene" ? "gotoScene" : ev.reason;
        if (ev.type === "end" && ev.reason === "gotoScene" && ev.nextScene) {
          nextScene = ev.nextScene;
          summary.next = ev.nextScene;
        }
        break;
      }
      summary.blocks = vm.blockTrace.length;
      scenes.push(summary);
      if (summary.exit === "stepLimit" || summary.exit === "lineLimit") {
        return { scenes, route, end: "limit", endDetail: `${summary.exit} in ${scene.scene}`, vars: this.vars, gaps, totalLines };
      }
      if (nextScene === null) {
        // Scene ended without a transition: an ending if the game profile
        // marks it as a terminal story scene (endings/epilogues have no
        // outgoing GOTO), otherwise a softlock worth reporting.
        const isEnding = this.endingScenes.some((re) => re.test(scene.scene));
        return {
          scenes,
          route,
          end: isEnding ? "ending" : "softlock",
          endDetail: `${scene.scene} terminated${isEnding ? " (terminal ending scene)" : " without a transition"}`,
          vars: this.vars,
          gaps,
          totalLines,
        };
      }
      current = nextScene;
    }
    return { scenes, route, end: "softlock", endDetail: "no start", vars: this.vars, gaps, totalLines };
  }
}
