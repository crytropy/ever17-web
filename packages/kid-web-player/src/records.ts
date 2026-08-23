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
 *   - an ending shows its name only once collected, otherwise a locked card;
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

export interface EndingCard {
  /** Present only once collected; a locked card carries no name. */
  name: string | null;
  collected: boolean;
  endingId?: string;
}

/**
 * Ending cards for the records screen: the game's own roster in order, each
 * named only once the player has collected it, plus anything collected that
 * the roster never listed.
 */
export function endingCardsFor(
  catalog: NarrativeProgressCatalog,
  collected: Iterable<string>,
): EndingCard[] {
  const collectedIds = [...collected];
  const resolved = new Set(
    collectedIds.map((id) => endingById(catalog, id)?.id).filter((id): id is string => id !== undefined),
  );
  const cards: EndingCard[] = catalog.endings.map((e) => ({
    name: resolved.has(e.id) ? e.name : null,
    collected: resolved.has(e.id),
    endingId: e.id,
  }));
  for (const id of collectedIds) {
    if (endingById(catalog, id)) continue; // already in the roster
    const label = labelForScene(catalog, id);
    cards.push({
      name: label.shortLabel !== catalog.fallbackLabel ? label.shortLabel : "结局",
      collected: true,
    });
  }
  return cards;
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
): void {
  content.replaceChildren();
  if (!catalog) {
    content.appendChild(el("p", "empty", "这个游戏没有提供章节名称。"));
    return;
  }
  renderChapters(content, catalog, visited);
  renderEndings(content, catalog, collected);
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
): void {
  content.appendChild(el("h2", undefined, "结局"));
  const cards = el("div", "cards");
  for (const card of endingCardsFor(catalog, collected)) {
    const node = el("div", card.collected ? "card" : "card locked");
    node.tabIndex = 0;
    node.appendChild(el("div", "title", card.name ?? "?????"));
    node.appendChild(el("div", "meta", card.collected ? "已收录" : "未收录"));
    cards.appendChild(node);
  }
  content.appendChild(cards);
}
