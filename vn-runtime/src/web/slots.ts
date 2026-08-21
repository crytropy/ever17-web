/**
 * Multi-slot save management over an injected localStorage-compatible store.
 * Slot payloads are the runtime's stable SessionSave (unchanged); this module
 * only adds addressing, metadata and thumbnails around it.
 */
import { SAVE_FORMAT, type SessionSave } from "../game-session.js";
import type { StorageLike } from "./config.js";

export interface SlotMeta {
  slot: string;
  label: string;
  savedAt: number;
  scene: string;
  lines: number;
  /** Small JPEG data URL captured from the stage at save time. */
  thumb?: string;
}

export const MANUAL_SLOTS = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;
export const AUTO_SLOT = "auto";
export const QUICK_SLOT = "quick";
export const ALL_SLOTS: readonly string[] = [AUTO_SLOT, QUICK_SLOT, ...MANUAL_SLOTS];

const PREFIX = "e17vn:save:";
const INDEX_KEY = "e17vn:slots";
const LEGACY_KEY = "e17vn:slot0";

interface StoredSlot {
  meta: SlotMeta;
  save: SessionSave;
}

export class SaveSlots {
  constructor(private readonly storage: StorageLike) {
    this.migrateLegacy();
  }

  /** Move the phase-4A single slot into manual slot 1, once. */
  private migrateLegacy(): void {
    try {
      const legacy = this.storage.getItem(LEGACY_KEY);
      if (!legacy) return;
      const parsed = JSON.parse(legacy) as { label?: string; savedAt?: number; save: SessionSave };
      if (parsed?.save?.format === SAVE_FORMAT && !this.storage.getItem(PREFIX + "1")) {
        this.put("1", parsed.save, undefined, parsed.savedAt);
      }
      this.storage.removeItem(LEGACY_KEY);
    } catch {
      this.storage.removeItem(LEGACY_KEY);
    }
  }

  private readIndex(): string[] {
    try {
      const raw = this.storage.getItem(INDEX_KEY);
      const arr = raw ? (JSON.parse(raw) as string[]) : [];
      return Array.isArray(arr) ? arr.filter((s) => ALL_SLOTS.includes(s)) : [];
    } catch {
      return [];
    }
  }

  private writeIndex(slots: string[]): void {
    this.storage.setItem(INDEX_KEY, JSON.stringify([...new Set(slots)]));
  }

  /** Metadata of every occupied slot, in ALL_SLOTS order. */
  list(): SlotMeta[] {
    const out: SlotMeta[] = [];
    for (const slot of ALL_SLOTS) {
      const meta = this.peek(slot);
      if (meta) out.push(meta);
    }
    return out;
  }

  peek(slot: string): SlotMeta | null {
    try {
      const raw = this.storage.getItem(PREFIX + slot);
      if (!raw) return null;
      const stored = JSON.parse(raw) as StoredSlot;
      if (stored?.save?.format !== SAVE_FORMAT) return null;
      return stored.meta;
    } catch {
      return null;
    }
  }

  put(slot: string, save: SessionSave, thumb?: string, savedAt?: number): SlotMeta {
    if (!ALL_SLOTS.includes(slot)) throw new Error(`unknown slot "${slot}"`);
    const meta: SlotMeta = {
      slot,
      label: `${save.vm.scene} · line ${save.counters.lines}`,
      savedAt: savedAt ?? Date.now(),
      scene: save.vm.scene,
      lines: save.counters.lines,
      ...(thumb ? { thumb } : {}),
    };
    const stored: StoredSlot = { meta, save };
    try {
      this.storage.setItem(PREFIX + slot, JSON.stringify(stored));
    } catch (err) {
      // storage quota: retry without the thumbnail before giving up
      if (thumb) {
        const { thumb: _dropped, ...lean } = meta;
        this.storage.setItem(PREFIX + slot, JSON.stringify({ meta: lean, save }));
        this.writeIndex([...this.readIndex(), slot]);
        return lean;
      }
      throw err;
    }
    this.writeIndex([...this.readIndex(), slot]);
    return meta;
  }

  get(slot: string): SessionSave | null {
    try {
      const raw = this.storage.getItem(PREFIX + slot);
      if (!raw) return null;
      const stored = JSON.parse(raw) as StoredSlot;
      return stored?.save?.format === SAVE_FORMAT ? stored.save : null;
    } catch {
      return null;
    }
  }

  remove(slot: string): void {
    this.storage.removeItem(PREFIX + slot);
    this.writeIndex(this.readIndex().filter((s) => s !== slot));
  }
}
