/**
 * The player-facing records screen.
 *
 * A visual novel's record page shows where you have been, not how the game is
 * wired: no scene ids, no graph, no line counts, and above all nothing you
 * have not reached yet. The full technical route graph still exists for
 * development, behind /debug/routes.
 *
 * Disclosure rules, all driven by what completion tracking actually saw:
 *   - a viewpoint appears once a chapter told from it has been visited;
 *   - a route appears once the player has been inside it;
 *   - a day appears once visited;
 *   - an ending appears only once collected, and unreached ones are not
 *     listed at all - a row of locked placeholders would count the endings
 *     out for a player who has not agreed to know how many there are;
 *   - a route the player has never entered is never named, so a later,
 *     unlocked route cannot be spoiled by the imported data containing it.
 *
 * Rules and rendering only, with no page bootstrap: the game imports this to
 * draw the same screen as an in-game overlay, because navigating to /records
 * from a running session would end the run. The standalone page's entry point
 * is `records-page.ts`.
 */
import {
  labelForScene,
  endingById,
  type EndingProgressDefinition,
  type NarrativeProgressCatalog,
  type SceneProgressLabel,
} from "kid-contracts";

const el = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export interface DiscoveredRoute {
  /** Stable route id from the catalog. */
  routeId: string;
  name: string;
  /** Visited days, ascending; empty when the route has no day structure. */
  days: number[];
  /** Visited chapters with no day of their own (epilogues, the finale). */
  extras: string[];
  order: number;
}

export interface DiscoveredViewpoint {
  /** Stable viewpoint id, or "" for chapters that belong to no viewpoint. */
  viewpointId: string;
  name: string;
  routes: DiscoveredRoute[];
}

/**
 * Group the scenes a player has actually visited into viewpoints and routes.
 *
 * This is the disclosure rule: only visited scenes contribute, and a scene
 * with no chapter name (a system or developer script) contributes nothing. A
 * route the player has never entered therefore cannot appear, however much
 * the imported catalog knows about it.
 *
 * Exported and pure so the rule itself can be tested, rather than a
 * re-implementation of it.
 */
export function groupDiscoveredChapters(
  catalog: NarrativeProgressCatalog,
  visited: Iterable<string>,
): DiscoveredViewpoint[] {
  const byViewpoint = new Map<string, DiscoveredViewpoint>();
  const routeOf = new Map(catalog.routes.map((r) => [r.id, r]));
  const viewpointName = new Map((catalog.viewpoints ?? []).map((v) => [v.id, v.name]));

  for (const scene of visited) {
    const label: SceneProgressLabel | undefined = catalog.scenes[scene.toLowerCase()];
    if (!label || label.kind === "other") continue;

    const viewpointId = label.viewpointId ?? "";
    // Chapters that belong to no viewpoint and no route (the opening, the
    // finale) each stand on their own row rather than sharing one.
    const routeId = label.routeId ?? (viewpointId ? `${viewpointId}-unknown` : label.shortLabel);
    const routeName = routeOf.get(routeId)?.name ?? label.shortLabel;

    let group = byViewpoint.get(viewpointId);
    if (!group) {
      byViewpoint.set(viewpointId, (group = {
        viewpointId,
        name: viewpointName.get(viewpointId) ?? label.viewpoint ?? "",
        routes: [],
      }));
    }
    let route = group.routes.find((r) => r.routeId === routeId);
    if (!route) {
      route = { routeId, name: routeName, days: [], extras: [], order: group.routes.length };
      group.routes.push(route);
    }
    if (label.day !== undefined) {
      if (!route.days.includes(label.day)) route.days.push(label.day);
    } else if (label.shortLabel !== route.name && !route.extras.includes(label.shortLabel)) {
      route.extras.push(label.shortLabel);
    }
  }

  const groups = [...byViewpoint.values()];
  for (const g of groups) {
    g.routes.sort((a, b) => a.order - b.order);
    for (const r of g.routes) r.days.sort((a, b) => a - b);
  }
  return groups;
}

