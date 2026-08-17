import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeCps } from "./cps/index.js";
import { decodeWaf, decodeRawPcm, pcmToWav } from "./waf/index.js";
import { RAW_PCM_CHANNELS, RAW_PCM_SAMPLE_RATE } from "./library.js";
import { encodePng } from "./png.js";
import { AssetLibrary } from "./library.js";
import type { AssetRef } from "./scene-assets.js";
import type { AssetManifest, ManifestEntry } from "./types.js";

export interface ExtractOptions {
  outDir: string;
  /** Skip files that already exist in outDir. */
  incremental?: boolean;
  onProgress?: (name: string, entry: ManifestEntry | null, error?: Error) => void;
}

/** Decode one resolved asset and write it as .png / .wav. */
export function extractAsset(
  lib: AssetLibrary,
  ref: AssetRef,
  opts: ExtractOptions,
): ManifestEntry {
  const resolved = lib.resolve(ref.name, ref.kind);
  if (!resolved) throw new Error(`asset not found in any archive: ${ref.kind} "${ref.name}"`);

  const subdir = ref.kind === "image" ? "images" : "audio";
  mkdirSync(join(opts.outDir, subdir), { recursive: true });
  const base = ref.name.toLowerCase().replace(/\.[^.]+$/, "");

  if (ref.kind === "image") {
    const img = decodeCps(resolved.entry.data);
    const file = join(subdir, `${base}.png`);
    writeFileSync(join(opts.outDir, file), encodePng(img));
    return {
      name: ref.name,
      kind: "image",
      archive: resolved.archive,
      file,
      width: img.width,
      height: img.height,
      hasAlpha: img.hasAlpha,
      baseLeftOffset: img.baseLeftOffset,
    };
  }

  const audio =
    resolved.format === "pcm"
      ? decodeRawPcm(resolved.entry.data, RAW_PCM_CHANNELS, RAW_PCM_SAMPLE_RATE)
      : decodeWaf(resolved.entry.data);
  const file = join(subdir, `${base}.wav`);
  writeFileSync(join(opts.outDir, file), pcmToWav(audio));
  return {
    name: ref.name,
    kind: "audio",
    archive: resolved.archive,
    file,
    channels: audio.channels,
    sampleRate: audio.sampleRate,
    duration: Number(audio.duration.toFixed(3)),
  };
}

/** Extract a set of assets and build a manifest describing the result. */
export function extractAssets(
  lib: AssetLibrary,
  refs: AssetRef[],
  opts: ExtractOptions,
  generatedFrom: string[],
): AssetManifest {
  mkdirSync(opts.outDir, { recursive: true });
  const assets: Record<string, ManifestEntry> = {};
  const missing: string[] = [];
  for (const ref of refs) {
    try {
      const entry = extractAsset(lib, ref, opts);
      assets[ref.name.toLowerCase()] = entry;
      opts.onProgress?.(ref.name, entry);
    } catch (err) {
      missing.push(`${ref.kind}:${ref.name} (${ref.via}) - ${(err as Error).message}`);
      opts.onProgress?.(ref.name, null, err as Error);
    }
  }
  return { assets, missing, generatedFrom };
}

export function writeManifest(outDir: string, manifest: AssetManifest): string {
  const path = join(outDir, "manifest.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}
