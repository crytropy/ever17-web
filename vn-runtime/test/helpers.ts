import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const IR_DIR = process.env["E17_IR_DIR"] ?? join(root, "build", "ir");
export const ASSETS_DIR = process.env["E17_ASSETS_DIR"] ?? join(root, "build", "assets", "s_1a");
export const S1A_IR = join(IR_DIR, "s_1a.json");
export const S1A_MANIFEST = join(ASSETS_DIR, "manifest.json");

/**
 * Integration tests need a decompiled scene plus its extracted assets:
 *   npm run e17 -- decompile-all <game>/script.dat -o build/ir
 *   npm run e17-assets -- scene <game> build/ir/s_1a.json -o build/assets/s_1a
 */
export const HAVE_PIPELINE = existsSync(S1A_IR) && existsSync(S1A_MANIFEST);
