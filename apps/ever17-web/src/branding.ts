/**
 * Ever17 product branding and game-package metadata assembly. Branding is an
 * app concern: the engine packages render whatever this supplies.
 */
import {
  GAME_PACKAGE_FORMAT,
  GAME_PACKAGE_SCHEMA_VERSION,
  KID_ENGINE_VERSION,
  type GamePackageMeta,
  type PlayerBranding,
} from "kid-contracts";
import { EVER17_GAME_ID, EVER17_PROFILE, EVER17_START_SCENE, EVER17_TITLE } from "ever17-pc";

export const EVER17_BRANDING: PlayerBranding = {
  title: EVER17_TITLE,
  subtitle: "-the out of infinity-",
  hint: "click to start · 点击开始",
  lang: "zh",
  themeColor: "#000814",
  pwaName: "Ever17",
  pwaShortName: "Ever17",
};

/** Assemble Ever17 game-package metadata (dev serving and the importer). */
export function ever17PackageMeta(overrides: Partial<GamePackageMeta> = {}): GamePackageMeta {
  return {
    format: GAME_PACKAGE_FORMAT,
    schemaVersion: GAME_PACKAGE_SCHEMA_VERSION,
    engineVersion: KID_ENGINE_VERSION,
    gameId: EVER17_GAME_ID,
    title: EVER17_TITLE,
    sourceFingerprint: "dev",
    startScene: EVER17_START_SCENE,
    profile: EVER17_PROFILE,
    paths: { ir: "ir", assets: "assets", movies: "assets/movies" },
    branding: EVER17_BRANDING,
    ...overrides,
  };
}
