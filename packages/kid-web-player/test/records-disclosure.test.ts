import { describe, expect, it } from "vitest";
import {
  NARRATIVE_CATALOG_FORMAT,
  NARRATIVE_CATALOG_VERSION,
  labelForScene,
  type NarrativeProgressCatalog,
} from "kid-contracts";
import { endingCardsFor, groupDiscoveredChapters } from "../src/records.js";

/**
 * The records screen must never show a player something they have not
 * reached. These tests drive the production grouping and card functions
 * directly - re-implementing the rules here would only prove the test agrees
 * with itself, which is what an earlier version of this file did.
 */

const catalog: NarrativeProgressCatalog = {
  format: NARRATIVE_CATALOG_FORMAT,
  version: NARRATIVE_CATALOG_VERSION,
  gameId: "ever17",
  fallbackLabel: "未知章节",
  viewpoints: [
    { id: "takeshi", name: "武视角", order: 0 },
    { id: "kid", name: "少年视角", order: 1 },
    { id: "both", name: "双视角", order: 2 },
  ],
  scenes: {
    op00: { shortLabel: "序章", kind: "opening" },
    y_ed: { shortLabel: "终章", kind: "ending" },
    t_1a: { shortLabel: "武视角 · 第1日", kind: "chapter", viewpointId: "takeshi", viewpoint: "武视角", routeId: "common-takeshi", day: 1 },
    t_1b: { shortLabel: "武视角 · 第1日", kind: "chapter", viewpointId: "takeshi", viewpoint: "武视角", routeId: "common-takeshi", day: 1 },
    t_2a: { shortLabel: "武视角 · 第2日", kind: "chapter", viewpointId: "takeshi", viewpoint: "武视角", routeId: "common-takeshi", day: 2 },
    tt6a: { shortLabel: "鸠篇 · 第6日", kind: "chapter", viewpointId: "takeshi", viewpoint: "武视角", routeId: "tsugumi", day: 6 },
    s_1a: { shortLabel: "少年视角 · 第1日", kind: "chapter", viewpointId: "kid", viewpoint: "少年视角", routeId: "common-kid", day: 1 },
    ssep: { shortLabel: "沙罗篇 · 尾声", kind: "epilogue", viewpointId: "kid", viewpoint: "少年视角", routeId: "sara" },
    // a route only reachable once the game unlocks it
    yc3a: { shortLabel: "可可篇 · 第3日", kind: "chapter", viewpointId: "both", viewpoint: "双视角", routeId: "coco", day: 3 },
    system: { shortLabel: "未知章节", kind: "other" },
    debug: { shortLabel: "未知章节", kind: "other" },
  },
  routes: [
    { id: "common-takeshi", name: "共通篇", viewpointId: "takeshi", viewpoint: "武视角", common: true },
    { id: "tsugumi", name: "鸠篇", viewpointId: "takeshi", viewpoint: "武视角" },
    { id: "common-kid", name: "共通篇", viewpointId: "kid", viewpoint: "少年视角", common: true },
    { id: "sara", name: "沙罗篇", viewpointId: "kid", viewpoint: "少年视角" },
    { id: "coco", name: "可可篇", viewpointId: "both", viewpoint: "双视角" },
  ],
  endings: [
    { id: "tsugumi-good", name: "鸠篇 · 结局", routeId: "tsugumi", aliases: ["END_TU00", "end_tu00"] },
    { id: "sara-good", name: "沙罗篇 · 结局", routeId: "sara", aliases: ["END_SA00"] },
  ],
};

const routeIds = (visited: string[]): string[] =>
  groupDiscoveredChapters(catalog, visited).flatMap((g) => g.routes.map((r) => r.routeId));
const viewpointIds = (visited: string[]): string[] =>
  groupDiscoveredChapters(catalog, visited).map((g) => g.viewpointId);
const endingNames = (collected: string[]): (string | null)[] =>
  endingCardsFor(catalog, collected).map((c) => c.name);

