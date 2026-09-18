import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureBridge, followLogFile, stopBridge, stopBridgeAndWait } from "../src/process/daemon.js";
import { writeRuntimeState, clearRuntimeState, probeBridge, type RuntimeState } from "../src/bridge/runtime.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir, write, isolateStateDir } from "./helpers.js";

function stubRuntime(workspaceId: string, workspaceRoot: string, pid: number, port: number): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId,
    workspaceRoot,
    pid,
    port,
    adminToken: "test-token",
    publicUrl: null,
    startedAt: new Date().toISOString(),
  };
}

describe("stopBridge identity verification", () => {
  it("does not kill an unrelated process and clears the stale runtime", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("stopbridge-stale");
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    // Spawn a long-lived process that is NOT an awehitch bridge.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
    child.unref();
    try {
      if (!child.pid) throw new Error("failed to spawn helper");
      writeRuntimeState(stubRuntime(workspace.id, workspace.root, child.pid, 1));
      const stopped = await stopBridge(root);
      expect(stopped).toBe(false);
      // The child must still be alive.
      expect(() => process.kill(child.pid, 0)).not.toThrow();
      // The runtime file must be cleared.
      expect(fs.existsSync(path.join(stateDir, "runtime", `${workspace.id}.json`))).toBe(false);
    } finally {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // ignore
      }
      cleanup(root);
      delete process.env.AWEHITCH_STATE_DIR;
    }
  });
});

describe("ensureBridge concurrency lock", () => {
  it("spawns only once when called concurrently for the same workspace", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("ensurebridge-concurrent");
    write(root, "a.txt", "a");
    try {
      const [a, b] = await Promise.all([ensureBridge(root), ensureBridge(root)]);

      // One must be the spawned bridge, the other must be the reused one.
      const spawned = [a, b].filter((r) => r.spawned);
      expect(spawned.length).toBe(1);
      // Both must report the same runtime.
      expect(a.runtime.port).toBe(b.runtime.port);
      expect(a.runtime.workspaceId).toBe(b.runtime.workspaceId);
      expect(a.stopped).toEqual([]);
      expect(b.stopped).toEqual([]);
    } finally {
      // ensureBridge spawns a DETACHED daemon; stop it or the test leaks a
      // bridge process holding the default port.
      await stopBridge(root);
      cleanup(root);
      delete process.env.AWEHITCH_STATE_DIR;
    }
  });
});

describe("one bridge per machine", () => {
  it("stops the previous workspace's bridge when up runs for another directory", async () => {
    const stateDir = isolateStateDir();
    const rootA = makeTmpDir("single-instance-a");
    const rootB = makeTmpDir("single-instance-b");
    write(rootA, "a.txt", "a");
    write(rootB, "b.txt", "b");
    try {
      const first = await ensureBridge(rootA);
      expect(first.spawned).toBe(true);
      expect(first.stopped).toEqual([]);

      const second = await ensureBridge(rootB);
      // A's bridge was switched off; B is the only one left.
      expect(second.stopped.map((s) => s.workspaceRoot)).toEqual([first.runtime.workspaceRoot]);
      expect(second.runtime.workspaceId).not.toBe(first.runtime.workspaceId);
      const aGone = await probeBridge(first.runtime.port);
      expect(aGone === null || aGone.workspaceId !== first.runtime.workspaceId).toBe(true);
      // A's runtime file was cleared by its own graceful shutdown.
      const workspaceA = new Workspace(rootA);
      expect(fs.existsSync(path.join(stateDir, "runtime", `${workspaceA.id}.json`))).toBe(false);
    } finally {
      await stopBridge(rootB);
      await stopBridge(rootA);
      cleanup(rootA);
      cleanup(rootB);
      delete process.env.AWEHITCH_STATE_DIR;
    }
  });

  it("refuses to start when a foreign bridge cannot be verified", async () => {
    const stateDir = isolateStateDir();
    const rootA = makeTmpDir("single-unverified-a");
    const rootB = makeTmpDir("single-unverified-b");
    write(rootB, "b.txt", "b");
    const workspaceA = new Workspace(rootA);
    // An alive pid whose cmdline looks like an awehitch bridge but which
    // never opens its port: unverifiable, so ensureBridge must refuse.
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000);", "awehitch", "serve", "--workspace", workspaceA.root],
      { stdio: "ignore", detached: true }
    );
    child.unref();
    try {
      if (!child.pid) throw new Error("failed to spawn helper");
      writeRuntimeState(stubRuntime(workspaceA.id, workspaceA.root, child.pid, 1));
      await expect(ensureBridge(rootB)).rejects.toThrow(/cannot be verified|stop -w/);
      expect(() => process.kill(child.pid, 0)).not.toThrow();
    } finally {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // ignore
      }
      cleanup(rootA);
      cleanup(rootB);
      delete process.env.AWEHITCH_STATE_DIR;
    }
  });
});

describe("foreground mode", () => {
  it("spawns an attached child; stopBridgeAndWait confirms a graceful shutdown", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("foreground-attach");
    write(root, "a.txt", "a");
    try {
      const result = await ensureBridge(root, { foreground: true });
      expect(result.spawned).toBe(true);
      const child = result.child;
      expect(child).not.toBeNull();
      const exited = new Promise<number | null>((resolve) => child!.once("exit", (code) => resolve(code)));
      expect(await stopBridgeAndWait(root)).toBe(true);
      // The attached serve child shut down cleanly with the bridge.
      expect(await exited).toBe(0);
      expect(await probeBridge(result.runtime.port)).toBeNull();
      const workspace = new Workspace(root);
      expect(fs.existsSync(path.join(stateDir, "runtime", `${workspace.id}.json`))).toBe(false);
    } finally {
      await stopBridge(root);
      cleanup(root);
      delete process.env.AWEHITCH_STATE_DIR;
    }
  });
});

describe("followLogFile", () => {
  it("emits appended content starting from the current end, and stops cleanly", async () => {
    const dir = makeTmpDir("follow-log");
    const file = path.join(dir, "bridge.log");
    fs.writeFileSync(file, "first\n");
    const chunks: string[] = [];
    const stop = followLogFile(file, (text) => chunks.push(text));
    try {
      fs.appendFileSync(file, "second\n");
      await vi.waitFor(() => expect(chunks.join("")).toContain("second"));
      fs.appendFileSync(file, "third\n");
      await vi.waitFor(() => expect(chunks.join("")).toContain("third"));
      expect(chunks.join("")).not.toContain("first");
    } finally {
      stop();
      cleanup(dir);
    }
  });
});
