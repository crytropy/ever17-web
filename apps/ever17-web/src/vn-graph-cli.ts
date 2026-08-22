#!/usr/bin/env node
/**
 * Compatibility alias: `npm run vn-graph -- ...` with the Ever17 defaults
 * (start scene op00, Ever17 profile). The generic kid-graph CLI itself takes
 * no game defaults.
 */
import { runGraphCli } from "kid-graph/cli";
import { EVER17_PROFILE } from "ever17-pc";

process.exit(await runGraphCli(process.argv.slice(2), { start: "op00", profile: EVER17_PROFILE }));
