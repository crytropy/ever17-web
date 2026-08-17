/**
 * Runtime-facing view of the scenario. These types describe only what the
 * runtime consumes: the IR JSON emitted by e17-parser and the asset manifest
 * emitted by e17-assets. Nothing here knows about SC3, LNK, CPS or WAF.
 */
import type { IrScene, IrOp, IrBlock, IrCondition } from "e17-parser";
import type { AssetManifest, ManifestEntry } from "e17-assets";

export type { IrScene, IrOp, IrBlock, IrCondition, AssetManifest, ManifestEntry };

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

/** Everything the presentation layer needs to draw one moment of the story. */
export interface SceneState {
  background: LayerState | null;
  sprites: Map<number, LayerState>;
  bgm: string | null;
  /** Screen fill applied instead of a background (colour index from the IR). */
  fill: number | null;
}

export interface DialogueEvent {
  type: "dialogue";
  speaker: string | null;
  text: string;
  voice: string | null;
  voiceFile: string | null;
  state: SceneStateSnapshot;
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
}

export interface SceneEndEvent {
  type: "end";
  reason: "gotoScene" | "terminated" | "stepLimit";
  nextScene?: string;
}

export type PlayerEvent = DialogueEvent | ChoiceEvent | SceneEndEvent;

/** Immutable copy of SceneState for event consumers. */
export interface SceneStateSnapshot {
  background: LayerState | null;
  sprites: LayerState[];
  bgm: string | null;
  fill: number | null;
  block: string;
}
