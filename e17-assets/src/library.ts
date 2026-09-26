import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseLnk } from "e17-parser/lnk";
import type { LnkArchive, LnkEntry } from "e17-parser";

/**
 * The archives an Ever17 installation ships, and what the scenario references
 * inside them. A logical name in the bytecode ("bg01a1", "SE01_04", "S1A012")
 * carries no extension and no archive; resolution is by extension + search
 * order, case-insensitively.
 */
export const ARCHIVES = [
  { file: "bg.dat", ext: ".cps", kind: "image" as const, format: "cps" as const },
  { file: "chara.dat", ext: ".cps", kind: "image" as const, format: "cps" as const },
  { file: "system.dat", ext: ".cps", kind: "image" as const, format: "cps" as const },
  { file: "bgm.dat", ext: ".waf", kind: "audio" as const, format: "waf" as const },
  { file: "se.dat", ext: ".waf", kind: "audio" as const, format: "waf" as const },
  { file: "voice.dat", ext: ".waf", kind: "audio" as const, format: "waf" as const },
  // sysvoice.dat stores headerless 16-bit LE PCM under .wav names, not WAF.
  // Confidence: High - lag-1 autocorrelation is 0.92 on even byte offsets and
  // 0.03 on odd ones (the signature of 16-bit LE samples aligned at 0), and the
  // entries play back intelligibly as 22050 Hz mono, matching every other
  // voice asset in the release.
  { file: "sysvoice.dat", ext: ".wav", kind: "audio" as const, format: "pcm" as const },
];

/** Sample rate assumed for the headerless PCM in sysvoice.dat. */
export const RAW_PCM_SAMPLE_RATE = 22050;
export const RAW_PCM_CHANNELS = 1;

export type AssetFormat = "cps" | "waf" | "pcm";

export interface ResolvedAsset {
  name: string;
  archive: string;
  kind: "image" | "audio";
  /** On-disk encoding, which differs per archive (see ARCHIVES). */
  format: AssetFormat;
  entry: LnkEntry;
}

/**
 * Lazily-opened set of game archives with a case-insensitive name index.
 * Archives are memory-mapped by readFileSync on first use only, so resolving a
 * handful of assets does not read the ~1.7 GB of media the game ships.
 */
export class AssetLibrary {
  private readonly gameDir: string;
  private readonly cache = new Map<string, LnkArchive>();
  private readonly index = new Map<string, ResolvedAsset>();
  /** Every archive a base name appears in, in ARCHIVES order. */
  private readonly byName = new Map<string, ResolvedAsset[]>();
  private indexed = new Set<string>();

  private looseImages: Map<string, string> | null = null;

  /**
   * Official PC patches place replacement CPS files in graph/bg.
   * These override same-named images stored in bg.dat.
   */
  private resolveLooseImage(logicalName: string): ResolvedAsset | undefined {
    const base = logicalName.toLowerCase().replace(/\.[^.]+$/, "");

    if (this.looseImages === null) {
      this.looseImages = new Map<string, string>();

      const dir = join(this.gameDir, "graph", "bg");
      if (existsSync(dir)) {
        for (const file of readdirSync(dir)) {
          if (!file.toLowerCase().endsWith(".cps")) continue;
          const key = file.toLowerCase().replace(/\.cps$/, "");
          this.looseImages.set(key, file);
        }
      }
    }

    const file = this.looseImages.get(base);
    if (!file) return undefined;

    const data = readFileSync(join(this.gameDir, "graph", "bg", file));

    return {
      name: file,
      archive: "graph/bg",
      kind: "image",
      format: "cps",
      entry: {
        name: file,
        offset: 0,
        size: data.length,
        compressed: false,
        data,
      },
    };
  }

  constructor(gameDir: string) {
    this.gameDir = gameDir;
  }

  /** Archives present on disk, in resolution order. */
  available(): typeof ARCHIVES {
    return ARCHIVES.filter((a) => existsSync(join(this.gameDir, a.file)));
  }

  archive(file: string): LnkArchive {
    let a = this.cache.get(file);
    if (!a) {
      const path = join(this.gameDir, file);
      if (!existsSync(path)) throw new Error(`archive not found: ${path}`);
      a = parseLnk(readFileSync(path));
      this.cache.set(file, a);
    }
    return a;
  }

  /**
   * Index one archive's entries, once. An archive that is absent or unreadable
   * is deliberately NOT marked as indexed: a later call retries it, so an
   * installation that was briefly unavailable (an unmounted volume, a file
   * being replaced) recovers without restarting the process.
   */
  private ensureIndexed(spec: (typeof ARCHIVES)[number]): void {
    if (this.indexed.has(spec.file)) return;
    if (!existsSync(join(this.gameDir, spec.file))) return;
    const archive = this.archive(spec.file); // throws: stays unindexed, retried
    this.indexed.add(spec.file);
    for (const entry of archive.entries) {
      const base = entry.name.toLowerCase().replace(/\.[^.]+$/, "");
      const key = `${spec.kind}:${base}`;
      const resolved: ResolvedAsset = {
        name: entry.name,
        archive: spec.file,
        kind: spec.kind,
        format: spec.format,
        entry,
      };
      // First archive in ARCHIVES order wins for a bare name.
      if (!this.index.has(key)) this.index.set(key, resolved);
      const all = this.byName.get(key);
      if (all) all.push(resolved);
      else this.byName.set(key, [resolved]);
    }
  }

  /**
   * Resolve a scenario-level logical name, e.g. ("bg01a1", "image").
   *
   * Bare names are not globally unique: every one of the 168 `sysNNN` entries
   * in sysvoice.dat is shadowed by a same-named entry in se.dat. Without an
   * `archive` hint the first match in ARCHIVES order wins, which favours
   * se.dat - the archive the scenario's PLAY_SE opcode draws from. Callers
   * that mean the system-voice asset must say so explicitly.
   */
  resolve(
    logicalName: string,
    kind: "image" | "audio",
    opts: { archive?: string } = {},
  ): ResolvedAsset | undefined {
    const base = logicalName.toLowerCase().replace(/\.[^.]+$/, "");
    const key = `${kind}:${base}`;
	  // Official patch images in graph/bg override the copies inside bg.dat.
  if (kind === "image" && (!opts.archive || opts.archive === "graph/bg")) {
    const loose = this.resolveLooseImage(base);
    if (loose) return loose;

    // The caller explicitly requested graph/bg and it was not there.
    if (opts.archive === "graph/bg") return undefined;
  }
    for (const spec of ARCHIVES) {
      if (spec.kind !== kind) continue;
      if (opts.archive && spec.file !== opts.archive) continue;
      this.ensureIndexed(spec);
      const candidates = this.byName.get(key);
      if (!candidates) continue;
      const hit = opts.archive
        ? candidates.find((c) => c.archive === opts.archive)
        : this.index.get(key);
      if (hit) return hit;
    }
    return undefined;
  }

  /** Every archive that carries this base name, in ARCHIVES order. */
  resolveAll(logicalName: string, kind: "image" | "audio"): ResolvedAsset[] {
    const base = logicalName.toLowerCase().replace(/\.[^.]+$/, "");
    for (const spec of ARCHIVES) {
      if (spec.kind === kind) this.ensureIndexed(spec);
    }
    return this.byName.get(`${kind}:${base}`) ?? [];
  }
}
