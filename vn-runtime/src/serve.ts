import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, normalize, resolve } from "node:path";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

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
  port?: number;
  /** Fixture list served to the /shots.html harness. */
  fixturesPath?: string;
  /** Where the harness's POSTed PNGs are written. */
  shotsOutDir?: string;
  /** Exploration data for /routes (default: build/exploration.json if present). */
  explorationPath?: string;
}

/**
 * Bundle the web client and serve it together with the IR and the extracted
 * assets. Static only - the client fetches /ir/<scene>.json and /assets/...
 */
export function serve(opts: ServeOptions): void {
  const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");
  const bundlePath = join(webDir, "bundle.js");
  const webSrc = resolve(dirname(fileURLToPath(import.meta.url)), "web");
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
    entryPoints: [join(webSrc, "routes.ts")],
    bundle: true,
    outfile: join(webDir, "routes-bundle.js"),
    format: "iife",
    target: "es2022",
    sourcemap: "inline",
    logLevel: "warning",
  });
  console.log(`bundled web client + shots harness + route explorer -> ${webDir}`);

  const roots: Record<string, string> = {
    "/ir": resolve(opts.irDir),
    "/assets": resolve(opts.assetsDir),
  };

  const fixturesPath = opts.fixturesPath ?? resolve("vn-runtime", "test", "__shots__", "fixtures.json");
  const shotsOutDir = opts.shotsOutDir ?? resolve("build", "shots", "current");
  const explorationPath = opts.explorationPath ?? resolve("build", "exploration.json");

  // Route graph for /routes: built once from the IR on first request (the
  // graph logic lives in vn-graph; this server only serializes it).
  let graphJson: string | null = null;
  const buildGraph = async (): Promise<string> => {
    if (graphJson) return graphJson;
    const { buildGraphModel, applyExploration, toJson } = await import("vn-graph");
    const { readdirSync } = await import("node:fs");
    const { fsSceneSource } = await import("./scene-source.js");
    const source = fsSceneSource(opts.irDir);
    const scenes = new Map<string, import("./types.js").IrScene>();
    for (const f of readdirSync(opts.irDir).filter((f) => f.endsWith(".json")).sort()) {
      const s = source.load(f.replace(/\.json$/, ""));
      if (s) scenes.set(s.scene.toLowerCase(), s);
    }
    const model = buildGraphModel(scenes, "op00");
    if (existsSync(explorationPath)) {
      applyExploration(model, JSON.parse(readFileSync(explorationPath, "utf8")));
    }
    graphJson = JSON.stringify(toJson(model));
    return graphJson;
  };

  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0]!;

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
    for (const [prefix, root] of Object.entries(roots)) {
      if (url.startsWith(prefix + "/")) {
        const rel = normalize(url.slice(prefix.length + 1));
        if (!rel.startsWith("..")) filePath = join(root, rel);
        break;
      }
    }
    if (!filePath) {
      const rel = url === "/" ? "index.html" : url === "/routes" ? "routes.html" : normalize(url.slice(1));
      if (!rel.startsWith("..")) filePath = join(webDir, rel);
    }
    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`not found: ${url}`);
      return;
    }
    // HEAD support for the client's movie probe
    const type = MIME[extname(filePath)] ?? "application/octet-stream";
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-type": type, "content-length": statSync(filePath).size });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": type });
    res.end(readFileSync(filePath));
  });
  const port = opts.port ?? 8017;
  server.listen(port, () => {
    console.log(`vn-runtime web client: http://localhost:${port}/  (ir=${opts.irDir}, assets=${opts.assetsDir})`);
  });
}
