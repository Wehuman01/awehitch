import { describe, it, expect } from "vitest";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import { probeBridge } from "../src/bridge/runtime.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";

describe("port collision handling", () => {
  it("falls back to a free port when the preferred one is taken", async () => {
    isolateStateDir();
    const rootA = makeTmpDir("port-a");
    const rootB = makeTmpDir("port-b");
    write(rootA, "a.txt", "a");
    write(rootB, "b.txt", "b");
    const preferred = 47000 + Math.floor(Math.random() * 1000);

    // A stale process holding the preferred port must not stop the machine
    // bridge from starting: startBridge falls back to an ephemeral port.
    const bridgeA = await startBridge({
      workspaceRoots: [rootA],
      port: preferred,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth"), "a.json"),
    });
    const bridgeB = await startBridge({
      workspaceRoots: [rootB],
      port: preferred,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth"), "b.json"),
    });

    expect(bridgeA.port).toBe(preferred);
    expect(bridgeB.port).not.toBe(preferred);
    expect(bridgeB.port).toBeGreaterThan(0);

    // /health answers with machine scope and the served workspace count
    const healthA = await probeBridge(bridgeA.port);
    const healthB = await probeBridge(bridgeB.port);
    expect(healthA?.scope).toBe("machine");
    expect(healthB?.scope).toBe("machine");
    expect(healthA?.workspaceCount).toBe(1);
    expect(healthB?.workspaceCount).toBe(1);

    await bridgeA.close();
    await bridgeB.close();
    cleanup(rootA);
    cleanup(rootB);
  });

  it("refuses to bind non-loopback hosts", async () => {
    const root = makeTmpDir("port-c");
    write(root, "c.txt", "c");
    await expect(
      startBridge({ workspaceRoots: [root], host: "0.0.0.0", persistRuntime: false })
    ).rejects.toThrow(/loopback/);
    cleanup(root);
  });
});
