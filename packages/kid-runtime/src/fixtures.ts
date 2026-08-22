import { GameSession, type SessionEvent } from "./game-session.js";
import { fsSceneSource } from "./scene-source.js";
import { AssetResolver } from "./assets.js";
import type { PresentationAction, SceneStateSnapshot } from "./types.js";

/**
 * Capture representative presentation fixtures from a real headless
 * playthrough. Selection is by *generic predicates* over the presentation
 * state (never by scene name), and fixtures contain only state + actions -
 * no dialogue text - so they are committable metadata.
 */
export interface ShotFixture {
  name: string;
  state: {
    background: SceneStateSnapshot["background"];
    sprites: SceneStateSnapshot["sprites"];
    fill: number | null;
  };
  actions: PresentationAction[];
}

const PREDICATES: { name: string; match: (ev: Extract<SessionEvent, { type: "dialogue" | "choice" }>) => boolean }[] = [
  { name: "fill-screen", match: (ev) => ev.state.fill !== null },
  { name: "bg-only", match: (ev) => !!ev.state.background && ev.state.sprites.length === 0 },
  { name: "bg-sprite", match: (ev) => !!ev.state.background && ev.state.sprites.length === 1 },
  { name: "two-sprites", match: (ev) => ev.state.sprites.length >= 2 },
  {
    name: "effect-active",
    match: (ev) => ev.actions.some((a) => a.kind === "effectOn" && a.effect !== null && a.effect !== 47 && a.effect !== 48 && a.effect !== 49),
  },
  { name: "cg-effect", match: (ev) => ev.actions.some((a) => a.kind === "cgEffect" && a.file !== null) },
  {
    name: "crossfade-bg",
    match: (ev) =>
      ev.actions.some((a) => a.kind === "setBackground" && (a.fade ?? 0) > 0) &&
      ev.actions.some((a) => a.kind === "transitionTime" && (a.frames ?? 0) >= 12),
  },
];

export async function captureFixtures(
  irDir: string,
  manifestPath: string,
  startScene: string,
  maxEvents = 20_000,
  profile?: import("kid-contracts/profile").GameProfile,
): Promise<ShotFixture[]> {
  const assets = new AssetResolver(manifestPath);
  const source = {
    load: (n: string) => fsSceneSource(irDir).load(n),
    assets: () => assets,
  };
  const session = await GameSession.start(source, startScene, profile ? { vm: { profile } } : {});
  const found = new Map<string, ShotFixture>();
  for (let i = 0; i < maxEvents && found.size < PREDICATES.length; i++) {
    const raw = await session.next();
    if (raw.type === "sessionEnd") break;
    const ev = raw as Extract<SessionEvent, { type: "dialogue" | "choice" }>;
    for (const p of PREDICATES) {
      if (found.has(p.name) || !p.match(ev)) continue;
      // only keep fixtures whose referenced assets are all resolved, so the
      // shot renders deterministically
      const filesOk =
        (!ev.state.background || ev.state.background.file) &&
        ev.state.sprites.every((s) => s.file);
      if (!filesOk) continue;
      found.set(p.name, {
        name: p.name,
        state: {
          background: ev.state.background,
          sprites: ev.state.sprites,
          fill: ev.state.fill,
        },
        actions: ev.actions,
      });
    }
    if (ev.type === "choice") session.choose(ev.options.find((o) => o.enabled)?.index ?? 0);
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
