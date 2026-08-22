/**
 * Multi-slot save management over an injected localStorage-compatible store.
 * Slot payloads are the runtime's stable SessionSave (unchanged); this module
 * only adds addressing, metadata and thumbnails around it.
 */
import { SAVE_FORMAT, type SessionSave } from "kid-contracts/save";
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

interface StoredSlot {
  meta: SlotMeta;
  save: SessionSave;
}

export class SaveSlots {
  /** `<prefix>:save:<slot>` payloads, `<prefix>:slots` index. */
  private readonly prefix: string;
  private readonly indexKey: string;
  private readonly legacyKey: string;

  constructor(
    private readonly storage: StorageLike,
    /**
     * Storage prefix for the active play-data generation
     * (PlayDataScope.storagePrefix). For generation 0 this is the game
     * namespace itself, which is why pre-generation saves keep working.
     */
    storagePrefix: string,
  ) {
    this.prefix = `${storagePrefix}:save:`;
    this.indexKey = `${storagePrefix}:slots`;
    this.legacyKey = `${storagePrefix}:slot0`;
    this.migrateLegacy();
  }

  /** Move the phase-4A single slot into manual slot 1, once. */
  private migrateLegacy(): void {
    try {
      const legacy = this.storage.getItem(this.legacyKey);
      if (!legacy) return;
      const parsed = JSON.parse(legacy) as { label?: string; savedAt?: number; save: SessionSave };
      if (parsed?.save?.format === SAVE_FORMAT && !this.storage.getItem(this.prefix + "1")) {
        this.put("1", parsed.save, undefined, parsed.savedAt);
      }
      this.storage.removeItem(this.legacyKey);
    } catch {
      this.storage.removeItem(this.legacyKey);
    }
  }

  private readIndex(): string[] {
    try {
      const raw = this.storage.getItem(this.indexKey);
      const arr = raw ? (JSON.parse(raw) as string[]) : [];
      return Array.isArray(arr) ? arr.filter((s) => ALL_SLOTS.includes(s)) : [];
    } catch {
      return [];
    }
  }

  private writeIndex(slots: string[]): void {
    this.storage.setItem(this.indexKey, JSON.stringify([...new Set(slots)]));
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
      const raw = this.storage.getItem(this.prefix + slot);
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
      this.storage.setItem(this.prefix + slot, JSON.stringify(stored));
    } catch (err) {
      // storage quota: retry without the thumbnail before giving up
      if (thumb) {
        const { thumb: _dropped, ...lean } = meta;
        this.storage.setItem(this.prefix + slot, JSON.stringify({ meta: lean, save }));
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
      const raw = this.storage.getItem(this.prefix + slot);
      if (!raw) return null;
      const stored = JSON.parse(raw) as StoredSlot;
      return stored?.save?.format === SAVE_FORMAT ? stored.save : null;
    } catch {
      return null;
    }
  }

  remove(slot: string): void {
    this.storage.removeItem(this.prefix + slot);
    this.writeIndex(this.readIndex().filter((s) => s !== slot));
  }
}
