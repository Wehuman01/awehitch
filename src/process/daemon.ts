import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, getStateDir } from "../config/paths.js";
import {
  clearRuntimeState,
  findBridgeObservation,
  findLiveBridge,
  isAwehitchBridge,
  probeBridge,
  readProcessCmdline,
  readRuntimeState,
  type RuntimeState,
} from "../bridge/runtime.js";
import { Workspace } from "../workspace/manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the CLI entry, works from dist/ and from tsx dev runs. */
function cliEntry(): { cmd: string; args: string[] } {
  const distEntry = path.resolve(__dirname, "..", "cli", "index.js");
  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry] };
  }
  // dev fallback: run TypeScript sources through the tsx ESM loader
  const projectRoot = path.resolve(__dirname, "..", "..");
  const tsEntry = path.join(projectRoot, "src", "cli", "index.ts");
  return { cmd: process.execPath, args: ["--import", "tsx/esm", tsEntry] };
}

export interface EnsureBridgeResult {
  runtime: RuntimeState;
  spawned: boolean;
  /** Bridges for other workspaces that this call stopped (one bridge per machine). */
  stopped: RuntimeState[];
}

function ensureBridgeLockFile(workspaceId: string): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), `ensure-${workspaceId}.lock`);
}

function singleInstanceLockFile(): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), "ensure-single.lock");
}

function readLockInfo(file: string): { pid: number; acquiredAt: string } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<{ pid: number; acquiredAt: string }> | null;
    if (parsed && typeof parsed.pid === "number" && typeof parsed.acquiredAt === "string") {
      return parsed as { pid: number; acquiredAt: string };
    }
    return null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForBridgeLock(workspaceId: string, deadline: number): Promise<boolean> {
  const lockFile = ensureBridgeLockFile(workspaceId);
  while (Date.now() < deadline) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readLockInfo(lockFile);
      if (!holder || !isPidAlive(holder.pid)) {
        // Stale lock — steal it.
        fs.rmSync(lockFile, { force: true });
        continue;
      }
      // Lock held by a live process: double-check health and yield.
      const runtime = await findLiveBridge(workspaceId);
      if (runtime) return false;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return false;
}

function releaseBridgeLock(workspaceId: string): void {
  const lockFile = ensureBridgeLockFile(workspaceId);
  try {
    const holder = readLockInfo(lockFile);
    if (holder && holder.pid === process.pid) {
      fs.rmSync(lockFile, { force: true });
    }
  } catch {
    // ignore
  }
}

/**
 * Machine-level lock serializing bridge startup across workspaces, so two
 * concurrent `up`s for different directories cannot both end up healthy.
 * Unlike the per-workspace lock, a live holder is simply waited out.
 */
function acquireSingleInstanceLock(deadlineMs: number): Promise<boolean> {
  const lockFile = singleInstanceLockFile();
  const deadline = Date.now() + deadlineMs;
  const attempt = (): boolean => {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readLockInfo(lockFile);
      if (!holder || !isPidAlive(holder.pid)) {
        // Stale lock — steal it.
        fs.rmSync(lockFile, { force: true });
        return attempt();
      }
      return false;
    }
  };
  return (async () => {
    while (Date.now() < deadline) {
      if (attempt()) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  })();
}

function releaseSingleInstanceLock(): void {
  const lockFile = singleInstanceLockFile();
  try {
    const holder = readLockInfo(lockFile);
    if (holder && holder.pid === process.pid) {
      fs.rmSync(lockFile, { force: true });
    }
  } catch {
    // ignore
  }
}

/**
 * Live bridges for OTHER workspaces. Under the one-bridge-per-machine rule
 * these are switched off by ensureBridge. A pid that is alive but cannot be
 * verified as a bridge (probe down, cmdline unreadable) is reported as
 * `unverified` instead of being guessed at.
 */
async function scanForeignBridges(
  excludeWorkspaceId: string
): Promise<{ live: RuntimeState[]; unverified: RuntimeState | null }> {
  const dir = path.join(getStateDir(), "runtime");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { live: [], unverified: null };
  }
  const live: RuntimeState[] = [];
  let unverified: RuntimeState | null = null;
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || name.startsWith("ensure-")) continue;
    const id = name.slice(0, -".json".length);
    if (id === excludeWorkspaceId) continue;
    const runtime = readRuntimeState(id);
    if (!runtime) continue;
    const health = await probeBridge(runtime.port);
    if (health && health.workspaceId === id) {
      live.push(runtime);
      continue;
    }
    if (isPidAlive(runtime.pid)) {
      const cmdline = readProcessCmdline(runtime.pid);
      if (cmdline === null || isAwehitchBridge(cmdline, runtime.workspaceRoot)) {
        // Alive but not provably a live bridge for someone else: refuse to
        // touch it (same honesty rule as the per-workspace unknown state).
        unverified = runtime;
      }
    }
  }
  return { live, unverified };
}

