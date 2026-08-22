import { readFileSync, existsSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import type { AssetManifest, ManifestEntry } from "./types.js";

/**
 * Read-only view over an extracted asset set. The runtime never touches game
 * archives; it only knows manifest entries and converted file paths.
 */
export class AssetResolver {
  readonly baseDir: string;
  private readonly manifest: AssetManifest;

  constructor(manifestPath: string) {
    const path = isAbsolute(manifestPath) ? manifestPath : join(process.cwd(), manifestPath);
    if (!existsSync(path)) throw new Error(`asset manifest not found: ${path}`);
    this.manifest = JSON.parse(readFileSync(path, "utf8")) as AssetManifest;
    this.baseDir = dirname(path);
  }

  get(name: string | null | undefined): ManifestEntry | undefined {
    if (!name) return undefined;
    return this.manifest.assets[name.toLowerCase()];
  }

  /** Absolute path of a converted asset, or null when it was not extracted. */
  path(name: string | null | undefined): string | null {
    const e = this.get(name);
    return e ? join(this.baseDir, e.file) : null;
  }

  /** Manifest-relative path, suitable for a web runtime's URLs. */
  relative(name: string | null | undefined): string | null {
    return this.get(name)?.file ?? null;
  }

  get missing(): string[] {
    return this.manifest.missing;
  }

  get size(): number {
    return Object.keys(this.manifest.assets).length;
  }
}
