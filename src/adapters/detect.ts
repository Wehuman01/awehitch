import fs from "node:fs";
import { HARNESS_IDS, harnessHome, type HarnessId } from "./paths.js";

/**
 * Best-effort harness discovery for the default `awehitch` command: a harness
 * is considered installed when its config home directory exists. Honest but
 * cheap — it does not verify the actual skills/MCP wiring (that is `status()`'s
 * job), so a false positive only causes an idempotent (re)install later.
 */
export function detectHarnesses(): HarnessId[] {
  return HARNESS_IDS.filter((harness) => fs.existsSync(harnessHome(harness)));
}