describe("chapter disclosure", () => {
  it("shows nothing before the player has been anywhere", () => {
    expect(groupDiscoveredChapters(catalog, [])).toEqual([]);
  });

  it("reveals a viewpoint and day only after visiting them", () => {
    const groups = groupDiscoveredChapters(catalog, ["t_1a"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe("武视角");
    expect(groups[0]!.routes[0]!.days).toEqual([1]);
    expect(groups[0]!.routes[0]!.days).not.toContain(2);
  });

  it("collects several visits to the same day into one entry", () => {
    const groups = groupDiscoveredChapters(catalog, ["t_1a", "t_1b", "t_2a"]);
    expect(groups[0]!.routes[0]!.days).toEqual([1, 2]);
  });

  it("names the shared chapters by their route, not by the viewpoint again", () => {
    // regression: ids built from display names produced a "武视角 / 武视角" row
    const groups = groupDiscoveredChapters(catalog, ["t_1a", "s_1a"]);
    const takeshi = groups.find((g) => g.viewpointId === "takeshi")!;
    const kid = groups.find((g) => g.viewpointId === "kid")!;
    expect(takeshi.routes[0]!.name).toBe("共通篇");
    expect(kid.routes[0]!.name).toBe("共通篇");
    expect(takeshi.name).toBe("武视角");
    expect(kid.name).toBe("少年视角");
  });

  it("keeps the two viewpoints' shared chapters apart", () => {
    const groups = groupDiscoveredChapters(catalog, ["t_1a", "s_1a"]);
    expect(groups.map((g) => g.viewpointId).sort()).toEqual(["kid", "takeshi"]);
    expect(routeIds(["t_1a", "s_1a"]).sort()).toEqual(["common-kid", "common-takeshi"]);
  });

  it("never names a route the player has not entered", () => {
    const ids = routeIds(["op00", "t_1a", "t_2a"]);
    expect(ids).toContain("common-takeshi");
    expect(ids).not.toContain("tsugumi");
    expect(ids).not.toContain("coco");
  });

  it("does not leak the hidden final route just because the data contains it", () => {
    // a player who has finished an ordinary route but not unlocked the last
    const ids = routeIds(["op00", "t_1a", "tt6a"]);
    expect(ids).toContain("tsugumi");
    expect(ids).not.toContain("coco");
    expect(viewpointIds(["op00", "t_1a", "tt6a"])).not.toContain("both");
  });

  it("reveals the final route once the player is actually in it", () => {
    expect(routeIds(["op00", "t_1a", "yc3a"])).toContain("coco");
    expect(viewpointIds(["op00", "t_1a", "yc3a"])).toContain("both");
  });

  it("hides system and developer scripts even when visited", () => {
    const groups = groupDiscoveredChapters(catalog, ["system", "debug", "t_1a"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.viewpointId).toBe("takeshi");
  });

  it("gives chapters with no viewpoint their own row", () => {
    const groups = groupDiscoveredChapters(catalog, ["op00", "y_ed"]);
    const standalone = groups.find((g) => g.viewpointId === "")!;
    expect(standalone.routes.map((r) => r.name).sort()).toEqual(["序章", "终章"]);
    // and no duplicate chip repeating the row's own name
    for (const r of standalone.routes) expect(r.extras).toEqual([]);
  });

  it("lists an epilogue as its own entry under its route", () => {
    const groups = groupDiscoveredChapters(catalog, ["ssep"]);
    const sara = groups[0]!.routes.find((r) => r.routeId === "sara")!;
    expect(sara.name).toBe("沙罗篇");
    expect(sara.extras).toEqual(["沙罗篇 · 尾声"]);
  });
});

describe("ending disclosure", () => {
  it("shows a locked card for every uncollected ending in the roster", () => {
    expect(endingNames([])).toEqual([null, null]);
    expect(endingCardsFor(catalog, []).every((c) => !c.collected)).toBe(true);
  });

  it("names an ending only once collected, and resolves movie codes", () => {
    expect(endingNames(["END_TU00"])).toEqual(["鸠篇 · 结局", null]);
    expect(endingNames(["end_tu00", "END_SA00"])).toEqual(["鸠篇 · 结局", "沙罗篇 · 结局"]);
  });

  it("keeps the roster's length so the screen does not shift", () => {
    expect(endingCardsFor(catalog, ["END_TU00"])).toHaveLength(catalog.endings.length);
  });

  it("adds a card for an ending the roster never listed, once reached", () => {
    const cards = endingCardsFor(catalog, ["y_ed"]);
    expect(cards).toHaveLength(catalog.endings.length + 1);
    expect(cards[cards.length - 1]).toMatchObject({ collected: true, name: "终章" });
  });

  it("ignores an unknown id rather than showing an identifier", () => {
    const cards = endingCardsFor(catalog, ["not_a_thing"]);
    expect(cards[cards.length - 1]!.name).toBe("结局");
    expect(JSON.stringify(cards)).not.toContain("not_a_thing");
  });
});

describe("labels", () => {
  it("shows no scene id anywhere, even for an unlabelled scene", () => {
    for (const scene of ["op00", "t_1a", "yc3a", "unknown_scene"]) {
      expect(labelForScene(catalog, scene).shortLabel.toLowerCase()).not.toContain(scene);
    }
  });
});
