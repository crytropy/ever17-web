/**
 * Minimal playable browser client over the vn-runtime GameSession API.
 *
 * Consumes exactly what the toolchain emits - /ir/<scene>.json and
 * /assets/manifest.json - and contains no scene-specific logic: the starting
 * scene comes from the URL, everything else from the data.
 *
 * Player features: click/Enter advance, choices, backlog (L), auto mode (A,
 * paced by manifest voice durations), skip mode (hold Ctrl or toggle), one
 * localStorage save slot with identical-resume semantics (pinned by the
 * runtime's save/resume tests).
 */
import { GameSession, SAVE_FORMAT, type AsyncSceneSource, type SessionEvent, type SessionSave } from "../game-session.js";
import type { AssetIndex, AssetManifest, ManifestEntry, SceneStateSnapshot } from "../types.js";

declare global {
  interface Window {
    vnAssetsBase: string;
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
const backlogEl = $("backlog");
const toastEl = $("toast");
const btn = {
  auto: $("btn-auto"),
  skip: $("btn-skip"),
  log: $("btn-log"),
  save: $("btn-save"),
  load: $("btn-load"),
};

function fitStage(): void {
  const s = Math.min(window.innerWidth / 800, window.innerHeight / 600);
  stage.style.transform = `scale(${s})`;
}
window.addEventListener("resize", fitStage);
fitStage();

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
    const url = `${assetsBase}/${sprite.file}`;
    if (el.dataset["url"] !== url) {
      el.src = url;
      el.dataset["url"] = url;
    }
    el.style.left = `${sprite.x ?? 0}px`;
  }
}

// ---------------------------------------------------------------- player
const SAVE_KEY = "e17vn:slot0";

