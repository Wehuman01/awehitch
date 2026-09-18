import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";

/**
 * Runtime state file: how the CLI/Skill finds the running bridge. v0.2.6 made
 * the bridge machine-scoped — one file (`runtime/bridge.json`), serving every
 * workspace in the machine registry. Contains the admin token, so it is 0600
 * and lives in the user state dir, never in the project.
 */
export interface RuntimeState {
  service: string;
  version: string;
  pid: number;
  port: number;
  adminToken: string;
  publicUrl: string | null;
  startedAt: string;
  /** Registered workspace roots at the time this state was persisted (informational). */
  workspaces: string[];
}

export function runtimeFile(): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), "bridge.json");
}

export function writeRuntimeState(state: RuntimeState): void {
  writeSecureJson(runtimeFile(), state);
}

export function readRuntimeState(): RuntimeState | null {
  return readJsonIfExists<RuntimeState>(runtimeFile());
}

export function clearRuntimeState(): void {
  try {
    fs.rmSync(runtimeFile(), { force: true });
  } catch {
    // ignore
  }
}

interface LegacyRuntimeFile extends Partial<RuntimeState> {
  workspaceId?: string;
  workspaceRoot?: string;
}

/**
 * Runtime files from the pre-0.2.6 layout: one bridge per workspace, keyed by
 * workspace id. Still read (never written) so a v0.2.5 bridge still running
 * after an upgrade can be found and stopped by its own admin token.
 */
export function readLegacyRuntimeStates(): RuntimeState[] {
  const dir = path.join(getStateDir(), "runtime");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const states: RuntimeState[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || name.startsWith("ensure-") || name === "bridge.json") continue;
    const candidate = readJsonIfExists<LegacyRuntimeFile>(path.join(dir, name));
    if (!candidate || typeof candidate.pid !== "number" || typeof candidate.port !== "number") continue;
    states.push({
      service: String(candidate.service ?? SERVICE_NAME),
      version: String(candidate.version ?? ""),
      pid: candidate.pid,
      port: candidate.port,
      adminToken: String(candidate.adminToken ?? ""),
      publicUrl: candidate.publicUrl ?? null,
      startedAt: String(candidate.startedAt ?? ""),
      workspaces: typeof candidate.workspaceRoot === "string" ? [candidate.workspaceRoot] : [],
    });
  }
  return states;
}

export interface HealthPayload {
  service: string;
  version: string;
  /** v0.2.5 and earlier: the one workspace this bridge served. */
  workspaceId?: string;
  /** v0.2.6+: always "machine" — the bridge serves the whole registry. */
  scope?: "machine";
  workspaceCount?: number;
  status: string;
}

/** Probe a port and check whether a healthy awehitch bridge answers. */
export async function probeBridge(
  port: number,
  timeoutMs = 2000
): Promise<HealthPayload | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = (await response.json()) as HealthPayload;
    if (body.service !== SERVICE_NAME) return null;
    return body;
  } catch {
    return null;
  }
}

export type BridgeObservation =
  | { state: "healthy"; runtime: RuntimeState }
  | { state: "stopped"; runtime: RuntimeState | null; reason: "runtime_missing" | "pid_missing" | "stale_pid" | "legacy_workspace_scoped" }
  | { state: "unknown"; runtime: RuntimeState | null; reason: "probe_failed" | "pid_unknown" };

function observePid(pid: number): "present" | "missing" | "unknown" {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unknown";
  }
}

/** Read the command line of a running process. Null when unreadable. */
export function readProcessCmdline(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const content = fs.readFileSync(path.join("/proc", String(pid), "cmdline"), "utf8");
      // /proc/<pid>/cmdline uses NUL separators
      return content.replace(/\0/g, " ").trim();
    }
    if (process.platform === "darwin" || process.platform === "freebsd" || process.platform === "openbsd") {
      const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (result.status !== 0 || !result.stdout) return null;
      return result.stdout.trim();
    }
    if (process.platform === "win32") {
      const result = spawnSync("powershell", [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter ProcessId=${pid} | Select-Object -ExpandProperty CommandLine`,
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      if (result.status !== 0 || !result.stdout) return null;
      return result.stdout.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * True when a command line looks like an awehitch bridge serve process.
 * Heuristic by design: it guards against killing a pid the system reused, not
 * against a local adversary who can spoof cmdlines.
 */
export function isAwehitchBridge(cmdline: string | null): boolean {
  if (!cmdline) return false;
  const normalized = cmdline.toLowerCase();
  if (!normalized.includes("serve")) return false;
  // The entry appears as ".../awehitch" (installed) or ".../cli/index.js"
  // (repo dist/src layout).
  return normalized.includes("awehitch") || normalized.includes(`cli${path.sep}`);
}

/**
 * Distinguish a dead bridge from a probe that simply failed.
 * Read-only: never starts, stops, or clears runtime.
 */
export async function findBridgeObservation(): Promise<BridgeObservation> {
  const runtime = readRuntimeState();
  if (!runtime) return { state: "stopped", runtime: null, reason: "runtime_missing" };

  const health = await probeBridge(runtime.port);
  if (health?.scope === "machine") {
    return { state: "healthy", runtime };
  }
  // A probe hit from a bridge without machine scope is a pre-0.2.6 bridge
  // still bound to one workspace: replace it, do not reuse it.
  if (health) return { state: "stopped", runtime, reason: "legacy_workspace_scoped" };

  const pid = observePid(runtime.pid);
  if (pid === "missing") return { state: "stopped", runtime, reason: "pid_missing" };
  if (pid === "present") {
    const cmdline = readProcessCmdline(runtime.pid);
    if (cmdline === null) {
      // Identity unreadable (ps/proc failed): refuse to guess "stopped",
      // or a healthy-but-unverifiable bridge could be double-spawned.
      return { state: "unknown", runtime, reason: "pid_unknown" };
    }
    if (!isAwehitchBridge(cmdline)) {
      // The pid lives on as an unrelated process: the runtime file is stale.
      return { state: "stopped", runtime, reason: "stale_pid" };
    }
  }
  return { state: "unknown", runtime, reason: pid === "unknown" ? "pid_unknown" : "probe_failed" };
}

export async function findLiveBridge(): Promise<RuntimeState | null> {
  const observation = await findBridgeObservation();
  return observation.state === "healthy" ? observation.runtime : null;
}

export { SERVICE_NAME, VERSION };
