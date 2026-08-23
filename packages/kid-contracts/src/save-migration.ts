/**
 * Reading a save written by an older build.
 *
 * v2 records the full-screen CG as part of the picture. v1 did not record it
 * at all - and "the format never asked" is not the same fact as "there was no
 * CG". Coercing the first into the second is what made a legacy save restore
 * to the bare fill the CG had been covering: a white screen where the artwork
 * belongs, with nothing to say anything had gone wrong.
 *
 * So a v1 save is only accepted when the data it does carry proves what the
 * final picture was. When it does not, the load is refused with a reason the
 * player can act on, and the save is left exactly as it is - an unreadable
 * save is still the player's, and may become readable again.
 *
 * Everything here is pure and game-independent: it reasons about the recorded
 * presentation and its action deltas, never about a particular game's scenes
 * or assets.
 */
import type { LayerState, PresentationAction, ViewportState } from "./presentation.js";
import { SAVE_FORMAT, SAVE_VERSION, SUPPORTED_SAVE_VERSIONS, type SessionSave } from "./save.js";

export type SaveMigrationFailure = "invalid-save" | "unsupported-version" | "legacy-picture-incomplete";

export type SaveMigrationResult =
  | { ok: true; save: SessionSave; migrated: boolean }
  | { ok: false; reason: SaveMigrationFailure; message: string };

/** Player-facing wording for a save this build cannot safely display. */
export const LEGACY_PICTURE_INCOMPLETE_MESSAGE =
  "This save was created by an older build and does not contain enough picture " +
  "state to restore this scene safely. Load another save or start a new game.";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A layer the renderer can actually draw: it needs at least a name. */
function asLayer(v: unknown): LayerState | null {
  if (!isObject(v)) return null;
  if (typeof v["asset"] !== "string" || v["asset"].length === 0) return null;
  return v as unknown as LayerState;
}

/**
 * What the recorded action deltas prove about the CG.
 *
 * The deltas are the presented event's own script, in execution order, so the
 * last one that touches the full-screen layer decides what is on top of it:
 * a cgEffect puts a CG there, a background or a fill takes it away.
 *
 * Returns `undefined` when the deltas say nothing either way.
 */
function cgFromActions(actions: readonly PresentationAction[]): LayerState | null | undefined {
  let verdict: LayerState | null | undefined;
  for (const a of actions) {
    if (a.kind === "cgEffect") {
      // Only a CG with a resolved file is evidence of something drawn.
      verdict = a.file ? ({ asset: a.asset ?? "", file: a.file, width: null, height: null, x: null, slot: null } as LayerState) : null;
    } else if (a.kind === "setBackground" || a.kind === "fillScreen") {
      verdict = null;
    }
  }
  return verdict;
}

/**
 * What the recorded deltas prove about the camera.
 *
 * The same shape of evidence as the CG, for the same reason: a zoom outlives
 * the event that set it, so an event with no viewportRect says nothing about
 * where the camera is.
 */
function viewportFromActions(actions: readonly PresentationAction[]): ViewportState | null | undefined {
  let verdict: ViewportState | null | undefined;
  for (const a of actions) {
    if (a.kind === "viewportRect") verdict = { x: a.x, y: a.y, w: a.w, h: a.h };
  }
  return verdict;
}

/**
 * Decide the CG of an older picture, or report that it cannot be known.
 *
 * Only the recorded deltas can prove it. A CG shown by an *earlier* event
 * stays on screen until a later background or fill replaces it, so the event
 * a save was taken on may say nothing about the CG at all - and a recorded
 * background does not mean the background is what the player was looking at.
 * Neither does an empty picture: a persistent CG may be covering it.
 *
 * That leaves exactly one kind of evidence: an action in this event that
 * touches the full-screen layer. Everything else is a guess, and guessing is
 * what put a white screen where the artwork belonged.
 */
function recoverLegacyCg(actions: readonly PresentationAction[]): { ok: true; cg: LayerState | null } | { ok: false } {
  const fromActions = cgFromActions(actions);
  if (fromActions !== undefined) return { ok: true, cg: fromActions };
  return { ok: false };
}

/**
 * Normalize a stored save to the current version.
 *
 * The result is either a save the runtime can use directly, or a refusal with
 * a reason. Nothing is written, nothing is repaired in place: migration is a
 * reading of stored bytes, not an edit of them.
 */
export function migrateSave(raw: unknown): SaveMigrationResult {
  if (!isObject(raw)) return { ok: false, reason: "invalid-save", message: "that save could not be read" };
  if (raw["format"] !== SAVE_FORMAT) {
    return { ok: false, reason: "invalid-save", message: `that file is not a save (format "${String(raw["format"])}")` };
  }
  const version = raw["version"];
  if (typeof version !== "number" || !SUPPORTED_SAVE_VERSIONS.includes(version)) {
    return {
      ok: false,
      reason: "unsupported-version",
      message: `that save was written by a newer build (version ${String(version)})`,
    };
  }
  const vm = raw["vm"];
  if (!isObject(vm)) return { ok: false, reason: "invalid-save", message: "that save has no VM state" };
  const presentation = vm["presentation"];
  if (!isObject(presentation)) {
    return { ok: false, reason: "invalid-save", message: "that save has no presentation state" };
  }

  const cgRaw = presentation["cg"];
  const cgPresent = "cg" in presentation;
  if (cgPresent && cgRaw !== null && asLayer(cgRaw) === null) {
    return { ok: false, reason: "invalid-save", message: "that save's CG state is malformed" };
  }

  if (version === SAVE_VERSION) {
    // The current version must be explicit about everything that outlives an
    // event. Absent here is malformed, not legacy.
    if (!cgPresent) {
      return { ok: false, reason: "invalid-save", message: "that save is missing its CG state" };
    }
    if (!("viewport" in presentation)) {
      return { ok: false, reason: "invalid-save", message: "that save is missing its camera state" };
    }
    return { ok: true, save: raw as unknown as SessionSave, migrated: false };
  }

  const actions = Array.isArray(vm["actions"]) ? (vm["actions"] as PresentationAction[]) : [];

  // v2 already records the CG; only the camera is unknown. v1 records
  // neither. Either way, only this event's own deltas can prove what is
  // missing - so a save migrates when every missing piece is proven, and is
  // refused when any of them would be a guess.
  const recovered = cgPresent
    ? ({ ok: true, cg: cgRaw as LayerState | null } as const)
    : recoverLegacyCg(actions);
  if (!recovered.ok) {
    return { ok: false, reason: "legacy-picture-incomplete", message: LEGACY_PICTURE_INCOMPLETE_MESSAGE };
  }

  const viewport = viewportFromActions(actions);
  if (viewport === undefined) {
    return { ok: false, reason: "legacy-picture-incomplete", message: LEGACY_PICTURE_INCOMPLETE_MESSAGE };
  }

  // A copy: the stored save is left untouched, so a refusal or a later build
  // can still read the original bytes.
  const save = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  const savedVm = save["vm"] as Record<string, unknown>;
  const savedPresentation = savedVm["presentation"] as Record<string, unknown>;
  savedPresentation["cg"] = recovered.cg;
  savedPresentation["viewport"] = viewport;
  save["version"] = SAVE_VERSION;
  return { ok: true, save: save as unknown as SessionSave, migrated: true };
}
