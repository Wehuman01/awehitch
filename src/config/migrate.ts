import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "./paths.js";
import { isNamedTunnelReady, readLegacyTunnelStates, writeTunnelState } from "../tunnel/state.js";

/**
 * One-time v0.2.6 migration: adopt the useful parts of the pre-0.2.6
 * per-workspace state into the machine-scoped layout.
 *
 * - auth: copy the most recently written per-workspace store to
 *   `auth/machine.json`, so a paired ChatGPT connector keeps working across
 *   the upgrade instead of forcing a re-pair.
 * - tunnel: adopt the named-tunnel binding (stable hostname) when exactly one
 *   legacy workspace had one, so the hostname survives the upgrade.
 *
 * Everything else (per-workspace sessions, endpoints, runtime records) is
 * left in place as dead state; the machine files are the source of truth.
 * Idempotent: an existing machine file is never overwritten.
 */

function newestLegacyFile(dir: string, exclude: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best: { file: string; mtime: number } | null = null;
  for (const name of names) {
    if (!name.endsWith(".json") || name === exclude) continue;
    const file = path.join(dir, name);
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (!best || mtime > best.mtime) best = { file, mtime };
    } catch {
      // unreadable: skip
    }
  }
  return best?.file ?? null;
}

export function migrateLegacyStateToMachine(): { adoptedAuth: boolean; adoptedTunnel: boolean } {
  const stateDir = getStateDir();

  // Auth: the newest per-workspace store becomes the machine store.
  let adoptedAuth = false;
  const machineAuth = path.join(stateDir, "auth", "machine.json");
  if (!fs.existsSync(machineAuth)) {
    const source = newestLegacyFile(path.join(stateDir, "auth"), "machine.json");
    if (source) {
      try {
        fs.mkdirSync(path.dirname(machineAuth), { recursive: true, mode: 0o700 });
        fs.copyFileSync(source, machineAuth);
        fs.chmodSync(machineAuth, 0o600);
        adoptedAuth = true;
      } catch {
        // Migration is best-effort: without it the user pairs once more.
      }
    }
  }

  // Tunnel: adopt the one named binding, when exactly one workspace had one.
  let adoptedTunnel = false;
  if (!fs.existsSync(path.join(stateDir, "tunnels", "machine.json"))) {
    const named = readLegacyTunnelStates().filter((entry) => isNamedTunnelReady(entry.state));
    if (named.length === 1) {
      writeTunnelState({ ...named[0].state });
      adoptedTunnel = true;
    }
  }

  return { adoptedAuth, adoptedTunnel };
}
