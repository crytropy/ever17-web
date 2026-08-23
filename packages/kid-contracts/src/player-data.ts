/**
 * Player-data transfer: everything a person would be sad to lose, in one
 * file they can keep, move to another browser, or restore after clearing
 * site data.
 *
 * Browser storage is easy to wipe by accident, so this is deliberately a
 * plain, versioned JSON document rather than an opaque blob: saves, settings
 * and cross-run progress.
 *
 * It is NOT free of game content. Every save carries its dialogue backlog, so
 * an export contains the story text the player had recently read, and slot
 * metadata may carry a thumbnail of the screen. That is fine for a file the
 * player keeps: it stays on their machine unless they share it. It does mean
 * an export must never be committed to a repository or redistributed - the
 * same rule as the rest of the converted content.
 */
import { PERSISTENT_STATE_FORMAT, PERSISTENT_STATE_VERSION, type PersistentState } from "./persistence.js";
import { SAVE_FORMAT, SAVE_VERSION, type SessionSave } from "./save.js";

export const PLAYER_DATA_FORMAT = "kid-player-data";
export const PLAYER_DATA_VERSION = 1;

export interface ExportedSlot {
  slot: string;
  /** Slot metadata as stored; the label may be re-resolved on display. */
  meta: {
    slot: string;
    label: string;
    savedAt: number;
    scene: string;
    lines: number;
    thumb?: string;
  };
  save: SessionSave;
}

export interface PlayerDataExport {
  format: typeof PLAYER_DATA_FORMAT;
  version: typeof PLAYER_DATA_VERSION;
  gameId: string;
  exportedAt: string;
  /** Engine that wrote the file, for diagnostics. */
  engineVersion?: string;
  slots: ExportedSlot[];
  /** Settings, as stored (shape owned by the player). */
  config?: unknown;
  /** Cross-run progress. */
  progress?: PersistentState;
  /** Completion tracking (scenes/choices/endings/assets seen). */
  completion?: unknown;
}

export interface PlayerDataSummary {
  slots: number;
  hasConfig: boolean;
  hasProgress: boolean;
  hasCompletion: boolean;
  exportedAt: string;
  gameId: string;
}

/** Bounds, so a hostile or corrupt file cannot exhaust memory or storage. */
export const PLAYER_DATA_LIMITS = {
  /**
   * Refused before the file is even read into a string. Every other limit
   * here bounds one field or collection; this one bounds the whole document,
   * so a huge file cannot cost a tab's memory just to be parsed and rejected.
   */
  maxFileBytes: 32 * 1024 * 1024,
  maxSlots: 64,
  maxSlotNameLength: 32,
  maxLabelLength: 200,
  maxBacklogEntries: 5000,
  maxVars: 5000,
  maxCompletionEntries: 200_000,
  maxStringLength: 4000,
  /** Scene and block names; identifiers, not prose. */
  maxNameLength: 128,
  /** Scenes visited in one run. */
  maxRouteLength: 5000,
  /** On-screen sprite layers in a saved presentation state. */
  maxSprites: 64,
  /** Presentation deltas re-attached when the saved moment is re-presented. */
  maxActions: 512,
  /** Thumbnails are data URLs; anything larger is not a thumbnail. */
  maxThumbLength: 2_000_000,
} as const;

/**
 * Human-readable reason a file is too large to open, or null when it fits.
 * Checked against a file's byte size before reading it.
 */
export function playerDataSizeProblem(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes < 0) return "that file's size could not be determined";
  if (bytes > PLAYER_DATA_LIMITS.maxFileBytes) {
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    const max = PLAYER_DATA_LIMITS.maxFileBytes / (1024 * 1024);
    return `that file is ${mb} MB; save data files are at most ${max} MB`;
  }
  return null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isBoundedString = (v: unknown, max: number = PLAYER_DATA_LIMITS.maxStringLength): v is string =>
  typeof v === "string" && v.length <= max;

/** A required identifier: present, non-empty and short enough to be a name. */
const isName = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= PLAYER_DATA_LIMITS.maxNameLength;

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const isNonNegativeInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

