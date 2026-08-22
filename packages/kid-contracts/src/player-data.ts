/**
 * Player-data transfer: everything a person would be sad to lose, in one
 * file they can keep, move to another browser, or restore after clearing
 * site data.
 *
 * Browser storage is easy to wipe by accident, so this is deliberately a
 * plain, versioned JSON document rather than an opaque blob - it carries
 * saves, settings and cross-run progress, and nothing derived from the game
 * itself (no story text, no assets).
 */
import { PERSISTENT_STATE_FORMAT, PERSISTENT_STATE_VERSION, type PersistentState } from "./persistence.js";
import type { SessionSave } from "./save.js";

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
  maxSlots: 64,
  maxSlotNameLength: 32,
  maxLabelLength: 200,
  maxBacklogEntries: 5000,
  maxVars: 5000,
  maxCompletionEntries: 200_000,
  maxStringLength: 4000,
  /** Thumbnails are data URLs; anything larger is not a thumbnail. */
  maxThumbLength: 2_000_000,
} as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isBoundedString = (v: unknown, max: number = PLAYER_DATA_LIMITS.maxStringLength): v is string =>
  typeof v === "string" && v.length <= max;

const isNumberPairs = (v: unknown, max: number): boolean =>
  Array.isArray(v) &&
  v.length <= max &&
  v.every(
    (e) =>
      Array.isArray(e) &&
      e.length === 2 &&
      typeof e[0] === "number" &&
      Number.isFinite(e[0]) &&
      typeof e[1] === "number" &&
      Number.isFinite(e[1]),
  );

/** One save file, checked deeply enough that the runtime can load it. */
function validateSessionSave(save: unknown, where: string): string | null {
  if (!isPlainObject(save)) return `${where}: the save is not an object`;
  if (save["format"] !== "e17vn-save") return `${where}: unexpected save format "${String(save["format"])}"`;
  if (save["version"] !== 1) return `${where}: unsupported save version ${String(save["version"])}`;
  const vm = save["vm"];
  if (!isPlainObject(vm)) return `${where}: the save has no VM state`;
  if (!isBoundedString(vm["scene"], 128) || vm["scene"].length === 0) return `${where}: the save names no scene`;
  if (!isBoundedString(vm["block"], 128)) return `${where}: the save has no block`;
  if (typeof vm["pc"] !== "number" || !Number.isFinite(vm["pc"])) return `${where}: the save has no position`;
  if (!isPlainObject(vm["presentation"])) return `${where}: the save has no presentation state`;
  if (!isNumberPairs(save["vars"], PLAYER_DATA_LIMITS.maxVars)) return `${where}: the save's variables are malformed`;
  if (!isNumberPairs(save["sysVars"], PLAYER_DATA_LIMITS.maxVars)) {
    return `${where}: the save's system variables are malformed`;
  }
  if (!isPlainObject(save["counters"])) return `${where}: the save has no counters`;
  if (!Array.isArray(save["route"]) || !save["route"].every((s) => isBoundedString(s, 128))) {
    return `${where}: the save's route is malformed`;
  }
  const backlog = save["backlog"];
  if (!Array.isArray(backlog) || backlog.length > PLAYER_DATA_LIMITS.maxBacklogEntries) {
    return `${where}: the save's backlog is malformed or too large`;
  }
  for (const entry of backlog) {
    if (!isPlainObject(entry) || !isBoundedString(entry["text"] ?? "")) {
      return `${where}: a backlog entry is malformed`;
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
