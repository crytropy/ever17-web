import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, normalize, resolve } from "node:path";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { GamePackageMeta } from "kid-contracts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mpg": "video/mpeg",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
};

export interface ServeOptions {
  irDir: string;
  assetsDir: string;
  /** Game package metadata; served as /game.json and used to brand the shell. */
  meta: GamePackageMeta;
  port?: number;
  /** Bind address. Local-only by default; never expose game content publicly. */
  host?: string;
  /** Fixture list served to the /shots.html harness. */
  fixturesPath?: string;
  /** Where the harness's POSTed PNGs are written. */
  shotsOutDir?: string;
  /** Exploration data for /routes (default: build/exploration.json if present). */
  explorationPath?: string;
  /**
   * Lazy asset conversion: called when a request under /assets misses on
   * disk. Returns the absolute path of the file it materialized (adapters
   * decode from the original archives into the cache here), or null.
   */
  materializeAsset?: (relPath: string) => string | null | Promise<string | null>;
  onReady?: (url: string) => void;
}

/** Fill the {{PLACEHOLDER}}s of the static shell from the game metadata. */
function renderTemplate(raw: string, meta: GamePackageMeta): string {
  const b = meta.branding;
  const vars: Record<string, string> = {
    GAME_TITLE: b?.title ?? meta.title,
    GAME_SUBTITLE: b?.subtitle ?? "",
    GAME_HINT: b?.hint ?? "click to start",
    GAME_LANG: b?.lang ?? "en",
    THEME_COLOR: b?.themeColor ?? "#000814",
    PWA_NAME: b?.pwaName ?? b?.title ?? meta.title,
    PWA_SHORT_NAME: b?.pwaShortName ?? b?.title ?? meta.title,
    STAGE_W: String(meta.profile.canvas.width),
    STAGE_H: String(meta.profile.canvas.height),
    SW_CACHE: `${meta.profile.storageNamespace}-v3`,
  };
  return raw.replace(/\{\{([A-Z_]+)\}\}/g, (m, key: string) => vars[key] ?? m);
}

/**
 * Bundle the web client and serve it together with the game package: the
 * metadata (/game.json), the IR (/ir/...) and the converted assets
 * (/assets/...). Static only - plus the optional materializeAsset hook that
 * lets an adapter convert assets on first request.
 */