/** `T | null`, where absent is not the same as null. */
const isNullOr = (v: unknown, ok: (x: unknown) => boolean): boolean => v === null || ok(v);

/** An optional `T | null` field: absent, null, or valid. */
const isOptionalNullOr = (v: unknown, ok: (x: unknown) => boolean): boolean =>
  v === undefined || v === null || ok(v);

const isNumberPairs = (v: unknown, max: number): boolean =>
  Array.isArray(v) &&
  v.length <= max &&
  v.every(
    (e) =>
      Array.isArray(e) &&
      e.length === 2 &&
      // ids index a variable table, so they are integers; a non-finite value
      // would poison every later arithmetic op in the VM
      typeof e[0] === "number" &&
      Number.isInteger(e[0]) &&
      isFiniteNumber(e[1]),
  );

/**
 * A resolved background or sprite layer. The renderer dereferences `file` and
 * positions by the numbers, so each has to be the right shape or null - not
 * merely present.
 */
function isLayerState(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  return (
    isName(v["asset"]) &&
    isNullOr(v["file"], (x) => isBoundedString(x, PLAYER_DATA_LIMITS.maxNameLength)) &&
    isNullOr(v["width"], isFiniteNumber) &&
    isNullOr(v["height"], isFiniteNumber) &&
    isNullOr(v["x"], isFiniteNumber) &&
    isNullOr(v["slot"], isFiniteNumber)
  );
}

/** Presentation deltas the VM replays when a saved moment is re-presented. */
const ACTION_KINDS = new Set([
  "setBackground",
  "fillScreen",
  "showSprite",
  "hideSprite",
  "spriteOrder",
  "transitionTime",
  "transitionSync",
  "wait",
  "effectOn",
  "effectOff",
  "shake",
  "viewportRect",
  "cgEffect",
]);

function isPresentationAction(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  const kind = v["kind"];
  if (typeof kind !== "string" || !ACTION_KINDS.has(kind)) return false;
  // The two kinds that carry a layer are the ones the renderer dereferences;
  // the rest are numbers the stage clamps for itself.
  if (kind === "setBackground" || kind === "showSprite") {
    if (!isLayerState(v["layer"])) return false;
  }
  if (kind === "spriteOrder") {
    const order = v["order"];
    if (!Array.isArray(order) || order.length > PLAYER_DATA_LIMITS.maxSprites) return false;
    if (!order.every((o) => isNullOr(o, isFiniteNumber))) return false;
  }
  if (kind === "cgEffect") {
    const args = v["args"];
    if (!Array.isArray(args) || args.length > PLAYER_DATA_LIMITS.maxSprites) return false;
    if (!args.every((a) => isNullOr(a, isFiniteNumber))) return false;
  }
  return true;
}

/** The saved VM position and the screen it was presenting. */
function validateVmState(vm: unknown, where: string): string | null {
  if (!isPlainObject(vm)) return `${where}: the save has no VM state`;
  if (!isName(vm["scene"])) return `${where}: the save names no scene`;
  if (!isName(vm["block"])) return `${where}: the save names no block`;
  if (!isNonNegativeInt(vm["pc"])) return `${where}: the save's position is not a whole number`;
  if (!isNonNegativeInt(vm["steps"])) return `${where}: the save's step count is not a whole number`;

  const p = vm["presentation"];
  if (!isPlainObject(p)) return `${where}: the save has no presentation state`;
  if (!isNullOr(p["background"], isLayerState)) return `${where}: the save's background is malformed`;
  const sprites = p["sprites"];
  if (!Array.isArray(sprites)) return `${where}: the save has no sprite list`;
  if (sprites.length > PLAYER_DATA_LIMITS.maxSprites) return `${where}: the save has too many sprites`;
  for (const entry of sprites) {
    // stored as [slot, layer] pairs, not bare layers
    if (!Array.isArray(entry) || entry.length !== 2) return `${where}: a sprite entry is not a [slot, layer] pair`;
    if (!isFiniteNumber(entry[0])) return `${where}: a sprite entry has no slot`;
    if (!isLayerState(entry[1])) return `${where}: a sprite entry's layer is malformed`;
  }
  if (!isNullOr(p["bgm"], (x) => isBoundedString(x, PLAYER_DATA_LIMITS.maxNameLength))) {
    return `${where}: the save's music track is malformed`;
  }
  if (!isNullOr(p["fill"], isFiniteNumber)) return `${where}: the save's screen fill is malformed`;

  const actions = vm["actions"];
  if (actions !== undefined) {
    if (!Array.isArray(actions)) return `${where}: the save's presentation actions are malformed`;
    if (actions.length > PLAYER_DATA_LIMITS.maxActions) return `${where}: the save has too many presentation actions`;
    if (!actions.every(isPresentationAction)) return `${where}: a presentation action in the save is malformed`;
  }
  return null;
}

