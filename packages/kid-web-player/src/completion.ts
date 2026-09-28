/**
 * Persistent completion state: which scenes, dialogue lines, choices, endings
 * and assets the player has seen across every playthrough. Deliberately separate from
 * gameplay saves - loading an old save never rewinds completion - and stored
 * in IndexedDB rather than localStorage (it grows with the asset list).
 *
 * All progress is set-union, so replaying the same content is idempotent.
 */

export interface CompletionState {
  version: 1;
  visitedScenes: string[];
  /**
   * Stable dialogue ids. Optional for compatibility with completion data
   * written before per-line read tracking existed.
   */
  visitedLines?: string[];
  /** "<scene>:<choiceKey>:<option>" - the option actually taken. */
  visitedChoices: string[];
  endings: string[];
  discoveredAssets: string[];
}

export const EMPTY_COMPLETION: CompletionState = {
  version: 1,
  visitedScenes: [],
  visitedLines: [],
  visitedChoices: [],
  endings: [],
  discoveredAssets: [],
};

/** Stable id for one presented scenario line. */
export function dialogueLineId(
  scene: string,
  block: string,
  textIndex: number,
  segment: number,
): string {
  return `${scene.toLowerCase()}:${block.toLowerCase()}:${textIndex}:${segment}`;
}

export interface CompletionStore {
  load(): Promise<CompletionState | null>;
  save(state: CompletionState): Promise<void>;
}

export class MemoryCompletionStore implements CompletionStore {
  private state: CompletionState | null = null;
  load(): Promise<CompletionState | null> {
    return Promise.resolve(this.state ? structuredClone(this.state) : null);
  }
  save(state: CompletionState): Promise<void> {
    this.state = structuredClone(state);
    return Promise.resolve();
  }
}

const DB_STORE = "completion";
const DB_KEY = "v1";

/** IndexedDB-backed store (browser); one database per game namespace. */
export class IdbCompletionStore implements CompletionStore {
  private db: Promise<IDBDatabase> | null = null;
  private readonly dbName: string;

  constructor(
    /** Database name for the active play-data generation
     * (PlayDataScope.completionDb). */
    dbName: string,
  ) {
    this.dbName = dbName;
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error as Error);
    });
    return this.db;
  }

  async load(): Promise<CompletionState | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(DB_KEY);
      req.onsuccess = () => {
        const v = req.result as CompletionState | undefined;
        resolve(v && v.version === 1 ? v : null);
      };
      req.onerror = () => reject(req.error as Error);
    });
  }

  async save(state: CompletionState): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(state, DB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error as Error);
    });
  }
}

/** In-memory sets over a store, with debounced persistence. */
export class CompletionTracker {
  readonly scenes = new Set<string>();
  readonly lines = new Set<string>();
  readonly choices = new Set<string>();
  readonly endings = new Set<string>();
  readonly assets = new Set<string>();
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private constructor(private readonly store: CompletionStore) {}

  static async open(store: CompletionStore): Promise<CompletionTracker> {
    const t = new CompletionTracker(store);
    const state = await store.load().catch(() => null);
    if (state) {
      for (const s of state.visitedScenes) t.scenes.add(s);
      for (const l of state.visitedLines ?? []) t.lines.add(l);
      for (const c of state.visitedChoices) t.choices.add(c);
      for (const e of state.endings) t.endings.add(e);
      for (const a of state.discoveredAssets) t.assets.add(a);
    }
    return t;
  }

  scene(id: string): void {
    this.mark(this.scenes, id.toLowerCase());
  }
  hasLine(id: string): boolean {
    return this.lines.has(id.toLowerCase());
  }
  line(id: string): void {
    this.mark(this.lines, id.toLowerCase());
  }
  choice(scene: string, choiceKey: string | number, option: number): void {
    this.mark(this.choices, `${scene.toLowerCase()}:${choiceKey}:${option}`);
  }
  ending(id: string): void {
    this.mark(this.endings, id.toUpperCase());
  }
  asset(name: string | null | undefined): void {
    if (name) this.mark(this.assets, name.toLowerCase());
  }

  private mark(set: Set<string>, value: string): void {
    if (set.has(value)) return;
    set.add(value);
    this.dirty = true;
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 800);
  }

  /**
   * Fold an external state into this tracker (importing a backup). Progress
   * is a union, so nothing already discovered is lost.
   */
  absorb(state: CompletionState): void {
    for (const s of state.visitedScenes) this.mark(this.scenes, s);
    for (const l of state.visitedLines ?? []) this.mark(this.lines, l);
    for (const c of state.visitedChoices) this.mark(this.choices, c);
    for (const e of state.endings) this.mark(this.endings, e);
    for (const a of state.discoveredAssets) this.mark(this.assets, a);
  }

  snapshot(): CompletionState {
    return {
      version: 1,
      visitedScenes: [...this.scenes].sort(),
      visitedLines: [...this.lines].sort(),
      visitedChoices: [...this.choices].sort(),
      endings: [...this.endings].sort(),
      discoveredAssets: [...this.assets].sort(),
    };
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    await this.store.save(this.snapshot()).catch(() => {
      this.dirty = true; // retry on next mark
    });
  }
}
