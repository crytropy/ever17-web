import { describe, expect, it } from "vitest";
import {
  NARRATIVE_CATALOG_FORMAT,
  NARRATIVE_CATALOG_VERSION,
  labelForScene,
  type NarrativeProgressCatalog,
} from "kid-contracts";
import { endingsFor, groupDiscoveredChapters } from "../src/records.js";

/**
 * The records screen must never show a player something they have not
 * reached. These tests drive the production grouping and card functions
 * directly - re-implementing the rules here would only prove the test agrees
 * with itself, which is what an earlier version of this file did.
 *
 * The catalog below is an invented game. This is a generic engine package, so
 * it must not carry another game's scene names; using made-up ones also makes
 * the point that the grouping rules know nothing about any particular title.
 */

const catalog: NarrativeProgressCatalog = {
  format: NARRATIVE_CATALOG_FORMAT,
  version: NARRATIVE_CATALOG_VERSION,
  gameId: "sample",
  fallbackLabel: "Unknown chapter",
  viewpoints: [
    { id: "north", name: "North", order: 0 },
    { id: "south", name: "South", order: 1 },
    { id: "both", name: "Both", order: 2 },
  ],
  scenes: {
    intro: { shortLabel: "Prologue", kind: "opening" },
    finale: { shortLabel: "Finale", kind: "ending" },
    // two scenes on the same day, to prove days collapse
    n1a: { shortLabel: "North · Day 1", kind: "chapter", viewpointId: "north", viewpoint: "North", routeId: "common-north", day: 1 },
    n1b: { shortLabel: "North · Day 1", kind: "chapter", viewpointId: "north", viewpoint: "North", routeId: "common-north", day: 1 },
    n2a: { shortLabel: "North · Day 2", kind: "chapter", viewpointId: "north", viewpoint: "North", routeId: "common-north", day: 2 },
    nh6a: { shortLabel: "Hazel · Day 6", kind: "chapter", viewpointId: "north", viewpoint: "North", routeId: "hazel", day: 6 },
    s1a: { shortLabel: "South · Day 1", kind: "chapter", viewpointId: "south", viewpoint: "South", routeId: "common-south", day: 1 },
    swep: { shortLabel: "Wren · Epilogue", kind: "epilogue", viewpointId: "south", viewpoint: "South", routeId: "wren" },
    // a route only reachable once the game unlocks it
    b3a: { shortLabel: "Lark · Day 3", kind: "chapter", viewpointId: "both", viewpoint: "Both", routeId: "lark", day: 3 },
    system: { shortLabel: "Unknown chapter", kind: "other" },
    devmenu: { shortLabel: "Unknown chapter", kind: "other" },
  },
  routes: [
    // both viewpoints' shared chapters share a display name on purpose:
    // that collision is what an id built from a display name would lose
    { id: "common-north", name: "Common", viewpointId: "north", viewpoint: "North", common: true },
    { id: "hazel", name: "Hazel", viewpointId: "north", viewpoint: "North" },
    { id: "common-south", name: "Common", viewpointId: "south", viewpoint: "South", common: true },
    { id: "wren", name: "Wren", viewpointId: "south", viewpoint: "South" },
    { id: "lark", name: "Lark", viewpointId: "both", viewpoint: "Both" },
  ],
  endings: [
    { id: "hazel-good", name: "Hazel · Ending", routeId: "hazel", aliases: ["END_HA00", "end_ha00"] },
    { id: "wren-good", name: "Wren · Ending", routeId: "wren", aliases: ["END_WR00"] },
  ],
};

const routeIds = (visited: string[]): string[] =>
  groupDiscoveredChapters(catalog, visited).flatMap((g) => g.routes.map((r) => r.routeId));
const viewpointIds = (visited: string[]): string[] =>
  groupDiscoveredChapters(catalog, visited).map((g) => g.viewpointId);

