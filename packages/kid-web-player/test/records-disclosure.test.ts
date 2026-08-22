import { describe, expect, it } from "vitest";
import {
  NARRATIVE_CATALOG_FORMAT,
  NARRATIVE_CATALOG_VERSION,
  endingById,
  labelForScene,
  type NarrativeProgressCatalog,
} from "kid-contracts";

/**
 * The records screen must never show a player something they have not
 * reached. The rendering itself needs a DOM, so these tests pin the
 * disclosure *rules* the renderer applies - which is where a spoiler would
 * actually come from, since the imported catalog necessarily contains every
 * route and ending in the game.
 */

const catalog: NarrativeProgressCatalog = {
  format: NARRATIVE_CATALOG_FORMAT,
  version: NARRATIVE_CATALOG_VERSION,
  gameId: "ever17",
  fallbackLabel: "未知章节",
  scenes: {
    op00: { shortLabel: "序章", kind: "opening" },
    t_1a: { shortLabel: "武视角 · 第1日", kind: "chapter", viewpoint: "武视角", routeId: "common", day: 1 },
    t_1b: { shortLabel: "武视角 · 第1日", kind: "chapter", viewpoint: "武视角", routeId: "common", day: 1 },
    t_2a: { shortLabel: "武视角 · 第2日", kind: "chapter", viewpoint: "武视角", routeId: "common", day: 2 },
    tt6a: { shortLabel: "鸠篇 · 第6日", kind: "chapter", viewpoint: "武视角", routeId: "tsugumi", day: 6 },
    // a route only reachable after the game unlocks it
    yc3a: { shortLabel: "可可篇 · 第3日", kind: "chapter", viewpoint: "双视角", routeId: "coco", day: 3 },
    system: { shortLabel: "未知章节", kind: "other" },
  },
  routes: [
    { id: "common-takeshi", name: "共通篇", viewpoint: "武视角", common: true },
    { id: "tsugumi", name: "鸠篇", viewpoint: "武视角" },
    { id: "coco", name: "可可篇", viewpoint: "双视角" },
  ],
  endings: [
    { id: "tsugumi-good", name: "鸠篇 · 结局", routeId: "tsugumi", aliases: ["END_TU00", "end_tu00"] },
    { id: "sara-good", name: "沙罗篇 · 结局", routeId: "sara", aliases: ["END_SA00"] },
  ],
};

/**
 * The rule the chapter list applies: only visited scenes that have a chapter
 * name contribute, and everything shown comes from them.
 */
function visibleChapters(visited: Iterable<string>): { viewpoints: string[]; routes: string[]; days: string[] } {
  const viewpoints = new Set<string>();
  const routes = new Set<string>();
  const days = new Set<string>();
  for (const scene of visited) {
    const label = catalog.scenes[scene.toLowerCase()];
    if (!label || label.kind === "other") continue;
    if (label.viewpoint) viewpoints.add(label.viewpoint);
    if (label.routeId) routes.add(label.routeId);
    if (label.day !== undefined) days.add(`${label.routeId ?? ""}:${label.day}`);
  }
  return { viewpoints: [...viewpoints], routes: [...routes], days: [...days] };
}

/** The rule the endings list applies. */
function visibleEndingNames(collected: Iterable<string>): string[] {
  const got = new Set([...collected].map((id) => endingById(catalog, id)?.id).filter(Boolean));
  return catalog.endings.map((e) => (got.has(e.id) ? e.name : "?????"));
}

describe("records disclosure", () => {
  it("shows nothing before the player has been anywhere", () => {
    const v = visibleChapters([]);
    expect(v.viewpoints).toEqual([]);
    expect(v.routes).toEqual([]);
    expect(visibleEndingNames([])).toEqual(["?????", "?????"]);
  });

  it("reveals a viewpoint and day only after visiting them", () => {
    const v = visibleChapters(["op00", "t_1a"]);
    expect(v.viewpoints).toEqual(["武视角"]);
    expect(v.days).toEqual(["common:1"]);
    expect(v.days).not.toContain("common:2");
  });

  it("never names a route the player has not entered", () => {
    const v = visibleChapters(["op00", "t_1a", "t_2a"]);
    expect(v.routes).toContain("common");
    // the catalog knows about them; the screen must not say so
    expect(v.routes).not.toContain("tsugumi");
    expect(v.routes).not.toContain("coco");
  });

  it("does not leak the hidden final route just because the data contains it", () => {
    // a player who has finished every ordinary route but not unlocked the last
    const v = visibleChapters(["op00", "t_1a", "t_2a", "tt6a"]);
    expect(v.routes).toContain("tsugumi");
    expect(v.routes).not.toContain("coco");
    expect(v.viewpoints).not.toContain("双视角");
  });

  it("reveals the final route once the player is actually in it", () => {
    const v = visibleChapters(["op00", "t_1a", "yc3a"]);
    expect(v.routes).toContain("coco");
    expect(v.viewpoints).toContain("双视角");
  });

  it("hides system and developer scripts even when visited", () => {
    const v = visibleChapters(["system", "t_1a"]);
    expect(v.viewpoints).toEqual(["武视角"]);
    expect(v.routes).toEqual(["common"]);
  });

  it("names an ending only once collected, and resolves movie codes", () => {
    expect(visibleEndingNames([])).toEqual(["?????", "?????"]);
    expect(visibleEndingNames(["END_TU00"])).toEqual(["鸠篇 · 结局", "?????"]);
    expect(visibleEndingNames(["end_tu00", "END_SA00"])).toEqual(["鸠篇 · 结局", "沙罗篇 · 结局"]);
  });

  it("shows a locked card rather than omitting an uncollected ending", () => {
    // the roster is the game's own; hiding entries entirely would make the
    // screen useless, showing names would spoil them
    expect(visibleEndingNames(["END_TU00"]).length).toBe(catalog.endings.length);
  });

  it("shows no scene id anywhere, even for an unlabelled scene", () => {
    for (const scene of ["op00", "t_1a", "yc3a", "unknown_scene"]) {
      const label = labelForScene(catalog, scene);
      expect(label.shortLabel.toLowerCase()).not.toContain(scene);
    }
  });
});
