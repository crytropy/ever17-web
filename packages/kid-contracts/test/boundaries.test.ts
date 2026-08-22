import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

/**
 * Architectural boundary checks for the Web KID Engine.
 *
 * The generic engine packages must stay game-independent: no imports of the
 * Ever17 parser/asset/adapter packages, no runtime/graph dependency cycle,
 * and no Ever17 scene names, ending ids or control-variable ids as behavior
 * in their sources (comments citing evidence are fine and are stripped
 * before scanning).
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const GENERIC = ["kid-contracts", "kid-runtime", "kid-renderer-pixi", "kid-web-player", "kid-graph"];

/** Packages each workspace may import from (source-level and package.json). */
const ALLOWED_DEPS: Record<string, string[]> = {
  "kid-contracts": [],
  "kid-runtime": ["kid-contracts"],
  "kid-renderer-pixi": ["kid-contracts", "pixi.js"],
  "kid-graph": ["kid-contracts", "kid-runtime", "esbuild"],
  "kid-web-player": ["kid-contracts", "kid-runtime", "kid-renderer-pixi", "kid-graph", "esbuild"],
  "e17-parser": ["kid-contracts"],
  "e17-assets": ["kid-contracts", "e17-parser"],
  "ever17-pc": ["kid-contracts", "e17-parser", "e17-assets"],
  "ever17-web": ["kid-contracts", "kid-runtime", "kid-renderer-pixi", "kid-graph", "kid-web-player", "ever17-pc", "e17-parser", "e17-assets"],
};

const PKG_DIRS: Record<string, string> = {
  "kid-contracts": "packages/kid-contracts",
  "kid-runtime": "packages/kid-runtime",
  "kid-renderer-pixi": "packages/kid-renderer-pixi",
  "kid-web-player": "packages/kid-web-player",
  "kid-graph": "packages/kid-graph",
  "e17-parser": "e17-parser",
  "e17-assets": "e17-assets",
  "ever17-pc": "adapters/ever17-pc",
  "ever17-web": "apps/ever17-web",
};

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function importsOf(file: string): string[] {
  // comments are stripped first: prose like `distinguish "x" from "y"` is not
  // an import, and scanning it produced false violations
  const text = stripComments(readFileSync(file, "utf8"));
  const specs: string[] = [];
  const re = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
  for (const m of text.matchAll(re)) specs.push(m[1]!);
  return specs;
}

/** Root package name of an import specifier ("kid-graph/model" -> "kid-graph"). */
function rootPackage(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("node:")) return null;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function stripComments(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // line comments, but not the "//" inside a URL such as https://...
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("package dependency boundaries", () => {
  it("source imports stay inside each package's allowed dependency set", () => {
    const violations: string[] = [];
    for (const [pkg, allowed] of Object.entries(ALLOWED_DEPS)) {
      const srcDir = join(root, PKG_DIRS[pkg]!, "src");
      for (const file of sourceFiles(srcDir)) {
        for (const spec of importsOf(file)) {
          const dep = rootPackage(spec);
          if (!dep || dep === pkg) continue;
          if (dep === "vitest") continue;
          if (!allowed.includes(dep)) {
            violations.push(`${pkg}: ${file.slice(root.length + 1)} imports "${spec}"`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("package.json dependencies match the allowed sets and form no cycle", () => {
    const deps = new Map<string, string[]>();
    for (const [pkg, dir] of Object.entries(PKG_DIRS)) {
      const pj = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      const declared = Object.keys(pj.dependencies ?? {});
      deps.set(pkg, declared);
      for (const d of declared) {
        expect(ALLOWED_DEPS[pkg], `${pkg} declares dependency "${d}"`).toContain(d);
      }
    }
    // cycle check over the workspace packages
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (pkg: string, path: string[]): void => {
      if (done.has(pkg)) return;
      expect(visiting.has(pkg), `dependency cycle: ${[...path, pkg].join(" -> ")}`).toBe(false);
      visiting.add(pkg);
      for (const d of deps.get(pkg) ?? []) {
        if (deps.has(d)) visit(d, [...path, pkg]);
      }
      visiting.delete(pkg);
      done.add(pkg);
    };
    for (const pkg of deps.keys()) visit(pkg, []);
    // the historical cycle must stay gone
    expect(deps.get("kid-runtime")).not.toContain("kid-graph");
    expect(deps.get("kid-graph")).toContain("kid-runtime");
  });

  it("kid-runtime's browser entry reaches no Node built-ins", () => {
    const srcDir = join(root, "packages/kid-runtime/src");
    // transitive closure of relative imports from the root entry
    const queue = [join(srcDir, "index.ts")];
    const seen = new Set<string>();
    const nodeImports: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of importsOf(file)) {
        if (spec.startsWith("node:")) nodeImports.push(`${file.slice(root.length + 1)}: ${spec}`);
        if (spec.startsWith(".")) {
          queue.push(join(dirname(file), spec.replace(/\.js$/, ".ts")));
        }
      }
    }
    expect(nodeImports).toEqual([]);
    // sanity: the closure covers the core modules
    expect([...seen].some((f) => f.endsWith("vm.ts"))).toBe(true);
    expect([...seen].some((f) => f.endsWith("game-session.ts"))).toBe(true);
  });

  it("generic engine sources contain no Ever17 scene names, ending ids or control vars", () => {
    // Scene names, ending ids and route-control variable ids recovered from
    // Ever17; none may appear as behavior in generic code. Format-id strings
    // ("e17vn-save") are compatibility constants, not scenario knowledge,
    // and are not matched by these patterns.
    const banned =
      /\b(op00|y_ed|sybd|ssep|tt6a|tt7a|sy6b|s_1a|t_[1-6][a-d]|END_[A-Z]{2}00|1203|1050|1223)\b/i;
    const offenders: string[] = [];
    for (const pkg of GENERIC) {
      for (const file of sourceFiles(join(root, PKG_DIRS[pkg]!, "src"))) {
        const code = stripComments(readFileSync(file, "utf8"));
        const m = code.match(banned);
        if (m) offenders.push(`${file.slice(root.length + 1)}: "${m[0]}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

});