/** Stop a foreign bridge gracefully; its own shutdown clears runtime + tunnel. */
async function stopForeignBridge(runtime: RuntimeState): Promise<void> {
  try {
    await adminFetch(runtime, "POST", "/admin/shutdown", 5000);
  } catch {
    try {
      process.kill(runtime.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const still = await probeBridge(runtime.port);
    if (!still || still.workspaceId !== runtime.workspaceId) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/**
 * Ensure a bridge is running for the workspace. One bridge per machine:
 * a bridge for another workspace is stopped first, so `up` in a different
 * directory switches the active workspace (and reuses the live instance for
 * the same one). Reuses a live instance, otherwise spawns a detached daemon
 * and waits for it to become healthy.
 */
export async function ensureBridge(workspaceRoot: string, opts: { port?: number } = {}): Promise<EnsureBridgeResult> {
  const workspace = new Workspace(workspaceRoot);
  if (!(await acquireSingleInstanceLock(20_000))) {
    throw new Error("Another awehitch command is starting a bridge; try again in a moment.");
  }
  try {
    const foreign = await scanForeignBridges(workspace.id);
    if (foreign.unverified) {
      throw new Error(
        `Another workspace's bridge (${foreign.unverified.workspaceRoot}) is running but its state cannot be verified. ` +
          `Stop it first: awehitch stop -w ${foreign.unverified.workspaceRoot}`
      );
    }
    const stopped: RuntimeState[] = [];
    for (const runtime of foreign.live) {
      await stopForeignBridge(runtime);
      stopped.push(runtime);
    }
    const { runtime, spawned } = await ensureWorkspaceBridge(workspace, opts);
    return { runtime, spawned, stopped };
  } finally {
    releaseSingleInstanceLock();
  }
}

async function ensureWorkspaceBridge(
  workspace: Workspace,
  opts: { port?: number } = {}
): Promise<{ runtime: RuntimeState; spawned: boolean }> {
  const observation = await findBridgeObservation(workspace.id);
  if (observation.state === "healthy") return { runtime: observation.runtime, spawned: false };
  if (observation.state === "unknown") {
    throw new Error(
      `Bridge state is uncertain (${observation.reason}); refusing to start another bridge.`
    );
  }

  const lockDeadline = Date.now() + 20_000;
  const acquired = await waitForBridgeLock(workspace.id, lockDeadline);
  if (!acquired) {
    // Another caller won the race and already started the bridge.
    const runtime = await findLiveBridge(workspace.id);
    if (runtime) return { runtime, spawned: false };
    throw new Error(`Bridge did not become healthy within 20s (lock contention).`);
  }
  try {
    // Double-check after acquiring the lock: another caller may have just finished.
    const recheck = await findBridgeObservation(workspace.id);
    if (recheck.state === "healthy") return { runtime: recheck.runtime, spawned: false };
    if (recheck.state === "unknown") {
      throw new Error(
        `Bridge state is uncertain (${recheck.reason}); refusing to start another bridge.`
      );
    }

    const logDir = ensureDir(path.join(getStateDir(), "logs"));
    const logFile = path.join(logDir, `bridge-${workspace.id}.out.log`);
    const out = fs.openSync(logFile, "a", 0o600);
    try {
      // Existing files may have been created with a permissive umask. Keep the
      // daemon's inherited stdout/stderr log owner-readable only.
      fs.chmodSync(logFile, 0o600);
    } catch {
      // Windows / filesystems without chmod semantics
    }
    const { cmd, args } = cliEntry();
    const child = spawn(
      cmd,
      [...args, "serve", "--workspace", workspace.root, ...(opts.port ? ["--port", String(opts.port)] : [])],
      {
        detached: true,
        stdio: ["ignore", out, out],
        env: { ...process.env },
        windowsHide: true,
      }
    );
    child.unref();
    fs.closeSync(out);

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const runtime = await findLiveBridge(workspace.id);
      if (runtime) return { runtime, spawned: true };
      if (child.exitCode !== null && child.exitCode !== 0) {
        throw new Error(`Bridge process exited with code ${child.exitCode}. See ${logFile}`);
      }
    }
    throw new Error(`Bridge did not become healthy within 20s. See ${logFile}`);
  } finally {
    releaseBridgeLock(workspace.id);
  }
}

export async function adminFetch<T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs = 60_000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${runtime.adminToken}` },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      throw new Error((body as { message?: string }).message ?? `Admin request failed (${response.status})`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function stopBridge(workspaceRoot: string): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
  const runtime = readRuntimeState(workspace.id);
  if (!runtime) return false;
  const healthy = await probeBridge(runtime.port);
  if (healthy && healthy.workspaceId === workspace.id) {
    try {
      await adminFetch(runtime, "POST", "/admin/shutdown", 5000);
      return true;
    } catch {
      // fall through to kill
    }
  }
  const cmdline = readProcessCmdline(runtime.pid);
  if (!isAwehitchBridge(cmdline, workspace.root)) {
    // The pid is not an awehitch bridge (either reused by an unrelated
    // process or unreadable): never kill it. Clear the runtime file only
    // when the mismatch is verified, not when the cmdline was unreadable.
    if (cmdline !== null) clearRuntimeState(workspace.id);
    return false;
  }
  try {
    process.kill(runtime.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
