import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { labelForScene, endingById, type IrScene } from "kid-contracts";
import { fsSceneSource } from "kid-runtime/node";
import {
  buildNarrativeCatalog,
  collectEndingRoster,
  collectMenuEntries,
  composeShortLabel,
  parseMenuLabel,
} from "../src/narrative.js";
import { EVER17_GAME_ID } from "../src/profile.js";

/**
 * Chapter names come from the release's own developer menus. The parser tests
 * use the exact strings those menus contain; the catalog test runs over the
 * real imported scenario when one is available.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
function findPackageIr(): string {
  const cacheRoot = join(root, ".local", "ever17");
  if (existsSync(cacheRoot)) {
    for (const name of readdirSync(cacheRoot)) {
      const ir = join(cacheRoot, name, "ir");
      if (/^[0-9a-f]{16}$/.test(name) && existsSync(join(ir, "op00.json"))) return ir;
    }
  }
  return join(root, "build", "ir");
}
const IR_DIR = process.env["E17_IR_DIR"] ?? findPackageIr();
const HAVE_IR = existsSync(join(IR_DIR, "debug.json"));

const label = (menu: string): string => {
  const parsed = parseMenuLabel(menu);
  expect(parsed, menu).not.toBeNull();
  return composeShortLabel(parsed!);
};

describe("menu label parsing", () => {
  it("names the opening and the finale", () => {
    expect(label("オープニング")).toBe("序章");
    expect(label("オープニング他")).toBe("序章");
    expect(label("共通エンディング")).toBe("终章");
  });

  it("names shared chapters by viewpoint and day", () => {
    expect(label("武視点・共通１日目Ａ")).toBe("武视角 · 第1日");
    expect(label("武視点・共通６日目Ｂ")).toBe("武视角 · 第6日");
    expect(label("少年視点・共通３日目Ｅ")).toBe("少年视角 · 第3日");
  });

  it("names character routes by route and day", () => {
    expect(label("武視点・つぐみルート６日目")).toBe("鸠篇 · 第6日");
    expect(label("武視点・空ルート７日目")).toBe("空篇 · 第7日");
    expect(label("少年視点・優ルート４日目Ａ")).toBe("优篇 · 第4日");
    expect(label("少年視点・沙羅ルート５日目")).toBe("沙罗篇 · 第5日");
    expect(label("武＋少年視点・ココルート３日目Ａ")).toBe("可可篇 · 第3日");
  });

  it("names epilogues and bad ends without a day", () => {
    expect(label("少年視点・優ルートエピローグ")).toBe("优篇 · 尾声");
    expect(label("少年視点・沙羅ルートバッドＥＤ")).toBe("沙罗篇 · 结局");
    expect(label("武視点・エピローグ")).toBe("武视角 · 尾声");
    expect(label("武視点・バッドルート")).toBe("武视角 · 结局");
  });

  it("keeps the author's A/B/C division out of the player-facing name", () => {
    const parsed = parseMenuLabel("武視点・共通２日目Ｄ")!;
    expect(parsed.segment).toBe("D");
    expect(parsed.day).toBe(2);
    expect(composeShortLabel(parsed)).not.toMatch(/D/);
  });

  it("rejects menu entries that are not chapter labels", () => {
    for (const junk of ["エフェクトテスト", "次へ", "戻る", "工事中", "全選択肢ＯＮ", ""]) {
      expect(parseMenuLabel(junk), junk).toBeNull();
    }
  });
});

describe("catalog", () => {
  it("falls back to a neutral name, never a script id", () => {
    const catalog = buildNarrativeCatalog([], EVER17_GAME_ID);
    const l = labelForScene(catalog, "t_1a");
    expect(l.shortLabel).toBe(catalog.fallbackLabel);
    expect(l.shortLabel).not.toMatch(/t_1a/i);
    expect(labelForScene(null, "op00").shortLabel).not.toMatch(/op00/i);
  });

  it("reads labels out of synthetic menu data", () => {
    const menu: IrScene = {
      formatVersion: 1,
      scene: "debug",
      entry: "a",
      blocks: {
        a: {
          next: null,
          ops: [
            {
              op: "choice",
              id: 10,
              resultVar: 1203,
              options: [
                { index: 0, text: "武視点・共通１日目Ａ（Ｔ＿１Ａ）", target: null },
                { index: 1, text: "少年視点・優ルート４日目Ａ（ＳＹ４Ａ）", target: null },
                { index: 2, text: "戻る", target: null },
              ],
            },
          ],
        },
      },
      warnings: [],
      meta: { sceneIds: [], textChunks: 0, resources: [], unknownOpcodeCount: 0, coverage: 1 },
    };
    expect(collectMenuEntries([menu]).map((e) => e.scene).sort()).toEqual(["sy4a", "t_1a"]);
    const catalog = buildNarrativeCatalog([menu], EVER17_GAME_ID);
    expect(catalog.scenes["t_1a"]?.shortLabel).toBe("武视角 · 第1日");
    expect(catalog.scenes["sy4a"]).toMatchObject({ routeId: "you", day: 4, internalSegment: "A" });
    expect(catalog.routes.map((r) => r.id)).toContain("you");
  });

  it("builds an ending roster from a menu, with movie aliases", () => {
    const menu: IrScene = {
      formatVersion: 1,
      scene: "debug",
      entry: "a",
      blocks: {
        a: {
          next: null,
          ops: [
            {
              op: "choice",
              id: 10,
              resultVar: null,
              options: [
                { index: 0, text: "つぐみＧＯＯＤ", target: null },
                { index: 1, text: "沙羅ＢＡＤ", target: null },
              ],
            },
          ],
        },
      },
      warnings: [],
      meta: { sceneIds: [], textChunks: 0, resources: [], unknownOpcodeCount: 0, coverage: 1 },
    };
    const roster = collectEndingRoster([menu]);
    expect(roster.map((e) => e.id)).toEqual(["tsugumi-good", "sara-bad"]);
    expect(roster[0]!.name).toBe("鸠篇 · 结局");
    const catalog = buildNarrativeCatalog([menu], EVER17_GAME_ID);
    // completion records the movie code; the roster still resolves it
    expect(endingById(catalog, "END_TU00")?.id).toBe("tsugumi-good");
    expect(endingById(catalog, "end_tu00")?.id).toBe("tsugumi-good");
    expect(endingById(catalog, "nothing")).toBeNull();
  });
});

describe.skipIf(!HAVE_IR)("catalog over the real scenario", () => {
  const scenes = (): IrScene[] => {
    const src = fsSceneSource(IR_DIR);
    const out: IrScene[] = [];
    for (const f of readdirSync(IR_DIR).filter((n) => n.endsWith(".json")).sort()) {
      const s = src.load(f.replace(/\.json$/, ""));
      if (s) out.push(s);
    }
    return out;
  };

  it("labels every story scene a player can reach", () => {
    const all = scenes();
    const catalog = buildNarrativeCatalog(all, EVER17_GAME_ID);
    // developer and system scripts are not story and need no chapter name
    const story = all
      .map((s) => s.scene.toLowerCase())
      .filter((n) => !/^debug/.test(n) && n !== "system" && n !== "startup");
    const unlabelled = story.filter((n) => !catalog.scenes[n]);
    expect(unlabelled, `unlabelled story scenes: ${unlabelled.join(", ")}`).toEqual([]);
    expect(Object.keys(catalog.scenes).length).toBeGreaterThan(70);
  });

  it("gives a continuation chapter the name of the chapter it continues", () => {
    // s_1a2 continues s_1a; the menus list only the first
    const catalog = buildNarrativeCatalog(scenes(), EVER17_GAME_ID);
    expect(labelForScene(catalog, "s_1a2").shortLabel).toBe(labelForScene(catalog, "s_1a").shortLabel);
    expect(labelForScene(catalog, "s_1a2").shortLabel).not.toBe(catalog.fallbackLabel);
  });

  it("gives the opening, a common day and a route day their source names", () => {
    const catalog = buildNarrativeCatalog(scenes(), EVER17_GAME_ID);
    expect(labelForScene(catalog, "op00").shortLabel).toBe("序章");
    expect(labelForScene(catalog, "t_1a").shortLabel).toBe("武视角 · 第1日");
    expect(labelForScene(catalog, "y_ed").shortLabel).toBe("终章");
    expect(labelForScene(catalog, "tt6a").kind).toBe("chapter");
  });

  it("never exposes a script id through a label", () => {
    const catalog = buildNarrativeCatalog(scenes(), EVER17_GAME_ID);
    for (const [scene, l] of Object.entries(catalog.scenes)) {
      expect(l.shortLabel.toLowerCase(), scene).not.toContain(scene);
      expect(l.shortLabel, scene).not.toMatch(/[a-z]_[0-9]/i);
    }
  });
});