/**
 * Resolve one canonical ending from a route that is known to have completed.
 *
 * Unlike the records screen's cross-run visited-scene recovery, this is only
 * called after GameSession has emitted a real ending. That makes an epilogue
 * safe evidence for a GOOD ending without crediting a player who merely
 * entered an epilogue and quit before the run finished.
 */
export function endingForCompletedRoute(
  catalog: NarrativeProgressCatalog,
  route: Iterable<string>,
): EndingProgressDefinition | null {
  const scenes = [...route].map((scene) => scene.toLowerCase());

  for (let i = scenes.length - 1; i >= 0; i -= 1) {
    const scene = scenes[i]!;
    const label = catalog.scenes[scene];
    if (!label) continue;

    if (label.kind === "badEnd") {
      // Viewpoint-only bad-end scenes may be aliases of a canonical shared
      // ending (Ever17's Takeshi-side Tsugumi/Sora bad end).
      const byScene = endingById(catalog, scene);
      if (byScene) return byScene;

      if (label.routeId) {
        const ending = catalog.endings.find(
          (e) =>
            e.routeId === label.routeId &&
            e.id.toLowerCase().endsWith("-bad"),
        );
        if (ending) return ending;
      }

      if (label.shortLabel !== catalog.fallbackLabel) {
        return { id: scene, name: label.shortLabel };
      }
    }

    if (label.kind === "epilogue" && label.routeId) {
      const ending = catalog.endings.find(
        (e) =>
          e.routeId === label.routeId &&
          e.id.toLowerCase().endsWith("-good"),
      );
      if (ending) return ending;
    }
  }

  return null;
}

/** What the records screen may say about endings. */
export interface EndingsView {
  /** Endings actually reached, in the roster's order. */
  found: EndingCard[];
  /** True while the roster still holds something unreached - never how many. */
  more: boolean;
}

export interface EndingCard {
  /** Present only once collected; a locked card carries no name. */
  name: string | null;
  collected: boolean;
  endingId?: string;
}

/**
 * What to show under "endings": the ones actually reached, in the roster's
 * order, plus anything collected that the roster never listed.
 *
 * The roster's size is deliberately not part of the answer. A locked card per
 * unreached ending is a count, and a count is the shape of the story - how
 * many routes there are to find, and how far from done you are. `more` says
 * only whether anything remains.
 */
	export function endingsFor(
  catalog: NarrativeProgressCatalog,
  collected: Iterable<string>,
  visited: Iterable<string> = [],
  discoveredAssets: Iterable<string> = [],
): EndingsView {
  const collectedIds = [...collected];

  // 已經直接以正式 ending id / alias 記錄的結局。
  const resolved = new Set(
    collectedIds
      .map((id) => endingById(catalog, id)?.id)
      .filter((id): id is string => id !== undefined),
  );

  // 舊版可能只記下 Y_ED#... 這類技術 id。
  // 已實際播放過的結局 movie 是可靠證據。
  const assets = new Set(
    [...discoveredAssets].map((a) => a.toLowerCase()),
  );

  for (const ending of catalog.endings) {
    if (
      (ending.aliases ?? []).some((alias) =>
        assets.has(alias.toLowerCase()),
      )
    ) {
      resolved.add(ending.id);
    }
  }

  // 沒有專屬 movie 的 bad end，
  // 由玩家真正走過的 badEnd 場景還原。
  const visitedScenes = new Set(
    [...visited].map((scene) => scene.toLowerCase()),
  );

  const standaloneBadEnds = new Map<string, string>();

  for (const scene of visitedScenes) {
    const label = catalog.scenes[scene];
    if (!label || label.kind !== "badEnd") continue;

    if (!label.routeId) {
      const canonical = endingById(catalog, scene);
      if (canonical) {
        resolved.add(canonical.id);
      } else if (label.shortLabel !== catalog.fallbackLabel) {
        standaloneBadEnds.set(scene, label.shortLabel);
      }
      continue;
    }

    const ending = catalog.endings.find(
      (e) =>
        e.routeId === label.routeId &&
        e.id.toLowerCase().endsWith("-bad"),
    );

    if (ending) resolved.add(ending.id);
  }

  const found: EndingCard[] = catalog.endings
    .filter((e) => resolved.has(e.id))
    .map((e) => ({
      name: e.name,
      collected: true,
      endingId: e.id,
    }));

  // A bad-end chapter can be official player-facing data even when the
  // developer ending roster gives it no route id. Keep it as its own ending
  // instead of discarding it or exposing an internal Y_ED#... id.
  for (const [scene, name] of standaloneBadEnds) {
    found.push({
      name,
      collected: true,
      endingId: scene,
    });
  }

  const alreadyFound = new Set(
    found
      .map((card) => card.endingId?.toLowerCase())
      .filter((id): id is string => id !== undefined),
  );

  // 舊技術 id（例如 Y_ED#11）不再產生假的「結局」卡。
  for (const id of collectedIds) {
    if (endingById(catalog, id)) continue;
    if (alreadyFound.has(id.toLowerCase())) continue;

    const label = labelForScene(catalog, id);
    if (label.shortLabel === catalog.fallbackLabel) continue;

    found.push({
      name: label.shortLabel,
      collected: true,
      endingId: id,
    });
  }

  return {
    found,
    more: catalog.endings.some((e) => !resolved.has(e.id)),
  };
}