class WebPlayer {
  private session: GameSession | null = null;
  private source!: WebSceneSource;
  private assets!: WebAssets;
  private readonly audio = new AudioBox();
  private clickWaiter: (() => void) | null = null;
  private busy = false;
  private auto = false;
  private skip = false;
  private autoTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly assetsBase: string) {
    window.vnAssetsBase = assetsBase;
    textboxEl.addEventListener("click", () => this.advance());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") this.advance();
      else if (e.key === "a" || e.key === "A") this.toggleAuto();
      else if (e.key === "l" || e.key === "L") this.toggleBacklog();
      else if (e.key === "Escape") backlogEl.classList.add("hidden");
      else if (e.key === "Control") this.setSkip(true);
    });
    document.addEventListener("keyup", (e) => {
      if (e.key === "Control") this.setSkip(false);
    });
    btn.auto.addEventListener("click", () => this.toggleAuto());
    btn.skip.addEventListener("click", () => this.setSkip(!this.skip, true));
    btn.log.addEventListener("click", () => this.toggleBacklog());
    btn.save.addEventListener("click", () => this.saveGame());
    btn.load.addEventListener("click", () => void this.loadGame());
  }

  // ------------------------------------------------ pacing modes
  private toggleAuto(): void {
    this.auto = !this.auto;
    btn.auto.classList.toggle("on", this.auto);
    if (this.auto) this.scheduleAuto();
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
    const ev = this.session.current;
    if (!ev || ev.type !== "dialogue") return;
    const dur = this.session.voiceDuration(ev);
    const ms = Math.max(1400, dur !== null ? dur * 1000 + 600 : 0, ev.text.length * 45);
    this.autoTimer = setTimeout(() => {
      if (this.auto) this.advance();
    }, ms);
  }

  private cancelAuto(): void {
    if (this.autoTimer !== null) clearTimeout(this.autoTimer);
    this.autoTimer = null;
  }

  // ------------------------------------------------ backlog
  private toggleBacklog(): void {
    if (backlogEl.classList.contains("hidden")) {
      backlogEl.innerHTML = "";
      for (const e of this.session?.backlog ?? []) {
        const div = document.createElement("div");
        div.className = "entry";
        const who = e.speaker ? `<div class="who">${e.speaker}</div>` : "";
        div.innerHTML = `<span class="scn">${e.scene}</span>${who}<div class="line"></div>`;
        (div.querySelector(".line") as HTMLElement).textContent = e.text;
        backlogEl.appendChild(div);
      }
      backlogEl.classList.remove("hidden");
      backlogEl.scrollTop = backlogEl.scrollHeight;
    } else {
      backlogEl.classList.add("hidden");
    }
  }

  // ------------------------------------------------ save / load
  private saveGame(): void {
    if (!this.session) return;
    const ev = this.session.current;
    if (!ev || ev.type === "sessionEnd") {
      toast("nothing to save");
      return;
    }
    try {
      const save = this.session.save();
      const label = `${save.vm.scene} · line ${save.counters.lines}`;
      localStorage.setItem(SAVE_KEY, JSON.stringify({ label, savedAt: Date.now(), save }));
      toast(`saved: ${label}`);
    } catch (err) {
      toast(`save failed: ${(err as Error).message}`);
    }
  }

  private async loadGame(): Promise<void> {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) {
      toast("no save");
      return;
    }
    try {
      const { save, label } = JSON.parse(raw) as { save: SessionSave; label: string };
      if (save.format !== SAVE_FORMAT) throw new Error("bad save format");
      this.cancelAuto();
      this.audio.stopAll();
      this.clickWaiter = null;
      choicesEl.classList.add("hidden");
      backlogEl.classList.add("hidden");
      titleEl.classList.add("hidden");
      this.session = await GameSession.restore(this.source, save);
      toast(`loaded: ${label}`);
      void this.loop();
    } catch (err) {
      toast(`load failed: ${(err as Error).message}`);
    }
  }

  // ------------------------------------------------ core loop
  private advance(): void {
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

  private hud(): void {
    const s = this.session;
    hudEl.textContent = s ? `${s.scene} · scene ${s.route.length} · line ${s.lines}` : "";
  }

  private async playMovie(name: string): Promise<void> {
    const url = `${this.assetsBase}/movies/${name.toLowerCase()}.mp4`;
    const head = await fetch(url, { method: "HEAD" }).catch(() => null);
    if (!head?.ok) {
      speakerEl.textContent = "";
      textEl.textContent = `[MOVIE: ${name}]`;
      if (!this.skip) await this.waitAdvance();
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
      if (this.skip) setTimeout(done, 400);
    });
  }

  private pendingOps: { op: string; asset?: string; arg1?: number | null }[] = [];

  private async flushOps(): Promise<void> {
    const ops = this.pendingOps;
    this.pendingOps = [];
    for (const op of ops) {
      if (op.op === "playSE" && op.asset) {
        const entry = this.assets.get(op.asset);
        if (entry) {
          this.audio.playSe(
            `${this.assetsBase}/${entry.file}`,
            op.arg1 ?? 0,
            op.asset.toUpperCase().endsWith("L"),
          );
        }
      } else if (op.op === "playMovie" && op.asset) {
        await this.playMovie(op.asset);
      }
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
        await this.flushOps();
        if (ev.type === "dialogue") {
          renderState(ev.state, this.assetsBase);
          this.audio.setBgm(
            ev.state.bgm,
            ev.state.bgm ? `${this.assetsBase}/${this.assets.relative(ev.state.bgm) ?? ""}` : null,
          );
          speakerEl.textContent = ev.speaker ?? "";
          textEl.textContent = ev.text;
          if (!this.skip) {
            this.audio.playVoice(ev.voiceFile ? `${this.assetsBase}/${ev.voiceFile}` : null);
          }
          this.hud();
          await this.waitAdvance();
          if (this.session !== session) return; // a load replaced the session
          continue;
        }
        if (ev.type === "choice") {
          this.cancelAuto();
          renderState(ev.state, this.assetsBase);
          this.hud();
          const option = await this.showChoice(ev);
          if (this.session !== session) return;
          session.choose(option);
          continue;
        }
        // sessionEnd
        this.audio.stopAll();
        speakerEl.textContent = "";
        textEl.textContent = ev.reason === "ending" ? "— FIN —" : `— ${ev.reason} —`;
        hudEl.textContent += " · ended";
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
    this.source = new WebSceneSource(this.assets);
    const params = new URLSearchParams(location.search);
    const start = params.get("start") ?? "op00";
    await new Promise<void>((resolve) => {
      titleEl.addEventListener("click", () => {
        titleEl.classList.add("hidden");
        resolve();
      });
    });
    this.session = await GameSession.start(this.source, start, {
      vm: {
        onOp: (op) => {
          if (op.op === "playSE") this.pendingOps.push({ op: "playSE", asset: op.asset, arg1: op.arg1 });
          else if (op.op === "playMovie") this.pendingOps.push({ op: "playMovie", asset: op.asset });
        },
      },
    });
    await this.loop();
  }
}

void new WebPlayer("assets").boot();