/**
 * One save file, checked deeply enough that the runtime can load it.
 *
 * The bar is deliberately that high: anything this accepts is written into
 * storage and later handed to GameSession.restore, so a field that is merely
 * absent or of the wrong type must be caught here rather than thrown by the
 * VM halfway into a restored scene.
 */
function validateSessionSave(save: unknown, where: string): string | null {
  if (!isPlainObject(save)) return `${where}: the save is not an object`;
  if (save["format"] !== SAVE_FORMAT) return `${where}: unexpected save format "${String(save["format"])}"`;
  if (save["version"] !== SAVE_VERSION) return `${where}: unsupported save version ${String(save["version"])}`;

  const vmProblem = validateVmState(save["vm"], where);
  if (vmProblem) return vmProblem;

  if (!isNumberPairs(save["vars"], PLAYER_DATA_LIMITS.maxVars)) return `${where}: the save's variables are malformed`;
  if (!isNumberPairs(save["sysVars"], PLAYER_DATA_LIMITS.maxVars)) {
    return `${where}: the save's system variables are malformed`;
  }

  const counters = save["counters"];
  if (!isPlainObject(counters)) return `${where}: the save has no counters`;
  if (!isNonNegativeInt(counters["lines"])) return `${where}: the save's line count is malformed`;
  if (!isNonNegativeInt(counters["scenes"])) return `${where}: the save's scene count is malformed`;

  const route = save["route"];
  if (!Array.isArray(route)) return `${where}: the save's route is malformed`;
  if (route.length > PLAYER_DATA_LIMITS.maxRouteLength) return `${where}: the save's route is too long`;
  if (!route.every(isName)) return `${where}: the save's route names something that is not a scene`;

  const backlog = save["backlog"];
  if (!Array.isArray(backlog)) return `${where}: the save's backlog is malformed`;
  if (backlog.length > PLAYER_DATA_LIMITS.maxBacklogEntries) return `${where}: the save's backlog is too large`;
  for (const entry of backlog) {
    if (!isPlainObject(entry)) return `${where}: a backlog entry is malformed`;
    if (!isName(entry["scene"])) return `${where}: a backlog entry names no scene`;
    if (!isBoundedString(entry["text"])) return `${where}: a backlog entry's text is malformed or too long`;
    if (!isOptionalNullOr(entry["speaker"], (x) => isBoundedString(x, PLAYER_DATA_LIMITS.maxLabelLength))) {
      return `${where}: a backlog entry's speaker is malformed`;
    }
    if (!isOptionalNullOr(entry["voice"], (x) => isBoundedString(x, PLAYER_DATA_LIMITS.maxNameLength))) {
      return `${where}: a backlog entry's voice is malformed`;
    }
    if (!isOptionalNullOr(entry["voiceFile"], (x) => isBoundedString(x, PLAYER_DATA_LIMITS.maxNameLength))) {
      return `${where}: a backlog entry's voice file is malformed`;
    }
  }
  return null;
}

function validateStoredProgress(progress: unknown, gameId: string): string | null {
  if (progress === undefined) return null;
  if (!isPlainObject(progress)) return "the file's progress block is not an object";
  if (progress["format"] !== PERSISTENT_STATE_FORMAT) {
    return `the file's progress block has format "${String(progress["format"])}"`;
  }
  if (progress["version"] !== PERSISTENT_STATE_VERSION) {
    return `unsupported progress version ${String(progress["version"])}`;
  }
  if (progress["gameId"] !== gameId) return `the file's progress is for "${String(progress["gameId"])}"`;
  if (!isNumberPairs(progress["vars"], PLAYER_DATA_LIMITS.maxVars)) return "the file's progress variables are malformed";
  return null;
}

