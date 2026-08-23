/**
 * Playable browser client over the kid-runtime GameSession API.
 *
 * Consumes exactly what a game package serves - /game.json (metadata +
 * GameProfile), /ir/<scene>.json and /assets/manifest.json - and contains no
 * game- or scene-specific logic: the starting scene, canvas geometry, effect
 * semantics and storage namespace all come from the package metadata.
 *
 * Player features: click/Enter advance, choices, backlog (L), auto mode (A,
 * paced by manifest voice durations), skip mode (hold Ctrl or toggle),
 * multi-slot localStorage saves with identical-resume semantics (pinned by
 * the runtime's save/resume tests).
 */
import { GameSession, type AsyncSceneSource, type SessionEvent } from "kid-runtime";
import type { AssetIndex, AssetManifest, ManifestEntry } from "kid-runtime";
import {
  DEFAULT_GAME_PROFILE,
  labelForScene,
  playerDataSizeProblem,
  runCountsAsCompletion,
  type GamePackageMeta,
  type PlayerDataExport,
  type NarrativeProgressCatalog,
} from "kid-contracts";
import { PixiStage } from "kid-renderer-pixi";
import { loadConfig, saveConfig, type VnConfig } from "./config.js";
import { ALL_SLOTS, AUTO_SLOT, QUICK_SLOT, SaveSlots, type SlotMeta } from "./slots.js";
import type { SessionSave } from "kid-contracts";
import { CompletionTracker, IdbCompletionStore } from "./completion.js";
import { PersistentProgress } from "./progress.js";
import {
  activePlayDataKey,
  advanceGeneration,
  discardGeneration,
  readActiveGeneration,
  readActiveScope,
  type PlayDataScope,
} from "./play-data.js";
import { applyPlayerDataImport, buildPlayerDataExport, mergeCompletion } from "./transfer.js";
import { PlayerDataBackup } from "./backup.js";
import { LoadingIndicator } from "./loading-indicator.js";
import { computeAutoAdvanceDelay } from "./auto-timing.js";
import { renderRecordsInto } from "./records.js";
import { AutoAdvanceTimer } from "./auto-timer.js";
import {
  RewindLog,
  backlogOrdinal,
  captureTimeline,
  oldestBacklogOrdinal,
  timelineFor,
  type RewindPoint,
} from "./rewind.js";
import { routeKeyDown, routeKeyUp, type KeyAction, type Overlay } from "./keys.js";
import { AutosaveGate } from "./autosave.js";
import { MoviePlayer } from "./movie.js";
import { SessionSwap } from "./session-swap.js";
import { matchEndings, type RouteGraphJson } from "kid-graph/model";

/** A queued media operation, drained once the next line is presented. */
interface PendingOp {
  op: string;
  asset?: string;
  arg1?: number | null;
}

/** Everything that belongs to one GameSession rather than to the player. */
interface SessionContext {
  /** Decides which scene entries of this session deserve an autosave. */
  gate: AutosaveGate;
  /** Media this session has queued but not yet played. */
  ops: PendingOp[];
  /** An autosave this session owes, taken once its line is on screen. */
  autosaveDue: boolean;
}

const newSessionContext = (): SessionContext => ({ gate: new AutosaveGate(), ops: [], autosaveDue: false });

declare global {
  interface Window {
    vnAssetsBase: string;
  }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const stage = $("stage");
const pixiParent = $("pixi-parent");
const speakerEl = $("speaker");
const textEl = $("text");
const textboxEl = $("textbox");
const choicesEl = $("choices");
const titleEl = $("title");
const hudEl = $("hud");
const movieEl = $<HTMLVideoElement>("movie");
const backlogEl = $("backlog");
const toastEl = $("toast");
const btn = {
  auto: $("btn-auto"),
  skip: $("btn-skip"),
  log: $("btn-log"),
  save: $("btn-save"),
  load: $("btn-load"),
  quick: $("btn-quick"),
  routes: $("btn-routes"),
  cfg: $("btn-cfg"),
  title: $("btn-title"),
};
const menuEl = $("menu");
const menuTitleEl = menuEl.querySelector("#menu-title") as HTMLElement;
const menuSlotsEl = menuEl.querySelector("#menu-slots") as HTMLElement;
const settingsEl = $("settings");
const recordsEl = $("records");
const recordsContentEl = $("records-content");
const confirmEl = $("confirm");
const confirmTextEl = $("confirm-text");
const loadingEl = $("loading");
const loadingTextEl = $("loading-text");
const errorEl = $("error");
const errorTextEl = $("error-text");
const titleMenu = {
  newGame: $("t-new"),
  cont: $<HTMLButtonElement>("t-continue"),
  load: $("t-load"),
  settings: $("t-settings"),
  routes: $("t-routes"),
};

/**
 * How long a first-use asset conversion may take before the player is told
 * something is happening. Conversions of a full-screen background measure
 * ~190 ms locally, so this sits just under that: cached assets never flash
 * the indicator, and a genuinely slow one is never mistaken for a crash.
 */
const LOADING_INDICATOR_DELAY_MS = 120;

/** Canvas size; replaced by the game profile's before the player boots. */
let stageSize = { ...DEFAULT_GAME_PROFILE.canvas };

function fitStage(): void {
  const s = Math.min(window.innerWidth / stageSize.width, window.innerHeight / stageSize.height);
  stage.style.transform = `scale(${s})`;
}
window.addEventListener("resize", fitStage);
fitStage();

interface ConfirmOptions {
  /** Text for the confirming button; defaults to OK. */
  okLabel?: string;
  /**
   * An extra, non-committing action offered alongside (e.g. take a backup).
   * While it runs, confirming is disabled: when the extra action exists to
   * protect the player from the confirming one, the two must not race.
   */
  extra?: { label: string; busyLabel?: string; run: () => unknown };
}

/** In-page confirmation in the player's own visual language. */
function confirmDialog(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  confirmTextEl.textContent = message;
  const ok = confirmEl.querySelector("#confirm-ok") as HTMLButtonElement;
  const cancel = confirmEl.querySelector("#confirm-cancel") as HTMLButtonElement;
  const extraBtn = confirmEl.querySelector("#confirm-extra") as HTMLButtonElement;
  const okLabel = opts.okLabel ?? "OK";
  ok.textContent = okLabel;
  ok.disabled = false;
  extraBtn.disabled = false;
  extraBtn.classList.toggle("hidden", !opts.extra);
  if (opts.extra) extraBtn.textContent = opts.extra.label;
  confirmEl.classList.remove("hidden");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => (): void => {
      if (settled) return;
      settled = true;
      confirmEl.classList.add("hidden");
      ok.removeEventListener("click", yes);
      cancel.removeEventListener("click", no);
      extraBtn.removeEventListener("click", runExtra);
      ok.textContent = "OK";
      ok.disabled = false;
      extraBtn.disabled = false;
      resolve(value);
    };
    const yes = (): void => {
      if (ok.disabled) return; // the extra action is still running
      finish(true)();
    };
    const no = finish(false);
    // The extra action runs without answering the question - but it holds the
    // confirming button while it does, so a backup cannot be overtaken by the
    // reset it was taken to protect against.
    const runExtra = (): void => {
      if (!opts.extra || extraBtn.disabled) return;
      ok.disabled = true;
      extraBtn.disabled = true;
      extraBtn.textContent = opts.extra.busyLabel ?? opts.extra.label;
      void Promise.resolve(opts.extra.run()).finally(() => {
        if (settled) return; // cancelled while it ran: leave the dialog closed
        ok.disabled = false;
        extraBtn.disabled = false;
        extraBtn.textContent = opts.extra!.label;
      });
    };
    ok.addEventListener("click", yes);
    cancel.addEventListener("click", no);
    extraBtn.addEventListener("click", runExtra);
  });
}

