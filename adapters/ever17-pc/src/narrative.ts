/**
 * Ever17 narrative progress labels, extracted from the game's own data.
 *
 * The release ships developer menus (debug*.scr) whose entries name every
 * chapter and pair it with its script id, for example:
 *
 *     武視点・共通１日目Ａ（Ｔ＿１Ａ）
 *     少年視点・優ルート４日目Ａ（ＳＹ４Ａ）
 *     少年視点・沙羅ルートエピローグ（ＳＳＥＰ）
 *
 * Those strings are the author's own chapter names, so the catalog is built
 * from them rather than invented here. What this module adds is normalization:
 * the menus are in Japanese while this release's story text is Chinese, so a
 * small table renders each viewpoint and route with the name the localization
 * itself uses for that character (verified against the speaker tags in each
 * route's own scenes: つぐみ speaks as 鸠, 空 as 空, 優 as 优, 沙羅 as 沙罗,
 * ココ as 可可).
 *
 * Nothing here is guessed: a chapter with no menu entry gets a neutral
 * fallback, never a raw script id.
 */
import {
  NARRATIVE_CATALOG_FORMAT,
  NARRATIVE_CATALOG_VERSION,
  type EndingProgressDefinition,
  type IrScene,
  type NarrativeProgressCatalog,
  type RouteProgressDefinition,
  type SceneProgressKind,
  type SceneProgressLabel,
} from "kid-contracts";

/** Scripts that carry the menus these labels come from. */
const DEBUG_SCENE = /^debug/i;

/** Full-width ASCII and punctuation -> ASCII. */
function narrow(s: string): string {
  return s
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    .replace(/＿/g, "_");
}

/** Full-width and kanji digits -> a number. */
function toNumber(s: string): number | null {
  const kanji: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const ascii = narrow(s).replace(/[一二三四五六七八九十]/g, (c) => String(kanji[c] ?? ""));
  const n = Number.parseInt(ascii, 10);
  return Number.isFinite(n) ? n : null;
}

/** Viewpoint token -> (id, display name in this release's language). */
const VIEWPOINTS: { match: RegExp; id: string; name: string }[] = [
  { match: /^武＋少年視点$/, id: "both", name: "双视角" },
  { match: /^武視点$/, id: "takeshi", name: "武视角" },
  { match: /^少年視点$/, id: "kid", name: "少年视角" },
];

/**
 * Route token -> (id, display name). The names are the ones this release's
 * own script uses for those characters; only the menus are Japanese.
 */
const ROUTES: { match: RegExp; id: string; name: string; common?: boolean }[] = [
  { match: /^共通$/, id: "common", name: "共通篇", common: true },
  { match: /^つぐみ$/, id: "tsugumi", name: "鸠篇" },
  { match: /^空$/, id: "sora", name: "空篇" },
  { match: /^優$/, id: "you", name: "优篇" },
  { match: /^沙羅$/, id: "sara", name: "沙罗篇" },
  { match: /^ココ$/, id: "coco", name: "可可篇" },
];

/** Two-letter movie codes the ending movies use, e.g. end_tu00. */
const MOVIE_ROUTE_CODES: Record<string, string> = {
  tu: "tsugumi",
  so: "sora",
  yu: "you",
  sa: "sara",
};

const OPENING_LABEL = "序章";
const FINALE_LABEL = "终章";
const EPILOGUE_WORD = "尾声";
const BAD_END_WORD = "结局";
const FALLBACK_LABEL = "未知章节";

interface ParsedMenuLabel {
  viewpointId?: string;
  viewpointName?: string;
  routeId?: string;
  routeName?: string;
  day?: number;
  segment?: string;
  kind: SceneProgressKind;
}

/**
 * Parse one menu entry, e.g. `武視点・共通１日目Ａ`.
 * Returns null when the string is not a chapter label at all.
 */
export function parseMenuLabel(raw: string): ParsedMenuLabel | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  if (/^オープニング/.test(text)) return { kind: "opening" };
  if (/^共通エンディング/.test(text)) return { kind: "ending" };

  const [head, ...rest] = text.split("・");
  if (rest.length === 0) return null;
  const body = rest.join("・");

  const viewpoint = VIEWPOINTS.find((v) => v.match.test(head ?? ""));
  if (!viewpoint) return null;
  const out: ParsedMenuLabel = { viewpointId: viewpoint.id, viewpointName: viewpoint.name, kind: "chapter" };

  // `<route>ルート` or the shared `共通`
  const routeMatch = body.match(/^(.+?)ルート/) ?? body.match(/^(共通)/);
  const routeToken = routeMatch?.[1] ?? null;
  const route = routeToken ? ROUTES.find((r) => r.match.test(routeToken)) : undefined;
  if (route) {
    out.routeId = route.id;
    out.routeName = route.name;
  }
  const tail = routeMatch ? body.slice(routeMatch[0].length) : body;

  if (/エピローグ/.test(tail) || /エピローグ/.test(body)) out.kind = "epilogue";
  else if (/バッド/.test(tail) || /バッド/.test(body)) out.kind = "badEnd";

  const day = tail.match(/([０-９0-9一二三四五六七八九十]+)日目/);
  if (day) {
    const n = toNumber(day[1]!);
    if (n !== null) out.day = n;
    const seg = tail.slice((day.index ?? 0) + day[0].length).trim();
    const segAscii = narrow(seg).toUpperCase();
    if (/^[A-Z]$/.test(segAscii)) out.segment = segAscii;
  }
  return out;
}

