/**
 * Taking a backup, safely, right before the player erases everything.
 *
 * The reset dialog offers "export first". That makes the backup and the
 * destruction of the thing being backed up two steps of one interaction, so
 * the ordering has to be deliberate rather than incidental:
 *
 *   - the document is assembled *synchronously*, before any await. If a yield
 *     came first, the play-data generation could advance underneath and the
 *     file would describe a world that no longer exists - or, worse, an empty
 *     one;
 *   - while a backup is in flight the reset is refused, so the two can never
 *     interleave;
 *   - a second request while one is running is turned away rather than
 *     starting an overlapping export.
 *
 * The caller supplies the two halves; this owns only the ordering and the
 * busy flag, which is what is easy to get wrong and worth testing on its own.
 */

export interface BackupPorts<Doc> {
  /**
   * Assemble the document. MUST be synchronous - it runs before the first
   * yield precisely so the snapshot cannot be overtaken.
   */
  assemble: () => Doc;
  /** Hand the document to the browser. The backup is taken once this settles. */
  deliver: (doc: Doc) => Promise<void> | void;
}

export type BackupOutcome<Doc> =
  | { ok: true; doc: Doc }
  | { ok: false; reason: string; alreadyRunning?: true };

export class PlayerDataBackup<Doc> {
  private busy = false;

  constructor(private readonly ports: BackupPorts<Doc>) {}

  /** True while a backup is being assembled or handed over. */
  get inProgress(): boolean {
    return this.busy;
  }

  async take(): Promise<BackupOutcome<Doc>> {
    if (this.busy) {
      return { ok: false, reason: "a backup is already being written", alreadyRunning: true };
    }
    this.busy = true;
    try {
      // Synchronous on purpose: nothing may yield between here and having the
      // whole document in hand.
      const doc = this.ports.assemble();
      await this.ports.deliver(doc);
      return { ok: true, doc };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    } finally {
      this.busy = false;
    }
  }
}