function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.style.opacity = "1";
  setTimeout(() => (toastEl.style.opacity = "0"), 1400);
}

// ---------------------------------------------------------------- assets
class WebAssets implements AssetIndex {
  constructor(private manifest: AssetManifest) {}
  get(name: string | null | undefined): ManifestEntry | undefined {
    return name ? this.manifest.assets[name.toLowerCase()] : undefined;
  }
  relative(name: string | null | undefined): string | null {
    return this.get(name)?.file ?? null;
  }
}

class WebSceneSource implements AsyncSceneSource {
  constructor(private readonly index: WebAssets) {}
  async load(name: string) {
    const res = await fetch(`ir/${name.toLowerCase()}.json`);
    if (!res.ok) return null;
    return await res.json();
  }
  assets(): AssetIndex {
    return this.index;
  }
}

// ---------------------------------------------------------------- audio
class AudioBox {
  private bgm: HTMLAudioElement | null = null;
  private bgmName: string | null = null;
  private voice: HTMLAudioElement | null = null;
  private seChannels = new Map<number, HTMLAudioElement>();
  volumes = { bgm: 0.8, se: 0.9, voice: 1 };

  applyVolumes(): void {
    if (this.bgm) this.bgm.volume = this.volumes.bgm;
    if (this.voice) this.voice.volume = this.volumes.voice;
    for (const a of this.seChannels.values()) a.volume = this.volumes.se;
  }

  setBgm(name: string | null, url: string | null): void {
    if (name === this.bgmName) return;
    this.bgm?.pause();
    this.bgm = null;
    this.bgmName = name;
    if (name && url) {
      this.bgm = new Audio(url);
      this.bgm.loop = true;
      this.bgm.volume = this.volumes.bgm;
      void this.bgm.play().catch(() => {});
    }
  }
  playVoice(url: string | null): void {
    this.voice?.pause();
    this.voice = null;
    if (url) {
      this.voice = new Audio(url);
      this.voice.volume = this.volumes.voice;
      void this.voice.play().catch(() => {});
    }
  }
  playSe(url: string | null, channel: number, loop: boolean): void {
    if (!url) return;
    this.seChannels.get(channel)?.pause();
    const a = new Audio(url);
    a.loop = loop;
    a.volume = this.volumes.se;
    this.seChannels.set(channel, a);
    void a.play().catch(() => {});
  }
  stopAll(): void {
    this.bgm?.pause();
    this.voice?.pause();
    for (const a of this.seChannels.values()) a.pause();
    this.seChannels.clear();
    this.bgmName = null;
    this.bgm = null;
  }
}


