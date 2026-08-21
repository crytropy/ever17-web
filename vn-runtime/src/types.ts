/**
 * Runtime-facing view of the scenario. These types describe only what the
 * runtime consumes: the IR JSON emitted by e17-parser and the asset manifest
 * emitted by e17-assets. Nothing here knows about SC3, LNK, CPS or WAF.
 */
import type { IrScene, IrOp, IrBlock, IrCondition } from "e17-parser/ir";

export type { IrScene, IrOp, IrBlock, IrCondition };

/**
 * The manifest contract emitted by e17-assets (manifest.json). Declared here
 * rather than imported so the runtime - including its browser build - depends
 * only on the JSON shapes, never on the decoder packages.
 */
export interface ManifestEntry {
  name: string;
  kind: "image" | "audio";
  archive: string;
  /** Path of the converted file, relative to the manifest. */
  file: string;
  width?: number;
  height?: number;
  hasAlpha?: boolean;
  baseLeftOffset?: number;
  channels?: number;
  sampleRate?: number;
  duration?: number;
}

export interface AssetManifest {
  assets: Record<string, ManifestEntry>;
  missing: string[];
  generatedFrom: string[];
}

/**
 * The minimal, environment-agnostic view of an extracted asset set that the
 * VM needs. Implemented by AssetResolver (Node) and by the web client
 * (fetch-based); keeping the VM against this interface keeps it browser-safe.
 */
export interface AssetIndex {
  get(name: string | null | undefined): ManifestEntry | undefined;
  /** Manifest-relative path of the converted file, or null. */
  relative(name: string | null | undefined): string | null;
}

/**
 * Presentation delta accumulated between two presented events. The renderer
 * consumes these as the transition script and `SceneStateSnapshot` as the
 * truth to settle on (skipping = jump straight to the state). Pure data:
 * JSON-safe, environment-agnostic, and included in saves so a restored
 * session re-presents its moment with identical actions.
 */
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

/** Immutable copy of SceneState for event consumers. */
export interface SceneStateSnapshot {
  background: LayerState | null;
  sprites: LayerState[];
  bgm: string | null;
  fill: number | null;
  block: string;
}
