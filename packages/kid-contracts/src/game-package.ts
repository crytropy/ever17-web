/**
 * Game package: the versioned manifest of one locally generated, playable
 * game (game.json). An adapter converts a user-owned installation into this
 * layout; the web player consumes it. Game packages are derived from
 * copyrighted sources and must never be committed or redistributed.
 */
import type { GameProfile } from "./profile.js";
import type { PersistentStatePolicy } from "./persistence.js";

export const GAME_PACKAGE_FORMAT = "kid-game-package";
export const GAME_PACKAGE_SCHEMA_VERSION = 1;

/** Version of the Web KID Engine that generated a package. */
export const KID_ENGINE_VERSION = "0.7.0";

/** Player-facing branding; owned by the product app, not the engine. */
export interface PlayerBranding {
  /** Title-screen heading and page title. */
  title: string;
  subtitle?: string;
  /** "click to start" line on the title screen. */
  hint?: string;
  /** BCP 47 language of the game's text (html lang attribute). */
  lang?: string;
  themeColor?: string;
  pwaName?: string;
  pwaShortName?: string;
}

export interface GamePackageMeta {
  format: typeof GAME_PACKAGE_FORMAT;
  schemaVersion: number;
  engineVersion: string;
  /** Stable machine id of the game, e.g. "ever17". */
  gameId: string;
  title: string;
  /** Hash identifying the source installation this package was generated from. */
  sourceFingerprint: string;
  /** Scene a New Game starts at. */
  startScene: string;
  profile: GameProfile;
  /** Directories inside the package, relative to game.json. */
  paths: { ir: string; assets: string; movies?: string };
  branding?: PlayerBranding;
  /** What survives a New Game; derived by the adapter during import. */
  persistence?: PersistentStatePolicy;
  generatedAt?: string;
  /** Diagnostics: the source files the package was derived from. */
  source?: { files: { name: string; size: number }[] };
}