/**
 * Draw the whole records screen into a container.
 *
 * Shared by the standalone `/records` page and the in-game overlay, so the
 * two can never drift apart - and so opening records from a running game
 * needs no navigation, which would throw the session away.
 */
export function renderRecordsInto(
  content: HTMLElement,
  catalog: NarrativeProgressCatalog | null,
  visited: ReadonlySet<string>,
  collected: ReadonlySet<string>,
  discoveredAssets: ReadonlySet<string>,
): void {
  content.replaceChildren();
  if (!catalog) {
    content.appendChild(el("p", "empty", "这个游戏没有提供章节名称。"));
    return;
  }
  renderChapters(content, catalog, visited);
  renderEndings(content, catalog, collected, visited, discoveredAssets);
}

function renderChapters(
  content: HTMLElement,
  catalog: NarrativeProgressCatalog,
  visited: ReadonlySet<string>,
): void {
  content.appendChild(el("h2", undefined, "篇章"));
  const groups = groupDiscoveredChapters(catalog, visited);
  if (groups.length === 0) {
    content.appendChild(el("p", "empty", "还没有可记录的进度。开始新游戏后，走过的篇章会出现在这里。"));
    return;
  }
  for (const group of groups) {
    const section = el("section", "viewpoint");
    section.appendChild(el("div", "name", group.name || "　"));
    for (const route of group.routes) {
      const row = el("div", "route");
      row.appendChild(el("span", "rname", route.name));
      const days = el("div", "days");
      for (const d of route.days) days.appendChild(el("span", "day", `第${d}日`));
      for (const extra of route.extras) {
        days.appendChild(el("span", "day", extra.split(" · ").slice(-1)[0]!));
      }
      row.appendChild(days);
      section.appendChild(row);
    }
    content.appendChild(section);
  }
}

function renderEndings(
  content: HTMLElement,
  catalog: NarrativeProgressCatalog,
  collected: ReadonlySet<string>,
  visited: ReadonlySet<string>,
  discoveredAssets: ReadonlySet<string>,
): void {
  content.appendChild(el("h2", undefined, "结局"));
  const view = endingsFor(catalog, collected, visited, discoveredAssets);
  if (view.found.length === 0) {
    content.appendChild(el("p", "empty", "还没有收录任何结局。"));
    return;
  }
  const cards = el("div", "cards");
  for (const card of view.found) {
    const node = el("div", "card");
    node.tabIndex = 0;
    node.appendChild(el("div", "title", card.name ?? "结局"));
    node.appendChild(el("div", "meta", "已收录"));
    cards.appendChild(node);
  }
  content.appendChild(cards);
  // Whether anything remains, never how much: a count is the shape of the
  // story, and a player who has seen one ending has not agreed to know how
  // many more there are.
  content.appendChild(el("p", "empty", view.more ? "还有尚未发现的结局。" : "已收录全部结局。"));
}
