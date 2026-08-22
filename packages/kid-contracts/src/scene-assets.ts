/**
 * Generic IR walk collecting every asset a scene references. Pure data-in,
 * data-out: the only game-specific input is the profile's BGM track naming.
 */
import type { IrScene } from "./ir.js";
import { DEFAULT_GAME_PROFILE, type GameProfile } from "./profile.js";

export interface AssetRef {
  name: string;
  kind: "image" | "audio";
  /** Why this asset is referenced, for diagnostics. */
  via: string;
}

/**
 * BGM track number -> logical asset name (`PLAY_BGM [n]` is positional into
 * the BGM archive). The default mapping is the convention validated on
 * Ever17; other games override via their profile.
 */
export function bgmAssetName(
  track: number,
  profile: Pick<GameProfile, "bgmTrack"> = DEFAULT_GAME_PROFILE,
): string {
  return `${profile.bgmTrack.prefix}${String(track).padStart(profile.bgmTrack.pad, "0")}`;
}

/** Collect every asset a scene's IR references. */
export function collectSceneAssets(
  scene: IrScene,
  profile: Pick<GameProfile, "bgmTrack"> = DEFAULT_GAME_PROFILE,
): AssetRef[] {
  const seen = new Map<string, AssetRef>();
  const add = (name: string | null | undefined, kind: "image" | "audio", via: string): void => {
    if (!name) return;
    const key = `${kind}:${name.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, { name, kind, via });
  };

  for (const block of Object.values(scene.blocks)) {
    for (const op of block.ops) {
      switch (op.op) {
        case "setBackground":
          add(op.asset, "image", "setBackground");
          break;
        case "showSprite":
          add(op.asset, "image", "showSprite");
          break;
        case "showSprites":
          for (const s of op.sprites) add(s.asset, "image", "showSprites");
          break;
        case "playSE":
          add(op.asset, "audio", "playSE");
          break;
        case "cgEffect":
          add(op.asset, "image", "cgEffect");
          break;
        case "playBGM":
          if (op.track !== null) add(bgmAssetName(op.track, profile), "audio", "playBGM");
          break;
        case "dialogue":
          add(op.voice, "audio", "dialogue.voice");
          break;
        default:
          break;
      }
    }
  }
  return [...seen.values()];
}

/** Collect every movie asset a scene's IR plays (movies live outside the manifest). */
export function collectSceneMovies(scene: IrScene): string[] {
  const seen = new Set<string>();
  for (const block of Object.values(scene.blocks)) {
    for (const op of block.ops) {
      if (op.op === "playMovie" && op.asset) seen.add(op.asset.toLowerCase());
    }
  }
  return [...seen].sort();
}
