/**
 * Rewind points: how the player gets back to a line they can still see in the
 * backlog.
 *
 * A saved VM state alone is not enough to reproduce a moment. Ending
 * recognition is decided partly by *host* state - which movies have played -
 * so a rewind that restored only the VM would either forget evidence the run
 * had legitimately accumulated, or keep evidence from a future the player
 * just abandoned. Both change which ending the run is credited with. A
 * rewind point therefore carries the whole timeline, not just the save.
 *
 * What is deliberately NOT here: completion tracking (chapters and assets
 * seen) and cross-playthrough progress. Those are monotonic records of what a
 * person has actually witnessed - unseeing is not a thing - and route clears
 * are credited only when a run reaches a real ending, never on a save or a
 * rewind. See `runCountsAsCompletion`.
 */
import type { SessionSave } from "kid-contracts";

export interface RewindPoint {
  /** VM state at the moment the line was presented. */
  save: SessionSave;
  /** Every movie played in this run up to and including that line. */
  moviesPlayed: string[];
  /** Movies played since the last choice, as of that line. */
  moviesSinceChoice: string[];
}

/**
 * Rewind points held by line ordinal.
 *
 * Keyed by the session's own line ordinal rather than by backlog index: the
 * backlog trims from the front once full, which silently shifts every index,
 * while an ordinal keeps meaning the same line for the life of the session.
 */
export class RewindLog {
  private readonly points = new Map<number, RewindPoint>();

  /** Points currently held. Bounded by the backlog through `trim`. */
  get size(): number {
    return this.points.size;
  }

  /**
   * Remember a line. Re-noting the same ordinal overwrites: a restored moment
   * is re-presented without being re-logged, so the same line is noted twice
   * and the second is an equivalent no-op.
   */
  note(ordinal: number, point: RewindPoint): void {
    this.points.set(ordinal, point);
  }

  /** Forget lines the backlog no longer holds. Returns how many were dropped. */
  trim(oldestOrdinal: number): number {
    let dropped = 0;
    for (const key of [...this.points.keys()]) {
      if (key < oldestOrdinal) {
        this.points.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  has(ordinal: number): boolean {
    return this.points.has(ordinal);
  }

  get(ordinal: number): RewindPoint | undefined {
    return this.points.get(ordinal);
  }

  /** A restored session's history starts over: nothing before it is reachable. */
  clear(): void {
    this.points.clear();
  }

  /** Ordinals held, ascending. For tests and diagnostics. */
  ordinals(): number[] {
    return [...this.points.keys()].sort((a, b) => a - b);
  }
}

/**
 * Line ordinal of backlog entry `index`.
 *
 * `lines` counts every line the session has logged; the backlog holds the
 * last `backlogLength` of them, so entry 0 is the line `backlogLength` back.
 */
export function backlogOrdinal(lines: number, backlogLength: number, index: number): number {
  return lines - backlogLength + index;
}

/** Oldest ordinal the backlog still holds - everything before it is gone. */
export function oldestBacklogOrdinal(lines: number, backlogLength: number): number {
  return lines - backlogLength;
}

/**
 * Host-side state that is part of a moment but lives outside the VM.
 *
 * Currently the movie evidence that ending recognition consults. It is kept
 * as a named type rather than two loose fields so that anything added here
 * later is forced through the same capture/restore pair.
 */
export interface Timeline {
  /** Every movie played in this run. Order-insensitive evidence. */
  moviesPlayed: Set<string>;
  /** Movies played since the last choice, oldest first. */
  moviesSinceChoice: string[];
}

/** Snapshot the live timeline, detached from the caller's own collections. */
export function captureTimeline(live: Timeline): Pick<RewindPoint, "moviesPlayed" | "moviesSinceChoice"> {
  return {
    moviesPlayed: [...live.moviesPlayed],
    moviesSinceChoice: [...live.moviesSinceChoice],
  };
}

/**
 * The timeline a resumed session should run with.
 *
 * With a rewind point: exactly what the run had accumulated by that line, so
 * evidence earned before it survives and everything after it is gone.
 *
 * Without one - loading a save file - empty: a save records the VM, not which
 * movies a past session happened to play, so inventing evidence for it would
 * be worse than starting the record clean.
 */
export function timelineFor(point: RewindPoint | undefined): Timeline {
  return {
    moviesPlayed: new Set(point?.moviesPlayed ?? []),
    moviesSinceChoice: [...(point?.moviesSinceChoice ?? [])],
  };
}