// ---------------------------------------------------------------- player
class WebPlayer {
  /**
   * The live session. Owned by the swap controller so that "which session is
   * current" and "when may the old one be released" are the same decision.
   */
  private get session(): GameSession | null {
    return this.swap.session;
  }
  private stage: PixiStage | null = null;
  private readonly ns: string;
  /** Active play-data generation: which saves, progress and records are live. */
  private scope: PlayDataScope;
  /**
   * Where each recent line can be resumed from. Saves are stored without
   * their backlog copy: it is rebuilt from the live backlog on the way back,
   * which keeps this O(lines) rather than O(lines x backlog).
   */
  private readonly rewindPoints = new RewindLog();
  /**
   * State that belongs to one session rather than to the player.
   *
   * Kept together so a session swap can build the replacement's copy first
   * and adopt it only once the replacement exists - a failed load must leave
   * the running session's autosave counter and queued media exactly as they
   * were, not half-reset for a session that never came into being.
   */
  private ctx: SessionContext = newSessionContext();
  /**
   * Owns the movie surface and, crucially, the resolver of whatever the loop
   * is awaiting while a movie plays - so stopping one always releases the
   * loop rather than orphaning it.
   */
  private readonly movies = new MoviePlayer({
    el: movieEl,
    exists: async (url, signal) => {
      const res = await fetch(url, { method: "HEAD", signal }).catch(() => null);
      return res?.ok === true;
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  /** Transactional session replacement: builds first, releases only on success. */
  private readonly swap = new SessionSwap<GameSession>();
  /**
   * Owns the ordering between taking a backup and destroying what it backs
   * up. `inProgress` is what the reset checks before it advances anything.
   */
  private readonly backup = new PlayerDataBackup<PlayerDataExport>({
    assemble: () => this.assembleExport(),
    deliver: (doc) => this.deliverExport(doc),
  });
  private slots: SaveSlots;
  private config: VnConfig;
  /** Cross-run scenario state: what a finished route opens up next time. */
  private progress: PersistentProgress;
  /** Chapter names from the game's own data; null when it ships none. */
  private catalog: NarrativeProgressCatalog | null = null;
  /** Completion tracking (scenes/choices/endings/assets), separate from saves. */
  private tracker: CompletionTracker | null = null;
  /** Movies played since the last choice - identifies the ending reached. */
  private moviesSinceChoice: string[] = [];
  /** Every movie played this session - evidence for graph ending matching. */
  private moviesPlayed = new Set<string>();
  private graphJson: Promise<RouteGraphJson | null> | null = null;
  private source!: WebSceneSource;
  private assets!: WebAssets;
  private readonly audio = new AudioBox();
  private clickWaiter: (() => void) | null = null;
  private busy = false;
  /** Debounced indicator, so cached assets never flash it. */
  private readonly loading = new LoadingIndicator(
    () => {
      loadingTextEl.textContent = "converting artwork…";
      loadingEl.classList.remove("hidden");
    },
    () => loadingEl.classList.add("hidden"),
    LOADING_INDICATOR_DELAY_MS,
  );
  /** Assets whose conversion failed, shown in the error banner. */
  private assetErrors = new Set<string>();
  /** Set when another tab started fresh: this tab must stop writing. */
  private stale = false;
  private channel: BroadcastChannel | null = null;
  private auto = false;
  private skip = false;
  private readonly autoTimer = new AutoAdvanceTimer(() => {
    if (this.auto && !this.overlayOpen()) this.advance();
  });

  constructor(
    private readonly assetsBase: string,
    private readonly meta: GamePackageMeta,
  ) {
    this.ns = meta.profile.storageNamespace;
    // Settings live at the namespace; everything gameplay owns lives under
    // the active play-data generation, so "start completely fresh" is one
    // pointer move rather than a pile of deletes.
    this.scope = readActiveScope(localStorage, this.ns);
    this.slots = new SaveSlots(localStorage, this.scope.storagePrefix);
    this.config = loadConfig(localStorage, this.ns);
    this.progress = new PersistentProgress(localStorage, this.scope.storagePrefix, meta.gameId, meta.persistence ?? null);
    window.vnAssetsBase = assetsBase;
    textboxEl.addEventListener("click", () => this.advance());
    document.addEventListener("keydown", (e) => {
      const target = e.target as HTMLElement | null;
      const decision = routeKeyDown({
        key: e.key,
        targetTag: (target?.tagName ?? "").toLowerCase(),
        targetEditable: target?.isContentEditable === true,
        overlay: this.activeOverlay(),
      });
      if (decision.preventDefault) e.preventDefault();
      this.runKeyAction(decision.action);
    });
    document.addEventListener("keyup", (e) => {
      this.runKeyAction(routeKeyUp(e.key).action);
    });
    btn.auto.addEventListener("click", () => this.toggleAuto());
    btn.skip.addEventListener("click", () => this.setSkip(!this.skip, true));
    btn.log.addEventListener("click", () => this.toggleBacklog());
    btn.save.addEventListener("click", () => this.openMenu("save"));
    btn.load.addEventListener("click", () => this.openMenu("load"));
    btn.quick.addEventListener("click", () => void this.saveToSlot(QUICK_SLOT));
    btn.routes.addEventListener("click", () => this.openRecords());
    btn.cfg.addEventListener("click", () => this.openSettings());
    btn.title.addEventListener("click", () => void this.returnToTitle());
    titleMenu.newGame.addEventListener("click", () => void this.startNewGame());
    titleMenu.cont.addEventListener("click", () => void this.continueGame());
    titleMenu.load.addEventListener("click", () => this.openMenu("load"));
    titleMenu.settings.addEventListener("click", () => this.openSettings());
    titleMenu.routes.addEventListener("click", () => this.openRecords());
    settingsEl.querySelector("#cfg-export")!.addEventListener("click", () => void this.exportPlayerData());
    settingsEl.querySelector("#cfg-import")!.addEventListener("click", () => {
      (menuEl.querySelector("#menu-file") as HTMLInputElement).click();
    });
    settingsEl.querySelector("#cfg-reset")!.addEventListener("click", () => void this.resetPlayData());
    recordsEl.querySelector("#records-close")!.addEventListener("click", () => this.closeRecords());
    recordsEl.addEventListener("click", (e) => {
      if (e.target === recordsEl) this.closeRecords(); // click the backdrop
    });
    this.watchOtherTabs();
    errorEl.querySelector("#error-retry")!.addEventListener("click", () => void this.retryAssets());
    errorEl.querySelector("#error-close")!.addEventListener("click", () => this.clearError());
    menuEl.querySelector("#menu-export")!.addEventListener("click", () => void this.exportPlayerData());
    menuEl.querySelector("#menu-import")!.addEventListener("click", () => {
      (menuEl.querySelector("#menu-file") as HTMLInputElement).click();
    });
    (menuEl.querySelector("#menu-file") as HTMLInputElement).addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = ""; // let the same file be chosen again later
      if (file) void this.importPlayerData(file);
    });
    menuEl.querySelector("#menu-close")!.addEventListener("click", () => {
      menuEl.classList.add("hidden");
      if (this.auto) this.scheduleAuto();
    });
    settingsEl.querySelector("#settings-close")!.addEventListener("click", () => {
      settingsEl.classList.add("hidden");
      if (this.auto) this.scheduleAuto();
    });
    this.applyConfig();
  }

  private applyConfig(): void {
    this.audio.volumes = {
      bgm: this.config.bgmVolume,
      se: this.config.seVolume,
      voice: this.config.voiceVolume,
    };
    this.audio.applyVolumes();
  }

  /**
   * Open the player-facing records screen (never the developer graph).
   *
   * Shown as an overlay rather than a page: the session lives in memory, so
   * navigating to /records - which a blocked popup turns into a same-tab
   * navigation, and which is what a standalone/PWA window does anyway - threw
   * the run away and dropped the player back at the title.
   */
  private openRecords(): void {
    this.autoTimer.cancel();
    // The tracker's in-memory view is already current; the flush is only for
    // durability, so the screen does not need to wait for it.
    renderRecordsInto(
      recordsContentEl,
      this.catalog,
      new Set(this.tracker?.scenes ?? []),
      new Set(this.tracker?.endings ?? []),
    );
    recordsEl.classList.remove("hidden");
    void this.tracker?.flush().catch(() => {
      /* the screen is drawn from memory either way */
    });
  }

  private closeRecords(): void {
    if (recordsEl.classList.contains("hidden")) return;
    recordsEl.classList.add("hidden");
    recordsContentEl.replaceChildren();
    if (this.auto) this.scheduleAuto();
  }

  /** Award endings by the graph's own definitions (scene + dispatch
   * conditions on the final variables + movie evidence); fall back to the
   * movie/scene name when the graph is unavailable. */
  private async recordEnding(session: GameSession, endScene: string): Promise<void> {
    this.graphJson ??= fetch("graph.json")
      .then((r) => (r.ok ? (r.json() as Promise<RouteGraphJson>) : null))
      .catch(() => null);
    const graph = await this.graphJson;
    const matched = graph
      ? matchEndings(graph.endings, endScene, session.vars, this.moviesPlayed)
      : [];
    if (matched.length > 0) {
      for (const e of matched) this.tracker?.ending(e.id);
    } else {
      this.tracker?.ending(this.moviesSinceChoice[0] ?? endScene);
    }
  }

  // ------------------------------------------------ settings
  private openSettings(): void {
    this.cancelAuto();
    const autoSelect = settingsEl.querySelector("#cfg-auto") as HTMLSelectElement;
    autoSelect.value = this.config.autoSpeed;
    autoSelect.onchange = () => {
      this.config.autoSpeed = autoSelect.value as VnConfig["autoSpeed"];
      saveConfig(localStorage, this.ns, this.config);
    };
    const bind = (id: string, key: "bgmVolume" | "seVolume" | "voiceVolume" | "transitionSpeed"): void => {
      const input = settingsEl.querySelector(`#${id}`) as HTMLInputElement;
      const label = input.nextElementSibling as HTMLElement;
      input.value = String(this.config[key]);
      label.textContent = String(this.config[key]);
      input.oninput = () => {
        (this.config[key] as number) = Number(input.value);
        label.textContent = input.value;
        saveConfig(localStorage, this.ns, this.config);
        this.applyConfig();
      };
    };
    bind("cfg-bgm", "bgmVolume");
    bind("cfg-se", "seVolume");
    bind("cfg-voice", "voiceVolume");
    bind("cfg-trans", "transitionSpeed");
    (settingsEl.querySelector("#cfg-reset-note") as HTMLElement).textContent =
      "Export writes your saves, settings and progress to a file. " +
      "Starting completely fresh erases saves, records and everything unlocked " +
      "between playthroughs, but keeps your settings and the converted game files.";
    settingsEl.classList.remove("hidden");
  }

  // ------------------------------------------------ title flow
  /** The save a "Continue" should resume: the most recently written slot. */
  private latestSave(): SlotMeta | null {
    const metas = this.slots.list();
    if (metas.length === 0) return null;
    return metas.reduce((newest, m) => (m.savedAt > newest.savedAt ? m : newest));
  }

  /** Show the title screen, reflecting whether there is anything to continue. */
  private showTitle(): void {
    const latest = this.latestSave();
    if (latest) {
      titleMenu.cont.classList.remove("hidden");
      titleMenu.cont.textContent = `CONTINUE · ${this.chapterLabel(latest.scene)}`;
    } else {
      titleMenu.cont.classList.add("hidden");
    }
    titleEl.classList.remove("hidden");
    hudEl.textContent = "";
    speakerEl.textContent = "";
    textEl.textContent = "";
  }

  /** Tear the current session down; the caller decides what happens next. */
  private endSession(): void {
    this.cancelAuto();
    this.audio.stopAll();
    this.swap.set(null);
    this.skip = false;
    btn.skip.classList.remove("on");
    this.auto = false;
    btn.auto.classList.remove("on");
    // wake anything the loop is parked on so it can observe the change
    const wakeClick = this.clickWaiter;
    const wakeChoice = this.choiceResolve;
    this.clickWaiter = null;
    this.choiceResolve = null;
    wakeClick?.();
    wakeChoice?.(-1);
    choicesEl.classList.add("hidden");
    backlogEl.classList.add("hidden");
    menuEl.classList.add("hidden");
    settingsEl.classList.add("hidden");
    // Settles the promise the loop is awaiting if a movie is on screen;
    // merely hiding the element left the loop parked on it forever.
    this.movies.stop();
    this.ctx = newSessionContext();
    this.rewindPoints.clear();
  }

  /** Leave the story and go back to the title screen. */
  private async returnToTitle(): Promise<void> {
    if (!this.session) return;
    const ended = this.session.done;
    if (
      !ended &&
      !(await confirmDialog("Return to the title screen?\n\nProgress since your last save is lost."))
    ) {
      return;
    }
    await this.tracker?.flush();
    this.endSession();
    this.stage?.reset();
    this.showTitle();
  }

  /**
   * Start a fresh game. Existing saves are never written or cleared here -
   * only the autosave slot is reused later, as the player crosses scenes, so
   * that is what the confirmation warns about.
   */
  private async startNewGame(): Promise<void> {
    if (this.stale) {
      toast("play data was cleared in another tab - reload to continue");
      return;
    }
    const hasAutosave = this.slots.peek(AUTO_SLOT) !== null;
    if (
      hasAutosave &&
      !(await confirmDialog(
        "Start a new game?\n\nYour manual slots and quicksave are kept.\n" +
          "The autosave slot will be replaced as you play.",
      ))
    ) {
      return;
    }
    this.endSession();
    this.stage?.reset();
    titleEl.classList.add("hidden");
    const params = new URLSearchParams(location.search);
    const start = params.get("start") ?? this.meta.startScene;
    try {
      // A new run inherits whatever earlier runs unlocked - that is what
      // makes later playthroughs different, and it is scenario state, not a
      // save file.
      const fresh = newSessionContext();
      fresh.gate.begin("new");
      this.ctx = fresh;
      this.swap.set(
        await GameSession.start(this.source, start, {
          ...this.sessionOptions(fresh),
          initialVars: this.progress.seed(),
        }),
      );
    } catch (err) {
      this.showError(`could not start a new game: ${(err as Error).message}`);
      this.showTitle();
      return;
    }
    this.moviesSinceChoice = [];
    this.moviesPlayed = new Set();
    void this.loop();
  }

  /** Resume the most recently written save. */
  private async continueGame(): Promise<void> {
    const latest = this.latestSave();
    if (!latest) {
      toast("no save to continue");
      return;
    }
    await this.loadFromSlot(latest.slot);
  }

  // ------------------------------------------------ loading + errors
  private showError(message: string, retryable = false): void {
    errorTextEl.textContent = message;
    (errorEl.querySelector("#error-retry") as HTMLElement).classList.toggle("hidden", !retryable);
    errorEl.classList.remove("hidden");
  }

  private clearError(): void {
    errorEl.classList.add("hidden");
    this.assetErrors.clear();
  }

  /** An asset failed to load: name it, with the server's reason when it gave one. */
  private noteAssetError(file: string): void {
    const first = this.assetErrors.size === 0;
    this.assetErrors.add(file);
    const names = [...this.assetErrors];
    const summary =
      names.length === 1
        ? `could not load ${names[0]}`
        : `could not load ${names[0]} and ${names.length - 1} more file(s)`;
    this.showError(summary, true);
    if (!first) return;
    // the local server answers a failed conversion with a readable reason
    void fetch(`${this.assetsBase}/${file}`)
      .then(async (res) => (res.ok ? null : (await res.text()).split("\n")[0] ?? null))
      .then((detail) => {
        if (detail && !errorEl.classList.contains("hidden")) {
          errorTextEl.textContent = `${summary}\n${detail}`;
        }
      })
      .catch(() => {});
  }

  /** Retry every failed asset and rebuild the picture. */
  private async retryAssets(): Promise<void> {
    errorTextEl.textContent = "retrying…";
    const ok = await this.stage?.retryFailed();
    if (ok) {
      this.clearError();
      toast("assets reloaded");
    } else {
      this.assetErrors = new Set(this.stage?.failed ?? []);
      this.showError(`still failing: ${[...this.assetErrors].join(", ")}`, true);
    }
  }

  // ------------------------------------------------ save menu
  private async thumbnail(): Promise<string | undefined> {
    try {
      const png = await this.stage?.snapshotPng();
      if (!png) return undefined;
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("thumb"));
        img.src = png;
      });
      const c = document.createElement("canvas");
      c.width = 160;
      c.height = 120;
      c.getContext("2d")!.drawImage(img, 0, 0, 160, 120);
      return c.toDataURL("image/jpeg", 0.6);
    } catch {
      return undefined;
    }
  }

  private async saveToSlot(slot: string): Promise<void> {
    if (this.stale) {
      toast("play data was cleared in another tab - reload to continue");
      return;
    }
    if (!this.session || !this.session.current || this.session.current.type === "sessionEnd") {
      toast("nothing to save");
      return;
    }
    try {
      const thumb = await this.thumbnail();
      const meta = this.slots.put(slot, this.session.save(), thumb);
      toast(
        `saved ${slot === QUICK_SLOT ? "quicksave" : slot === AUTO_SLOT ? "autosave" : "slot " + slot}: ` +
          this.chapterLabel(meta.scene),
      );
    } catch (err) {
      toast(`save failed: ${(err as Error).message}`);
    }
  }

  private async loadFromSlot(slot: string): Promise<void> {
    const save = this.slots.get(slot);
    if (!save) {
      toast("empty slot");
      return;
    }
    await this.resumeFrom(save, `loaded: ${this.chapterLabel(save.vm.scene)}`);
  }

  /**
   * Swap the live session for one restored from `save`.
   *
   * Shared by loading a slot and by jumping back from the backlog, because
   * the delicate part is the same either way: the loop() that is currently
   * parked on a waiter has to notice the swap, drop its stale event, and
   * carry on with the new session instead of deadlocking.
   */
  private async resumeFrom(
    save: SessionSave,
    note: string,
    timeline?: RewindPoint,
    /** Line the player rewound to; absent for a load, which starts a new history. */
    rewoundTo?: number,
  ): Promise<void> {
    // The replacement's own context, so a failed build cannot disturb the
    // counter or the queued media of the session still playing.
    const next = newSessionContext();
    next.gate.begin("restore");

    const result = await this.swap.replace(
      () =>
        GameSession.restore(this.source, save, {
          ...this.sessionOptions(next),
          // an older save must not roll global progression backwards
          restoreOverrides: this.progress.reconcile(save.vars),
        }),
      {
        // Everything below runs only once the replacement exists.
        release: () => {
          this.cancelAuto();
          this.audio.stopAll();
          // Resolves whatever the loop is awaiting rather than orphaning it.
          this.movies.stop();
          this.ctx = next;
          // A rewind keeps the evidence the run had accumulated by that line
          // and drops what came after; a save file carries none at all, so
          // loading one starts that record empty.
          const restored = timelineFor(timeline);
          this.moviesPlayed = restored.moviesPlayed;
          this.moviesSinceChoice = restored.moviesSinceChoice;
          // A rewind stays inside the same run, so the lines before the one
          // chosen are still reachable and can be rewound to again; only the
          // abandoned future goes. A load is a different history entirely.
          if (rewoundTo === undefined) this.rewindPoints.clear();
          else this.rewindPoints.truncateAfter(rewoundTo);
          choicesEl.classList.add("hidden");
          backlogEl.classList.add("hidden");
          menuEl.classList.add("hidden");
          titleEl.classList.add("hidden");
        },
        commit: () => {
          // Park the waiters aside and wake them only now: the running loop
          // then sees the swap, drops its stale event, and continues with the
          // restored session instead of deadlocking.
          const wakeClick = this.clickWaiter;
          const wakeChoice = this.choiceResolve;
          this.clickWaiter = null;
          this.choiceResolve = null;
          toast(note);
          wakeClick?.();
          wakeChoice?.(-1);
          void this.loop();
        },
      },
    );

    if (!result.ok && !result.superseded) {
      // Nothing was released: the line or choice on screen is still live and
      // still answerable.
      toast(`load failed: ${result.reason}`);
    }
  }


  /**
   * Hooks for one session, bound to that session's own context.
   *
   * Bound rather than reading `this.ctx`, so a replacement being built during
   * a swap writes into its own context: if the build then fails, nothing it
   * did leaks into the session that is still playing.
   */
  private sessionOptions(ctx: SessionContext): Parameters<typeof GameSession.start>[2] {
    return {
      onSceneChange: (scene) => {
        // Seeing a chapter is monotonic: a rewind never unsees it.
        this.tracker?.scene(scene);
        // Deferred rather than written here: restore() calls this from inside
        // its own scene entry, where the VM has no presented event yet. The
        // loop takes it once the next line is actually on screen.
        if (ctx.gate.sceneEntered()) ctx.autosaveDue = true;
      },
      vm: {
        onOp: (op) => {
          if (op.op === "playSE") ctx.ops.push({ op: "playSE", asset: op.asset, arg1: op.arg1 });
          else if (op.op === "playMovie") ctx.ops.push({ op: "playMovie", asset: op.asset });
        },
      },
    };
  }

  private openMenu(mode: "save" | "load"): void {
    this.cancelAuto();
    menuTitleEl.textContent = mode.toUpperCase();
    menuSlotsEl.innerHTML = "";
    const metas = new Map<string, SlotMeta>(this.slots.list().map((m) => [m.slot, m]));
    for (const slot of ALL_SLOTS) {
      if (mode === "save" && slot === AUTO_SLOT) continue; // autosave is automatic
      const meta = metas.get(slot);
      if (mode === "load" && !meta) {
        // show empty slots only in save mode
      }
      const div = document.createElement("div");
      div.className = "slot";
      const name = slot === AUTO_SLOT ? "AUTO" : slot === QUICK_SLOT ? "QUICK" : `SLOT ${slot}`;
      if (meta) {
        const when = new Date(meta.savedAt).toLocaleString();
        div.innerHTML =
          (meta.thumb ? `<img alt="">` : `<div class="empty-thumb">·</div>`) +
          `<div><b>${name}</b></div><div class="slot-label"></div><div class="when">${when}</div>`;
        if (meta.thumb) (div.querySelector("img") as HTMLImageElement).src = meta.thumb;
        // resolved at display time, so saves written before chapter names
        // existed still show one
        (div.querySelector(".slot-label") as HTMLElement).textContent = this.chapterLabel(meta.scene);
      } else {
        div.innerHTML = `<div class="empty-thumb">empty</div><div><b>${name}</b></div><div class="when">—</div>`;
      }
      div.addEventListener("click", () => {
        if (mode === "save") {
          void this.saveToSlot(slot).then(() => this.openMenu("save"));
        } else if (meta) {
          void this.loadFromSlot(slot);
        }
      });
      menuSlotsEl.appendChild(div);
    }
    menuEl.classList.remove("hidden");
  }

  // ------------------------------------------------ save data transfer
  /** Write every save, setting and unlock to a file the player keeps. */
  /**
   * Assemble the backup document. Synchronous by contract: it reads the
   * generation that is active *now*, and PlayerDataBackup calls it before the
   * first yield so a reset cannot advance the generation underneath it.
   *
   * The completion snapshot is taken from the tracker's memory rather than
   * after an IndexedDB flush, for the same reason: awaiting the flush first
   * would be a yield before the snapshot.
   */
  private assembleExport(): PlayerDataExport {
    const scope = this.scope;
    return buildPlayerDataExport(
      {
        storage: localStorage,
        storagePrefix: scope.storagePrefix,
        settingsNamespace: this.ns,
        gameId: this.meta.gameId,
        policy: this.meta.persistence ?? null,
        engineVersion: this.meta.engineVersion,
      },
      this.tracker?.snapshot() ?? null,
    );
  }

  /** Hand a finished document to the browser as a download. */
  private deliverExport(doc: PlayerDataExport): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const blob = new Blob([JSON.stringify(doc, null, 1)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${this.meta.gameId}-savedata-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  /** Write every save, setting and unlock to a file the player keeps. */
  private async exportPlayerData(): Promise<boolean> {
    const outcome = await this.backup.take();
    if (!outcome.ok) {
      toast(outcome.alreadyRunning ? "a backup is already being written" : `export failed: ${outcome.reason}`);
      return false;
    }
    toast(`exported ${outcome.doc.slots.length} save slot(s)`);
    // Durability housekeeping only, and deliberately after the fact: the file
    // is already written from the tracker's in-memory state.
    void this.tracker?.flush().catch(() => {});
    return true;
  }

  /** Restore a previously exported file, merging rather than replacing. */
  private async importPlayerData(file: File): Promise<void> {
    // Checked before the file is read: a huge file would otherwise cost the
    // tab its memory just to be parsed and then rejected.
    const tooBig = playerDataSizeProblem(file.size);
    if (tooBig) {
      toast(`import failed: ${tooBig}`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch (err) {
      toast(`could not read that file: ${(err as Error).message}`);
      return;
    }
    if (
      !(await confirmDialog(
        `Import save data from "${file.name}"?\n\n` +
          "Slots in the file replace those slots.\nOther slots, and anything already unlocked, are kept.",
      ))
    ) {
      return;
    }
    const outcome = applyPlayerDataImport(
      {
        storage: localStorage,
        storagePrefix: this.scope.storagePrefix,
        settingsNamespace: this.ns,
        gameId: this.meta.gameId,
        policy: this.meta.persistence ?? null,
      },
      parsed,
    );
    if (!outcome.ok) {
      toast(`import failed: ${outcome.reason ?? "unusable file"}`);
      return;
    }
    if (outcome.completion && this.tracker) {
      // seeing something is never undone: union with what is already known
      const merged = mergeCompletion(this.tracker.snapshot(), outcome.completion);
      this.tracker.absorb(merged);
      await this.tracker.flush();
    }
    // reload settings and slot listing from the freshly written storage
    this.config = loadConfig(localStorage, this.ns);
    this.applyConfig();
    this.slots = new SaveSlots(localStorage, this.scope.storagePrefix);
    this.openMenu("load");
    toast(`imported ${outcome.slotsRestored} save slot(s)`);
  }

  /**
   * Start completely fresh: a first-playthrough state.
   *
   * Deliberately separate from New Game, which must keep the unlocks that
   * make a second playthrough different. The generation pointer moves first
   * and everything else is cleanup, so an interrupted reset still leaves the
   * player on empty data rather than half-erased data.
   */
  private async resetPlayData(): Promise<void> {
    const ok = await confirmDialog(
      "Start completely fresh?\n\n" +
        "This erases, for this game:\n" +
        "  · every save slot, the quicksave and the autosave\n" +
        "  · Continue\n" +
        "  · route-clear and unlock progress carried between playthroughs\n" +
        "  · visited chapters, choices and collected endings in RECORDS\n" +
        "  · the run you are playing now\n\n" +
        "It keeps:\n" +
        "  · your Ever17 installation and the converted assets\n" +
        "  · volume, Auto and transition settings\n\n" +
        "Export your save data first if you might want it back.",
      {
        okLabel: "start fresh",
        extra: {
          label: "export first",
          busyLabel: "exporting…",
          run: () => this.exportPlayerData(),
        },
      },
    );
    if (!ok) return;
    // Belt and braces: the dialog disables "start fresh" while a backup runs,
    // but the generation must not move for a backup started any other way.
    if (this.backup.inProgress) {
      toast("a backup is still being written - try again in a moment");
      return;
    }

    const previous = this.scope;
    this.endSession();
    this.stage?.reset();

    // --- the commit point: one write, and the new world is live
    this.scope = advanceGeneration(localStorage, this.ns);
    this.slots = new SaveSlots(localStorage, this.scope.storagePrefix);
    this.progress = new PersistentProgress(
      localStorage,
      this.scope.storagePrefix,
      this.meta.gameId,
      this.meta.persistence ?? null,
    );
    this.tracker = await CompletionTracker.open(new IdbCompletionStore(this.scope.completionDb)).catch(() => null);
    this.announceGeneration();

    // --- everything below is housekeeping; failure here is harmless
    try {
      discardGeneration(localStorage, this.ns, previous.generation);
      indexedDB.deleteDatabase(previous.completionDb);
    } catch {
      /* the old data is already unreachable */
    }

    this.showTitle();
    toast("play data cleared");
  }

  /** Tell other tabs of this game that their play data is no longer current. */
  private announceGeneration(): void {
    try {
      this.channel?.postMessage({ generation: this.scope.generation });
    } catch {
      /* the storage event below still reaches other tabs */
    }
  }

  /**
   * Notice a reset performed in another tab. This tab can only ever write to
   * its own (now old) generation, so it cannot repopulate the new one - but
   * it must stop pretending to be a live session.
   */
  private watchOtherTabs(): void {
    const onNewGeneration = (generation: number): void => {
      if (this.stale || generation <= this.scope.generation) return;
      this.stale = true;
      this.endSession();
      this.stage?.reset();
      this.showTitle();
      titleMenu.cont.classList.add("hidden");
      this.showError("Play data was cleared in another tab. Reload this page to continue.", false);
    };
    try {
      this.channel = new BroadcastChannel(`${this.ns}:playdata`);
      this.channel.onmessage = (e: MessageEvent<{ generation?: number }>) => {
        if (typeof e.data?.generation === "number") onNewGeneration(e.data.generation);
      };
    } catch {
      this.channel = null; // no BroadcastChannel: the storage event still works
    }
    window.addEventListener("storage", (e) => {
      if (e.key !== activePlayDataKey(this.ns)) return;
      onNewGeneration(readActiveGeneration(localStorage, this.ns));
    });
  }

  // ------------------------------------------------ pacing modes
  private toggleAuto(): void {
    this.setAuto(!this.auto);
  }

  private setAuto(on: boolean): void {
    this.auto = on;
    btn.auto.classList.toggle("on", on);
    if (on) this.scheduleAuto();
    else this.cancelAuto();
  }

  private setSkip(on: boolean, sticky = false): void {
    if (this.skip === on && !sticky) return;
    this.skip = on;
    btn.skip.classList.toggle("on", on);
    if (on) this.advance();
  }

  private scheduleAuto(): void {
    this.cancelAuto();
    if (!this.auto || !this.session) return;
    // Only ever schedules from the line on screen right now, so re-entering
    // Auto after a pause never inherits an old line's timing.
    const ev = this.session.current;
    if (!ev || ev.type !== "dialogue") return;
    if (this.overlayOpen()) return; // backlog/menu/settings: hold, do not advance
    const seconds = this.session.voiceDuration(ev);
    const { delayMs } = computeAutoAdvanceDelay(ev.text, seconds !== null ? seconds * 1000 : null, {
      speed: this.config.autoSpeed,
    });
    this.autoTimer.schedule(delayMs);
  }

  /**
   * Which surface owns the keyboard right now, most-modal first.
   *
   * A confirmation sits on top of whatever opened it, so it is checked before
   * the settings panel and the save menu; the title screen is last because it
   * is the resting state rather than something opened over the story.
   */
  private activeOverlay(): Overlay {
    if (!confirmEl.classList.contains("hidden")) return "confirm";
    if (!settingsEl.classList.contains("hidden")) return "settings";
    if (!menuEl.classList.contains("hidden")) return "menu";
    if (!recordsEl.classList.contains("hidden")) return "records";
    if (!backlogEl.classList.contains("hidden")) return "backlog";
    if (!titleEl.classList.contains("hidden")) return "title";
    return "none";
  }

  /** Perform whatever the key router decided. */
  private runKeyAction(action: KeyAction): void {
    switch (action) {
      case "none": return;
      case "advance": this.advance(); return;
      case "openBacklog": this.openBacklog(); return;
      case "closeBacklog": this.closeBacklog(); return;
      case "toggleBacklog": this.toggleBacklog(); return;
      case "closeRecords": this.closeRecords(); return;
      case "closeOverlay": this.closeTopOverlay(); return;
      case "toggleAuto": this.toggleAuto(); return;
      case "openSave": this.openMenu("save"); return;
      case "openLoad": this.openMenu("load"); return;
      case "quickSave": void this.saveToSlot(QUICK_SLOT); return;
      case "openRecords": this.openRecords(); return;
      case "openSettings": this.openSettings(); return;
      case "returnToTitle": void this.returnToTitle(); return;
      case "skipOn": this.setSkip(true); return;
      case "skipOff": this.setSkip(false); return;
    }
  }

  /** Escape from the surface that currently owns the keyboard. */
  private closeTopOverlay(): void {
    if (!confirmEl.classList.contains("hidden")) {
      (confirmEl.querySelector("#confirm-cancel") as HTMLElement | null)?.click();
      return;
    }
    if (!settingsEl.classList.contains("hidden")) {
      (settingsEl.querySelector("#settings-close") as HTMLElement | null)?.click();
      return;
    }
    if (!menuEl.classList.contains("hidden")) menuEl.classList.add("hidden");
    if (this.auto) this.scheduleAuto();
  }

  /** Any surface that should hold Auto rather than let it advance underneath. */
  private overlayOpen(): boolean {
    return [backlogEl, menuEl, settingsEl, confirmEl, titleEl].some((el) => !el.classList.contains("hidden"));
  }

  private cancelAuto(): void {
    this.autoTimer.cancel();
  }

  // ------------------------------------------------ backlog
  /**
   * Remember how to come back to the line now on screen.
   *
   * Keyed by the session's line ordinal rather than by backlog index: the
   * backlog trims from the front once it is full, which would silently shift
   * every index, while an ordinal keeps meaning the same line. A restored
   * moment is re-presented without being re-logged, so writing the same key
   * again is the correct no-op.
   */
  private noteRewindPoint(session: GameSession): void {
    if (session.lines <= 0) return;
    let snap: SessionSave;
    try {
      snap = session.save();
    } catch {
      return; // nothing to snapshot yet
    }
    this.rewindPoints.note(session.lines - 1, {
      // the backlog copy is rebuilt on the way back; keeping one per line
      // would cost O(lines x backlog)
      save: { ...snap, backlog: [] },
      // Host-side evidence, not VM state, and ending recognition reads it -
      // so it has to travel with the moment or a rewind would credit the run
      // with a different ending than uninterrupted play.
      ...captureTimeline({ moviesPlayed: this.moviesPlayed, moviesSinceChoice: this.moviesSinceChoice }),
    });
    this.rewindPoints.trim(oldestBacklogOrdinal(session.lines, session.backlog.length));
  }

  /** Line ordinal of backlog entry `index` in the current session. */
  private backlogOrdinal(session: GameSession, index: number): number {
    return backlogOrdinal(session.lines, session.backlog.length, index);
  }

  /** Go back to a line the player picked out of the backlog. */
  private async jumpToBacklog(index: number): Promise<void> {
    const session = this.session;
    if (!session) return;
    const entry = session.backlog[index];
    if (!entry) return;
    const ordinal = this.backlogOrdinal(session, index);
    const point = this.rewindPoints.get(ordinal);
    if (!point) {
      // lines carried in from a loaded save have no VM state of their own
      toast("that line is from before this session was loaded");
      return;
    }
    // restore re-presents the saved line without re-logging it, so the log it
    // starts from must already contain that line
    const save: SessionSave = { ...point.save, backlog: session.backlog.slice(0, index + 1) };
    await this.resumeFrom(save, `back to: ${this.chapterLabel(entry.scene)}`, point, ordinal);
  }

  private toggleBacklog(): void {
    if (backlogEl.classList.contains("hidden")) this.openBacklog();
    else this.closeBacklog();
  }

  private openBacklog(): void {
    if (!backlogEl.classList.contains("hidden")) return;
    this.cancelAuto(); // reading the log must not advance the story
    backlogEl.innerHTML = "";
    const session = this.session;
    const log = session?.backlog ?? [];
    log.forEach((e, i) => {
      const div = document.createElement("div");
      div.className = "entry";
      const who = e.speaker ? `<div class="who">${e.speaker}</div>` : "";
      div.innerHTML = `<span class="scn"></span>${who}<div class="line"></div>`;
      (div.querySelector(".scn") as HTMLElement).textContent = this.chapterLabel(e.scene);
      (div.querySelector(".line") as HTMLElement).textContent = e.text;
      // Jumping back is only offered where it can actually be honoured -
      // a line with no rewind point stays plain text rather than a control
      // that does nothing.
      if (session && this.rewindPoints.has(this.backlogOrdinal(session, i))) {
        div.classList.add("jump");
        div.tabIndex = 0;
        div.title = "return to this line";
        const go = (): void => void this.jumpToBacklog(i);
        div.addEventListener("click", go);
        div.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            ev.stopPropagation();
            go();
          }
        });
      }
      backlogEl.appendChild(div);
    });
    backlogEl.classList.remove("hidden");
    backlogEl.scrollTop = backlogEl.scrollHeight;
  }

  private closeBacklog(): void {
    if (backlogEl.classList.contains("hidden")) return;
    backlogEl.classList.add("hidden");
    if (this.auto) this.scheduleAuto();
  }

  // ------------------------------------------------ core loop
  private advance(): void {
    // Cancel first: a timer that fires between releasing this line and
    // scheduling the next one would advance the next line too.
    this.autoTimer.cancel();
    this.stage?.skip();
    const w = this.clickWaiter;
    this.clickWaiter = null;
    w?.();
  }

  private waitAdvance(): Promise<void> {
    if (this.skip) return new Promise((r) => setTimeout(r, 35));
    return new Promise((resolve) => {
      this.clickWaiter = resolve;
      this.scheduleAuto();
    });
  }

  /** The player-facing name of a chapter - never a script id. */
  private chapterLabel(scene: string | null | undefined): string {
    return labelForScene(this.catalog, scene).shortLabel;
  }

  private hud(): void {
    const s = this.session;
    hudEl.textContent = s ? this.chapterLabel(s.scene) : "";
  }

  private async playMovie(name: string): Promise<void> {
    const url = `${this.assetsBase}/movies/${name.toLowerCase()}.mp4`;
    const outcome = await this.movies.play(url, { skipAfterMs: this.skip ? 400 : null });
    if (outcome !== "missing") return;
    // No movie file in this package: say so in the textbox and let the player
    // move on, exactly as a line would.
    speakerEl.textContent = "";
    textEl.textContent = `[MOVIE: ${name}]`;
    if (!this.skip) await this.waitAdvance();
  }

  /** Resolver of the currently displayed choice, if any (woken on load). */
  private choiceResolve: ((option: number) => void) | null = null;



  /**
   * Play the media the session queued while producing its next event.
   *
   * Guarded per operation, not just on entry: a movie in the middle of the
   * queue is awaited, and the player can return to the title or load a save
   * during it. Everything after that point belongs to a session that no
   * longer exists and must not be played, counted as ending evidence, or
   * recorded as seen.
   */
  private async flushOps(session: GameSession): Promise<void> {
    const ops = this.ctx.ops;
    this.ctx.ops = [];
    for (const op of ops) {
      if (this.session !== session) return;
      if (op.op === "playSE" && op.asset) {
        const entry = this.assets.get(op.asset);
        if (entry) {
          this.audio.playSe(
            `${this.assetsBase}/${entry.file}`,
            op.arg1 ?? 0,
            this.seLoops(op.asset),
          );
        }
      } else if (op.op === "playMovie" && op.asset) {
        this.moviesSinceChoice.push(op.asset.toLowerCase());
        this.moviesPlayed.add(op.asset.toLowerCase());
        await this.playMovie(op.asset);
        if (this.session !== session) return;
      }
      if (op.asset) this.tracker?.asset(op.asset);
    }
  }

  /** Record what this event puts on screen into the completion state. */
  private trackEvent(ev: Extract<SessionEvent, { type: "dialogue" | "choice" }>): void {
    const t = this.tracker;
    if (!t) return;
    t.asset(ev.state.background?.asset);
    t.asset(ev.state.bgm);
    for (const s of ev.state.sprites) t.asset(s.asset);
    if (ev.type === "dialogue") t.asset(ev.voice);
    for (const a of ev.actions) {
      if (a.kind === "cgEffect") t.asset(a.asset);
    }
  }

  private async loop(): Promise<void> {
    if (this.busy || !this.session) return;
    this.busy = true;
    try {
      for (;;) {
        const session: GameSession | null = this.session;
        if (!session) return;
        const ev: SessionEvent = await session.next();
        // A rewind may have landed while next() was in flight; its ops belong
        // to a timeline that no longer exists.
        if (this.session !== session) continue;
        await this.flushOps(session);
        if (this.session !== session) continue;
        if (ev.type === "dialogue") {
          this.trackEvent(ev);
          this.noteRewindPoint(session);
          if (this.ctx.autosaveDue) {
            this.ctx.autosaveDue = false;
            void this.saveToSlot(AUTO_SLOT);
          }
          this.audio.setBgm(
            ev.state.bgm,
            ev.state.bgm ? `${this.assetsBase}/${this.assets.relative(ev.state.bgm) ?? ""}` : null,
          );
          // play the transition script, then show the line
          await this.stage?.apply(ev.state, ev.actions, (f) => `${this.assetsBase}/${f}`, {
            instant: this.skip || this.config.transitionSpeed === 0,
            speed: this.config.transitionSpeed || 1,
          });
          if (this.session !== session) continue; // a load replaced the session
          speakerEl.textContent = ev.speaker ?? "";
          textEl.textContent = ev.text;
          if (!this.skip) {
            this.audio.playVoice(ev.voiceFile ? `${this.assetsBase}/${ev.voiceFile}` : null);
          }
          this.hud();
          await this.waitAdvance();
          if (this.session !== session) continue; // a load replaced the session
          continue;
        }
        if (ev.type === "choice") {
          // a decision is the player's: Auto never answers one
          this.setAuto(false);
          this.trackEvent(ev);
          await this.stage?.apply(ev.state, ev.actions, (f) => `${this.assetsBase}/${f}`, {
            instant: this.skip,
          });
          if (this.session !== session) continue; // a load replaced the session
          this.hud();
          const option = await this.showChoice(ev);
          if (this.session !== session) continue; // a load replaced the session
          this.tracker?.choice(session.scene, ev.id ?? `b${ev.state.block}`, option);
          this.moviesSinceChoice = [];
          session.choose(option);
          continue;
        }
        // sessionEnd
        this.audio.stopAll();
        speakerEl.textContent = "";
        textEl.textContent =
          (ev.reason === "ending" ? "— FIN —" : `— ${ev.reason} —`) + "\n\nTITLE (T) returns to the title screen.";
        // Only a story that actually reached its ending counts. Ever17
        // writes some route-clear flags near the *start* of a long ending
        // scene, so recording them at a save - or when the player quits to
        // the title inside one - would credit a route they never finished.
        if (ev.type === "sessionEnd" && runCountsAsCompletion(ev.reason)) {
          this.recordProgress();
          if (this.tracker) {
            await this.recordEnding(session, ev.scene);
            await this.tracker.flush();
          }
        }
        return;
      }
    } finally {
      this.busy = false;
    }
  }

  private showChoice(ev: Extract<SessionEvent, { type: "choice" }>): Promise<number> {
    choicesEl.innerHTML = "";
    choicesEl.classList.remove("hidden");
    return new Promise((resolve) => {
      this.choiceResolve = (option) => {
        this.choiceResolve = null;
        choicesEl.classList.add("hidden");
        resolve(option);
      };
      for (const o of ev.options) {
        if (!o.enabled) continue;
        const b = document.createElement("button");
        b.textContent = o.text;
        b.addEventListener("click", () => this.choiceResolve?.(o.index));
        choicesEl.appendChild(b);
      }
      if (choicesEl.children.length === 0) {
        this.choiceResolve(ev.options[0]?.index ?? 0);
      }
    });
  }

  /**
   * Fold the finished run's declared cross-run variables into stored
   * progress. Called only from a confirmed ending - see the call site.
   */
  private recordProgress(): void {
    if (this.stale || !this.session || !this.progress.enabled) return;
    const changed = this.progress.record(this.session.vars);
    if (changed.length > 0) toast("progress recorded");
  }

  /** SE assets whose name ends with the profile's loop suffix loop forever. */
  private seLoops(asset: string): boolean {
    const suffix = this.meta.profile.seLoopSuffix;
    return !!suffix && asset.toLowerCase().endsWith(suffix.toLowerCase());
  }

  async boot(): Promise<void> {
    const res = await fetch(`${this.assetsBase}/manifest.json`);
    if (!res.ok) {
      throw new Error(`asset manifest unavailable (HTTP ${res.status}) - is the local server still running?`);
    }
    const manifest = (await res.json()) as AssetManifest;
    this.assets = new WebAssets(manifest);
    this.source = new WebSceneSource(this.assets);
    this.stage = await PixiStage.create(pixiParent, this.meta.profile);
    this.stage.onAssetActivity = (pending) => this.loading.update(pending);
    this.stage.onAssetError = (file) => this.noteAssetError(file);
    this.tracker = await CompletionTracker.open(new IdbCompletionStore(this.scope.completionDb)).catch(() => null);
    this.catalog = await fetch("narrative.json")
      .then((r) => (r.ok ? (r.json() as Promise<NarrativeProgressCatalog>) : null))
      .catch(() => null);
    // The title screen drives everything from here: New Game, Continue,
    // Load, Settings and the route map.
    this.showTitle();
  }
}

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("sw.js").catch(() => {});
}

/** Load the game package metadata, then boot the player against it. */
async function bootPlayer(): Promise<void> {
  const res = await fetch("game.json");
  if (!res.ok) {
    throw new Error(`game package metadata unavailable (HTTP ${res.status})`);
  }
  const meta = (await res.json()) as GamePackageMeta;
  stageSize = { ...meta.profile.canvas };
  fitStage();
  await new WebPlayer("assets", meta).boot();
}

void bootPlayer().catch((err: unknown) => {
  // Nothing is playable without the package; say so where the player looks.
  const message = err instanceof Error ? err.message : String(err);
  const errorBox = document.getElementById("error")!;
  const errorText = document.getElementById("error-text")!;
  errorText.textContent =
    `${message}\n\nRe-run: npm run ever17 -- serve --game-dir "<your Ever17 folder>"`;
  (errorBox.querySelector("#error-retry") as HTMLElement).textContent = "reload";
  errorBox.querySelector("#error-retry")!.addEventListener("click", () => location.reload());
  errorBox.classList.remove("hidden");
  const hint = document.getElementById("titlehint");
  if (hint) hint.textContent = "could not load the game package";
});
