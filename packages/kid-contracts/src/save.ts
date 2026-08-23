/**
 * Save-file contract: the serializable session state and its metadata.
 *
 * The format id "e17vn-save" predates the engine extraction and is kept
 * verbatim so every save written by earlier phases keeps loading. It names the
 * format, not the game; the payload itself is game-independent.
 */
import type { LayerState, PresentationAction } from "./presentation.js";

export const SAVE_FORMAT = "e17vn-save";
export const SAVE_VERSION = 1;

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
    /** Full-screen CG, when one is showing. Absent in saves written before it. */
    cg?: LayerState | null;
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
