import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureBridge, stopBridge } from "../src/process/daemon.js";
import { writeRuntimeState, clearRuntimeState, type RuntimeState } from "../src/bridge/runtime.js";
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
    } finally {
      // ensureBridge spawns a DETACHED daemon; stop it or the test leaks a
      // bridge process holding the default port.
      await stopBridge(root);
      cleanup(root);
      delete process.env.AWEHITCH_STATE_DIR;
    }
  });
});
