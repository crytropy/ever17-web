import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AssetResolver } from "./assets.js";
import type { SceneSource } from "./session.js";
import type { AssetIndex, IrScene } from "./types.js";

/** AssetIndex that resolves nothing - for asset-free routing runs. */
export const NULL_ASSETS: AssetIndex = {
  get: () => undefined,
  relative: () => null,
};

/**
 * Filesystem scene source: IR JSONs in one directory, plus either a single
 * shared manifest or per-scene manifest directories.
 */
export function fsSceneSource(irDir: string, manifestPath?: string): SceneSource {
  const shared = manifestPath ? new AssetResolver(manifestPath) : null;
  const cache = new Map<string, IrScene | null>();
  return {
    load(name: string): IrScene | null {
      const key = name.toLowerCase();
      if (!cache.has(key)) {
        const p = join(irDir, `${key}.json`);
        cache.set(key, existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as IrScene) : null);
      }
      return cache.get(key) ?? null;
    },
    assets(): AssetIndex {
      return shared ?? NULL_ASSETS;
    },
  };
}
