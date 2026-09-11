import os from "node:os";
import path from "node:path";

/**
 * Shared paths for harness adapters. Each adapter installs:
 *  1. an MCP entry (so the harness can call the control-plane proxy)
 *  2. an instruction file (so the harness knows the [C2C] loop)
 *  3. optional sandbox tweaks
 *
 * Adapters never import each other — they only share this module and the
 * control-plane server.
 */

export type HarnessId = "codex" | "opencode" | "zcode";

export const HARNESS_IDS: readonly HarnessId[] = ["codex", "opencode", "zcode"];

/** Resolve the awemind checkout the adapter spawns the control plane from. */
export function awemindCliEntry(): { cmd: string; args: string[] } {
  // dist build (preferred)
  const here = path.resolve(
    typeof import.meta.dirname === "string" ? import.meta.dirname : process.cwd()
  );
  const distEntry = path.resolve(here, "..", "..", "dist", "cli", "index.js");
  return { cmd: process.execPath, args: [distEntry, "control-plane"] };
}

export function harnessHome(harness: HarnessId): string {
  switch (harness) {
    case "codex":
      return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
    case "opencode":
      return process.env.OPENCODE_CONFIG?.trim() || path.join(os.homedir(), ".config", "opencode");
    case "zcode":
      return process.env.ZCODE_HOME?.trim() || path.join(os.homedir(), ".zcode", "cli");
  }
}

export function harnessLabel(harness: HarnessId): string {
  return { codex: "Codex", opencode: "opencode", zcode: "ZCode" }[harness];
}
