import { spawn, type ChildProcess } from "node:child_process";
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
  readLegacyRuntimeStates,
  readProcessCmdline,
  readRuntimeState,
  type RuntimeState,
} from "../bridge/runtime.js";
import { Workspace } from "../workspace/manager.js";
import { addWorkspaceRoot } from "../workspace/registry.js";

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
  /**
   * The spawned serve process, when it was started attached to this CLI run
   * (foreground mode). null in daemon mode and when an instance was reused.
   */
  child: ChildProcess | null;
}

function bridgeLockFile(): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), "ensure-bridge.lock");
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

async function waitForBridgeLock(deadline: number): Promise<boolean> {
  const lockFile = bridgeLockFile();
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
      const runtime = await findLiveBridge();
      if (runtime) return false;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return false;
}

function releaseBridgeLock(): void {
  const lockFile = bridgeLockFile();
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
 * Machine-level lock serializing bridge startup, so two concurrent `up`s (in
 * different directories or different terminals) cannot both spawn a serve
 * process. A live holder is simply waited out.
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
 * Stop one runtime record's process. Prefers the admin API (graceful, tunnel
 * included), falls back to SIGTERM only after verifying the pid really is an
 * awehitch bridge. A pid that is alive but cannot be verified is never
 * touched. `clearStaleFile` clears the machine runtime file when the record is
 * proven stale (pid reused by an unrelated process).
 */
async function stopRuntimeProcess(runtime: RuntimeState, clearStaleFile: boolean): Promise<boolean> {
  if (await probeBridge(runtime.port)) {
    try {
      await adminFetch(runtime, "POST", "/admin/shutdown", 5000);
      return true;
    } catch {
      // fall through to the verified kill
    }
  }
  const cmdline = readProcessCmdline(runtime.pid);
  if (!isAwehitchBridge(cmdline)) {
    // The pid is not an awehitch bridge (reused by an unrelated process or
    // unreadable): never kill it. Clear the stale machine record only when
    // the mismatch is verified, not when the cmdline was unreadable.
    if (clearStaleFile && cmdline !== null) clearRuntimeState();
    return false;
  }
  try {
    process.kill(runtime.pid, "SIGTERM");
    return true;
  } catch {
    // already gone
    return false;
  }
}

/**
 * Shut down pre-0.2.6 bridges still running after an upgrade: they answer on
 * their per-workspace runtime records. A record whose port answers with the
 * current machine bridge is skipped (stale file, not a stale process).
 */
