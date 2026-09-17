import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/** Directory of this module (src/adapters), independent of CWD or Node 20.11+ APIs. */
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the awehitch checkout the adapter spawns the control plane from.
 * Mirrors src/process/daemon.ts cliEntry(): uses the dist entry when present,
 * otherwise falls back to running the TypeScript sources via tsx.
 */
export function awehitchCliEntry(): { cmd: string; args: string[] } {
  const distEntry = path.resolve(here, "..", "..", "dist", "cli", "index.js");
  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry, "control-plane"] };
  }
  // dev fallback: run TypeScript sources through the tsx ESM loader
  const projectRoot = path.resolve(here, "..", "..");
  const tsEntry = path.join(projectRoot, "src", "cli", "index.ts");
  return { cmd: process.execPath, args: ["--import", "tsx/esm", tsEntry, "control-plane"] };
}

/**
 * Resolve the directory where opencode keeps its config. OPENCODE_CONFIG is a
 * FILE path (per opencode docs), not a directory; the directory variable is
 * OPENCODE_CONFIG_DIR. Resolution: OPENCODE_CONFIG_DIR → XDG_CONFIG_HOME/opencode
 * → ~/.config/opencode (XDG unset/empty uses the default).
 */
function opencodeConfigDir(): string {
  const dirOverride = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (dirOverride) return path.resolve(dirOverride);
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return path.join(path.resolve(xdg), "opencode");
  return path.join(os.homedir(), ".config", "opencode");
}

export function harnessHome(harness: HarnessId): string {
  switch (harness) {
    case "codex":
      return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
    case "opencode":
      return opencodeConfigDir();
    case "zcode":
      return process.env.ZCODE_HOME?.trim() || path.join(os.homedir(), ".zcode", "cli");
  }
}

export function harnessLabel(harness: HarnessId): string {
  return { codex: "Codex", opencode: "opencode", zcode: "ZCode" }[harness];
}
