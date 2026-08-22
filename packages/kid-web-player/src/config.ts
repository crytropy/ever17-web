/**
 * Client configuration: typed, versioned, persisted through an injected
 * localStorage-compatible store (mockable in tests). Presentation-side only -
 * the runtime contracts know nothing about it. Keys are namespaced per game
 * (GameProfile.storageNamespace) so multiple games on one origin never
 * collide.
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface VnConfig {
  version: 1;
  /** 0..1 gains applied to the three audio channels. */
  bgmVolume: number;
  seVolume: number;
  voiceVolume: number;
  /** Multiplies the computed auto-advance delay (0.5 = twice as fast). */
  autoDelayFactor: number;
  /** Multiplies transition speed (2 = twice as fast, 0 disables = instant). */
  transitionSpeed: number;
}

export const configKey = (ns: string): string => `${ns}:config`;

export const DEFAULT_CONFIG: VnConfig = {
  version: 1,
  bgmVolume: 0.8,
  seVolume: 0.9,
  voiceVolume: 1,
  autoDelayFactor: 1,
  transitionSpeed: 1,
};

const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : dflt;
  return Math.min(hi, Math.max(lo, n));
};

/** Load config, sanitizing every field; unknown versions fall back to defaults. */
export function loadConfig(storage: StorageLike, ns: string): VnConfig {
  try {
    const raw = storage.getItem(configKey(ns));
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<VnConfig>;
    if (parsed.version !== 1) return { ...DEFAULT_CONFIG };
    return {
      version: 1,
      bgmVolume: clamp(parsed.bgmVolume, 0, 1, DEFAULT_CONFIG.bgmVolume),
      seVolume: clamp(parsed.seVolume, 0, 1, DEFAULT_CONFIG.seVolume),
      voiceVolume: clamp(parsed.voiceVolume, 0, 1, DEFAULT_CONFIG.voiceVolume),
      autoDelayFactor: clamp(parsed.autoDelayFactor, 0.25, 4, DEFAULT_CONFIG.autoDelayFactor),
      transitionSpeed: clamp(parsed.transitionSpeed, 0, 4, DEFAULT_CONFIG.transitionSpeed),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(storage: StorageLike, ns: string, config: VnConfig): void {
  storage.setItem(configKey(ns), JSON.stringify(config));
}
