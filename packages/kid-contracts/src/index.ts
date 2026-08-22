export { IR_SCHEMA_VERSION } from "./ir.js";
export type { IrScene, IrBlock, IrOp, IrCondition, IrValue, DialogueLine } from "./ir.js";
export { MANIFEST_SCHEMA_VERSION } from "./manifest.js";
export type { AssetManifest, ManifestEntry } from "./manifest.js";
export type * from "./presentation.js";
export { SAVE_FORMAT, SAVE_VERSION } from "./save.js";
export type { VmSaveState, SessionSave, BacklogEntry } from "./save.js";
export { PROFILE_VERSION, DEFAULT_GAME_PROFILE } from "./profile.js";
export type { GameProfile, EffectProfile, EffectVisual, EffectClear } from "./profile.js";
export {
  GAME_PACKAGE_FORMAT,
  GAME_PACKAGE_SCHEMA_VERSION,
  KID_ENGINE_VERSION,
} from "./game-package.js";
export type { GamePackageMeta, PlayerBranding } from "./game-package.js";
export {
  IMPORT_REPORT_FORMAT,
  IMPORT_REPORT_VERSION,
} from "./import-report.js";
export type { ImportReport, ImportIssue, ImportSeverity } from "./import-report.js";
export {
  SUPPORTED_PACKAGE_SCHEMA_VERSIONS,
  SUPPORTED_MANIFEST_SCHEMA_VERSIONS,
  SUPPORTED_PROFILE_VERSIONS,
  SUPPORTED_IR_SCHEMA_VERSIONS,
  isSupportedPackageFormat,
  isSupportedPackageSchema,
  isSupportedManifestSchema,
  isSupportedProfileVersion,
  isSupportedIrSchema,
  isCompatibleEngineVersion,
} from "./compat.js";
export { collectSceneAssets, collectSceneMovies, bgmAssetName } from "./scene-assets.js";
export type { AssetRef } from "./scene-assets.js";
