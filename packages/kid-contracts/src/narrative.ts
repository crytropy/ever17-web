/**
 * Narrative progress catalog: how a player-facing surface names where the
 * story is, instead of showing scene ids and line numbers.
 *
 * The catalog is generated during import from labels the game itself carries
 * (its debug/menu scripts name every chapter), so the strings are the
 * original author's, not invented. It lives inside the generated package,
 * which is derived from copyrighted material and never committed.
 *
 * Generic shape only: no game decides anything here. An adapter fills it in.
 */

export const NARRATIVE_CATALOG_FORMAT = "kid-narrative-catalog";
export const NARRATIVE_CATALOG_VERSION = 1;

/** What kind of moment a scene is, for presentation. */
export type SceneProgressKind = "opening" | "chapter" | "epilogue" | "ending" | "badEnd" | "other";

export interface SceneProgressLabel {
  /** Short, player-facing name, e.g. a viewpoint and day. */
  shortLabel: string;
  kind: SceneProgressKind;
  /**
   * Perspective the chapter is told from, as a stable id into `viewpoints`.
   * Ids are never built from display names: those are localized and change.
   */
  viewpointId?: string;
  /** Display name of that perspective (denormalized for convenience). */
  viewpoint?: string;
  /** Route this scene belongs to: a stable id into `routes`. */
  routeId?: string;
  /** In-story day number, when the source labels one. */
  day?: number;
  /**
   * The author's own sub-division of a day (A/B/C...). Normally hidden: it is
   * a scripting detail, not something a player tracks.
   */
  internalSegment?: string;
}

export interface RouteProgressDefinition {
  /** Stable id, e.g. "common-takeshi"; never derived from a display name. */
  id: string;
  /** Player-facing route name. */
  name: string;
  /** Stable id of the viewpoint this route is told from. */
  viewpointId?: string;
  /** Display name of that viewpoint. */
  viewpoint?: string;
  /** True for the shared opening chapters rather than a character's route. */
  common?: boolean;
  /** Routes that must be finished before this one becomes reachable. */
  requires?: string[];
  /** Presentation order within its viewpoint. */
  order?: number;
}

export interface EndingProgressDefinition {
  /** Stable id; matches what completion tracking records when possible. */
  id: string;
  /** Player-facing name, revealed only once collected. */
  name: string;
  routeId?: string;
  /** Additional ids that mean this ending (movie codes, scene names). */
  aliases?: string[];
  /** Presentation order in the records screen. */
  order?: number;
}

/** A perspective the story is told from. */
export interface ViewpointDefinition {
  id: string;
  name: string;
  order?: number;
}

export interface NarrativeProgressCatalog {
  format: typeof NARRATIVE_CATALOG_FORMAT;
  version: typeof NARRATIVE_CATALOG_VERSION;
  gameId: string;
  /** Perspectives, in presentation order. */
  viewpoints?: ViewpointDefinition[];
  /** Label for a scene with no entry at all. */
  fallbackLabel: string;
  /** Scene name (lowercase) -> label. */
  scenes: Record<string, SceneProgressLabel>;
  routes: RouteProgressDefinition[];
  endings: EndingProgressDefinition[];
  /** Where the labels came from, for diagnostics. */
  derivedFrom?: string;
}

/** The label for a scene, or a neutral fallback - never a raw identifier. */
export function labelForScene(
  catalog: NarrativeProgressCatalog | null,
  scene: string | null | undefined,
): SceneProgressLabel {
  const fallback: SceneProgressLabel = {
    shortLabel: catalog?.fallbackLabel ?? "…",
    kind: "other",
  };
  if (!catalog || !scene) return fallback;
  return catalog.scenes[scene.toLowerCase()] ?? fallback;
}

/** Resolve a recorded ending id (or alias) to its definition. */
export function endingById(
  catalog: NarrativeProgressCatalog | null,
  id: string,
): EndingProgressDefinition | null {
  if (!catalog) return null;
  const needle = id.toLowerCase();
  return (
    catalog.endings.find(
      (e) => e.id.toLowerCase() === needle || (e.aliases ?? []).some((a) => a.toLowerCase() === needle),
    ) ?? null
  );
}
