import type { AssetIndex } from "./types.js";

/** AssetIndex that resolves nothing - for asset-free routing runs. */
export const NULL_ASSETS: AssetIndex = {
  get: () => undefined,
  relative: () => null,
};
