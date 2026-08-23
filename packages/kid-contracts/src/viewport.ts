/**
 * What counts as a camera rectangle.
 *
 * One implementation, used by the save migration, by player-data validation
 * and by the renderer's transform - because three slightly different opinions
 * about "is this a valid viewport" is how a zero width reaches a division.
 *
 * A dimension may be null, meaning "the canvas dimension"; that is how the
 * scenario expresses a rect it does not crop in one axis. What it may not be
 * is zero or negative: those are not framings, and the transform they imply
 * is an infinite or mirrored world rather than a picture.
 */
import type { ViewportState } from "./presentation.js";

export interface ViewportValidation {
  valid: boolean;
  reason?: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const finiteOrNull = (v: unknown): boolean => v === null || (typeof v === "number" && Number.isFinite(v));

/** A dimension: null for "the whole canvas", otherwise a real positive length. */
const dimensionOrNull = (v: unknown): boolean =>
  v === null || (typeof v === "number" && Number.isFinite(v) && v > 0);

/**
 * Validate a stored or imported camera rectangle.
 *
 * `null` is the whole canvas and always valid. Anything else must be an object
 * carrying all four members, with finite offsets and strictly positive
 * dimensions.
 */
export function validateViewportState(value: unknown): ViewportValidation {
  if (value === null || value === undefined) return { valid: true };
  if (!isPlainObject(value)) return { valid: false, reason: "the camera is not a rectangle" };
  for (const axis of ["x", "y"] as const) {
    if (!(axis in value) || value[axis] === undefined) return { valid: false, reason: `the camera has no ${axis}` };
    if (!finiteOrNull(value[axis])) return { valid: false, reason: `the camera's ${axis} is not a number` };
  }
  for (const side of ["w", "h"] as const) {
    if (!(side in value) || value[side] === undefined) return { valid: false, reason: `the camera has no ${side}` };
    if (!dimensionOrNull(value[side])) {
      return { valid: false, reason: `the camera's ${side} is not a positive size` };
    }
  }
  return { valid: true };
}

/** Convenience for callers that only need the boolean. */
export const isValidViewportState = (value: unknown): value is ViewportState | null =>
  validateViewportState(value).valid;

/**
 * The world transform a camera rectangle means.
 *
 * The last boundary before Pixi, so it never returns a value the renderer
 * cannot use: anything malformed falls back to the identity transform. That
 * fallback does not make a malformed save valid - validation still refuses
 * those - it only guarantees that no arithmetic here can produce an infinite
 * or mirrored world.
 */
export function transformForViewport(
  viewport: ViewportState | null | undefined,
  canvas: { width: number; height: number },
): { scale: number; pivotX: number; pivotY: number } {
  const identity = { scale: 1, pivotX: 0, pivotY: 0 };
  if (!viewport || !validateViewportState(viewport).valid) return identity;
  const cw = canvas.width;
  const ch = canvas.height;
  if (!Number.isFinite(cw) || !Number.isFinite(ch) || cw <= 0 || ch <= 0) return identity;

  const w = viewport.w ?? cw;
  const h = viewport.h ?? ch;
  // A rect covering the whole canvas is how the scenario zooms back out.
  if (w >= cw && h >= ch) return identity;

  const scale = Math.min(cw / w, ch / h);
  if (!Number.isFinite(scale) || scale <= 0) return identity;
  const cx = (viewport.x ?? 0) + w / 2;
  const cy = (viewport.y ?? 0) + h / 2;
  const pivotX = cx - cw / 2 / scale;
  const pivotY = cy - ch / 2 / scale;
  if (!Number.isFinite(pivotX) || !Number.isFinite(pivotY)) return identity;
  return { scale, pivotX, pivotY };
}
