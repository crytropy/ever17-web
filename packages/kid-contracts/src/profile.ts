/**
 * GameProfile: the JSON-safe description of everything game-specific that the
 * generic engine needs to interpret a scenario. The engine ships neutral
 * defaults; each adapter supplies the profile for its game, so no title's
 * geometry, naming conventions or effect semantics are hardcoded in the
 * runtime or renderer.
 */

export const PROFILE_VERSION = 1;

/** How an `effectOn` id is visualized. All are labelled approximations. */
export type EffectVisual =
  | { type: "flash" }
  /** Full-screen colour tint; `pulse` oscillates its alpha while active. */
  | { type: "tint"; color: number; alpha: number; pulse?: boolean }
  /** Static full-screen overlay on a named layer (cleared per layer). */
  | { type: "overlay"; layer: "beams" | "fog"; color: number; alpha: number }
  | { type: "quake"; amplitude: number }
  | { type: "particles"; variant: "snow"; count: number };

/** What an `effectOff` category clears. */
export type EffectClear = "tint" | "beams" | "fog" | "particles" | "quake" | "all";

export interface EffectProfile {
  /** effect id -> visual. Unmapped ids are recorded but draw nothing. */
  on: Record<number, EffectVisual>;
  /** effectOff category -> targets to clear. A null category clears everything. */
  off: Record<number, EffectClear[]>;
  /** Effect ids that also stop the tint when an `off` clears "tint". */
  tintEffects?: number[];
}

export interface GameProfile {
  profileVersion: typeof PROFILE_VERSION;
  /** Native canvas size the game's artwork targets. */
  canvas: { width: number; height: number };
  /**
   * Sprite x operands are expressed in this logical width (centre = half).
   * screenX = baseLeftOffset + (x - logicalWidth/2) * (canvas.width / logicalWidth)
   */
  spriteLogicalWidth: number;
  /** playBGM track number -> logical asset name: `${prefix}${pad(track)}`. */
  bgmTrack: { prefix: string; pad: number };
  /** SE assets whose name ends with this suffix (case-insensitive) loop. */
  seLoopSuffix?: string;
  /**
   * Case-insensitive regex sources; a scene matching one of these that
   * terminates without a transition is an ending (otherwise a softlock).
   */
  endingScenePatterns: string[];
  /** Prefix for browser storage keys and databases (must be per-game unique). */
  storageNamespace: string;
  /**
   * Case-insensitive regex sources matching scripts that are UI or developer
   * tooling rather than story content. Import diagnostics use this to tell
   * "a background the player will see is missing" from "a debug menu
   * references something the release does not ship".
   */
  nonStoryScenePatterns?: string[];
  /** Presentation effect interpretation; absent = record only, draw nothing. */
  effects?: EffectProfile;
}

/**
 * Neutral defaults following the KID-era conventions validated on Ever17
 * (800x600 artwork, 640-wide logical sprite space, positional bgmNN track
 * naming). Adapters override anything their game does differently; the
 * defaults exist so tools can run on bare IR without a profile.
 */
export const DEFAULT_GAME_PROFILE: GameProfile = {
  profileVersion: PROFILE_VERSION,
  canvas: { width: 800, height: 600 },
  spriteLogicalWidth: 640,
  bgmTrack: { prefix: "bgm", pad: 2 },
  endingScenePatterns: [],
  storageNamespace: "kidvn",
};
