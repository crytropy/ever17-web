/**
 * Compatibility rules for the versioned contracts.
 *
 * These decide whether a previously generated game package may be reused or
 * must be rebuilt. They live next to the version constants deliberately: a
 * version that nothing checks is decoration, so every version this project
 * stamps has a predicate here that consumers actually call.
 *
 * Pure functions only - no filesystem, no environment. The filesystem side of
 * cache validation belongs to whichever adapter owns the package layout.
 */
import { GAME_PACKAGE_FORMAT, GAME_PACKAGE_SCHEMA_VERSION, KID_ENGINE_VERSION } from "./game-package.js";
import { MANIFEST_SCHEMA_VERSION } from "./manifest.js";
import { PROFILE_VERSION } from "./profile.js";
import { IR_SCHEMA_VERSION } from "./ir.js";

/** Package schema versions this build can read. */
export const SUPPORTED_PACKAGE_SCHEMA_VERSIONS: readonly number[] = [GAME_PACKAGE_SCHEMA_VERSION];
/** Manifest schema versions this build can read. Manifests written before
 * versioning (phase 6A and earlier) carry no formatVersion; they are treated
 * as version 1, which is what they in fact are. */
export const SUPPORTED_MANIFEST_SCHEMA_VERSIONS: readonly number[] = [MANIFEST_SCHEMA_VERSION];
/** GameProfile versions the engine can interpret. */
export const SUPPORTED_PROFILE_VERSIONS: readonly number[] = [PROFILE_VERSION];
/** Scene-IR schema versions the runtime can execute. */
export const SUPPORTED_IR_SCHEMA_VERSIONS: readonly number[] = [IR_SCHEMA_VERSION];

export function isSupportedPackageFormat(format: unknown): boolean {
  return format === GAME_PACKAGE_FORMAT;
}

export function isSupportedPackageSchema(version: unknown): boolean {
  return typeof version === "number" && SUPPORTED_PACKAGE_SCHEMA_VERSIONS.includes(version);
}

export function isSupportedManifestSchema(version: unknown): boolean {
  if (version === undefined) return true; // pre-versioned manifests are v1
  return typeof version === "number" && SUPPORTED_MANIFEST_SCHEMA_VERSIONS.includes(version);
}

export function isSupportedProfileVersion(version: unknown): boolean {
  return typeof version === "number" && SUPPORTED_PROFILE_VERSIONS.includes(version);
}

export function isSupportedIrSchema(version: unknown): boolean {
  if (version === undefined) return true; // pre-versioned IR is v1
  return typeof version === "number" && SUPPORTED_IR_SCHEMA_VERSIONS.includes(version);
}

/**
 * Engine compatibility. While the engine is pre-1.0 every minor release may
 * change what a generated package contains, so a package is reusable only if
 * it was produced by the same major.minor. Patch releases stay compatible.
 */
export function isCompatibleEngineVersion(
  packageEngineVersion: unknown,
  engineVersion: string = KID_ENGINE_VERSION,
): boolean {
  if (typeof packageEngineVersion !== "string") return false;
  const series = (v: string): string | null => {
    const m = v.match(/^(\d+)\.(\d+)\./);
    return m ? `${m[1]}.${m[2]}` : null;
  };
  const a = series(packageEngineVersion);
  const b = series(engineVersion);
  return a !== null && a === b;
}
