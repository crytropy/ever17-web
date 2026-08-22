/**
 * The generic IR asset walk lives in kid-contracts; re-exported here so
 * existing consumers of "e17-assets/scene-assets" keep working. The default
 * profile's bgmNN naming matches Ever17, so behavior is unchanged.
 */
export { bgmAssetName, collectSceneAssets, collectSceneMovies } from "kid-contracts/scene-assets";
export type { AssetRef } from "kid-contracts/scene-assets";