describe("chapter disclosure", () => {
  it("shows nothing before the player has been anywhere", () => {
    expect(groupDiscoveredChapters(catalog, [])).toEqual([]);
  });

  it("reveals a viewpoint and day only after visiting them", () => {
    const groups = groupDiscoveredChapters(catalog, ["n1a"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe("North");
    expect(groups[0]!.routes[0]!.days).toEqual([1]);
    expect(groups[0]!.routes[0]!.days).not.toContain(2);
  });

  it("collects several visits to the same day into one entry", () => {
    const groups = groupDiscoveredChapters(catalog, ["n1a", "n1b", "n2a"]);
    expect(groups[0]!.routes[0]!.days).toEqual([1, 2]);
  });

  it("names the shared chapters by their route, not by the viewpoint again", () => {
    // regression: ids built from display names produced a "North / North" row
    const groups = groupDiscoveredChapters(catalog, ["n1a", "s1a"]);
    const north = groups.find((g) => g.viewpointId === "north")!;
    const south = groups.find((g) => g.viewpointId === "south")!;
    expect(north.routes[0]!.name).toBe("Common");
    expect(south.routes[0]!.name).toBe("Common");
    expect(north.name).toBe("North");
    expect(south.name).toBe("South");
  });

  it("keeps the two viewpoints' shared chapters apart despite one display name", () => {
    const groups = groupDiscoveredChapters(catalog, ["n1a", "s1a"]);
    expect(groups.map((g) => g.viewpointId).sort()).toEqual(["north", "south"]);
    expect(routeIds(["n1a", "s1a"]).sort()).toEqual(["common-north", "common-south"]);
  });

  it("never names a route the player has not entered", () => {
    const ids = routeIds(["intro", "n1a", "n2a"]);
    expect(ids).toContain("common-north");
    expect(ids).not.toContain("hazel");
    expect(ids).not.toContain("lark");
  });

  it("does not leak the hidden final route just because the data contains it", () => {
    // a player who has finished an ordinary route but not unlocked the last
    const ids = routeIds(["intro", "n1a", "nh6a"]);
    expect(ids).toContain("hazel");
    expect(ids).not.toContain("lark");
    expect(viewpointIds(["intro", "n1a", "nh6a"])).not.toContain("both");
  });

  it("reveals the final route once the player is actually in it", () => {
    expect(routeIds(["intro", "n1a", "b3a"])).toContain("lark");
    expect(viewpointIds(["intro", "n1a", "b3a"])).toContain("both");
  });

  it("hides system and developer scripts even when visited", () => {
    const groups = groupDiscoveredChapters(catalog, ["system", "devmenu", "n1a"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.viewpointId).toBe("north");
  });

  it("gives chapters with no viewpoint their own row", () => {
    const groups = groupDiscoveredChapters(catalog, ["intro", "finale"]);
    const standalone = groups.find((g) => g.viewpointId === "")!;
    expect(standalone.routes.map((r) => r.name).sort()).toEqual(["Finale", "Prologue"]);
    // and no duplicate chip repeating the row's own name
    for (const r of standalone.routes) expect(r.extras).toEqual([]);
  });

  it("lists an epilogue as its own entry under its route", () => {
    const groups = groupDiscoveredChapters(catalog, ["swep"]);
    const wren = groups[0]!.routes.find((r) => r.routeId === "wren")!;
    expect(wren.name).toBe("Wren");
    expect(wren.extras).toEqual(["Wren · Epilogue"]);
  });
});

describe("ending disclosure", () => {
  const names = (collected: string[]): (string | null)[] => endingsFor(catalog, collected).found.map((c) => c.name);

  it("lists nothing at all before the player has reached one", () => {
    const view = endingsFor(catalog, []);
    expect(view.found, "no placeholders to count").toEqual([]);
    expect(view.more).toBe(true);
  });

  it("never reveals how many endings the game has", () => {
    // the roster holds two; a player who has found one must not be able to
    // infer the second from the screen
    for (const collected of [[], ["END_HA00"]]) {
      const view = endingsFor(catalog, collected);
      expect(view.found.length, "only what was reached").toBe(collected.length);
      expect(view.found.length).toBeLessThan(catalog.endings.length);
    }
  });

  it("names an ending once collected, and resolves movie codes", () => {
    expect(names(["END_HA00"])).toEqual(["Hazel · Ending"]);
    expect(names(["end_ha00", "END_WR00"])).toEqual(["Hazel · Ending", "Wren · Ending"]);
  });

  it("keeps the roster's order rather than the order they were found in", () => {
    expect(names(["END_WR00", "END_HA00"])).toEqual(["Hazel · Ending", "Wren · Ending"]);
  });

  it("says whether anything remains, never how much", () => {
    expect(endingsFor(catalog, []).more).toBe(true);
    expect(endingsFor(catalog, ["END_HA00"]).more).toBe(true);
    expect(endingsFor(catalog, ["END_HA00", "END_WR00"]).more, "all found").toBe(false);
  });

  it("adds an ending the roster never listed, once reached", () => {
    const view = endingsFor(catalog, ["finale"]);
    expect(view.found).toHaveLength(1);
    expect(view.found[0]).toMatchObject({ collected: true, name: "Finale" });
  });

  it("ignores an unknown id rather than showing an identifier", () => {
    const view = endingsFor(catalog, ["not_a_thing"]);
    // the screen's own word for "ending" - the point is that the raw id is
    // never what a player sees, whatever the interface language is
    expect(view.found.at(-1)!.name).toBe("结局");
    expect(JSON.stringify(view)).not.toContain("not_a_thing");
  });
});

describe("labels", () => {
  it("shows no scene id anywhere, even for an unlabelled scene", () => {
    for (const scene of ["intro", "n1a", "b3a", "unknown_scene"]) {
      expect(labelForScene(catalog, scene).shortLabel.toLowerCase()).not.toContain(scene);
    }
  });
});
