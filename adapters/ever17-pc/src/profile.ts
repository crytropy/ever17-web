/**
 * The Ever17 game profile: every game-specific constant the generic engine
 * needs, in one JSON-safe object. Values were established during phases 1-5
 * (see e17-parser/docs/sc3-format.md) and previously lived inside the
 * runtime/renderer as hardcoded constants.
 */
import { PROFILE_VERSION, type GameProfile } from "kid-contracts/profile";

export const EVER17_GAME_ID = "ever17";
export const EVER17_TITLE = "Ever17";

/** Ever17's New Game start scene: op00 is the opening the debug menu labels
 * オープニング; the title screen (startup.scr) is system UI outside the
 * story graph. */
export const EVER17_START_SCENE = "op00";

export const EVER17_PROFILE: GameProfile = {
  profileVersion: PROFILE_VERSION,
  /** The shipped artwork is 800x600. */
  canvas: { width: 800, height: 600 },
  /** Sprite x operands use a 640-wide logical space (320 = centre). */
  spriteLogicalWidth: 640,
  /** PLAY_BGM track n plays bgm.dat's bgmNN.waf. */
  bgmTrack: { prefix: "bgm", pad: 2 },
  /** SE names ending in "L" (e.g. rainL) are looping ambience channels. */
  seLoopSuffix: "l",
  /**
   * Terminal story scenes: *ep (epilogues), *bd (bad ends), *_ed (ending
   * dispatchers, including y_ed). Matches the classification validated by the
   * phase-5 exploration of all reachable endings.
   */
  endingScenePatterns: ["(ep|bd|_ed)$"],
  /**
   * Storage namespace. Kept at the historical "e17vn" so every save, config
   * and completion database written by earlier phases keeps loading; new
   * games must pick a fresh namespace.
   */
  storageNamespace: "e17vn",
  /**
   * Effect-id interpretation for the Pixi renderer. Only ids reachable during
   * full-route playback are mapped; all are labelled approximations of the
   * original engine's behaviour (see sc3-format.md).
   */
  effects: {
    on: {
      46: { type: "flash" },
      45: { type: "tint", color: 0x203050, alpha: 0.3, pulse: true }, // blink
      44: { type: "tint", color: 0x203050, alpha: 0.35 }, // filter
      32: { type: "tint", color: 0x203050, alpha: 0.35 },
      12: { type: "quake", amplitude: 14 }, // params in vars 571-576; approximated
      4: { type: "quake", amplitude: 8 }, // QUA1
      5: { type: "quake", amplitude: 8 }, // QUA2
      27: { type: "overlay", layer: "beams", color: 0xfff2c0, alpha: 0.18 }, // sunbeams
      19: { type: "overlay", layer: "fog", color: 0xb8c0cc, alpha: 0.3 }, // fog
      41: { type: "particles", variant: "snow", count: 80 },
      // 47/48/49 (eyecatch/pins/route markers) and unmapped ids: recorded, no visual
    },
    off: {
      13: ["tint"],
      11: ["tint"],
      15: ["tint"],
      16: ["tint"],
      7: ["beams"],
      6: ["fog"], // rain category; fog shares it
      14: ["particles"],
      0: ["all"],
    },
  },
};
