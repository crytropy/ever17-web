import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { parseLnk } from "../src/lnk/parser.js";
import type { LnkArchive } from "../src/lnk/types.js";

/**
 * Tests run against the real (user-supplied, non-redistributable) archive.
 * Set E17_SCRIPT_DAT to point elsewhere; tests are skipped when it is absent.
 */
const defaultPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "ever17games",
  "script.dat",
);
export const DAT_PATH = process.env["E17_SCRIPT_DAT"] ?? defaultPath;
export const HAVE_DAT = existsSync(DAT_PATH);

let cached: LnkArchive | undefined;
export function archive(): LnkArchive {
  cached ??= parseLnk(readFileSync(DAT_PATH));
  return cached;
}

export function scr(name: string) {
  const e = archive().entries.find((x) => x.name === name);
  if (!e) throw new Error(`missing ${name}`);
  return e;
}
