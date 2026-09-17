import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";

/**
 * Runtime state file: how the CLI/Skill finds a running bridge for a
 * workspace. Contains the admin token, so it is 0600 and lives in the user
 * state dir, never in the project.
 */
export interface RuntimeState {
  service: string;
  version: string;
  workspaceId: string;
  workspaceRoot: string;
  pid: number;
  port: number;
  adminToken: string;
  publicUrl: string | null;
  startedAt: string;
}

export function runtimeFile(workspaceId: string): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), `${workspaceId}.json`);
}

export function writeRuntimeState(state: RuntimeState): void {
  writeSecureJson(runtimeFile(state.workspaceId), state);
}

export function readRuntimeState(workspaceId: string): RuntimeState | null {
  return readJsonIfExists<RuntimeState>(runtimeFile(workspaceId));
}

export function clearRuntimeState(workspaceId: string): void {
  try {
    fs.rmSync(runtimeFile(workspaceId), { force: true });
  } catch {
    // ignore
  }
}

export interface HealthPayload {
  service: string;
  version: string;
  workspaceId: string;
  status: string;
}

/** Probe a port and check whether a healthy c2c bridge for the workspace answers. */
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
  | { state: "stopped"; runtime: RuntimeState | null; reason: "runtime_missing" | "pid_missing" | "stale_pid" }
  | { state: "unknown"; runtime: RuntimeState | null; reason: "probe_failed" | "pid_unknown" | "workspace_mismatch" };

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
 * True when a command line looks like an awehitch bridge serving this
 * workspace. Heuristic by design: it guards against killing a pid the system
 * reused, not against a local adversary who can spoof cmdlines.
 */
export function isAwehitchBridge(cmdline: string | null, workspaceRoot: string): boolean {
  if (!cmdline) return false;
  const normalized = cmdline.toLowerCase();
  if (!normalized.includes("serve")) return false;
  if (!normalized.includes(workspaceRoot.toLowerCase())) return false;
  // The entry appears as ".../awehitch" (installed) or ".../cli/index.js"
  // (repo dist/src layout).
  return normalized.includes("awehitch") || normalized.includes(`cli${path.sep}`);
}

/**
 * Distinguish a dead bridge from a probe that simply failed.
 * Read-only: never starts, stops, or clears runtime.
 */
export async function findBridgeObservation(workspaceId: string): Promise<BridgeObservation> {
  const runtime = readRuntimeState(workspaceId);
  if (!runtime) return { state: "stopped", runtime: null, reason: "runtime_missing" };

  const health = await probeBridge(runtime.port);
  if (health && health.workspaceId === workspaceId) {
    return { state: "healthy", runtime };
  }
  if (health) {
    return { state: "unknown", runtime, reason: "workspace_mismatch" };
  }

  const pid = observePid(runtime.pid);
  if (pid === "missing") return { state: "stopped", runtime, reason: "pid_missing" };
  if (pid === "present") {
    const cmdline = readProcessCmdline(runtime.pid);
    if (cmdline === null) {
      // Identity unreadable (ps/proc failed): refuse to guess "stopped",
      // or a healthy-but-unverifiable bridge could be double-spawned.
      return { state: "unknown", runtime, reason: "pid_unknown" };
    }
    if (!isAwehitchBridge(cmdline, runtime.workspaceRoot)) {
      // The pid lives on as an unrelated process: the runtime file is stale.
      return { state: "stopped", runtime, reason: "stale_pid" };
    }
  }
  return { state: "unknown", runtime, reason: pid === "unknown" ? "pid_unknown" : "probe_failed" };
}

export async function findLiveBridge(workspaceId: string): Promise<RuntimeState | null> {
  const observation = await findBridgeObservation(workspaceId);
  return observation.state === "healthy" ? observation.runtime : null;
}

export { SERVICE_NAME, VERSION };
