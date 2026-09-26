/**
 * Lazy asset conversion for the local server.
 *
 * The package manifest is built from archive headers, so pixels and samples
 * are decoded the first time the player actually asks for them and cached on
 * disk next to the manifest. That makes this the one part of the pipeline
 * that runs while a person is waiting, so it is written to be:
 *
 * - gated: only paths the generated manifest declares can be materialized,
 *   so a crafted request cannot reach the archives or the filesystem
 * - atomic: bytes are written to a unique temporary name and renamed into
 *   place, so a crashed or failed conversion can never leave a truncated
 *   file that later looks like a valid cached asset
 * - shared: concurrent requests for the same asset await one conversion
 * - explicit: failures name the asset, its archive and the reason, so the
 *   player can surface a real message (and the user can retry) instead of
 *   waiting forever on a request that will never succeed
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssetManifest, ManifestEntry } from "kid-contracts";
import {
  AssetLibrary,
  RAW_PCM_CHANNELS,
  RAW_PCM_SAMPLE_RATE,
  decodeCps,
  decodeRawPcm,
  decodeWaf,
  encodePng,
  pcmToWav,
  type ResolvedAsset,
} from "e17-assets";

/** What the materializer needs from the asset archives (injectable for tests). */
export interface AssetSource {
  resolve(
    name: string,
    kind: "image" | "audio",
    opts?: { archive?: string },
  ): ResolvedAsset | undefined;
}

export interface MaterializeDeps {
  /** Archive access; defaults to a real AssetLibrary over the game directory. */
  source?: AssetSource;
  /** Decode one resolved asset to the bytes to cache; defaults to CPS/WAF. */
  convert?: (resolved: ResolvedAsset, kind: "image" | "audio") => Buffer;
  /** Manifest to gate on; defaults to reading assets/manifest.json. */
  manifest?: AssetManifest;
}

/** Thrown when a declared asset cannot be produced; carries the diagnosis. */
export class AssetConversionError extends Error {
  constructor(
    readonly asset: string,
    readonly archive: string,
    readonly reason: string,
  ) {
    super(`could not convert "${asset}" from ${archive}: ${reason}`);
    this.name = "AssetConversionError";
  }
}

function defaultConvert(resolved: ResolvedAsset, kind: "image" | "audio"): Buffer {
  if (kind === "image") return encodePng(decodeCps(resolved.entry.data));
  const audio =
    resolved.format === "pcm"
      ? decodeRawPcm(resolved.entry.data, RAW_PCM_CHANNELS, RAW_PCM_SAMPLE_RATE)
      : decodeWaf(resolved.entry.data);
  return pcmToWav(audio);
}

/** Normalize a request path the way the manifest spells its `file` values. */
function normalizeRel(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\.?\//, "");
}

export interface Materializer {
  /**
   * Produce the converted file for a manifest-relative path, returning its
   * absolute path. Resolves to null when the path is not in the manifest;
   * rejects with AssetConversionError when conversion fails.
   */
  (relPath: string): Promise<string | null>;
}

/**
 * Build the server's on-demand asset converter for a prepared package.
 */
export function createAssetMaterializer(
  gameDir: string,
  assetsDir: string,
  deps: MaterializeDeps = {},
): Materializer {
  const manifest =
    deps.manifest ??
    (JSON.parse(readFileSync(join(assetsDir, "manifest.json"), "utf8")) as AssetManifest);
  // Only what the manifest declares may be materialized, keyed by the exact
  // relative path the player will request.
  const declared = new Map<string, ManifestEntry>();
  for (const entry of Object.values(manifest.assets ?? {})) {
    if (entry?.file) declared.set(normalizeRel(entry.file), entry);
  }

  const source: AssetSource = deps.source ?? new AssetLibrary(gameDir);
  const convert = deps.convert ?? defaultConvert;
  /** In-flight conversions, so simultaneous requests share one decode. */
  const inFlight = new Map<string, Promise<string | null>>();
  let tempCounter = 0;

  const run = async (rel: string, entry: ManifestEntry): Promise<string | null> => {
    const outPath = join(assetsDir, rel);
    if (existsSync(outPath)) return outPath;

    const resolved = source.resolve(entry.name, entry.kind, {
  archive: entry.archive,
});
    if (!resolved) {
      throw new AssetConversionError(entry.name, entry.archive, "not present in the source archives");
    }
    let bytes: Buffer;
    try {
      bytes = convert(resolved, entry.kind);
    } catch (err) {
      throw new AssetConversionError(entry.name, resolved.archive, (err as Error).message);
    }

    mkdirSync(dirname(outPath), { recursive: true });
    // Unique per process and per call: a second writer can never share it.
    const tmp = `${outPath}.tmp-${process.pid}-${Date.now().toString(36)}-${(tempCounter += 1)}`;
    try {
      writeFileSync(tmp, bytes);
      // Atomic within the filesystem: readers see either nothing or the
      // complete file, never a partial one.
      renameSync(tmp, outPath);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw new AssetConversionError(entry.name, resolved.archive, (err as Error).message);
    }
    return outPath;
  };

  return (relPath: string): Promise<string | null> => {
    const rel = normalizeRel(relPath);
    const entry = declared.get(rel);
    if (!entry) return Promise.resolve(null); // not in the manifest: 404, no archive access

    const pending = inFlight.get(rel);
    if (pending) return pending;

    const task = run(rel, entry).finally(() => inFlight.delete(rel));
    inFlight.set(rel, task);
    return task;
  };
}
