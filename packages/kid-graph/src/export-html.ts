import { buildSync } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RouteGraphJson } from "./model.js";

/**
 * Standalone HTML viewer export (Node-only: bundles the viewer with esbuild).
 * Self-contained single file: embedded graph JSON + inlined bundle, no
 * external requests, works from file://.
 */
export function toHtml(json: RouteGraphJson): string {
  const src = dirname(fileURLToPath(import.meta.url));
  const bundle = buildSync({
    entryPoints: [join(src, "standalone.ts")],
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
    logLevel: "silent",
  }).outputFiles[0]!.text;

  const data = JSON.stringify(json).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Route graph · ${json.start}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin:0; height:100%; background:#070b16; color:#dbe4ff;
               font-family:system-ui, sans-serif; overflow:hidden; }
  #stats { position:fixed; left:12px; top:10px; z-index:5; font:12px monospace; color:#8093b8; }
  #legend { position:fixed; right:12px; top:10px; z-index:5; font:11px monospace; color:#8093b8;
            display:flex; gap:14px; }
  #legend span::before { content:"—"; font-weight:bold; margin-right:4px; }
  #legend .lin::before { color:#64748b; } #legend .cho::before { color:#3b82f6; }
  #legend .con::before { color:#d97706; } #legend .end::before { color:#dc2626; }
  #app { position:fixed; inset:0; }
  #panel { position:fixed; right:12px; bottom:12px; top:44px; width:330px; z-index:6;
           background:rgba(10,16,34,.95); border:1px solid #2c3a5c; border-radius:8px;
           padding:14px 16px; overflow-y:auto; font-size:13px; }
  #panel h2 { margin:0 0 6px; font:16px monospace; color:#9fc3ff; }
  #panel h3 { margin:12px 0 4px; font-size:12px; color:#8093b8; text-transform:uppercase; }
  #panel .kv { margin:2px 0; color:#c6d2f0; }
  #panel .opt { margin:1px 0 1px 10px; color:#9aa8cc; }
  #panel .edge { margin:2px 0; }
  #panel .edge.ending { color:#f87171; } #panel .edge.choice { color:#93c5fd; }
  #panel .edge.conditional { color:#fbbf24; } #panel .edge.linear { color:#94a3b8; }
  .hidden { display:none; }
</style>
</head>
<body>
<div id="stats"></div>
<div id="legend"><span class="lin">linear</span><span class="cho">choice</span><span class="con">conditional</span><span class="end">ending</span></div>
<div id="app"></div>
<div id="panel" class="hidden"></div>
<script>window.__GRAPH__ = ${data};</script>
<script>${bundle}</script>
</body>
</html>`;
}
