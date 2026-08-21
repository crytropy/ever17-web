import { SceneVm, type VmOptions, type VmSaveState } from "./vm.js";
import type {
  AssetIndex,
  ChoiceEvent,
  IrScene,
  PlayerEvent,
} from "./types.js";

/**
 * GameSession - the stable driver API for interactive front ends.
 *
 * Wraps SceneVm with everything a player-facing client needs and nothing
 * scene-specific: async scene chaining across gotoScene with one shared
 * variable table, a bounded dialogue backlog, and serializable save states
 * that resume identically (pinned by regression tests).
 *
 * Environment-agnostic: scene loading goes through AsyncSceneSource, assets
 * through AssetIndex; there are no Node or DOM dependencies here.
 */

export interface AsyncSceneSource {
  /** Load a scene's IR by (case-insensitive) name; null when absent. */
  load(name: string): Promise<IrScene | null> | IrScene | null;
  /** Asset index for a scene; may be shared across scenes. */
  assets(name: string): AssetIndex;
}

export interface BacklogEntry {
  scene: string;
  speaker: string | null;
  text: string;
  voice: string | null;
  voiceFile: string | null;
}

export const SAVE_FORMAT = "e17vn-save";
export const SAVE_VERSION = 1;

/** Serializable session state. */
export interface SessionSave {
  format: typeof SAVE_FORMAT;
  version: typeof SAVE_VERSION;
  vm: VmSaveState;
  vars: [number, number][];
  sysVars: [number, number][];
  counters: { lines: number; scenes: number };
  route: string[];
  backlog: BacklogEntry[];
}

export interface GameSessionOptions {
  /** Backlog entries kept in memory and in saves. Default 200. */
  backlogLimit?: number;
  /** Called whenever a new scene is entered (including the first). */
  onSceneChange?: (scene: string, index: number) => void;
  vm?: VmOptions;
}

/** The session's terminal event: the route finished (or failed to continue). */
export interface SessionEndEvent {
  type: "sessionEnd";
  reason: "ending" | "missing-scene" | "stepLimit";
  scene: string;
}

export type SessionEvent = PlayerEvent | SessionEndEvent;

export class GameSession {
  readonly vars = new Map<number, number>();
  readonly sysVars = new Map<number, number>();
  readonly backlog: BacklogEntry[] = [];
  readonly route: string[] = [];
  lines = 0;

  private vm: SceneVm | null = null;
  private source: AsyncSceneSource;
  private opts: GameSessionOptions;
  private currentEvent: SessionEvent | null = null;
  private pendingChoice: ChoiceEvent | null = null;
  private finished = false;
  /** True between restore() and the first event, which is a re-presentation
   * of the saved moment and must not be re-counted or re-logged. */
  private representing = false;

  private constructor(source: AsyncSceneSource, opts: GameSessionOptions) {
    this.source = source;
    this.opts = opts;
  }

  /** Begin a fresh game at startScene ("New Game"). */
  static async start(
    source: AsyncSceneSource,
    startScene: string,
    opts: GameSessionOptions = {},
  ): Promise<GameSession> {
    const s = new GameSession(source, opts);
    await s.enterScene(startScene, null);
    return s;
  }

  /** Resume a saved session; the next event re-presents the saved moment. */
  static async restore(
    source: AsyncSceneSource,
    save: SessionSave,
    opts: GameSessionOptions = {},
  ): Promise<GameSession> {
    if (save.format !== SAVE_FORMAT) throw new Error(`not a save file (format ${String(save.format)})`);
    if (save.version !== SAVE_VERSION) throw new Error(`unsupported save version ${String(save.version)}`);
    const s = new GameSession(source, opts);
    for (const [k, v] of save.vars) s.vars.set(k, v);
    for (const [k, v] of save.sysVars) s.sysVars.set(k, v);
    s.lines = save.counters.lines;
    s.route.push(...save.route.slice(0, -1)); // last entry re-added by enterScene
    s.backlog.push(...save.backlog);
    await s.enterScene(save.vm.scene, save.vm);
    s.representing = true;
    return s;
  }