/** Compose the short, player-facing label for a parsed entry. */
export function composeShortLabel(p: ParsedMenuLabel): string {
  if (p.kind === "opening") return OPENING_LABEL;
  if (p.kind === "ending") return FINALE_LABEL;

  // A character route names itself; the shared chapters name the viewpoint.
  const head =
    p.routeId && p.routeId !== "common" ? p.routeName! : (p.viewpointName ?? p.routeName ?? FALLBACK_LABEL);

  if (p.kind === "epilogue") return `${head} · ${EPILOGUE_WORD}`;
  if (p.kind === "badEnd") return `${head} · ${BAD_END_WORD}`;
  if (p.day !== undefined) return `${head} · 第${p.day}日`;
  return head;
}

/** One `<label>（<SCENE>）` pair recovered from a menu. */
interface MenuEntry {
  scene: string;
  label: string;
}

/** Every scene-labelled menu entry in the debug scripts, first one wins. */
export function collectMenuEntries(scenes: readonly IrScene[]): MenuEntry[] {
  const seen = new Map<string, string>();
  for (const scene of scenes) {
    if (!DEBUG_SCENE.test(scene.scene)) continue;
    for (const block of Object.values(scene.blocks)) {
      for (const op of block.ops) {
        if (op.op !== "choice") continue;
        for (const option of op.options) {
          const m = option.text?.match(/^(.*?)[（(]([^）)]+)[）)]\s*$/);
          if (!m) continue;
          const target = narrow(m[2]!).toLowerCase().trim();
          // menu entries pair a label with a script id, e.g. （Ｔ＿１Ａ）
          if (!/^[a-z0-9_]+$/.test(target)) continue;
          if (!seen.has(target)) seen.set(target, m[1]!.trim());
        }
      }
    }
  }
  return [...seen].map(([scene, label]) => ({ scene, label }));
}

