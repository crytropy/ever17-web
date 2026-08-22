/**
 * Play-data generations.
 *
 * "New Game" cannot mean "erase everything" in a game built around replaying:
 * clearing routes is what opens later content, so that progress has to survive
 * a new run. Starting genuinely from scratch is therefore a separate, explicit
 * action - and it must be safe, which rules out deleting a dozen storage keys
 * one by one and hoping every delete lands.
 *
 * Instead, everything gameplay owns lives under a generation, and starting
 * fresh increments it. That single write is the commit point: after it the
 * game reads an empty generation, whatever happens to the old data afterwards.
 * A crash mid-cleanup leaves the new generation active and empty, which is
 * exactly what the player asked for.
 *
 * Settings are deliberately outside the generation - a player resetting their
 * progress does not expect their volume sliders to move.
 *
 * Generation 0 maps to the pre-generation key names, so saves written before
 * this existed keep working with no copying, duplication or deletion.
 */
import type { StorageLike } from "./config.js";

export const PLAY_DATA_VERSION = 1;

export interface ActivePlayData {
  version: typeof PLAY_DATA_VERSION;
  generation: number;
}

/** Where one generation's gameplay data lives. */
export interface PlayDataScope {
  generation: number;
  /** Prefix for gameplay keys in the key-value store. */
  storagePrefix: string;
  /** Database name for completion tracking. */
  completionDb: string;
}

/** The pointer key; itself outside any generation. */
export const activePlayDataKey = (ns: string): string => `${ns}:playdata`;

/**
 * Storage names for a generation. Generation 0 is the historical layout, so
 * existing players keep their saves without a migration step; later
 * generations are namespaced under `play:<n>`.
 */
export function scopeFor(ns: string, generation: number): PlayDataScope {
  if (generation <= 0) {
    return { generation: 0, storagePrefix: ns, completionDb: `${ns}-completion` };
  }
  return {
    generation,
    storagePrefix: `${ns}:play:${generation}`,
    completionDb: `${ns}-play-${generation}-completion`,
  };
}

/** The generation currently in play; 0 when nothing has ever been reset. */
export function readActiveGeneration(storage: StorageLike, ns: string): number {
  try {
    const raw = storage.getItem(activePlayDataKey(ns));
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as Partial<ActivePlayData>;
    if (parsed.version !== PLAY_DATA_VERSION) return 0;
    const g = parsed.generation;
    return typeof g === "number" && Number.isInteger(g) && g >= 0 ? g : 0;
  } catch {
    return 0;
  }
}

export function readActiveScope(storage: StorageLike, ns: string): PlayDataScope {
  return scopeFor(ns, readActiveGeneration(storage, ns));
}

/**
 * Move to a fresh, empty generation. The single write below is the commit
 * point for "start completely fresh": once it lands the player is on new
 * data, and any cleanup of the old generation is optional housekeeping.
 */
export function advanceGeneration(storage: StorageLike, ns: string): PlayDataScope {
  const next = readActiveGeneration(storage, ns) + 1;
  const value: ActivePlayData = { version: PLAY_DATA_VERSION, generation: next };
  storage.setItem(activePlayDataKey(ns), JSON.stringify(value));
  return scopeFor(ns, next);
}

/**
 * Keys belonging to a generation, so old data can be swept up after the
 * pointer has already moved. Only ever called for a generation that is no
 * longer active.
 */
export function keysOfGeneration(storage: StorageLike, ns: string, generation: number): string[] {
  const scope = scopeFor(ns, generation);
  const all = listKeys(storage);
  if (generation === 0) {
    // The historical layout shares its prefix with settings, so name the
    // gameplay keys explicitly rather than sweeping everything under `ns:`.
    return all.filter(
      (k) => k.startsWith(`${ns}:save:`) || k === `${ns}:slots` || k === `${ns}:progress` || k === `${ns}:slot0`,
    );
  }
  return all.filter((k) => k.startsWith(`${scope.storagePrefix}:`));
}

/** Best-effort key enumeration; a plain StorageLike need not support it. */
function listKeys(storage: StorageLike): string[] {
  const withKeys = storage as StorageLike & { length?: number; key?(i: number): string | null };
  if (typeof withKeys.length === "number" && typeof withKeys.key === "function") {
    const out: string[] = [];
    for (let i = 0; i < withKeys.length; i += 1) {
      const k = withKeys.key(i);
      if (k !== null) out.push(k);
    }
    return out;
  }
  const maybeMap = (storage as unknown as { map?: Map<string, string> }).map;
  return maybeMap ? [...maybeMap.keys()] : [];
}

/** Remove one generation's gameplay keys. Never touches settings. */
export function discardGeneration(storage: StorageLike, ns: string, generation: number): number {
  let removed = 0;
  for (const key of keysOfGeneration(storage, ns, generation)) {
    try {
      storage.removeItem(key);
      removed += 1;
    } catch {
      /* leftover data is harmless: it is no longer reachable */
    }
  }
  return removed;
}
