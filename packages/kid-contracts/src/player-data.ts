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
import type { PersistentState } from "./persistence.js";
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

/**
 * Validate a parsed file before anything is written. Returns a reason string
 * when the document cannot be trusted, or null when it is safe to import.
 */
export function validatePlayerData(data: unknown, expectedGameId: string): string | null {
  if (typeof data !== "object" || data === null) return "not a player-data file";
  const d = data as Partial<PlayerDataExport>;
  if (d.format !== PLAYER_DATA_FORMAT) return `not a player-data file (format "${String(d.format)}")`;
  if (d.version !== PLAYER_DATA_VERSION) return `unsupported player-data version ${String(d.version)}`;
  if (d.gameId !== expectedGameId) return `this file is for "${String(d.gameId)}", not "${expectedGameId}"`;
  if (!Array.isArray(d.slots)) return "the file carries no save slots";
  for (const s of d.slots) {
    if (typeof s?.slot !== "string" || typeof s?.save !== "object" || s.save === null) {
      return "a save slot in the file is malformed";
    }
  }
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
