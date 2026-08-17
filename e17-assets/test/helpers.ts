import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { AssetLibrary } from "../src/library.js";

/**
 * Archive-backed tests need the user's own game installation; they are skipped
 * when it is absent. Override the location with E17_GAME_DIR.
 */
const defaultDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "ever17games");
export const GAME_DIR = process.env["E17_GAME_DIR"] ?? defaultDir;
export const HAVE_GAME = existsSync(join(GAME_DIR, "bg.dat"));

let cached: AssetLibrary | undefined;
export function library(): AssetLibrary {
  cached ??= new AssetLibrary(GAME_DIR);
  return cached;
}
