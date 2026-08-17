import type { IrScene } from "e17-parser";

export interface AssetRef {
  name: string;
  kind: "image" | "audio";
  /** Why this asset is referenced, for diagnostics. */
  via: string;
}

/**
 * BGM track number -> archive name. `PLAY_BGM [n] [volume]` operands run 1..19
 * and bgm.dat holds bgm01.waf..bgm28.waf, so the mapping is positional.
 * Confidence: Medium - consistent with the archive contents and with op00.scr
 * playing track 1 over the title sequence, but not yet verified by ear
 * against the original engine.
 */
export function bgmAssetName(track: number): string {
  return `bgm${String(track).padStart(2, "0")}`;
}

/** Collect every asset a scene's IR references. */
export function collectSceneAssets(scene: IrScene): AssetRef[] {
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
        case "playBGM":
          if (op.track !== null) add(bgmAssetName(op.track), "audio", "playBGM");
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
