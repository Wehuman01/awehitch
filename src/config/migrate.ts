import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "./paths.js";
import { isNamedTunnelReady, readLegacyTunnelStates, writeTunnelState } from "../tunnel/state.js";

/**
 * One-time v0.2.6 migration: adopt the useful parts of the pre-0.2.6
 * per-workspace state into the machine-scoped layout.
 *
 * - auth: copy the per-workspace store that actually holds credentials to
 *   `auth/machine.json` (most clients + tokens; mtime only breaks ties), so a
 *   paired ChatGPT connector keeps working across the upgrade instead of
 *   forcing a re-pair. Empty stores — a bridge start writes one even when
 *   nothing ever paired — must never beat a populated one by mtime alone.
 * - tunnel: adopt the named-tunnel binding (stable hostname) when exactly one
 *   legacy workspace had one, so the hostname survives the upgrade.
 *
 * Everything else (per-workspace sessions, endpoints, runtime records) is
 * left in place as dead state; the machine files are the source of truth.
 * Idempotent: an existing machine file is never overwritten.
 */

function richestLegacyAuthStore(dir: string, exclude: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best: { file: string; credentials: number; mtime: number } | null = null;
  for (const name of names) {
    if (!name.endsWith(".json") || name === exclude) continue;
    const file = path.join(dir, name);
    try {
      const mtime = fs.statSync(file).mtimeMs;
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
        clients?: unknown[];
        tokens?: unknown[];
      };
      const credentials =
        (Array.isArray(raw.clients) ? raw.clients.length : 0) +
        (Array.isArray(raw.tokens) ? raw.tokens.length : 0);
      if (
        !best ||
        credentials > best.credentials ||
        (credentials === best.credentials && mtime > best.mtime)
      ) {
        best = { file, credentials, mtime };
      }
    } catch {
      // unreadable: skip
    }
  }
  return best?.file ?? null;
}

export function migrateLegacyStateToMachine(): { adoptedAuth: boolean; adoptedTunnel: boolean } {
  const stateDir = getStateDir();

  // Auth: the credential-holding per-workspace store becomes the machine store.
  let adoptedAuth = false;
  const machineAuth = path.join(stateDir, "auth", "machine.json");
  if (!fs.existsSync(machineAuth)) {
    const source = richestLegacyAuthStore(path.join(stateDir, "auth"), "machine.json");
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