function validateStoredCompletion(completion: unknown): string | null {
  if (completion === undefined) return null;
  if (!isPlainObject(completion)) return "the file's completion block is not an object";
  if (completion["version"] !== 1) return `unsupported completion version ${String(completion["version"])}`;
  for (const field of ["visitedScenes", "visitedChoices", "endings", "discoveredAssets"] as const) {
    const list = completion[field];
    if (!Array.isArray(list)) return `the file's completion is missing ${field}`;
    if (list.length > PLAYER_DATA_LIMITS.maxCompletionEntries) return `the file's ${field} is too large`;
    if (!list.every((e) => isBoundedString(e, 256))) return `the file's ${field} contains something that is not a name`;
  }
  return null;
}

/**
 * Validate a parsed file before anything is written.
 *
 * This is user-supplied input that lands directly in storage, so every field
 * the player would rely on is checked here rather than trusted: a malformed
 * file must be refused whole, never applied halfway. Returns a reason string,
 * or null when the document is safe to import.
 */
export function validatePlayerData(data: unknown, expectedGameId: string): string | null {
  if (!isPlainObject(data)) return "not a player-data file";
  const d = data as Partial<PlayerDataExport>;
  if (d.format !== PLAYER_DATA_FORMAT) return `not a player-data file (format "${String(d.format)}")`;
  if (d.version !== PLAYER_DATA_VERSION) return `unsupported player-data version ${String(d.version)}`;
  if (d.gameId !== expectedGameId) return `this file is for "${String(d.gameId)}", not "${expectedGameId}"`;
  if (!Array.isArray(d.slots)) return "the file carries no save slots";
  if (d.slots.length > PLAYER_DATA_LIMITS.maxSlots) return `the file carries ${d.slots.length} slots, which is too many`;

  const seen = new Set<string>();
  for (const s of d.slots) {
    if (!isPlainObject(s)) return "a save slot in the file is malformed";
    const slot = s["slot"];
    if (!isBoundedString(slot, PLAYER_DATA_LIMITS.maxSlotNameLength) || slot.length === 0) {
      return "a save slot in the file has no usable name";
    }
    if (seen.has(slot)) return `the file lists slot "${slot}" twice`;
    seen.add(slot);
    const meta = s["meta"];
    if (meta !== undefined) {
      if (!isPlainObject(meta)) return `slot "${slot}": its metadata is malformed`;
      if (meta["label"] !== undefined && !isBoundedString(meta["label"], PLAYER_DATA_LIMITS.maxLabelLength)) {
        return `slot "${slot}": its label is malformed`;
      }
      if (meta["savedAt"] !== undefined && (typeof meta["savedAt"] !== "number" || !Number.isFinite(meta["savedAt"]))) {
        return `slot "${slot}": its timestamp is malformed`;
      }
      if (meta["thumb"] !== undefined && !isBoundedString(meta["thumb"], PLAYER_DATA_LIMITS.maxThumbLength)) {
        return `slot "${slot}": its thumbnail is malformed or too large`;
      }
    }
    const problem = validateSessionSave(s["save"], `slot "${slot}"`);
    if (problem) return problem;
  }

  if (d.config !== undefined && !isPlainObject(d.config)) return "the file's settings block is not an object";
  const progressProblem = validateStoredProgress(d.progress, expectedGameId);
  if (progressProblem) return progressProblem;
  const completionProblem = validateStoredCompletion(d.completion);
  if (completionProblem) return completionProblem;
  return null;
}

export function summarizePlayerData(data: PlayerDataExport): PlayerDataSummary {
  return {
    slots: data.slots.length,
    hasConfig: data.config !== undefined,
    hasProgress: data.progress !== undefined,
    hasCompletion: data.completion !== undefined,
    exportedAt: data.exportedAt,
    gameId: data.gameId,
  };
}
