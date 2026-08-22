/**
 * Asset manifest: the JSON contract between an adapter's asset conversion and
 * the engine. Adapters decode original archives into web-native files (PNG,
 * WAV, MP4) and describe the result here; the runtime and player consume only
 * manifest entries and converted file paths, never original archive formats.
 */

/** Version of the manifest JSON shape. Bump on incompatible changes. */
export const MANIFEST_SCHEMA_VERSION = 1;

export interface ManifestEntry {
  /** Logical name as referenced by the scenario (e.g. "bg01a1", "SE01_04"). */
  name: string;
  kind: "image" | "audio";
  /** Source archive file, e.g. "bg.dat". */
  archive: string;
  /** Path of the converted file, relative to the manifest. */
  file: string;
  width?: number;
  height?: number;
  hasAlpha?: boolean;
  /** Sprite anchor: x offset of the trimmed bitmap inside its nominal frame. */
  baseLeftOffset?: number;
  channels?: number;
  sampleRate?: number;
  /** Duration in seconds (drives auto-mode pacing). */
  duration?: number;
}

export interface AssetManifest {
  /** MANIFEST_SCHEMA_VERSION at generation time (absent in pre-versioned output). */
  formatVersion?: number;
  /** Asset entries keyed by lowercased logical name. */
  assets: Record<string, ManifestEntry>;
  /** Names referenced by the scenario that could not be found in any archive. */
  missing: string[];
  generatedFrom: string[];
}
