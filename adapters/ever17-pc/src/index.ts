export { EVER17_PROFILE, EVER17_GAME_ID, EVER17_TITLE, EVER17_START_SCENE } from "./profile.js";
export { discoverInstallation, expectedFiles } from "./discover.js";
export type { Ever17Installation, SourceFile } from "./discover.js";
export {
  fingerprintInstallation,
  hashFileChunked,
  DigestIndex,
  FINGERPRINT_ALGO,
} from "./fingerprint.js";
export type {
  FingerprintResult,
  FingerprintOptions,
  FingerprintedFile,
  FingerprintSource,
} from "./fingerprint.js";
export {
  digestIndexPath,
  prepareGamePackage,
  validateInstallation,
} from "./import.js";
export type { PrepareOptions, PreparedPackage } from "./import.js";
export { createAssetMaterializer, AssetConversionError } from "./materialize.js";
export type { Materializer, MaterializeDeps, AssetSource } from "./materialize.js";
export { validateCachedPackage, validateSceneIr } from "./cache.js";
export type { CacheValidation, CacheExpectation } from "./cache.js";
export {
  promoteDirectory,
  cleanupAbandonedBuilds,
  recoverInterruptedPromotion,
  retiredCandidates,
  withCacheLock,
  buildDirName,
  BUILD_SUFFIX,
  RETIRE_SUFFIX,
  ABANDONED_BUILD_MS,
} from "./promotion.js";
export type { RecoveryOutcome } from "./promotion.js";
