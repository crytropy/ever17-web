/**
 * Export and import of a player's own data.
 *
 * Collects saves, settings, cross-run progress and completion tracking into
 * one versioned document, and puts them back. Importing is additive by
 * default: a slot in the file replaces that slot, other slots are untouched,
 * and cross-run progress is merged forward so restoring an older backup
 * cannot take away something already unlocked.
 */
import {
  PLAYER_DATA_FORMAT,
  PLAYER_DATA_VERSION,
  mergePersistentState,
  validatePlayerData,
  type ExportedSlot,
  type PersistentState,
  type PersistentStatePolicy,
  type PlayerDataExport,
} from "kid-contracts";
import type { StorageLike } from "./config.js";
import { ALL_SLOTS, SaveSlots } from "./slots.js";
import { PersistentProgress } from "./progress.js";
import type { CompletionState } from "./completion.js";

export interface TransferContext {
  storage: StorageLike;
  ns: string;
  gameId: string;
  policy: PersistentStatePolicy | null;
  engineVersion?: string;
  now?: () => Date;
}

/** Gather everything worth keeping into one document. */
export function buildPlayerDataExport(
  ctx: TransferContext,
  completion: CompletionState | null,
): PlayerDataExport {
  const slots = new SaveSlots(ctx.storage, ctx.ns);
  const exported: ExportedSlot[] = [];
  for (const slot of ALL_SLOTS) {
    const meta = slots.peek(slot);
    const save = slots.get(slot);
    if (meta && save) exported.push({ slot, meta, save });
  }
  const progress = new PersistentProgress(ctx.storage, ctx.ns, ctx.gameId, ctx.policy);
  let config: unknown;
  try {
    const raw = ctx.storage.getItem(`${ctx.ns}:config`);
    config = raw ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    config = undefined;
  }
  return {
    format: PLAYER_DATA_FORMAT,
    version: PLAYER_DATA_VERSION,
    gameId: ctx.gameId,
    exportedAt: (ctx.now?.() ?? new Date()).toISOString(),
    ...(ctx.engineVersion ? { engineVersion: ctx.engineVersion } : {}),
    slots: exported,
    ...(config !== undefined ? { config } : {}),
    ...(ctx.policy ? { progress: progress.snapshot() } : {}),
    ...(completion ? { completion } : {}),
  };
}

export interface ImportOutcome {
  ok: boolean;
  reason?: string;
  slotsRestored: number;
  configRestored: boolean;
  progressMerged: boolean;
  /** Completion to write back, when the file carried any. */
  completion?: CompletionState;
}

/**
 * Apply a player-data document. Storage is written slot by slot, so a
 * malformed entry cannot leave the whole set half-written: the document is
 * fully validated first.
 */
export function applyPlayerDataImport(ctx: TransferContext, data: unknown): ImportOutcome {
  const problem = validatePlayerData(data, ctx.gameId);
  if (problem) return { ok: false, reason: problem, slotsRestored: 0, configRestored: false, progressMerged: false };
  const doc = data as PlayerDataExport;

  const slots = new SaveSlots(ctx.storage, ctx.ns);
  let restored = 0;
  for (const entry of doc.slots) {
    if (!ALL_SLOTS.includes(entry.slot)) continue; // unknown slot names are ignored
    try {
      slots.put(entry.slot, entry.save, entry.meta?.thumb, entry.meta?.savedAt);
      restored += 1;
    } catch {
      /* one unreadable slot must not abort the rest */
    }
  }

  let configRestored = false;
  if (doc.config !== undefined) {
    try {
      ctx.storage.setItem(`${ctx.ns}:config`, JSON.stringify(doc.config));
      configRestored = true;
    } catch {
      configRestored = false;
    }
  }

  let progressMerged = false;
  if (doc.progress && ctx.policy) {
    // merged, never assigned: an older backup cannot revoke an unlock
    const progress = new PersistentProgress(ctx.storage, ctx.ns, ctx.gameId, ctx.policy);
    const incoming: PersistentState = doc.progress;
    const changed = progress.record(incoming.vars);
    progressMerged = changed.length > 0;
  }

  return {
    ok: true,
    slotsRestored: restored,
    configRestored,
    progressMerged,
    ...(isCompletionState(doc.completion) ? { completion: doc.completion } : {}),
  };
}

function isCompletionState(v: unknown): v is CompletionState {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Partial<CompletionState>;
  return (
    c.version === 1 &&
    Array.isArray(c.visitedScenes) &&
    Array.isArray(c.visitedChoices) &&
    Array.isArray(c.endings) &&
    Array.isArray(c.discoveredAssets)
  );
}

/** Union of two completion states: seeing something is never undone. */
export function mergeCompletion(a: CompletionState | null, b: CompletionState): CompletionState {
  const union = (x: string[] = [], y: string[] = []): string[] => [...new Set([...x, ...y])].sort();
  return {
    version: 1,
    visitedScenes: union(a?.visitedScenes, b.visitedScenes),
    visitedChoices: union(a?.visitedChoices, b.visitedChoices),
    endings: union(a?.endings, b.endings),
    discoveredAssets: union(a?.discoveredAssets, b.discoveredAssets),
  };
}

/** Merge stored progress with an incoming state under the policy. */
export function mergeProgressStates(
  policy: PersistentStatePolicy,
  stored: PersistentState,
  incoming: PersistentState,
): PersistentState {
  return mergePersistentState(policy, stored, incoming.vars);
}
