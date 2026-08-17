import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
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
};

export interface ServeOptions {
  irDir: string;
  assetsDir: string;
  port?: number;
}

/**
 * Bundle the web client and serve it together with the IR and the extracted
 * assets. Static only - the client fetches /ir/<scene>.json and /assets/...
 */
export function serve(opts: ServeOptions): void {
  const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");
  const bundlePath = join(webDir, "bundle.js");
  const entry = resolve(dirname(fileURLToPath(import.meta.url)), "web", "main.ts");
  buildSync({
    entryPoints: [entry],
    bundle: true,
    outfile: bundlePath,
    format: "iife",
    target: "es2022",
    sourcemap: "inline",
    logLevel: "warning",
  });
  console.log(`bundled web client -> ${bundlePath}`);

  const roots: Record<string, string> = {
    "/ir": resolve(opts.irDir),
    "/assets": resolve(opts.assetsDir),
  };

  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0]!;
    let filePath: string | null = null;
    for (const [prefix, root] of Object.entries(roots)) {
      if (url.startsWith(prefix + "/")) {
        const rel = normalize(url.slice(prefix.length + 1));
        if (!rel.startsWith("..")) filePath = join(root, rel);
        break;
      }
    }
    if (!filePath) {
      const rel = url === "/" ? "index.html" : normalize(url.slice(1));
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
