/**
 * Minimal playable browser client over the vn-runtime core.
 *
 * Consumes exactly what the toolchain emits - /ir/<scene>.json and
 * /assets/manifest.json - and drives SceneVm interactively. Contains no
 * scene-specific logic: the starting scene comes from the server config and
 * everything else from the data.
 */
import { SceneVm } from "../vm.js";
import type {
  AssetIndex,
  AssetManifest,
  ChoiceEvent,
  IrOp,
  IrScene,
  ManifestEntry,
  SceneStateSnapshot,
} from "../types.js";

declare global {
  interface Window {
    vnConfig?: { start?: string };
  }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const stage = $("stage");
const bgEl = $<HTMLImageElement>("bg");
const fillEl = $("fill");
const spritesEl = $("sprites");
const speakerEl = $("speaker");
const textEl = $("text");
const textboxEl = $("textbox");
const choicesEl = $("choices");
const titleEl = $("title");
const hudEl = $("hud");
const movieEl = $<HTMLVideoElement>("movie");

function fitStage(): void {
  const s = Math.min(window.innerWidth / 800, window.innerHeight / 600);
  stage.style.transform = `scale(${s})`;
}
window.addEventListener("resize", fitStage);
fitStage();

class WebAssets implements AssetIndex {
  constructor(private manifest: AssetManifest) {}
  get(name: string | null | undefined): ManifestEntry | undefined {
    return name ? this.manifest.assets[name.toLowerCase()] : undefined;
  }
  relative(name: string | null | undefined): string | null {
    return this.get(name)?.file ?? null;
  }
}

// ---------------------------------------------------------------- audio
class AudioBox {
  private bgm: HTMLAudioElement | null = null;
  private bgmName: string | null = null;
  private voice: HTMLAudioElement | null = null;
  private seChannels = new Map<number, HTMLAudioElement>();

  setBgm(name: string | null, url: string | null): void {
    if (name === this.bgmName) return;
    this.bgm?.pause();
    this.bgm = null;
    this.bgmName = name;
    if (name && url) {
      this.bgm = new Audio(url);
      this.bgm.loop = true;
      void this.bgm.play().catch(() => {});
    }
  }
  playVoice(url: string | null): void {
    this.voice?.pause();
    this.voice = null;
    if (url) {
      this.voice = new Audio(url);
      void this.voice.play().catch(() => {});
    }
  }
  playSe(url: string | null, channel: number, loop: boolean): void {
    if (!url) return;
    this.seChannels.get(channel)?.pause();
    const a = new Audio(url);
    a.loop = loop;
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

// ---------------------------------------------------------------- rendering
function renderState(state: SceneStateSnapshot, assetsBase: string): void {
  if (state.background?.file) {
    const url = `${assetsBase}/${state.background.file}`;
    if (bgEl.dataset["url"] !== url) {
      bgEl.src = url;
      bgEl.dataset["url"] = url;
    }
    bgEl.classList.remove("hidden");
    fillEl.style.background = "transparent";
  } else {
    bgEl.classList.add("hidden");
    bgEl.dataset["url"] = "";
    fillEl.style.background = state.fill === 1 ? "#fff" : "#000";
  }
  // sprites keyed by slot
  const want = new Map(state.sprites.filter((s) => s.file).map((s) => [`s${s.slot}`, s]));
  for (const el of [...spritesEl.children] as HTMLImageElement[]) {
    if (!want.has(el.id)) el.remove();
  }
  for (const [id, sprite] of want) {
    let el = document.getElementById(id) as HTMLImageElement | null;
    if (!el) {
      el = document.createElement("img");
      el.id = id;
      el.className = "sprite";
      spritesEl.appendChild(el);
    }
    const url = `${window.vnAssetsBase}/${sprite.file}`;
    if (el.dataset["url"] !== url) {
      el.src = url;
      el.dataset["url"] = url;
    }
    el.style.left = `${sprite.x ?? 0}px`;
  }
}

declare global {
  interface Window {
    vnAssetsBase: string;
  }
}

// ---------------------------------------------------------------- driver
type Waiter = { resolve: () => void } | null;

class WebPlayer {
  private vm: SceneVm | null = null;
  private readonly vars = new Map<number, number>();
  private readonly sysVars = new Map<number, number>();
  private assets!: WebAssets;
  private readonly audio = new AudioBox();
  private clickWaiter: Waiter = null;
  private sceneName = "";
  private lines = 0;
  private sceneCount = 0;

  constructor(private readonly assetsBase: string) {
    window.vnAssetsBase = assetsBase;
    textboxEl.addEventListener("click", () => this.advance());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") this.advance();
    });
  }

  private advance(): void {
    const w = this.clickWaiter;
    this.clickWaiter = null;
    w?.resolve();
  }

  private waitClick(): Promise<void> {
    return new Promise((resolve) => {
      this.clickWaiter = { resolve };
    });
  }

  private hud(): void {
    hudEl.textContent = `${this.sceneName} · scene ${this.sceneCount} · line ${this.lines}`;
  }

  private async loadScene(name: string): Promise<IrScene | null> {
    const res = await fetch(`ir/${name.toLowerCase()}.json`);
    if (!res.ok) return null;
    return (await res.json()) as IrScene;
  }

  private async playMovie(name: string): Promise<void> {
    const url = `${this.assetsBase}/movies/${name.toLowerCase()}.mp4`;
    const head = await fetch(url, { method: "HEAD" }).catch(() => null);
    if (!head?.ok) {
      // no converted movie: show a labelled card instead
      speakerEl.textContent = "";
      textEl.textContent = `[MOVIE: ${name}]`;
      await this.waitClick();
      return;
    }
    movieEl.src = url;
    movieEl.classList.remove("hidden");
    await movieEl.play().catch(() => {});
    await new Promise<void>((resolve) => {
      const done = (): void => {
        movieEl.classList.add("hidden");
        movieEl.pause();
        resolve();
      };
      movieEl.onended = done;
      movieEl.onclick = done;
    });
  }

  /** Ops the VM does not present, surfaced during next(). */
  private pendingOps: IrOp[] = [];

  private async flushOps(): Promise<void> {
    const ops = this.pendingOps;
    this.pendingOps = [];
    for (const op of ops) {
      if (op.op === "playSE") {
        const entry = this.assets.get(op.asset);
        if (entry) {
          this.audio.playSe(
            `${this.assetsBase}/${entry.file}`,
            op.arg1 ?? 0,
            op.asset.toUpperCase().endsWith("L"),
          );
        }
      } else if (op.op === "playMovie") {
        await this.playMovie(op.asset);
      }
    }
  }

  async run(start: string): Promise<void> {
    let current: string | null = start;
    while (current) {
      const scene = await this.loadScene(current);
      if (!scene) {
        textEl.textContent = `— missing scene: ${current} —`;
        return;
      }
      this.sceneName = scene.scene;
      this.sceneCount += 1;
      const vm = new SceneVm(scene, this.assets, {
        vars: this.vars,
        sysVars: this.sysVars,
        onOp: (op) => {
          this.pendingOps.push(op);
        },
      });
      this.vm = vm;
      let next: string | null = null;
      for (;;) {
        const ev = vm.next();
        await this.flushOps();
        if (ev.type === "dialogue") {
          this.lines += 1;
          renderState(ev.state, this.assetsBase);
          this.audio.setBgm(
            ev.state.bgm,
            ev.state.bgm ? `${this.assetsBase}/${this.assets.relative(ev.state.bgm) ?? ""}` : null,
          );
          speakerEl.textContent = ev.speaker ?? "";
          textEl.textContent = ev.text;
          this.audio.playVoice(ev.voiceFile ? `${this.assetsBase}/${ev.voiceFile}` : null);
          this.hud();
          await this.waitClick();
          continue;
        }
        if (ev.type === "choice") {
          renderState(ev.state, this.assetsBase);
          const option = await this.showChoice(ev);
          vm.choose(ev, { option });
          continue;
        }
        if (ev.reason === "gotoScene" && ev.nextScene) next = ev.nextScene;
        break;
      }
      current = next;
    }
    // terminal scene finished: FIN
    this.audio.stopAll();
    speakerEl.textContent = "";
    textEl.textContent = "— FIN —";
    hudEl.textContent += " · ended";
  }

  private showChoice(ev: ChoiceEvent): Promise<number> {
    choicesEl.innerHTML = "";
    choicesEl.classList.remove("hidden");
    return new Promise((resolve) => {
      for (const o of ev.options) {
        if (!o.enabled) continue;
        const b = document.createElement("button");
        b.textContent = o.text;
        b.addEventListener("click", () => {
          choicesEl.classList.add("hidden");
          resolve(o.index);
        });
        choicesEl.appendChild(b);
      }
      if (choicesEl.children.length === 0) {
        choicesEl.classList.add("hidden");
        resolve(ev.options[0]?.index ?? 0);
      }
    });
  }

  async boot(): Promise<void> {
    const manifest = (await (await fetch(`${this.assetsBase}/manifest.json`)).json()) as AssetManifest;
    this.assets = new WebAssets(manifest);
    const start = window.vnConfig?.start ?? "op00";
    await new Promise<void>((resolve) => {
      titleEl.addEventListener("click", () => {
        titleEl.classList.add("hidden");
        resolve();
      });
    });
    await this.run(start);
  }
}

const params = new URLSearchParams(location.search);
const startParam = params.get("start");
window.vnConfig = startParam ? { start: startParam } : {};
void new WebPlayer("assets").boot();
