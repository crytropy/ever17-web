/**
 * Presentation state and runtime events: what the VM tells a front end.
 *
 * Everything here is pure JSON-safe data, environment-agnostic, and included
 * in saves so a restored session re-presents its moment identically. The
 * renderer consumes `PresentationAction[]` as the transition script and
 * `SceneStateSnapshot` as the truth to settle on (skipping = jump straight to
 * the state).
 */

/** A resolved on-screen background or sprite. */
export interface LayerState {
  /** Logical asset name from the scenario. */
  asset: string;
  /** Path of the converted file, relative to the manifest directory. */
  file: string | null;
  width: number | null;
  height: number | null;
  /** Screen-space x of the layer's left edge, when computable. */
  x: number | null;
  slot: number | null;
}

/** Presentation delta accumulated between two presented events. */
export type PresentationAction =
  | { kind: "setBackground"; layer: LayerState; fade: number | null; variant?: string }
  | { kind: "fillScreen"; color: number | null; fade: number | null }
  | { kind: "showSprite"; layer: LayerState; mode: number | null }
  | { kind: "hideSprite"; slot: number | null; mode: number | null }
  | { kind: "spriteOrder"; order: (number | null)[] }
  | { kind: "transitionTime"; frames: number | null; mode: number | null }
  | { kind: "transitionSync" }
  | { kind: "wait"; amount: number | null; unit: "vm" | "frames" }
  | { kind: "effectOn"; effect: number | null }
  | { kind: "effectOff"; category: number | null }
  | { kind: "shake"; mode: number | null; amplitude: number | null }
  | { kind: "viewportRect"; x: number | null; y: number | null; w: number | null; h: number | null; frames: number | null }
  | { kind: "cgEffect"; asset: string | null; file: string | null; args: (number | null)[] };

/** Immutable copy of the VM's scene state at an event boundary. */
/**
 * The camera: which rectangle of the canvas is on screen.
 *
 * Persistent, not a transition. Verified against the scenario data: one
 * viewportRect is followed by four presented lines before the next one, and
 * the way back to the whole canvas is an explicit rect of the canvas size -
 * so a moment saved inside a zoom has to record the zoom, exactly as it has
 * to record the CG.
 *
 * `null` is the whole canvas.
 */
export interface ViewportState {
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
}

export interface SceneStateSnapshot {
  background: LayerState | null;
  /**
   * Full-screen CG shown over the background and any fill.
   *
   * Part of the picture, not a transition: it stays on screen until a
   * background or a fill replaces it. Omitted by builds that predate it, and
   * by events that never showed one - absent and null both mean "no CG".
   */
  cg?: LayerState | null;
  /** Camera rectangle, or null for the whole canvas. */
  viewport?: ViewportState | null;
  sprites: LayerState[];
  bgm: string | null;
  /** Screen fill applied instead of a background (colour index from the IR). */
  fill: number | null;
  block: string;
}

export interface DialogueEvent {
  type: "dialogue";
  speaker: string | null;
  text: string;
  /**
   * Stable source coordinates of this line inside the scene IR. Optional so
   * older/custom PlayerEvent producers remain compatible; the runtime emits
   * both for every scenario dialogue line.
   */
  textIndex?: number;
  segment?: number;
  voice: string | null;
  voiceFile: string | null;
  state: SceneStateSnapshot;
  /** Presentation deltas since the previous event, in execution order. */
  actions: PresentationAction[];
}

export interface ChoiceOptionView {
  index: number;
  text: string;
  target: string | null;
  enabled: boolean;
}

export interface ChoiceEvent {
  type: "choice";
  id: number | null;
  resultVar: number | null;
  options: ChoiceOptionView[];
  state: SceneStateSnapshot;
  /** Presentation deltas since the previous event, in execution order. */
  actions: PresentationAction[];
}

export interface SceneEndEvent {
  type: "end";
  reason: "gotoScene" | "terminated" | "stepLimit";
  nextScene?: string;
}

export type PlayerEvent = DialogueEvent | ChoiceEvent | SceneEndEvent;
