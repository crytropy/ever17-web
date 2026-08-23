/**
 * Save-file contract: the serializable session state and its metadata.
 *
 * The format id "e17vn-save" predates the engine extraction and is kept
 * verbatim so every save written by earlier phases keeps loading. It names the
 * format, not the game; the payload itself is game-independent.
 */
import type { LayerState, PresentationAction } from "./presentation.js";

export const SAVE_FORMAT = "e17vn-save";

/**
 * Current save version.
 *
 * v2 added the full-screen CG to the recorded picture. v1 did not record it at
 * all, which is a real difference in meaning rather than a missing default: a
 * v1 save cannot say whether a CG was showing, so v1 data reaches the runtime
 * only through `migrateSave`, never directly.
 */
export const SAVE_VERSION = 2;
/** Versions a migration can accept. Anything else is refused outright. */
export const SUPPORTED_SAVE_VERSIONS: readonly number[] = [1, 2];

/**
 * Serializable snapshot of one SceneVm, taken at an event boundary: restoring
 * it re-presents the same event with the same presentation state, and the
 * continuation is identical to an uninterrupted run (pinned by tests).
 */
export interface VmSaveState {
  scene: string;
  /** Block/op index of the op that produced the currently presented event. */
  block: string;
  pc: number;
  steps: number;
  presentation: {
    background: LayerState | null;
    /**
     * Full-screen CG over the background and fill, or null when the picture
     * had none. Required at v2: `null` means "proven absent", which is what a
     * v1 save could not express.
     */
    cg: LayerState | null;
    sprites: [number, LayerState][];
    bgm: string | null;
    fill: number | null;
  };
  /** Presentation deltas of the presented event (re-attached on resume). */
  actions?: PresentationAction[];
}

export interface BacklogEntry {
  scene: string;
  speaker: string | null;
  text: string;
  voice: string | null;
  voiceFile: string | null;
}

/** Serializable session state. */
export interface SessionSave {
  format: typeof SAVE_FORMAT;
  version: typeof SAVE_VERSION;
  vm: VmSaveState;
  vars: [number, number][];
  sysVars: [number, number][];
  counters: { lines: number; scenes: number };
  route: string[];
  backlog: BacklogEntry[];
}
