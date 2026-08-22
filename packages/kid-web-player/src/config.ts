/**
 * Client configuration: typed, versioned, persisted through an injected
 * localStorage-compatible store (mockable in tests). Presentation-side only -
 * the runtime contracts know nothing about it. Keys are namespaced per game
 * (GameProfile.storageNamespace) so multiple games on one origin never
 * collide.
 */

import type { AutoSpeed } from "./auto-timing.js";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const CONFIG_VERSION = 2;

export interface VnConfig {
  version: typeof CONFIG_VERSION;
  /** 0..1 gains applied to the three audio channels. */
  bgmVolume: number;
  seVolume: number;
  voiceVolume: number;
  /** How long Auto holds a line: a reading pace, not a raw multiplier. */
  autoSpeed: AutoSpeed;
  /** Multiplies transition speed (2 = twice as fast, 0 disables = instant). */
  transitionSpeed: number;
}

export const configKey = (ns: string): string => `${ns}:config`;

export const DEFAULT_CONFIG: VnConfig = {
  version: CONFIG_VERSION,
  bgmVolume: 0.8,
  seVolume: 0.9,
  voiceVolume: 1,
  autoSpeed: "normal",
  transitionSpeed: 1,
};

/**
 * Settings written before Auto had a reading model stored a raw multiplier.
 * Map it onto the closest pace rather than discarding the player's choice.
 */
export function autoSpeedFromLegacyFactor(factor: unknown): AutoSpeed {
  const n = typeof factor === "number" && Number.isFinite(factor) ? factor : 1;
  if (n <= 0.75) return "fast";
  if (n >= 1.5) return "slow";
  return "normal";
}

const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : dflt;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * Load config, sanitizing every field. Settings from an older version are
 * migrated rather than dropped; anything newer or unreadable falls back to
 * defaults.
 */
export function loadConfig(storage: StorageLike, ns: string): VnConfig {
  try {
    const raw = storage.getItem(configKey(ns));
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<Omit<VnConfig, "version">> & {
      version?: number;
      autoDelayFactor?: unknown;
    };
    if (parsed.version !== 1 && parsed.version !== CONFIG_VERSION) return { ...DEFAULT_CONFIG };
    const autoSpeed: AutoSpeed =
      parsed.version === 1
        ? autoSpeedFromLegacyFactor(parsed.autoDelayFactor)
        : isAutoSpeed(parsed.autoSpeed)
          ? parsed.autoSpeed
          : DEFAULT_CONFIG.autoSpeed;
    return {
      version: CONFIG_VERSION,
      bgmVolume: clamp(parsed.bgmVolume, 0, 1, DEFAULT_CONFIG.bgmVolume),
      seVolume: clamp(parsed.seVolume, 0, 1, DEFAULT_CONFIG.seVolume),
      voiceVolume: clamp(parsed.voiceVolume, 0, 1, DEFAULT_CONFIG.voiceVolume),
      autoSpeed,
      transitionSpeed: clamp(parsed.transitionSpeed, 0, 4, DEFAULT_CONFIG.transitionSpeed),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function isAutoSpeed(v: unknown): v is AutoSpeed {
  return v === "fast" || v === "normal" || v === "slow";
}

export function saveConfig(storage: StorageLike, ns: string, config: VnConfig): void {
  storage.setItem(configKey(ns), JSON.stringify(config));
}