/** Ending names from the developer ending menu (the game's own roster). */
export function collectEndingRoster(scenes: readonly IrScene[]): EndingProgressDefinition[] {
  const out: EndingProgressDefinition[] = [];
  const seen = new Set<string>();
  for (const scene of scenes) {
    if (!DEBUG_SCENE.test(scene.scene)) continue;
    for (const block of Object.values(scene.blocks)) {
      for (const op of block.ops) {
        if (op.op !== "choice") continue;
        // the ending menu is the run of options ending in GOOD/BAD
        const endings = op.options.filter((o) => /(ＧＯＯＤ|ＢＡＤ|GOOD|BAD)\s*$/.test(o.text ?? ""));
        if (endings.length < 2) continue;
        for (const o of endings) {
          const text = (o.text ?? "").trim();
          if (seen.has(text)) continue;
          seen.add(text);
          const grade = /(ＧＯＯＤ|GOOD)\s*$/.test(text) ? "GOOD" : "BAD";
          const token = text.replace(/(ＧＯＯＤ|ＢＡＤ|GOOD|BAD)\s*$/, "").trim();
          const route = ROUTES.find((r) => r.match.test(token));
          const routeName = route?.name ?? token;
          const id = `${route?.id ?? token}-${grade.toLowerCase()}`;
          const aliases = route
            ? Object.entries(MOVIE_ROUTE_CODES)
                .filter(([, rid]) => rid === route.id && grade === "GOOD")
                .flatMap(([code]) => [`END_${code.toUpperCase()}00`, `end_${code}00`])
            : [];
          out.push({
            id,
            name: `${routeName} · ${grade === "GOOD" ? "结局" : "另一种结局"}`,
            ...(route ? { routeId: route.id } : {}),
            ...(aliases.length > 0 ? { aliases } : {}),
            order: out.length,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Build the catalog for an imported scenario. Scenes with no menu entry get a
 * neutral label derived from whatever is known, never their script id.
 */
export function buildNarrativeCatalog(scenes: readonly IrScene[], gameId: string): NarrativeProgressCatalog {
  const entries = collectMenuEntries(scenes);
  const labels: Record<string, SceneProgressLabel> = {};
  const routes = new Map<string, RouteProgressDefinition>();
  const viewpoints = new Map<string, { id: string; name: string; order: number }>();

  for (const { scene, label } of entries) {
    const parsed = parseMenuLabel(label);
    if (!parsed) continue;
    const shortLabel = composeShortLabel(parsed);
    if (parsed.viewpointId && parsed.viewpointName && !viewpoints.has(parsed.viewpointId)) {
      viewpoints.set(parsed.viewpointId, {
        id: parsed.viewpointId,
        name: parsed.viewpointName,
        order: viewpoints.size,
      });
    }
    labels[scene] = {
      shortLabel,
      kind: parsed.kind,
      ...(parsed.viewpointId ? { viewpointId: parsed.viewpointId } : {}),
      ...(parsed.viewpointName ? { viewpoint: parsed.viewpointName } : {}),
      // the stable id, so the shared chapters of two viewpoints stay distinct
      ...(parsed.routeId ? { routeId: routeKey(parsed) } : {}),
      ...(parsed.day !== undefined ? { day: parsed.day } : {}),
      ...(parsed.segment ? { internalSegment: parsed.segment } : {}),
    };
    if (parsed.routeId && !routes.has(routeKey(parsed))) {
      const def = ROUTES.find((r) => r.id === parsed.routeId)!;
      routes.set(routeKey(parsed), {
        id: routeKey(parsed),
        name: def.name,
        ...(parsed.viewpointId ? { viewpointId: parsed.viewpointId } : {}),
        ...(parsed.viewpointName ? { viewpoint: parsed.viewpointName } : {}),
        ...(def.common ? { common: true } : {}),
        order: routes.size,
      });
    }
  }

  // A handful of chapters continue another one and carry its name plus a
  // numeric suffix (s_1a -> s_1a2). The menus list only the first, so the
  // continuation inherits its label rather than falling back to nothing.
  for (const scene of scenes) {
    const name = scene.scene.toLowerCase();
    if (labels[name] || DEBUG_SCENE.test(name)) continue;
    const cont = name.match(/^(.*[a-z])(\d+)$/);
    const parent = cont ? labels[cont[1]!] : undefined;
    if (!cont || !parent) continue;
    labels[name] = { ...parent, internalSegment: `${parent.internalSegment ?? ""}${cont[2]!}` };
  }

  const endingRoster = collectEndingRoster(scenes);

  // The source menus label Takeshi's shared failure chapter only by viewpoint
  // ("武視点・バッド..."), while the player-facing clear list treats it as
  // one shared Tsugumi/Sora bad ending. The ending roster itself names only
  // one of those two routes, so normalize that one entry into the shared end
  // and keep both the old parsed id and the bad-end scene as aliases.
  const sharedTakeshiBadScene = Object.entries(labels).find(
    ([, label]) =>
      label.kind === "badEnd" &&
      label.viewpointId === "takeshi" &&
      !label.routeId,
  )?.[0];

  if (sharedTakeshiBadScene) {
    const goodTakeshiRoutes = [...routes.values()]
      .filter((route) => !route.common && route.viewpointId === "takeshi")
      .filter((route) =>
        endingRoster.some(
          (ending) =>
            ending.routeId === route.id &&
            ending.id.toLowerCase().endsWith("-good"),
        ),
      );

    const badTakeshiEndings = endingRoster.filter(
      (ending) =>
        ending.routeId &&
        goodTakeshiRoutes.some((route) => route.id === ending.routeId) &&
        ending.id.toLowerCase().endsWith("-bad"),
    );

    if (goodTakeshiRoutes.length === 2 && badTakeshiEndings.length === 1) {
      const old = badTakeshiEndings[0]!;
      const sharedId = `${goodTakeshiRoutes.map((route) => route.id).join("-")}-bad`;
      const sharedName =
        `${goodTakeshiRoutes.map((route) => route.name.replace(/篇$/, "")).join("・")}篇 · 另一种结局`;
      const index = endingRoster.indexOf(old);
      endingRoster[index] = {
        id: sharedId,
        name: sharedName,
        aliases: [...new Set([...(old.aliases ?? []), old.id, sharedTakeshiBadScene])],
        order: old.order,
      };
    }
  }

  return {
    format: NARRATIVE_CATALOG_FORMAT,
    version: NARRATIVE_CATALOG_VERSION,
    gameId,
    fallbackLabel: FALLBACK_LABEL,
    viewpoints: [...viewpoints.values()].sort((a, b) => a.order - b.order),
    scenes: labels,
    routes: [...routes.values()],
    endings: endingRoster,
    derivedFrom: "chapter names in the release's own developer menus (debug*.scr)",
  };
}

/** Routes are per viewpoint: the shared chapters differ between them. */
function routeKey(p: ParsedMenuLabel): string {
  return p.routeId === "common" && p.viewpointId ? `common-${p.viewpointId}` : (p.routeId ?? "unknown");
}
