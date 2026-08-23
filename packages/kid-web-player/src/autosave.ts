/**
 * When entering a scene should write the autosave.
 *
 * GameSession.restore enters a scene as part of restoring, so the host's
 * onSceneChange hook fires for a scene the player did not travel to. Treated
 * as a real transition it overwrites the autosave with the place they just
 * came back to - so loading a save, or rewinding through the backlog, would
 * quietly destroy the autosave that was the reason to have one.
 *
 * The rule is stated in terms of a per-session counter rather than the
 * route's length, so it cannot be fooled by a save taken deep into a run.
 */

export type SessionStart = "new" | "restore";

/**
 * @param start        how this session began
 * @param sceneChanges how many onSceneChange calls this session has already
 *                     delivered, counting from 0 for the first
 *
 * Policy, for both kinds of start: the first scene entry is where the session
 * begins, not somewhere the player went, and never autosaves.
 *
 *   - new game: index 0 is the opening scene. There is nothing to preserve
 *     yet, and an autosave written there would be indistinguishable from
 *     "New Game" itself.
 *   - restored save, including a backlog rewind: index 0 is restore()
 *     re-entering the saved scene. Loading a manual save deliberately leaves
 *     the autosave alone; it is written again at the next genuine scene
 *     transition, so the autosave keeps tracking where the player actually
 *     got to rather than the last place they loaded.
 */
export function shouldAutosaveOnSceneChange(start: SessionStart, sceneChanges: number): boolean {
  void start; // the rule is currently the same for both; the parameter keeps it explicit
  return sceneChanges > 0;
}

/**
 * The autosave rule with its counter, so the ordering it depends on lives in
 * one place.
 *
 * `begin` MUST be called before the GameSession is constructed. Both
 * GameSession.start and GameSession.restore enter a scene from inside the
 * call that creates them, so their onSceneChange arrives before the
 * constructor has returned. Resetting afterwards numbers that entry as a real
 * transition and then suppresses the next real one in its place - which lost
 * the autosave for a whole scene after every rewind.
 */
export class AutosaveGate {
  private sceneChanges = 0;
  private start: SessionStart = "new";

  /** Arm for a session that is about to be created. */
  begin(start: SessionStart): void {
    this.start = start;
    this.sceneChanges = 0;
  }

  /** Report a scene entry; true when it deserves an autosave. */
  sceneEntered(): boolean {
    return shouldAutosaveOnSceneChange(this.start, this.sceneChanges++);
  }
}
