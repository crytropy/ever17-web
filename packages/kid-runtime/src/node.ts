/**
 * Node-only helpers over the environment-independent core: filesystem scene
 * sources, manifest-backed asset resolution, headless frame rendering and
 * fixture capture. Browser code must import from "kid-runtime" (the root
 * entry), which pulls none of this.
 */
export { AssetResolver } from "./assets.js";
export { fsSceneSource } from "./scene-source.js";
export { renderFrame, decodePng } from "./frame.js";
export type { Raster, FrameLabels } from "./frame.js";
export { captureFixtures } from "./fixtures.js";
export type { ShotFixture } from "./fixtures.js";
