/**
 * Runtime-facing view of the scenario. The JSON contracts (scene IR, asset
 * manifest, presentation state, events) are owned by kid-contracts; this
 * module re-exports them and adds the two interfaces the runtime itself
 * defines: AssetIndex (how assets are looked up) and the VM's mutable
 * SceneState. Nothing here knows about SC3, LNK, CPS or WAF.
 */
import type { LayerState } from "kid-contracts/presentation";
import type { ManifestEntry } from "kid-contracts/manifest";

export type { IrScene, IrOp, IrBlock, IrCondition } from "kid-contracts/ir";
export type { AssetManifest, ManifestEntry } from "kid-contracts/manifest";
export type {
  PresentationAction,
  LayerState,
  SceneStateSnapshot,
  DialogueEvent,
  ChoiceOptionView,
  ChoiceEvent,
  SceneEndEvent,
  PlayerEvent,
} from "kid-contracts/presentation";

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

/** Everything the presentation layer needs to draw one moment of the story.
 * The VM's working state; snapshots of it (SceneStateSnapshot) are the
 * JSON-safe contract form. */
export interface SceneState {
  background: LayerState | null;
  sprites: Map<number, LayerState>;
  bgm: string | null;
  /** Screen fill applied instead of a background (colour index from the IR). */
  fill: number | null;
}
