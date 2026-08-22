/**
 * Import report: the machine-readable record of how a game package was
 * generated, written into the package as import-report.json.
 *
 * It is both a diagnostic for the user and the evidence a cache validator
 * uses to decide whether a package is complete: `status: "complete"` plus the
 * list of scenes is what proves an import was not cut short.
 */

export const IMPORT_REPORT_FORMAT = "kid-import-report";
export const IMPORT_REPORT_VERSION = 1;

/**
 * Severity of a diagnostic raised while importing.
 *
 * - `fatal`   the package cannot be produced (import aborts)
 * - `story`   content a player will actually encounter is missing
 * - `system`  referenced only by system/UI or developer scripts
 * - `movie`   an optional movie is absent (a placeholder is shown instead)
 */
export type ImportSeverity = "fatal" | "story" | "system" | "movie";

export interface ImportIssue {
  severity: ImportSeverity;
  /** Stable machine tag, e.g. "asset-missing", "script-failed". */
  code: string;
  /** What is affected: a script name, asset name or movie name. */
  subject: string;
  detail: string;
  /** Scenes that reference the subject, when known. */
  referencedBy?: string[];
}

export interface ImportReport {
  format: typeof IMPORT_REPORT_FORMAT;
  version: typeof IMPORT_REPORT_VERSION;
  /** "complete" is the only status a reusable package may carry. */
  status: "complete" | "failed";
  gameId: string;
  sourceFingerprint: string;
  generatedAt: string;
  durationMs: number;
  schemaVersions: {
    package: number;
    manifest: number;
    ir: number;
    profile: number;
    engine: string;
    fingerprintAlgo: string;
  };
  scripts: {
    discovered: number;
    decompiled: number;
    failed: number;
    /** Scene names written, lowercased and sorted. */
    scenes: string[];
    failures: { script: string; reason: string }[];
  };
  assets: {
    referenced: number;
    indexed: number;
    missing: number;
    /** Missing assets a player can actually reach. */
    missingStory: number;
    /** Missing assets referenced only by system/UI or developer scripts. */
    missingSystem: number;
  };
  movies: {
    referenced: number;
    converted: number;
    missingSource: number;
    /** Present in the source but not transcoded (e.g. no ffmpeg). */
    unconverted: number;
  };
  issues: ImportIssue[];
  warnings: string[];
}