  get scene(): string {
    return this.vm?.scene.scene ?? "";
  }

  get current(): SessionEvent | null {
    return this.currentEvent;
  }

  get done(): boolean {
    return this.finished;
  }

  private async enterScene(name: string, resume: VmSaveState | null): Promise<boolean> {
    const scene = await this.source.load(name);
    if (!scene) return false;
    this.vm = new SceneVm(scene, this.source.assets(name), {
      ...this.opts.vm,
      vars: this.vars,
      sysVars: this.sysVars,
      ...(resume ? { resume } : {}),
    });
    this.route.push(scene.scene);
    this.opts.onSceneChange?.(scene.scene, this.route.length);
    return true;
  }

  /**
   * Advance to the next presentable event. Scene transitions are followed
   * internally, so the caller only ever sees dialogue, choices, and the
   * final sessionEnd.
   */
  async next(): Promise<SessionEvent> {
    if (this.finished) {
      return (this.currentEvent as SessionEndEvent | null) ?? { type: "sessionEnd", reason: "ending", scene: this.scene };
    }
    if (this.pendingChoice) {
      throw new Error("a choice is pending; call choose() first");
    }
    for (;;) {
      if (!this.vm) {
        return this.finish("missing-scene");
      }
      const ev = this.vm.next();
      if (ev.type === "dialogue") {
        if (this.representing) {
          // re-presentation of the saved line: already counted and logged
          this.representing = false;
        } else {
          this.lines += 1;
          this.pushBacklog({
            scene: this.scene,
            speaker: ev.speaker,
            text: ev.text,
            voice: ev.voice,
            voiceFile: ev.voiceFile,
          });
        }
        this.currentEvent = ev;
        return ev;
      }
      if (ev.type === "choice") {
        this.representing = false;
        this.pendingChoice = ev;
        this.currentEvent = ev;
        return ev;
      }
      // end of scene
      if (ev.reason === "gotoScene" && ev.nextScene) {
        const ok = await this.enterScene(ev.nextScene, null);
        if (!ok) return this.finish("missing-scene");
        continue;
      }
      return this.finish(ev.reason === "stepLimit" ? "stepLimit" : "ending");
    }
  }

  /** Answer the currently pending choice by option index. */
  choose(option: number): void {
    if (!this.pendingChoice || !this.vm) throw new Error("no choice is pending");
    const ev = this.pendingChoice;
    this.pendingChoice = null;
    this.vm.choose(ev, { option });
  }

  /**
   * Snapshot the session at the currently presented event; restoring
   * re-presents that event. Choices must be saved before answering.
   */
  save(): SessionSave {
    if (!this.vm) throw new Error("session has no active scene");
    return {
      format: SAVE_FORMAT,
      version: SAVE_VERSION,
      vm: this.vm.getSaveState(),
      vars: [...this.vars.entries()],
      sysVars: [...this.sysVars.entries()],
      counters: { lines: this.lines, scenes: this.route.length },
      route: [...this.route],
      backlog: [...this.backlog],
    };
  }

  /** Duration (seconds) of the voice line of an event, when known. */
  voiceDuration(ev: SessionEvent): number | null {
    if (ev.type !== "dialogue" || !ev.voice || !this.vm) return null;
    const entry = this.source.assets(this.scene).get(ev.voice);
    return entry?.duration ?? null;
  }

  private pushBacklog(entry: BacklogEntry): void {
    this.backlog.push(entry);
    const limit = this.opts.backlogLimit ?? 200;
    if (this.backlog.length > limit) this.backlog.splice(0, this.backlog.length - limit);
  }

  private finish(reason: SessionEndEvent["reason"]): SessionEndEvent {
    this.finished = true;
    const ev: SessionEndEvent = { type: "sessionEnd", reason, scene: this.scene };
    this.currentEvent = ev;
    return ev;
  }
}