async function stopLegacyBridges(): Promise<void> {
  for (const legacy of readLegacyRuntimeStates()) {
    const health = await probeBridge(legacy.port);
    if (!health || health.scope === "machine") continue;
    await stopRuntimeProcess(legacy, false);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const still = await probeBridge(legacy.port);
      if (!still || still.scope === "machine") break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

/**
 * Ensure THE machine bridge is running and that `workspaceRoot` is one of its
 * served workspaces. v0.2.6: one bridge serves every registered directory, so
 * `up` in a new directory registers the root with the live instance (or starts
 * the one bridge). Reuses a healthy instance, otherwise spawns the `serve`
 * child — attached in foreground mode (logs stream to the caller's terminal)
 * or as a detached daemon (logs go to the state dir) — and waits for health.
 */
export async function ensureBridge(
  workspaceRoot: string,
  opts: { port?: number; foreground?: boolean } = {}
): Promise<EnsureBridgeResult> {
  const workspace = new Workspace(workspaceRoot); // throws when the root is invalid
  if (!(await acquireSingleInstanceLock(20_000))) {
    throw new Error("Another awehitch command is starting a bridge; try again in a moment.");
  }
  try {
    await stopLegacyBridges();
    // Register before spawning so the serve process reads a complete registry.
    addWorkspaceRoot(workspace.root);
    const ensured = await ensureMachineBridge(opts);
    if (!ensured.spawned) {
      // The bridge predates this call: register the root with the live
      // process so its MCP tools see it immediately (also refreshes the
      // runtime snapshot).
      try {
        await adminFetch(ensured.runtime, "POST", "/admin/workspaces", 10_000, { root: workspace.root });
      } catch (error) {
        throw new Error(
          `The running bridge did not accept the workspace registration: ${(error as Error).message}`
        );
      }
    }
    return ensured;
  } finally {
    releaseSingleInstanceLock();
  }
}

async function ensureMachineBridge(
  opts: { port?: number; foreground?: boolean } = {}
): Promise<{ runtime: RuntimeState; spawned: boolean; child: ChildProcess | null }> {
  const observation = await findBridgeObservation();
  if (observation.state === "healthy") return { runtime: observation.runtime, spawned: false, child: null };
  if (observation.state === "unknown") {
    throw new Error(
      `Bridge state is uncertain (${observation.reason}); refusing to start another bridge.`
    );
  }

  const lockDeadline = Date.now() + 20_000;
  const acquired = await waitForBridgeLock(lockDeadline);
  if (!acquired) {
    // Another caller won the race and already started the bridge.
    const runtime = await findLiveBridge();
    if (runtime) return { runtime, spawned: false, child: null };
    throw new Error(`Bridge did not become healthy within 20s (lock contention).`);
  }
  let child: ChildProcess | null = null;
  try {
    // Double-check after acquiring the lock: another caller may have just finished.
    const recheck = await findBridgeObservation();
    if (recheck.state === "healthy") return { runtime: recheck.runtime, spawned: false, child: null };
    if (recheck.state === "unknown") {
      throw new Error(
        `Bridge state is uncertain (${recheck.reason}); refusing to start another bridge.`
      );
    }

    const logDir = ensureDir(path.join(getStateDir(), "logs"));
    const logFile = path.join(logDir, "bridge.out.log");
    const { cmd, args } = cliEntry();
    const serveArgs = [...args, "serve", ...(opts.port ? ["--port", String(opts.port)] : [])];
    if (opts.foreground) {
      // Attached: the caller's terminal IS the service's lifetime. Ctrl+C
      // reaches the serve child (same process group) and it shuts down
      // gracefully, tunnel included. The Logger still writes its files.
      child = spawn(cmd, serveArgs, {
        detached: false,
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env },
        windowsHide: true,
      });
    } else {
      const out = fs.openSync(logFile, "a", 0o600);
      try {
        // Existing files may have been created with a permissive umask. Keep the
        // daemon's inherited stdout/stderr log owner-readable only.
        fs.chmodSync(logFile, 0o600);
      } catch {
        // Windows / filesystems without chmod semantics
      }
      child = spawn(cmd, serveArgs, {
        detached: true,
        stdio: ["ignore", out, out],
        env: { ...process.env },
        windowsHide: true,
      });
      child.unref();
      fs.closeSync(out);
    }

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const runtime = await findLiveBridge();
      if (runtime) return { runtime, spawned: true, child };
      if (child.exitCode !== null && child.exitCode !== 0) {
        throw new Error(`Bridge process exited with code ${child.exitCode}. See ${logFile}`);
      }
    }
    // Never healthy: do not leave an attached child holding the caller's loop.
    child.kill("SIGTERM");
    throw new Error(`Bridge did not become healthy within 20s. See ${logFile}`);
  } finally {
    releaseBridgeLock();
  }
}

export async function adminFetch<T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs = 60_000,
  body?: unknown
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${runtime.adminToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const parsed = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      throw new Error((parsed as { message?: string }).message ?? `Admin request failed (${response.status})`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stop every bridge this machine knows about: the v0.2.6 machine bridge via
 * `runtime/bridge.json`, plus any pre-0.2.6 per-workspace bridge still running
 * after an upgrade. Returns true when at least one process was stopped.
 */
export async function stopBridge(): Promise<boolean> {
  let stopped = false;
  const runtime = readRuntimeState();
  if (runtime) {
    stopped = await stopRuntimeProcess(runtime, true);
  }
  for (const legacy of readLegacyRuntimeStates()) {
    const wasStopped = await stopRuntimeProcess(legacy, false);
    stopped = stopped || wasStopped;
  }
  return stopped;
}

/** The bridge's structured log (Logger name "bridge"), written in both modes. */
export function bridgeLogPath(): string {
  return path.join(ensureDir(path.join(getStateDir(), "logs")), "bridge.log");
}

/**
 * Follow a log file from its current end, emitting appended text. Poll-based
 * on purpose: no fs-watch dependencies, and the file may not exist yet (the
 * bridge creates it lazily). Returns a stop function.
 */
export function followLogFile(file: string, onChunk: (text: string) => void): () => void {
  let pos = 0;
  try {
    pos = fs.statSync(file).size;
  } catch {
    pos = 0;
  }
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size < pos) pos = 0; // truncated or rotated: start over
    if (size === pos) return;
    let fd: number;
    try {
      fd = fs.openSync(file, "r");
    } catch {
      return;
    }
    try {
      const buf = Buffer.alloc(size - pos);
      const read = fs.readSync(fd, buf, 0, buf.length, pos);
      pos += read;
      if (read > 0) onChunk(buf.toString("utf8", 0, read));
    } catch {
      // file vanished mid-read: keep polling
    } finally {
      fs.closeSync(fd);
    }
  };
  const timer = setInterval(tick, 400);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Graceful stop (admin shutdown, tunnel included) + wait until the bridge
 * really stops answering. Returns true only when the stop is confirmed.
 */
export async function stopBridgeAndWait(timeoutMs = 10_000): Promise<boolean> {
  const runtime = readRuntimeState();
  const stopped = await stopBridge();
  if (!runtime) return stopped;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const still = await probeBridge(runtime.port);
    if (!still) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}
