import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureBridge, followLogFile, stopBridge, stopBridgeAndWait } from "../src/process/daemon.js";
import {
  writeRuntimeState,
  clearRuntimeState,
  probeBridge,
  readRuntimeState,
  readLegacyRuntimeStates,
  type RuntimeState,
} from "../src/bridge/runtime.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { readRegistryRoots } from "../src/workspace/registry.js";
import { cleanup, makeTmpDir, write, isolateStateDir } from "./helpers.js";

function stubRuntime(pid: number, port: number): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: VERSION,
    pid,
    port,
    adminToken: "test-token",
    publicUrl: null,
    startedAt: new Date().toISOString(),
    workspaces: [],
  };
}

describe("stopBridge identity verification", () => {
  it("does not kill an unrelated process and clears the stale runtime", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("stopbridge-stale");
    write(root, "a.txt", "a");
    // Spawn a long-lived process that is NOT an awehitch bridge.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
    child.unref();
    try {
      if (!child.pid) throw new Error("failed to spawn helper");
      writeRuntimeState(stubRuntime(child.pid, 1));
      const stopped = await stopBridge();
      expect(stopped).toBe(false);
      // The child must still be alive.
      expect(() => process.kill(child.pid, 0)).not.toThrow();
      // The runtime file must be cleared.
      expect(fs.existsSync(path.join(stateDir, "runtime", "bridge.json"))).toBe(false);
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
    isolateStateDir();
    const root = makeTmpDir("ensurebridge-concurrent");
    write(root, "a.txt", "a");
    try {
      const [a, b] = await Promise.all([ensureBridge(root), ensureBridge(root)]);

      // One must be the spawned bridge, the other must be the reused one.
      const spawned = [a, b].filter((r) => r.spawned);
      expect(spawned.length).toBe(1);
      // Both must report the same machine bridge.
      expect(a.runtime.port).toBe(b.runtime.port);
    } finally {
      // ensureBridge spawns a DETACHED daemon; stop it or the test leaks a
      // bridge process holding the default port.
      await stopBridge();
      cleanup(root);
      delete process.env.AWEHITCH_STATE_DIR;
    }
  });
});

describe("one machine bridge, many workspaces", () => {
  it("registers a second directory with the running bridge instead of spawning another", async () => {
    isolateStateDir();
    const rootA = makeTmpDir("machine-a");
    const rootB = makeTmpDir("machine-b");
    write(rootA, "a.txt", "a");
    write(rootB, "b.txt", "b");
    try {
      const first = await ensureBridge(rootA);
      expect(first.spawned).toBe(true);

      const second = await ensureBridge(rootB);
      // Same machine instance, nothing was stopped or replaced.
      expect(second.spawned).toBe(false);
      expect(second.runtime.port).toBe(first.runtime.port);

      // Both roots are now registered and visible to the bridge.
      const roots = readRegistryRoots();
      expect(roots).toContain(rootA);
      expect(roots).toContain(rootB);
      const info = (await fetch(`http://127.0.0.1:${second.runtime.port}/health`).then((r) => r.json())) as {
        scope?: string;
        workspaceCount?: number;
      };
      expect(info.scope).toBe("machine");
      expect(info.workspaceCount).toBe(2);
    } finally {
      await stopBridge();
      cleanup(rootA);
      cleanup(rootB);
      delete process.env.AWEHITCH_STATE_DIR;
    }
  });

  it("replaces a pre-0.2.6 workspace-scoped bridge via its own admin API", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("machine-legacy");
    write(root, "a.txt", "a");

    // A stand-in for a v0.2.5 bridge: legacy /health (workspaceId, no scope)
    // and an admin shutdown endpoint, on a port recorded in a legacy
    // runtime/<workspaceId>.json file.
    let legacyFile: string | null = null;
    const legacy = await new Promise<{ server: http.Server; port: number }>((resolve) => {
      const server = http.createServer((req, res) => {
        if (req.url === "/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ service: SERVICE_NAME, version: "0.2.5", workspaceId: "legacyws000001", status: "ok" }));
          return;
        }
        if (req.url === "/admin/shutdown" && req.method === "POST") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ shuttingDown: true }));
          // A real v0.2.5 bridge clears its own runtime record on shutdown and
          // exits; closing the listener makes the probe report the port dead
          // (and this test process must live on).
          if (legacyFile) fs.rmSync(legacyFile, { force: true });
          server.close();
          return;
        }
        res.writeHead(404);
        res.end();
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resolve({ server, port });
      });
    });
    // The legacy runtime record points at THIS test process (the http server
    // keeps it busy), so the admin shutdown is what stops the "legacy bridge".
    const runtimeDir = path.join(stateDir, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    legacyFile = path.join(runtimeDir, "legacyws000001.json");
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({
        service: SERVICE_NAME,
        version: "0.2.5",
        workspaceId: "legacyws000001",
        workspaceRoot: root,
        pid: process.pid,
        port: legacy.port,
        adminToken: "legacy-token",
        publicUrl: null,
        startedAt: new Date().toISOString(),
      })
    );

    try {
      const result = await ensureBridge(root);
      expect(result.spawned).toBe(true);
      expect(result.runtime.port).not.toBe(legacy.port);
      // The legacy bridge's own shutdown cleared its record.
      await vi.waitFor(() => {
        expect(fs.existsSync(path.join(stateDir, "runtime", "legacyws000001.json"))).toBe(false);
      });
    } finally {
      legacy.server.close();
      await stopBridge();
      cleanup(root);
      delete process.env.AWEHITCH_STATE_DIR;
    }
  });

  it("keeps pre-0.2.6 runtime records readable for stop", () => {
    const stateDir = isolateStateDir();
    const runtimeDir = path.join(stateDir, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, "oldws00000001.json"),
      JSON.stringify({
        service: SERVICE_NAME,
        version: "0.2.5",
        workspaceId: "oldws00000001",
        workspaceRoot: "/tmp/old",
        pid: 1,
        port: 59999,
        adminToken: "t",
        publicUrl: null,
        startedAt: new Date().toISOString(),
      })
    );
    writeRuntimeState(stubRuntime(1, 59998));
    try {
      // The machine record is primary; legacy records are still readable.
      expect(readRuntimeState()?.port).toBe(59998);
      const legacy = readLegacyRuntimeStates();
      expect(legacy).toHaveLength(1);
      expect(legacy[0].workspaces).toEqual(["/tmp/old"]);
      clearRuntimeState();
      expect(readRuntimeState()).toBeNull();
    } finally {
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
      expect(await stopBridgeAndWait()).toBe(true);
      // The attached serve child shut down cleanly with the bridge.
      expect(await exited).toBe(0);
      expect(await probeBridge(result.runtime.port)).toBeNull();
      expect(fs.existsSync(path.join(stateDir, "runtime", "bridge.json"))).toBe(false);
    } finally {
      await stopBridge();
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