export function serve(opts: ServeOptions): void {
  const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");
  const bundlePath = join(webDir, "bundle.js");
  const webSrc = resolve(dirname(fileURLToPath(import.meta.url)));
  buildSync({
    entryPoints: [join(webSrc, "main.ts")],
    bundle: true,
    outfile: bundlePath,
    format: "iife",
    target: "es2022",
    sourcemap: "inline",
    logLevel: "warning",
  });
  buildSync({
    entryPoints: [join(webSrc, "shots.ts")],
    bundle: true,
    outfile: join(webDir, "shots-bundle.js"),
    format: "iife",
    target: "es2022",
    logLevel: "warning",
  });
  buildSync({
    entryPoints: [join(webSrc, "records.ts")],
    bundle: true,
    outfile: join(webDir, "records-bundle.js"),
    format: "iife",
    target: "es2022",
    sourcemap: "inline",
    logLevel: "warning",
  });
  buildSync({
    entryPoints: [join(webSrc, "routes.ts")],
    bundle: true,
    outfile: join(webDir, "routes-bundle.js"),
    format: "iife",
    target: "es2022",
    sourcemap: "inline",
    logLevel: "warning",
  });
  console.log(`bundled web client + records screen + shots harness + route explorer -> ${webDir}`);

  const roots: Record<string, string> = {
    "/ir": resolve(opts.irDir),
    "/assets": resolve(opts.assetsDir),
  };

  const fixturesPath = opts.fixturesPath ?? resolve("packages", "kid-runtime", "test", "__shots__", "fixtures.json");
  const shotsOutDir = opts.shotsOutDir ?? resolve("build", "shots", "current");
  const explorationPath = opts.explorationPath ?? resolve("build", "exploration.json");
  const gameJson = JSON.stringify(opts.meta, null, 1);
  /** Files whose contents carry {{...}} branding placeholders. */
  const TEMPLATED = new Set(["index.html", "records.html", "routes.html", "shots.html", "manifest.webmanifest", "sw.js"]);
  const templateCache = new Map<string, string>();

  // Route graph for /routes: built once from the IR on first request (the
  // graph logic lives in kid-graph; this server only serializes it).
  let graphJson: string | null = null;
  const buildGraph = async (): Promise<string> => {
    if (graphJson) return graphJson;
    const { buildGraphModel, applyExploration, toJson } = await import("kid-graph");
    const { readdirSync } = await import("node:fs");
    const { fsSceneSource } = await import("kid-runtime/node");
    const source = fsSceneSource(opts.irDir);
    const scenes = new Map<string, import("kid-contracts/ir").IrScene>();
    for (const f of readdirSync(opts.irDir).filter((f) => f.endsWith(".json")).sort()) {
      const s = source.load(f.replace(/\.json$/, ""));
      if (s) scenes.set(s.scene.toLowerCase(), s);
    }
    const model = buildGraphModel(scenes, opts.meta.startScene, opts.meta.profile);
    if (existsSync(explorationPath)) {
      applyExploration(model, JSON.parse(readFileSync(explorationPath, "utf8")));
    }
    graphJson = JSON.stringify(toJson(model));
    return graphJson;
  };

  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0]!;

    if (url === "/game.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(gameJson);
      return;
    }
    if (url === "/narrative.json") {
      // chapter names generated during import; absent for a game whose
      // adapter does not provide any
      const path = join(resolve(opts.irDir), "..", "narrative.json");
      if (!existsSync(path)) {
        res.writeHead(404, { "content-type": "text/plain" }).end("no narrative catalog");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(readFileSync(path));
      return;
    }

    // ------------- route explorer endpoints
    if (url === "/graph.json") {
      buildGraph().then(
        (json) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(json);
        },
        (err: Error) => {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end(`graph build failed: ${err.message}`);
        },
      );
      return;
    }
    if (url === "/exploration.json") {
      if (!existsSync(explorationPath)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end(`no exploration data - run: vn explore ${opts.irDir} -o ${explorationPath}`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(readFileSync(explorationPath));
      return;
    }

    // ------------- visual-regression harness endpoints
    if (url === "/shots/fixtures.json") {
      if (!existsSync(fixturesPath)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end(`no fixtures at ${fixturesPath} - run: vn fixtures <irDir> <manifest> -o ${fixturesPath}`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(readFileSync(fixturesPath));
      return;
    }
    if (req.method === "POST" && url.startsWith("/shots/save/")) {
      const name = basename(decodeURIComponent(url.slice("/shots/save/".length))).replace(/[^a-z0-9_-]/gi, "");
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const dataUrl = Buffer.concat(chunks).toString("utf8");
        const m = dataUrl.match(/^data:image\/png;base64,(.+)$/s);
        if (!name || !m) {
          res.writeHead(400).end("expected a png data url");
          return;
        }
        mkdirSync(shotsOutDir, { recursive: true });
        const out = join(shotsOutDir, `${name}.png`);
        writeFileSync(out, Buffer.from(m[1]!, "base64"));
        console.log(`shot saved: ${out}`);
        res.writeHead(200).end("ok");
      });
      return;
    }

    let filePath: string | null = null;
    let assetRel: string | null = null;
    for (const [prefix, root] of Object.entries(roots)) {
      if (url.startsWith(prefix + "/")) {
        const rel = normalize(decodeURIComponent(url.slice(prefix.length + 1)));
        if (!rel.startsWith("..")) {
          filePath = join(root, rel);
          if (prefix === "/assets") assetRel = rel;
        }
        break;
      }
    }
    let templateName: string | null = null;
    if (!filePath) {
      // /records is the player's screen; the full technical graph stays
      // available for development at /debug/routes.
      const rel =
        url === "/" ? "index.html"
        : url === "/records" || url === "/routes" ? "records.html"
        : url === "/debug/routes" ? "routes.html"
        : normalize(url.slice(1));
      if (!rel.startsWith("..")) {
        filePath = join(webDir, rel);
        if (TEMPLATED.has(rel)) templateName = rel;
      }
    }

    const respondFile = (path: string): void => {
      const type = MIME[extname(path)] ?? "application/octet-stream";
      if (templateName) {
        let body = templateCache.get(templateName);
        if (body === undefined) {
          body = renderTemplate(readFileSync(path, "utf8"), opts.meta);
          templateCache.set(templateName, body);
        }
        if (req.method === "HEAD") {
          res.writeHead(200, { "content-type": type, "content-length": Buffer.byteLength(body) });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": type });
        res.end(body);
        return;
      }
      // HEAD support for the client's movie probe
      if (req.method === "HEAD") {
        res.writeHead(200, { "content-type": type, "content-length": statSync(path).size });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": type });
      res.end(readFileSync(path));
    };

    const missing = (): void => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`not found: ${url}`);
    };

    if (!filePath) {
      missing();
      return;
    }
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      respondFile(filePath);
      return;
    }
    // Asset miss: give the adapter a chance to convert it from the originals.
    // Failures answer with a readable 5xx rather than leaving the request (and
    // the player) hanging - the client retries or reports it.
    if (assetRel && opts.materializeAsset) {
      Promise.resolve(opts.materializeAsset(assetRel)).then(
        (produced) => {
          if (produced && existsSync(produced) && statSync(produced).isFile()) respondFile(produced);
          else missing();
        },
        (err: Error) => {
          const detail = err.message || String(err);
          console.error(`asset conversion failed: ${detail}`);
          res.writeHead(503, { "content-type": "text/plain", "cache-control": "no-store" });
          res.end(`asset conversion failed for ${assetRel}: ${detail}`);
        },
      );
      return;
    }
    missing();
  });
  const port = opts.port ?? 8017;
  const host = opts.host ?? "127.0.0.1";
  server.listen(port, host, () => {
    const url = `http://${host}:${port}/`;
    console.log(`${opts.meta.title} web player: ${url}  (ir=${opts.irDir}, assets=${opts.assetsDir})`);
    opts.onReady?.(url);
  });
}
