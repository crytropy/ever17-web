#!/usr/bin/env node
/**
 * Compatibility alias: `npm run vn-graph -- ...` with the Ever17 defaults
 * (start scene op00). The generic kid-graph CLI takes no game defaults.
 */
import { runGraphCli } from "kid-graph/cli";

process.exit(await runGraphCli(process.argv.slice(2)));
