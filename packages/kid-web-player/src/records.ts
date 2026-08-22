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
 */
import {
  labelForScene,
  endingById,
  type GamePackageMeta,
  type NarrativeProgressCatalog,
  type SceneProgressLabel,
} from "kid-contracts";
import { CompletionTracker, IdbCompletionStore } from "./completion.js";
import { SaveSlots } from "./slots.js";

const $ = (id: string): HTMLElement => document.getElementById(id)!;

const el = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

interface DiscoveredRoute {
  routeId: string;
  name: string;
  /** Visited days, ascending; empty when the route has no day structure. */
  days: number[];
  /** Visited chapters with no day (epilogues, endings). */
  extras: string[];
  order: number;
}

/** Group the scenes a player has actually visited into viewpoints and routes. */
function discovered(
  catalog: NarrativeProgressCatalog,
  visited: ReadonlySet<string>,
): Map<string, DiscoveredRoute[]> {
  const byViewpoint = new Map<string, Map<string, DiscoveredRoute>>();
  for (const scene of visited) {
    const label: SceneProgressLabel | undefined = catalog.scenes[scene.toLowerCase()];
    // A visited scene with no chapter name is not story content (system or
    // developer scripts) and never appears here.
    if (!label || label.kind === "other") continue;
    const viewpoint = label.viewpoint ?? "";
    // Chapters that belong to no viewpoint and no route (the opening, the
    // finale) each stand on their own row rather than sharing one.
    const routeId = label.routeId ?? (viewpoint ? "unknown" : label.shortLabel);
    const routeName =
      catalog.routes.find((r) => r.id === routeId || r.id === `${routeId}-${viewpointId(viewpoint)}`)?.name ??
      (label.routeId ? label.shortLabel.split(" · ")[0]! : label.shortLabel);

    let routes = byViewpoint.get(viewpoint);
    if (!routes) byViewpoint.set(viewpoint, (routes = new Map()));
    let route = routes.get(routeId);
    if (!route) {
      routes.set(routeId, (route = { routeId, name: routeName, days: [], extras: [], order: routes.size }));
    }
    if (label.day !== undefined) {
      if (!route.days.includes(label.day)) route.days.push(label.day);
    } else if (label.shortLabel !== route.name && !route.extras.includes(label.shortLabel)) {
      // a chapter with no day of its own (an epilogue, the finale); skip it
      // when it would just repeat the row's own name
      route.extras.push(label.shortLabel);
    }
  }
  const out = new Map<string, DiscoveredRoute[]>();
  for (const [viewpoint, routes] of byViewpoint) {
    const list = [...routes.values()].sort((a, b) => a.order - b.order);
    for (const r of list) r.days.sort((a, b) => a - b);
    out.set(viewpoint, list);
  }
  return out;
}

/** Stable-ish id for a viewpoint display name, for route lookups. */
function viewpointId(name: string): string {
  return name;
}

function renderChapters(
  content: HTMLElement,
  catalog: NarrativeProgressCatalog,
  visited: ReadonlySet<string>,
): void {
  content.appendChild(el("h2", undefined, "篇章"));
  const groups = discovered(catalog, visited);
  if (groups.size === 0) {
    content.appendChild(el("p", "empty", "还没有可记录的进度。开始新游戏后，走过的篇章会出现在这里。"));
    return;
  }
  for (const [viewpoint, routes] of groups) {
    const section = el("section", "viewpoint");
    section.appendChild(el("div", "name", viewpoint || "　"));
    for (const route of routes) {
      const row = el("div", "route");
      row.appendChild(el("span", "rname", route.name));
      const days = el("div", "days");
      for (const d of route.days) days.appendChild(el("span", "day", `第${d}日`));
      for (const extra of route.extras) {
        // an epilogue or finale: show its own name, it has no day number
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

  const matched = new Set<string>();
  for (const ending of catalog.endings) {
    const got = [...collected].some((id) => endingById(catalog, id)?.id === ending.id);
    if (got) matched.add(ending.id);
    const card = el("div", got ? "card" : "card locked");
    card.tabIndex = 0;
    card.appendChild(el("div", "title", got ? ending.name : "?????"));
    card.appendChild(el("div", "meta", got ? "已收录" : "未收录"));
    cards.appendChild(card);
  }

  // Anything collected that the roster does not list - the game can end in
  // ways its own menu never enumerated. Shown only once reached.
  for (const id of collected) {
    const known = endingById(catalog, id);
    if (known && matched.has(known.id)) continue;
    if (known) continue;
    const label = labelForScene(catalog, id);
    const card = el("div", "card");
    card.tabIndex = 0;
    card.appendChild(el("div", "title", label.shortLabel !== catalog.fallbackLabel ? label.shortLabel : "结局"));
    card.appendChild(el("div", "meta", "已收录"));
    cards.appendChild(card);
  }

  content.appendChild(cards);
}

async function main(): Promise<void> {
  const content = $("content");
  const meta = await fetch("game.json")
    .then((r) => (r.ok ? (r.json() as Promise<GamePackageMeta>) : null))
    .catch(() => null);
  const catalog = await fetch("narrative.json")
    .then((r) => (r.ok ? (r.json() as Promise<NarrativeProgressCatalog>) : null))
    .catch(() => null);

  if (meta?.branding?.title) {
    document.title = `${meta.branding.title} · records`;
  }
  if (!catalog) {
    content.appendChild(el("p", "empty", "这个游戏没有提供章节名称。"));
    return;
  }

  const ns = meta?.profile.storageNamespace ?? "kidvn";
  const tracker = await CompletionTracker.open(new IdbCompletionStore(ns)).catch(() => null);
  const visited = new Set(tracker?.scenes ?? []);
  const collected = new Set(tracker?.endings ?? []);

  // "last played" comes from the newest save, so it survives a reload
  try {
    const slots = new SaveSlots(localStorage, ns);
    const list = slots.list();
    const latest = list.length > 0 ? list.reduce((a, b) => (b.savedAt > a.savedAt ? b : a)) : null;
    if (latest) {
      $("lede").textContent = `最后游玩 · ${labelForScene(catalog, latest.scene).shortLabel}`;
    }
  } catch {
    /* storage unavailable: the rest of the page still renders */
  }

  renderChapters(content, catalog, visited);
  renderEndings(content, catalog, collected);
}

void main();
